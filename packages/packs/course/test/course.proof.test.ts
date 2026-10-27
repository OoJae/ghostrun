// End to end: a fill for "a neon parkour time trial: double-jump the opening wall, cross the beams,
// stairs and hops, clear the lava pit, grab time gems, reach the finish arch", placed on the course
// pack and run through the whole proof ladder.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { loadNavNode } from "@ghostrun/nav/node";
import type { PackLayout } from "@ghostrun/plugin-api";
import { chipLine, prove, type Receipt } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { course } from "../src";
import { runCourse } from "./runner";

const fixture = readFileSync(new URL("./fixtures/parkour-time-trial.jsonl", import.meta.url), "utf8");
const ENGINE = "e".repeat(64);
let R: Rapier;
let layout: PackLayout;
let world: WorldBundle;
let receipt: Receipt;

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
  const fill = parseFill(fixture, { seed: 7 });
  expect(fill.stats.invalid).toBe(0);
  layout = course.generate({ seed: 7, params: course.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  // the fixture names its zones after this seed's plan; keep it honest if the plan ever changes
  expect(layout.zones.map((z) => z.tag)).toEqual(["start", "ledge", "beam", "steps", "gaps", "pit", "steps", "finish"]);
  const placed = placeWorld({ ...fill.draft, engine: ENGINE }, layout);
  expect(placed.notes.filter((n) => n.includes("not in"))).toEqual([]);
  world = placed.bundle;
  receipt = await prove(R, world, { engine: ENGINE, runs: 12 });
  console.log(["", `parkour time trial · spec ${receipt.spec.slice(0, 8)} · ${receipt.ms} ms`, ...receipt.chips.map(chipLine), `par: ${JSON.stringify(receipt.par)}`].join("\n"));
}, 60_000);

describe("course pack, end to end through the proof ladder", () => {
  it("verifies the headline: the opening wall needs a double jump (T1 model and T3 physics witness)", () => {
    expect(receipt.headline).toMatchObject({ expect: "x_wall", status: "verified" });
    expect(receipt.chips.find((c) => c.id === "T1:x_wall")?.status).toBe("verified");
    expect(receipt.chips.find((c) => c.id === "T3:x_wall")).toMatchObject({ status: "played", k: 4 });
  });

  it("finds the win chain, force-tests every rule, and T1 reaches the finish", () => {
    expect(receipt.chips.find((c) => c.id === "T0:win_chain")?.status).toBe("verified");
    const t2 = receipt.chips.filter((c) => c.tier === "T2");
    expect(t2).toHaveLength(world.rules.length);
    expect(t2.every((c) => c.status === "verified")).toBe(true);
    expect(receipt.chips.find((c) => c.id === "T1:x_finish")?.status).toBe("verified");
  });

  it("is won in physics by a runner that jumps each hop (this exact world: lava, gems and all)", () => {
    const g = layout.zones.find((z) => z.slot === "finish")!.anchors.goal!;
    const out = runCourse(R, world, [g[0], g[2]]);
    expect(out.result).toBe("win");
    expect(out.ticks / 60).toBeLessThan(60);
  });

  // BLOCKED on packages/proof (lead-owned): T3's runners follow navmesh paths and add at most one
  // jump per plan step (climbOnto the target's surface from flat ground), so no course with gaps
  // can be won by them; the receipt says "no AI runner could win · 0 of 12". The runner above
  // shows the world is winnable; T3 needs hop-by-hop jump links over the T1 surface graph.
  // `it.fails` flips red the day T3 learns to jump gaps, as a reminder to make it a plain `it`.
  it("AI runners win by playing it in physics (T3 hop routes)", () => {
    const win = receipt.chips.find((c) => c.id === "T3:win")!;
    expect(win.status).toBe("played");
    expect(win.k).toBeGreaterThanOrEqual(10);
  });
});
