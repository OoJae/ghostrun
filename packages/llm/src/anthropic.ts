// Anthropic adapter (Messages API over plain HTTP, the same shape as the Cerebras one). Claude Haiku
// is the rung below the fast lane; the fast jobs run with thinking off and low effort so the first
// line still arrives in about a second. Plain fetch rather than the SDK: the SDK bundles an
// Unlicense dependency (fast-sha256, for webhooks) that our licence list doesn't allow.
import { clock, jsonIn, LlmError, post, sseData, type ChatOptions, type StreamEvent } from "./wire";

const BASE = "https://api.anthropic.com/v1";
const VERSION = "2026-10-21";

// Structured outputs reject numeric, length and size bounds (400). Callers re-check those bounds
// on the answer anyway (a mind's option against its menu, the Host's cites against its facts).
const UNSUPPORTED = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "uniqueItems"]);

/** A JSON schema cut down to what structured outputs accept. */
export function claudeSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(claudeSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (UNSUPPORTED.has(k) || (k === "minItems" && typeof v === "number" && v > 1)) continue;
    out[k] =
      k === "properties" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, p]) => [name, claudeSchema(p)]))
      : k === "enum" || k === "const" || k === "required" ? v
      : claudeSchema(v);
  }
  return out;
}

/** Thinking off where the model allows it (Haiku: disabled; Sonnet 5.5: between tools); elsewhere low effort does the work. */
function thinkingOff(model: string): Record<string, unknown> | undefined {
  if (model.startsWith("claude-haiku")) return { type: "disabled" };
  if (model.startsWith("claude-sonnet-5-5")) return { type: "between_tools" };
  return undefined;
}

function body(o: ChatOptions, stream: boolean) {
  const system = o.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const fast = !o.reasoningEffort || o.reasoningEffort === "none";
  const thinking = fast ? thinkingOff(o.model) : { type: "adaptive" };
  return JSON.stringify({
    model: o.model,
    max_tokens: o.maxTokens ?? 4096,
    stream,
    ...(system ? { system } : {}),
    // a picture goes before the words about it, as its own block
    messages: o.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.image ? [{ type: "image", source: { type: "base64", media_type: m.image.mediaType, data: m.image.data } }, { type: "text", text: m.content }] : m.content })),
    ...(thinking ? { thinking } : {}),
    output_config: { effort: fast ? "low" : o.reasoningEffort, ...(o.jsonSchema ? { format: { type: "json_schema", schema: claudeSchema(o.jsonSchema.schema) } } : {}) },
  });
}

const send = (o: ChatOptions, stream: boolean) => post("anthropic", `${o.baseUrl ?? BASE}/messages`, { "x-api-key": o.apiKey, "anthropic-version": VERSION }, body(o, stream), o);

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}
const inputOf = (u: Usage | undefined) => (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);

/** Stream answer text; a refusal or a mid-stream overload ends the call with an LlmError. */
export async function* streamClaude(o: ChatOptions): AsyncGenerator<StreamEvent> {
  const now = clock(o);
  const t0 = now();
  const res = await send(o, true);
  let first = true;
  let inTok = 0;
  let outTok = 0;
  for await (const data of sseData(res)) {
    let ev: { type?: string; message?: { usage?: Usage }; delta?: { type?: string; text?: string; stop_reason?: string }; usage?: Usage; error?: { type?: string; message?: string } };
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (ev.type === "message_start") inTok = inputOf(ev.message?.usage);
    else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
      if (first) {
        first = false;
        yield { type: "first_token", ms: Math.round(now() - t0) };
      }
      yield { type: "text", delta: ev.delta.text };
    } else if (ev.type === "message_delta") {
      outTok = ev.usage?.output_tokens ?? outTok;
      if (ev.delta?.stop_reason === "refusal") throw new LlmError("anthropic declined the request", 200, false);
    } else if (ev.type === "error") {
      // the HTTP answer was a 200 and tokens may have been billed, so it's charged as such (fail closed)
      throw new LlmError(`anthropic stream: ${ev.error?.type ?? "error"} ${ev.error?.message ?? ""}`.trim(), 200, true);
    }
  }
  yield { type: "usage", inTok, outTok, model: o.model };
  yield { type: "done", ms: Math.round(now() - t0) };
}

/** One-shot JSON answer through structured outputs. */
export async function claudeJson<T>(o: ChatOptions): Promise<{ value: T; ms: number; inTok: number; outTok: number; model: string }> {
  const now = clock(o);
  const t0 = now();
  const res = await send(o, false);
  const j = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string; usage?: Usage };
  if (j.stop_reason === "refusal") throw new LlmError("anthropic declined the request", 200, false);
  const text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  return { value: jsonIn<T>(text), ms: Math.round(now() - t0), inTok: inputOf(j.usage), outTok: j.usage?.output_tokens ?? 0, model: o.model };
}
