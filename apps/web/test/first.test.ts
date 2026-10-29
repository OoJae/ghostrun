// The first ten seconds' pure parts: the honest substitution notes, and what a world's mood
// sounds like (the music's key, mode and tempo).
import { describe, expect, it } from "vitest";
import gallery from "../src/gallery/index.json";
import { scoreFor } from "../src/audio/music";
import { substitution } from "../src/substitutions";

const world = (...verbs: string[]) => ({ verbs: verbs.map((verb) => ({ id: `vb_${verb}`, src: "ai" as const, layer: "gameplay" as const, verb, on: "x", params: {}, signature: false })) });

describe("substitution notes", () => {
  it("says plainly what a world does instead of a mechanic no kit has yet", () => {
    expect(substitution("Drive a race car through a neon city", world())).toBe("No vehicles yet: you race on foot");
    expect(substitution("Bumper cars at the fair", world("combat_sport.shove"))).toBe("No vehicles yet: you play it on foot");
    expect(substitution("Fly through the clouds to the sky castle", world())).toBe("No flying yet: you get up high by jumping");
    expect(substitution("Swim with the dolphins in a coral reef", world())).toBe("No swimming yet: water is scenery, you stay on foot");
    expect(substitution("A wizard duel: cast spells until one falls", world("combat_sport.throw"))).toBe("No shooting yet: you throw instead");
    expect(substitution("Laser tag in an abandoned mall", world())).toBe("No shooting yet: you win by moving and using things");
  });

  it("goes quiet once the world has the verb (checked by id, so a new kit verb needs no edit here)", () => {
    expect(substitution("A wizard duel: cast spells until one falls", world("combat_sport.shoot"))).toBeNull();
    expect(substitution("Drive a race car through a neon city", world("vehicle.drive"))).toBeNull();
  });

  it("leaves prompts that don't ask for one alone (a basketball shot is a throw)", () => {
    for (const p of ["Basketball: shoot five hoops before the buzzer", "Penalty shootout: score three goals past the keeper", "Smuggle the diamond past the laser grid in the museum", "Create a capture-the-flag game in a neon city. Add double jump. Score when the orb reaches the goal."]) {
      expect(substitution(p, world("combat_sport.throw")), p).toBeNull();
    }
  });

  it("flags only the gallery prompts that really ask for something missing", () => {
    const flagged = (gallery as { prompt: string }[]).filter((g) => substitution(g.prompt, world())).map((g) => g.prompt);
    expect(flagged).toEqual([]);
  });
});

describe("the music follows the mood", () => {
  it("a sunny grove is bright and major; a tense museum at night is darker and minor-ish", () => {
    const beach = scoreFor({ mood: [0.6, 0.3, 0.4], timeOfDay: 12, look: "grove", night: false });
    const vault = scoreFor({ mood: [0.2, 0.6, 0.8], timeOfDay: 23, look: "gallery", night: true });
    expect(["lydian", "ionian"]).toContain(beach.key.mode);
    expect(["dorian", "aeolian", "phrygian"]).toContain(vault.key.mode);
    expect(beach.bright).toBeGreaterThan(vault.bright);
    expect(vault.bpm).toBeGreaterThan(beach.bpm); // more arousal, more tension: faster
  });

  it("keeps the tempo in a calm range at the extremes", () => {
    for (const a of [-1, 0, 1]) {
      const s = scoreFor({ mood: [0, a, 1], timeOfDay: 0, look: "neon", night: true });
      expect(s.bpm).toBeGreaterThanOrEqual(60);
      expect(s.bpm).toBeLessThanOrEqual(110);
    }
  });
});
