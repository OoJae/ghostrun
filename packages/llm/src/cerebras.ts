// Cerebras adapter (OpenAI-compatible chat completions). Streams text deltas and drops the
// reasoning channel; reports time-to-first-answer-token so the stopwatch can show real splits.
import { clock, jsonIn, LlmError, post, sseData, type ChatOptions, type StreamEvent } from "./wire";

export { LlmError, RETRY_MS, type ChatMessage, type ChatOptions, type ImageIn, type StreamEvent } from "./wire";

const BASE = "https://api.cerebras.ai/v1";

function body(o: ChatOptions, stream: boolean) {
  // the fast lane reads text only: a picture sent here would be dropped without a word, so refuse it
  if (o.messages.some((m) => m.image)) throw new LlmError("cerebras reads no images", 400, false);
  return JSON.stringify({
    model: o.model,
    messages: o.messages,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(o.reasoningEffort ? { reasoning_effort: o.reasoningEffort } : {}),
    ...(o.maxTokens ? { max_completion_tokens: o.maxTokens } : {}),
    ...(o.jsonSchema ? { response_format: { type: "json_schema", json_schema: { name: o.jsonSchema.name, strict: true, schema: o.jsonSchema.schema } } } : {}),
  });
}

const send = (o: ChatOptions, stream: boolean) => post("cerebras", `${o.baseUrl ?? BASE}/chat/completions`, { authorization: `Bearer ${o.apiKey}` }, body(o, stream), o);

/** Stream answer text (reasoning deltas are dropped). */
export async function* streamChat(o: ChatOptions): AsyncGenerator<StreamEvent> {
  const now = clock(o);
  const t0 = now();
  const res = await send(o, true);
  let first = true;
  for await (const data of sseData(res)) {
    if (data === "[DONE]") continue;
    let chunk: { choices?: { delta?: { content?: string | null } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      if (first) {
        first = false;
        yield { type: "first_token", ms: Math.round(now() - t0) };
      }
      yield { type: "text", delta };
    }
    if (chunk.usage) yield { type: "usage", inTok: chunk.usage.prompt_tokens, outTok: chunk.usage.completion_tokens, model: o.model };
  }
  yield { type: "done", ms: Math.round(now() - t0) };
}

/** One-shot JSON answer (used for the intent call, ideally with a strict json schema). */
export async function chatJson<T>(o: ChatOptions): Promise<{ value: T; ms: number; inTok: number; outTok: number; model: string }> {
  const now = clock(o);
  const t0 = now();
  const res = await send(o, false);
  const j = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
  const value = jsonIn<T>(j.choices[0]?.message.content ?? "");
  return { value, ms: Math.round(now() - t0), inTok: j.usage?.prompt_tokens ?? 0, outTok: j.usage?.completion_tokens ?? 0, model: o.model };
}
