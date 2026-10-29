// Which model does which job, and the rungs below it. Cerebras is the fast lane; when it is busy,
// down or out of credit before it has said a word, the same request goes to Claude instead of
// losing the world. Once text has streamed the call is final either way (the client has already
// placed those lines).
import { claudeJson, streamClaude } from "./anthropic";
import { chatJson, streamChat } from "./cerebras";
import { LlmError, type ChatMessage, type ChatOptions, type StreamEvent } from "./wire";

export type Provider = "cerebras" | "anthropic";
export type Job = "intent" | "fill" | "patch" | "mind" | "host" | "director" | "hard_repair" | "vision";
export interface Route {
  provider: Provider;
  model: string;
  reasoningEffort: NonNullable<ChatOptions["reasoningEffort"]>;
}
export interface Lane extends ChatOptions {
  provider: Provider;
}
export interface Keys {
  cerebras?: string | undefined;
  anthropic?: string | undefined;
}

const QWEN: Route = { provider: "cerebras", model: "qwen-3.8-27b", reasoningEffort: "none" };
const GPT_OSS: Route = { provider: "cerebras", model: "gpt-oss-120b", reasoningEffort: "low" };
const HAIKU: Route = { provider: "anthropic", model: "claude-haiku-5-5", reasoningEffort: "none" };
const SONNET: Route = { provider: "anthropic", model: "claude-sonnet-5-5", reasoningEffort: "low" };

/**
 * The routing table, each job's lanes in the order to try them. Minds and the Host start on Haiku:
 * they are frequent and short, a Haiku mind costs about a ninth of a qwen one, and every fast-lane
 * token comes out of a small trial credit that world builds need. The Director's cut and hard
 * repairs are Sonnet's. Reading a photo or sketch into a scene brief is Haiku's alone: the fast
 * lane reads no images, and the brief is text the fast lane then writes the world from. The intent
 * and fill model ids are part of the template hash (a change re-proves the gallery).
 */
export const ROUTES: Record<Job, Route[]> = {
  intent: [QWEN, HAIKU],
  fill: [GPT_OSS, HAIKU],
  patch: [GPT_OSS, HAIKU],
  mind: [HAIKU, QWEN],
  host: [HAIKU, QWEN],
  director: [SONNET, HAIKU],
  hard_repair: [SONNET, HAIKU],
  vision: [HAIKU],
};

export interface JobCall {
  messages: ChatMessage[];
  maxTokens?: number;
  jsonSchema?: NonNullable<ChatOptions["jsonSchema"]>;
  signal?: AbortSignal;
  /** A provider to put first for every job (a KV switch at the edge); unset keeps the table's order. */
  primary?: Provider | undefined;
}

/** One quick retry of the first lane before failing over: a 429 often clears in under a second. */
export const FAILOVER_RETRY_MS = [700] as const;

// Providers this isolate just saw fail, and until when to try them last: a busy one briefly, one
// that turned the key away (out of credit, trial over) for longer. Builds stop waiting on it.
const resting = new Map<Provider, number>();
const restMs = (status: number) => (status === 429 ? 20_000 : OUT.has(status) ? 600_000 : 10_000);
/** Statuses that mean this provider won't serve us now, whatever we send: try the other one. */
const OUT = new Set([401, 402, 403]);

/** Forget which providers failed (tests; a fresh isolate starts this way). */
export function resetLaneHealth() {
  resting.clear();
}

/** The lanes for a job, in the order to try them. Empty if no provider has a key. */
export function lanesFor(job: Job, keys: Keys, call: JobCall): Lane[] {
  const { primary, ...rest } = call;
  const now = Date.now();
  const score = (r: Route) => ((resting.get(r.provider) ?? 0) > now ? 2 : 0) + (primary && r.provider !== primary ? 1 : 0);
  const usable = ROUTES[job].filter((r) => keys[r.provider]).sort((a, b) => score(a) - score(b)); // stable: ties keep the table's order
  return usable.map((r, k) => ({ ...rest, ...r, apiKey: keys[r.provider]!, ...(k === 0 && usable.length > 1 ? { retryMs: FAILOVER_RETRY_MS } : {}) }));
}

/** May the next lane take over from this failure? A busy, broken or refusing provider; never a bad request. */
function failsOver(e: unknown, lane: Lane, next: Lane | undefined): next is Lane {
  if (!(e instanceof LlmError) || !(e.retryable || OUT.has(e.status)) || lane.signal?.aborted) return false;
  if (e.status !== 200) resting.set(lane.provider, Date.now() + restMs(e.status));
  return Boolean(next);
}

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

/** A JSON answer from the first lane that gives one; `fellBack` says the first lane didn't. */
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
