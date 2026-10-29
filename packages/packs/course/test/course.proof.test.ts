// End to end: a fill for "a neon parkour time trial: double-jump the opening wall, cross the beams,
// stairs and hops, clear the lava pit, grab time gems, reach the finish arch", placed on the course
// pack and run through the whole proof ladder.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type Laws, type WorldBundle } from "@ghostrun/ir";
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
let draft: ReturnType<typeof parseFill>["draft"];

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
  const fill = parseFill(fixture, { seed: 7 });
  expect(fill.stats.invalid).toBe(0);
  layout = course.generate({ seed: 7, params: course.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  // the fixture names its zones after this seed's plan; keep it honest if the plan ever changes
  expect(layout.zones.map((z) => z.tag)).toEqual(["start", "ledge", "beam", "steps", "gaps", "pit", "steps", "finish"]);
  draft = fill.draft;
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

  it("AI runners win by playing it in physics (T3 hop routes)", () => {
    const win = receipt.chips.find((c) => c.id === "T3:win")!;
    expect(win.status).toBe("played");
    expect(win.k).toBeGreaterThanOrEqual(10);
  });

  // an edit changes the laws in the same geometry (the layout stays fitted to the original laws)
  it("edited laws: runners still climb with 4 m jumps; with one jump the counterexample names the step", async () => {
    const relaw = (laws: Partial<Laws>) => placeWorld({ ...draft, laws: { ...draft.laws, ...laws }, engine: ENGINE }, layout).bundle;
    const high = await prove(R, relaw({ jumpH: 4 }), { engine: ENGINE, runs: 4 });
    expect(high.chips.find((c) => c.id === "T3:win")!.k).toBeGreaterThan(0);
    // (the placer would allow the jump the finish takes again; the proof is asked about one jump as edited)
    const one = await prove(R, { ...relaw({}), laws: { ...draft.laws, jumpsMax: 1 } }, { engine: ENGINE, runs: 2 });
    expect(one.chips.find((c) => c.id === "T3:win")!.cx!.text).toMatch(/no route reaches the finish arch: a 2\.3 m step on the way, and 1 jump reaches 1\.5 m$/);
  }, 120_000);
});

// A live fill (gpt-oss-120b, "collect 10 crystals in a glowing cave before the timer runs out,
// avoid the lava"): the world the runners used to lose every time.
describe("a live crystal cave on the course pack", () => {
  it("lava with no pit of its own lies below the walkway, and runners collect all ten crystals, beams included", async () => {
    const text = readFileSync(new URL("./fixtures/crystal-cave-live.jsonl", import.meta.url), "utf8");
    const seed = (JSON.parse(text.split("\n", 1)[0]!) as { seed: number }).seed;
    const fill = parseFill(text, { seed });
    const lay = course.generate({ seed, params: course.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    const placed = placeWorld({ ...fill.draft, engine: ENGINE }, lay);
    expect(placed.notes).toContain("lava_1: anchor 'pit_2' not in slot 'seg_2', laid on the floor below the walkway");
    const r = await prove(R, placed.bundle, { engine: ENGINE, runs: 4 });
    const win = r.chips.find((c) => c.id === "T3:win")!;
    expect(win.status).toBe("played");
    expect(win.k).toBeGreaterThanOrEqual(3);
  }, 120_000);
});
