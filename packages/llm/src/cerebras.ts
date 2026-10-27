// Cerebras adapter (OpenAI-compatible chat completions). Streams text deltas and drops the
// reasoning channel; reports time-to-first-answer-token so the stopwatch can show real splits.
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  reasoningEffort?: "none" | "low" | "medium" | "high";
  maxTokens?: number;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  baseUrl?: string;
  signal?: AbortSignal;
  now?: () => number;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "first_token"; ms: number }
  | { type: "usage"; inTok: number; outTok: number }
  | { type: "done"; ms: number };

const BASE = "https://api.cerebras.ai/v1";

function body(o: ChatOptions, stream: boolean) {
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

export class LlmError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
  }
}

async function post(o: ChatOptions, stream: boolean): Promise<Response> {
  const res = await fetch(`${o.baseUrl ?? BASE}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
    body: body(o, stream),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(`cerebras ${res.status}: ${text.slice(0, 300)}`, res.status, res.status === 429 || res.status >= 500);
  }
  return res;
}

/** Stream answer text (reasoning deltas are dropped). */
export async function* streamChat(o: ChatOptions): AsyncGenerator<StreamEvent> {
  const now = o.now ?? (() => globalThis.performance?.now?.() ?? 0);
  const t0 = now();
  const res = await post(o, true);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let first = true;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
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
      if (chunk.usage) yield { type: "usage", inTok: chunk.usage.prompt_tokens, outTok: chunk.usage.completion_tokens };
    }
  }
  yield { type: "done", ms: Math.round(now() - t0) };
}

/** One-shot JSON answer (used for the intent call, ideally with a strict json schema). */
export async function chatJson<T>(o: ChatOptions): Promise<{ value: T; ms: number; inTok: number; outTok: number }> {
  const now = o.now ?? (() => globalThis.performance?.now?.() ?? 0);
  const t0 = now();
  const res = await post(o, false);
  const j = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
  const text = j.choices[0]?.message.content ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new LlmError(`no JSON object in answer: ${text.slice(0, 200)}`, 200, true);
  return { value: JSON.parse(text.slice(start, end + 1)) as T, ms: Math.round(now() - t0), inTok: j.usage?.prompt_tokens ?? 0, outTok: j.usage?.completion_tokens ?? 0 };
}
