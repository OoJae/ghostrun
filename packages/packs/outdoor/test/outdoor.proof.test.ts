// End to end: a fill for "a bioluminescent forest where you carry a glowing seed from the grove to
// the camp shrine, a will-o'-wisp haunts the pond, and the owl lookout needs a double jump", placed
// on the outdoor pack and run through the whole proof ladder.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { loadNavNode } from "@ghostrun/nav/node";
import { chipLine, prove, type Receipt } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { outdoor } from "../src";

const fixture = readFileSync(new URL("./fixtures/glow-forest.jsonl", import.meta.url), "utf8");
const ENGINE = "e".repeat(64);
let R: Rapier;
let world: WorldBundle;
let receipt: Receipt;

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
  const fill = parseFill(fixture, { seed: 7 });
  expect(fill.stats.invalid).toBe(0);
  const layout = outdoor.generate({ seed: 7, params: outdoor.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  const placed = placeWorld({ ...fill.draft, engine: ENGINE }, layout);
  expect(placed.notes.filter((n) => n.includes("not in"))).toEqual([]);
  world = placed.bundle;
  receipt = await prove(R, world, { engine: ENGINE, runs: 12 });
  console.log(["", `glow forest · spec ${receipt.spec.slice(0, 8)} · ${receipt.ms} ms`, ...receipt.chips.map(chipLine), `par: ${JSON.stringify(receipt.par)}`].join("\n"));
}, 60_000);

describe("outdoor pack, end to end through the proof ladder", () => {
  it("verifies the headline: the lookout needs a double jump (T1 model and T3 physics witness)", () => {
    expect(receipt.headline).toMatchObject({ expect: "x_lookout", status: "verified" });
    expect(receipt.chips.find((c) => c.id === "T1:x_lookout")?.status).toBe("verified");
    expect(receipt.chips.find((c) => c.id === "T3:x_lookout")?.status).toBe("played");
    expect(receipt.chips.find((c) => c.id === "T1:x_camp")?.status).toBe("verified");
  });

  it("finds the win chain and force-tests every rule", () => {
    expect(receipt.chips.find((c) => c.id === "T0:win_chain")?.status).toBe("verified");
    const t2 = receipt.chips.filter((c) => c.tier === "T2");
    expect(t2).toHaveLength(world.rules.length);
    expect(t2.every((c) => c.status === "verified")).toBe(true);
  });

  it("AI runners win by playing it in physics", () => {
    const win = receipt.chips.find((c) => c.id === "T3:win")!;
    expect(win.status).toBe("played");
    expect(win.k).toBeGreaterThanOrEqual(10); // ≥10 of 12 runners carry the seed to the shrine
    expect(receipt.par!.goldS).toBeGreaterThan(5);
    expect(receipt.chips.filter((c) => c.status === "counterexample")).toEqual([]);
  });
});
