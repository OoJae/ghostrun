import { describe, expect, it } from "vitest";
import { DEFAULT_LAWS } from "@ghostrun/ir";
import { BRIEF_MAX_CHARS, fillMessages, intentMessages, visionMessages, type IntentOut } from "@ghostrun/llm";
import { PACKS } from "@ghostrun/registry";
import EXAMPLE from "../../../packages/ir/fixtures/vault-heist.jsonl?raw";
import { buildEstimate, costMicroUsd, FILL_MAX_IN, FILL_MAX_OUT, FILL_MODEL, imageTokens, inputBound, INTENT_MAX_OUT, INTENT_MODEL, VISION_MAX_OUT, VISION_MODEL, visionEstimate } from "../src/cost";
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
      // a Feng Shui prompt brings the Form School's rules with it
      expect(inputBound(fillMessages(`Feng Shui ${prompt.slice(10)}`, intent, layout, EXAMPLE, 7)), `${p.id}, Feng Shui`).toBeLessThanOrEqual(FILL_MAX_IN);
      // and a bribe (or a booking) brings how the act rules fit together
      expect(inputBound(fillMessages(`bribe the guard ${prompt.slice(16)}`, intent, layout, EXAMPLE, 7)), `${p.id}, a bribe`).toBeLessThanOrEqual(FILL_MAX_IN);
    }
  });

  it("a build is reserved at about a cent", () => {
    const est = buildEstimate(intentMessages("a maze with ghosts and a key that opens the exit", PACKS));
    expect(est.fill).toBe(costMicroUsd(FILL_MODEL, FILL_MAX_IN, FILL_MAX_OUT));
    expect(est.intent + est.fill).toBeGreaterThan(5_000);
    expect(est.intent + est.fill).toBeLessThan(15_000);
  });

  it("a picture's brief fits the hold it was given: the longest prompt plus the longest brief, at 3 bytes a character", () => {
    const prompt = "ű".repeat(500) + "語".repeat(BRIEF_MAX_CHARS);
    const intent = { ...INTENT, headline: "x".repeat(INTENT_MAX_OUT * 6), sub: ["rooftop"] } as IntentOut;
    const est = buildEstimate(intentMessages("ű".repeat(500), PACKS), BRIEF_MAX_CHARS);
    expect(est.intent).toBeGreaterThanOrEqual(costMicroUsd(INTENT_MODEL, inputBound(intentMessages(prompt, PACKS)), INTENT_MAX_OUT));
    for (const p of PACKS) {
      const layout = p.impl.generate({ seed: 7, params: p.impl.defaults, sub: intent.sub, laws: DEFAULT_LAWS, harder: false });
      expect(costMicroUsd(FILL_MODEL, inputBound(fillMessages(prompt, intent, layout, EXAMPLE, 7)), FILL_MAX_OUT), p.id).toBeLessThanOrEqual(est.fill);
    }
  });

  it("reading a picture is priced by its area on Haiku, a fraction of the build", () => {
    expect(VISION_MODEL).toBe("claude-haiku-5-5");
    expect(imageTokens(768, 576)).toBe(590); // 442,368 px / 750, rounded up
    expect(imageTokens(1, 1)).toBe(1);
    const msgs = visionMessages("a heist here", { mediaType: "image/webp", data: "" });
    const est = visionEstimate(msgs, 768, 576);
    expect(est).toBe(costMicroUsd("claude-haiku-5-5", inputBound(msgs) + 590, VISION_MAX_OUT));
    expect(visionEstimate(msgs, 1024, 1024)).toBeGreaterThan(est);
    expect(est).toBeLessThan(1_000); // under a tenth of a cent
  });
});
