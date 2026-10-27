import { describe, expect, it } from "vitest";
import { settleIntent, type IntentOut } from "../src/prompts";

const intent = (mode: IntentOut["mode"]): IntentOut => ({ lang: "en", mode, genre: "", setting: "", role: "", goal: "", fail: "", mood: "", pack: "outdoor", sub: [], safety: "ok", headline: "", nouns: [], moodVec: { valence: 0, arousal: 0, tension: 0 } });

describe("settleIntent", () => {
  it("a prompt that opens with something to do is a game; a place stays a place", () => {
    expect(settleIntent("Find your way out of a dark cave using glowing mushrooms", intent("wander")).mode).toBe("play");
    expect(settleIntent("A volcano island: carry the sacred stone up to the summit shrine", intent("wander")).mode).toBe("play");
    for (const p of ["A quiet zen garden with a koi pond to walk around", "A cozy coffee shop where you can order a latte", "a bioluminescent forest where you climb to an owl's lookout"]) expect(settleIntent(p, intent("wander")).mode).toBe("wander");
    expect(settleIntent("A night market with food stalls and lanterns", intent("play")).mode).toBe("play"); // never the other way
  });
});
