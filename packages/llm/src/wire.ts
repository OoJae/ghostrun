// What every provider adapter shares: the call options, the stream events the edge relays, the
// error a caller can branch on, a POST that waits out a busy provider, and an SSE data reader.
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
  /** Waits before each retry of a busy provider (default RETRY_MS); [] fails over at once. */
  retryMs?: readonly number[];
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "first_token"; ms: number }
  | { type: "usage"; inTok: number; outTok: number; model: string }
  | { type: "fallback"; from: string; to: string; status: number }
  | { type: "done"; ms: number };

export class LlmError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
  }
}

/** Waits `ms`, or less if the caller gives up. */
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Backoff before each retry of a busy provider (429) or a server error: a second or two, not a failed world. */
export const RETRY_MS = [700, 1500] as const;

export const clock = (o: ChatOptions) => o.now ?? (() => globalThis.performance?.now?.() ?? 0);

/** POST a request, retrying a busy provider (429, 5xx) after the provider's own hint or our backoff. */
export async function post(provider: string, url: string, headers: Record<string, string>, body: string, o: ChatOptions): Promise<Response> {
  const waits = o.retryMs ?? RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body, ...(o.signal ? { signal: o.signal } : {}) });
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500;
    const wait = waits[attempt];
    if (!retryable || wait === undefined || o.signal?.aborted) throw new LlmError(`${provider} ${res.status}: ${text.slice(0, 300)}`, res.status, retryable);
    // the provider's own hint when it gives one (in seconds), never more than 2 s
    const hint = Number(res.headers.get("retry-after"));
    await pause(Number.isFinite(hint) && hint > 0 ? Math.min(2000, hint * 1000) : wait, o.signal);
  }
}

/** The `data:` payloads of a server-sent event stream, in order. */
export async function* sseData(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

/** The JSON object in a model's answer (tolerates a stray sentence or fence around it). */
export function jsonIn<T>(text: string): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new LlmError(`no JSON object in answer: ${text.slice(0, 200)}`, 200, true);
  return JSON.parse(text.slice(start, end + 1)) as T;
}
