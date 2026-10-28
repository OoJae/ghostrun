// What a build costs. Prices are integer nano-USD per token so the ledger never rounds; the
// pre-flight estimate is an upper bound (input at ≤2 UTF-8 bytes per token, output at its max
// token budget), so a commit almost never exceeds its hold. The estimate prices the fast lane;
// the Haiku fallback costs less per token than either of its models, so a hold covers it too.
import { ROUTES, type Job } from "@ghostrun/llm";

export const INTENT_MODEL = ROUTES.intent[0]!.model;
export const FILL_MODEL = ROUTES.fill[0]!.model;
export const INTENT_MAX_OUT = 800;
export const FILL_MAX_OUT = 6000;
/** Input-token bound for the fill call, which is only known after the intent; test-guarded per pack. */
export const FILL_MAX_IN = 12_000; // raised with the kit vocabulary (12 more verb lines)

// $/M tokens → nano-USD/token: gpt-oss-120b $0.35 in / $0.75 out; qwen-3.8-27b $0.99 in / $1.49 out;
// Claude Haiku 5.5 $0.10 / $0.50 (prompts ≤100K tokens); Claude Sonnet 5.5 $2 / $10.
const NANO: Record<string, { in: number; out: number }> = {
  "gpt-oss-120b": { in: 350, out: 750 },
  "qwen-3.8-27b": { in: 990, out: 1490 },
  "claude-haiku-5-5": { in: 100, out: 500 },
  "claude-sonnet-5-5": { in: 2000, out: 10000 },
};
/** A model missing from the table is charged at the dearest price in it (fail closed). */
const DEAREST = { in: Math.max(...Object.values(NANO).map((p) => p.in)), out: Math.max(...Object.values(NANO).map((p) => p.out)) };

export function costMicroUsd(model: string, inTok: number, outTok: number): number {
  const p = NANO[model] ?? DEAREST;
  return Math.ceil((Math.max(0, inTok) * p.in + Math.max(0, outTok) * p.out) / 1000);
}

const enc = new TextEncoder();

/** Upper bound on prompt tokens for a message list. */
export function inputBound(messages: { content: string }[]): number {
  let bytes = 0;
  for (const m of messages) bytes += enc.encode(m.content).length + 16;
  return Math.ceil(bytes / 2);
}

export function buildEstimate(intentMessages: { content: string }[]): { intent: number; fill: number } {
  return {
    intent: costMicroUsd(INTENT_MODEL, inputBound(intentMessages), INTENT_MAX_OUT),
    fill: costMicroUsd(FILL_MODEL, FILL_MAX_IN, FILL_MAX_OUT),
  };
}

/** The hold for a job: its dearest lane at this call's input bound and output budget. */
export function jobEstimate(job: Job, messages: { content: string }[], maxOut: number): number {
  return Math.max(...ROUTES[job].map((r) => costMicroUsd(r.model, inputBound(messages), maxOut)));
}

/** A repair call reads the fill plus the world rules and writes a patch. */
export const REPAIR_MAX_IN = 20_000;
export const REPAIR_MAX_OUT = 4_000;
