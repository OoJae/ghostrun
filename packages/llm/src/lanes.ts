// Which model does which job, and the rung below it. Cerebras is the fast lane; when it is busy or
// down before it has said a word, the same request goes to Claude Haiku instead of losing the world.
// Once text has streamed the call is final either way (the client has already placed those lines).
import { claudeJson, streamClaude } from "./anthropic";
import { chatJson, streamChat } from "./cerebras";
import { LlmError, type ChatMessage, type ChatOptions, type StreamEvent } from "./wire";

export type Provider = "cerebras" | "anthropic";
export type Job = "intent" | "fill" | "patch" | "mind" | "host";
export interface Lane extends ChatOptions {
  provider: Provider;
}
export interface Keys {
  cerebras?: string | undefined;
  anthropic?: string | undefined;
}

type Route = { model: string; reasoningEffort: NonNullable<ChatOptions["reasoningEffort"]> };
const HAIKU: Route = { model: "claude-haiku-5-5", reasoningEffort: "none" };

/** The routing table. The model ids are part of the template hash (a change re-proves the gallery). */
export const ROUTES: Record<Job, Record<Provider, Route>> = {
  intent: { cerebras: { model: "qwen-3.8-27b", reasoningEffort: "none" }, anthropic: HAIKU },
  fill: { cerebras: { model: "gpt-oss-120b", reasoningEffort: "low" }, anthropic: HAIKU },
  patch: { cerebras: { model: "gpt-oss-120b", reasoningEffort: "low" }, anthropic: HAIKU },
  mind: { cerebras: { model: "qwen-3.8-27b", reasoningEffort: "none" }, anthropic: HAIKU },
  host: { cerebras: { model: "qwen-3.8-27b", reasoningEffort: "none" }, anthropic: HAIKU },
};

export interface JobCall {
  messages: ChatMessage[];
  maxTokens?: number;
  jsonSchema?: NonNullable<ChatOptions["jsonSchema"]>;
  signal?: AbortSignal;
  /** Which provider goes first (a KV switch at the edge); the other one, if it has a key, is the fallback. */
  primary?: Provider;
}

/** One quick retry of the primary before failing over: a 429 often clears in under a second. */
export const FAILOVER_RETRY_MS = [700] as const;

/** The lanes for a job, in the order to try them. Empty if no provider has a key. */
export function lanesFor(job: Job, keys: Keys, call: JobCall): Lane[] {
  const order: Provider[] = call.primary === "anthropic" ? ["anthropic", "cerebras"] : ["cerebras", "anthropic"];
  const usable = order.filter((p) => keys[p]);
  const { primary: _, ...rest } = call;
  return usable.map((provider, k) => ({ ...rest, ...ROUTES[job][provider], provider, apiKey: keys[provider]!, ...(k === 0 && usable.length > 1 ? { retryMs: FAILOVER_RETRY_MS } : {}) }));
}

/** May the next lane take over from this failure? Only a busy or broken provider, never a bad request. */
const failsOver = (e: unknown, lane: Lane, next: Lane | undefined): next is Lane => Boolean(next) && e instanceof LlmError && e.retryable && !lane.signal?.aborted;

/** Stream from the first lane that answers; a `fallback` event marks each switch. */
export async function* streamLanes(lanes: Lane[]): AsyncGenerator<StreamEvent> {
  if (!lanes.length) throw new LlmError("no model provider configured", 503, false);
  for (let k = 0; k < lanes.length; k++) {
    const lane = lanes[k]!;
    let spoke = false;
    try {
      for await (const ev of lane.provider === "anthropic" ? streamClaude(lane) : streamChat(lane)) {
        if (ev.type === "text") spoke = true;
        yield ev;
      }
      return;
    } catch (e) {
      const next = lanes[k + 1];
      if (spoke || !failsOver(e, lane, next)) throw e;
      yield { type: "fallback", from: lane.model, to: next.model, status: (e as LlmError).status };
    }
  }
}

/** A JSON answer from the first lane that gives one; `fellBack` says the primary didn't. */
export async function jsonLanes<T>(lanes: Lane[]): Promise<{ value: T; ms: number; inTok: number; outTok: number; model: string; fellBack: boolean }> {
  if (!lanes.length) throw new LlmError("no model provider configured", 503, false);
  for (let k = 0; ; k++) {
    const lane = lanes[k]!;
    try {
      const r = await (lane.provider === "anthropic" ? claudeJson<T>(lane) : chatJson<T>(lane));
      return { ...r, fellBack: k > 0 };
    } catch (e) {
      if (!failsOver(e, lane, lanes[k + 1])) throw e;
    }
  }
}
