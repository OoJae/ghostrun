// What a build costs. Prices are integer nano-USD per token so the ledger never rounds; the
// pre-flight estimate is an upper bound (input at ≤2 UTF-8 bytes per token, output at its max
// token budget), so a commit almost never exceeds its hold.
export const INTENT_MODEL = "qwen-3.8-27b";
export const FILL_MODEL = "gpt-oss-120b";
export const INTENT_MAX_OUT = 800;
export const FILL_MAX_OUT = 6000;
/** Input-token bound for the fill call, which is only known after the intent; test-guarded per pack. */
export const FILL_MAX_IN = 12_000; // raised with the kit vocabulary (12 more verb lines)

type Model = typeof INTENT_MODEL | typeof FILL_MODEL;
// $/M tokens → nano-USD/token: gpt-oss-120b $0.35 in / $0.75 out; qwen-3.8-27b $0.99 in / $1.49 out.
const NANO: Record<Model, { in: number; out: number }> = {
  [FILL_MODEL]: { in: 350, out: 750 },
  [INTENT_MODEL]: { in: 990, out: 1490 },
};

export function costMicroUsd(model: Model, inTok: number, outTok: number): number {
  const p = NANO[model];
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

/** A repair call reads the fill plus the world rules and writes a patch. */
export const REPAIR_MAX_IN = 20_000;
export const REPAIR_MAX_OUT = 4_000;
