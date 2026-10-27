// Worlds the live lane built for prompts nobody tuned on (the committed eval sets), re-proved as
// recorded: each one stands for a class of failure the placer or the runners now handle.
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { splitObjects } from "@ghostrun/ir";
import { loadNavNode } from "@ghostrun/nav/node";
import { prove } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { ENGINE_HASH, worldFromFill } from "../src/pipeline";

const WORLDS = new URL("../../../tools/bench/worlds/", import.meta.url);
const recorded = (set: string, prefix: string) => {
  const dir = new URL(`${set}/`, WORLDS);
  const f = readdirSync(dir).find((x) => x.startsWith(prefix) && x.endsWith(".fill.jsonl"))!;
  const text = readFileSync(new URL(f, dir), "utf8");
  const { intent } = JSON.parse(readFileSync(new URL(f.replace(".fill.jsonl", ".receipt.json"), dir), "utf8")) as { intent: { pack: string; mode: "play" | "wander" } };
  const seed = (JSON.parse(splitObjects(text.split("\n", 1)[0]!)[0]!) as { seed: number }).seed;
  return worldFromFill(text, seed, undefined, intent.pack, intent.mode);
};

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

describe("recorded unseen worlds", () => {
  it.each([
    ["fresh4", "smuggle-the-diamond", "a laser grid in a doorway stands inside the vault, and runners jump it both ways"],
    ["fresh4", "a-wizard-school", "three rules each winning on one ingredient mean all three go in the cauldron"],
    ["fresh4", "a-treehouse-village", "'IF the player is in z_finish' on reaching the bell is dropped as already true"],
    ["fresh3", "a-spy-mission", "a runner holding the kept key puts it down to pick up the documents"],
    ["fresh4", "a-zombie-school", "zombies you lose by touching are walked around, and the exit nothing opens means the locked gym door"],
    ["combat", "a-snowball-fight", "rivals leave balls they can't throw alone, and a ball under a deck is fetched from the floor"],
    ["combat", "a-sumo-ring", "'pushed into out of bounds' means out of the ring"],
    ["combat", "bumper-cars-arena", "a shove lands from behind the car, toward where it must go"],
    ["combat", "dodgeball-arena", "'when blue is hit' means anyone on team blue"],
    ["fresh", "dodgeball-arena", "a hit by a ball red threw scores for red, whatever the rule said"],
    ["fresh3", "a-jungle-temple", "a jump pad a fill put on the lane is landed beside, not on"],
    ["fresh3", "build-up-speed", "a portal on the lane is walked around; putting the key down frees the hands for the trophy at once"],
    ["judges", "a-temple-run", "boulders on the lane are landed clear of and walked round; 'carry_count is 4' counts the idols collected"],
  ])("%s %s: %s", async (set, prefix) => {
    const w = recorded(set, prefix);
    const r = await prove(R, w.bundle, { engine: ENGINE_HASH, runs: 12 });
    expect(r.chips.find((c) => c.id === "T3:win")?.k ?? 0).toBeGreaterThanOrEqual(10);
  }, 180_000);
});
