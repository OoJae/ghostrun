import { describe, expect, it } from "vitest";
import { DEFAULT_LAWS } from "@ghostrun/ir";
import { fillMessages, intentMessages, type IntentOut } from "@ghostrun/llm";
import { PACKS } from "@ghostrun/registry";
import EXAMPLE from "../../../packages/ir/fixtures/ctf-neon.jsonl?raw";
import { buildEstimate, costMicroUsd, FILL_MAX_IN, FILL_MAX_OUT, FILL_MODEL, inputBound, INTENT_MAX_OUT, INTENT_MODEL } from "../src/cost";
import { INTENT } from "./fakes";

describe("cost", () => {
  it("prices tokens exactly (integer micro-USD, rounded up)", () => {
    expect(costMicroUsd(FILL_MODEL, 1_000_000, 0)).toBe(350_000);
    expect(costMicroUsd(FILL_MODEL, 0, 1_000_000)).toBe(750_000);
    expect(costMicroUsd(INTENT_MODEL, 1_000_000, 1_000_000)).toBe(990_000 + 1_490_000);
    expect(costMicroUsd(FILL_MODEL, 3000, 1500)).toBe(1050 + 1125);
    expect(costMicroUsd(INTENT_MODEL, 1, 0)).toBe(1); // 0.99 µ$ rounds up, never down
  });

  it("the fill input bound holds for every pack, the longest prompt and an 800-token intent", () => {
    const prompt = "ű".repeat(500); // 2 UTF-8 bytes per char
    // The whole 800-token intent budget spent on the headline (it is quoted twice), at 6 bytes a token.
    const intent = { ...INTENT, headline: "x".repeat(INTENT_MAX_OUT * 6), sub: ["rooftop"] } as IntentOut;
    for (const p of PACKS) {
      const layout = p.impl.generate({ seed: 7, params: p.impl.defaults, sub: intent.sub, laws: DEFAULT_LAWS, harder: false });
      const bound = inputBound(fillMessages(prompt, intent, layout, EXAMPLE, 7));
      expect(bound, p.id).toBeLessThanOrEqual(FILL_MAX_IN);
    }
  });

  it("a build is reserved at about a cent", () => {
    const est = buildEstimate(intentMessages("a maze with ghosts and a key that opens the exit", PACKS));
    expect(est.fill).toBe(costMicroUsd(FILL_MODEL, FILL_MAX_IN, FILL_MAX_OUT));
    expect(est.intent + est.fill).toBeGreaterThan(5_000);
    expect(est.intent + est.fill).toBeLessThan(15_000);
  });
});
