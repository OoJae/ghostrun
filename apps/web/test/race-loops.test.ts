// Every pack can host a race: its loop has ground all the way round and room for a car, on every
// seed the pack is tested on, with the default laws and the ones a race fill usually writes (no
// jumping, which turns a course into a walk).
import { describe, expect, it } from "vitest";
import { DEFAULT_LAWS } from "@ghostrun/ir";
import { raceLoopProblems } from "@ghostrun/layout";
import { PACKS } from "@ghostrun/registry";

const NO_JUMP = { ...DEFAULT_LAWS, jumpsMax: 0, jumpH: 0 };

describe("race loops", () => {
  // (the volume pack is crossed through the air or the water: there is no ground to drive a loop on)
  it.each(PACKS.filter((p) => p.id !== "volume").map((p) => [p.id, p.impl] as const))("%s: a car can drive the race loop on every seed", (_id, pack) => {
    const bad: string[] = [];
    for (const seed of pack.ci.seeds) {
      for (const laws of [DEFAULT_LAWS, NO_JUMP]) {
        const layout = pack.generate({ seed, params: pack.defaults, sub: [], laws, harder: false });
        for (const p of raceLoopProblems(layout)) bad.push(`seed ${seed}${laws === NO_JUMP ? " (no jumps)" : ""}: ${p}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
