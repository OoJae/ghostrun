// End to end, one fixture world per medium through the whole proof ladder: runners that fly with a
// jetpack over the sky islands, swim down to the wreck in the lagoon, and float in zero-g to the
// escape pod; and the bugs "try to fool it" plants in each (a goal beyond the jetpack's climb, a
// breath too short for the dive) caught.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { loadNavNode } from "@ghostrun/nav/node";
import { caught, chipLine, plants, prove, type Receipt } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { volume } from "../src";

const ENGINE = "e".repeat(64);
let R: Rapier;

function place(name: string): WorldBundle {
  const text = readFileSync(new URL(`../../../ir/fixtures/${name}.jsonl`, import.meta.url), "utf8");
  const fill = parseFill(text, { seed: 7 });
  expect(fill.stats.invalid).toBe(0);
  const seed = fill.draft.seed;
  const layout = volume.generate({ seed, params: volume.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  const placed = placeWorld({ ...fill.draft, engine: ENGINE }, layout);
  expect(placed.notes.filter((n) => n.includes("not in"))).toEqual([]);
  return placed.bundle;
}

const worlds: Record<string, { b: WorldBundle; r: Receipt }> = {};

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
  for (const name of ["jetpack-islands", "sunken-treasure", "zero-g-escape"]) {
    const b = place(name);
    const r = await prove(R, b, { engine: ENGINE, runs: 12 });
    worlds[name] = { b, r };
    console.log(["", `${name} · spec ${r.spec.slice(0, 8)} · ${r.ms} ms`, ...r.chips.filter((c) => c.tier !== "T2" || c.id.startsWith("T2:fly") || c.id.startsWith("T2:swim") || c.id.startsWith("T2:zero")).map(chipLine), `par: ${JSON.stringify(r.par)}`].join("\n"));
  }
}, 180_000);

const clean = (r: Receipt) => {
  expect(r.chips.filter((c) => c.status === "counterexample").map(chipLine)).toEqual([]);
  expect(r.chips.find((c) => c.id === "T3:win")).toMatchObject({ status: "played", k: 12, n: 12 });
  expect(r.headline?.status).toBe("verified");
};

describe("volume pack fixtures, proved clean with runners that fly or swim", () => {
  it("sky: a jetpack race through the floating islands", () => {
    const { r } = worlds["jetpack-islands"]!;
    clean(r);
    expect(r.chips.find((c) => c.id === "T1:fly")).toMatchObject({ status: "verified" });
    expect(r.chips.find((c) => c.id === "T1:fly")!.text).toMatch(/the longest flight/);
    expect(r.chips.find((c) => c.id === "T2:fly")).toMatchObject({ status: "verified", k: 1 });
  });

  it("water: the sunken treasure, dived for and brought back to the beach", () => {
    const { r } = worlds["sunken-treasure"]!;
    clean(r);
    expect(r.chips.find((c) => c.id === "T1:swim:chest")).toMatchObject({ status: "verified" });
    expect(r.chips.find((c) => c.id.startsWith("T2:swim:"))).toMatchObject({ status: "verified" });
  });

  it("space: a zero-g escape to the pod", () => {
    const { r } = worlds["zero-g-escape"]!;
    clean(r);
    expect(r.chips.find((c) => c.id === "T1:fly")).toMatchObject({ status: "verified" });
    expect(r.chips.find((c) => c.id === "T2:zero_g")).toMatchObject({ status: "verified" });
  });

  it("try to fool it: every planted bug is caught (the goal beyond the thrust budget, a breath too short)", async () => {
    const seen = new Set<string>();
    for (const name of Object.keys(worlds)) {
      const { b, r } = worlds[name]!;
      for (const p of plants(b, r.par?.goldS ?? null)) {
        seen.add(p.id);
        const after = await prove(R, p.bundle, { engine: ENGINE, runs: 12 });
        const c = caught(after);
        expect(c.caught, `${name}: ${p.id} (${p.text})`).toBe(true);
        if (p.id === "goal_beyond_thrust") expect(c.by?.id).toBe("T1:fly");
        if (p.id === "breath_too_short") expect(c.by?.id).toBe("T1:swim:chest");
      }
    }
    expect(seen).toContain("goal_beyond_thrust");
    expect(seen).toContain("breath_too_short");
    // never in zero-g: nothing up there is out of reach
    expect(plants(worlds["zero-g-escape"]!.b, null).map((p) => p.id)).not.toContain("goal_in_the_sky");
  }, 300_000);
});
