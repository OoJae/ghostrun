import { beforeAll, describe, expect, it } from "vitest";
import { mergeFill, pinLayout } from "@ghostrun/ir";
import { loadNavNode } from "@ghostrun/nav/node";
import { pairRuns, prove, type Chip, type Receipt, type Trail } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { buildWorld, ENGINE_HASH, worldFromFill } from "../src/pipeline";
import { failingOnly, parRunner, planPair, redGreenOf } from "../src/redgreen";
import { ease, flight, frameAt } from "../src/render/flight";
import type { Box } from "../src/sim/aabb";

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

const chip = (id: string, status: Chip["status"], k = 0, n = 0, method = "physics"): Chip => ({ id, tier: id.startsWith("T1") ? "T1" : "T3", subject: { kind: "property", id }, status, method, n, k, text: id, cx: null, src: "", ms: 0 });
const runs = (won: boolean[], ticks = 600): Trail[] => won.map((w, i) => ({ won: w, xyz: [], ticks: w ? ticks + i * 10 : 7200 }));
const receipt = (chips: Chip[], trails: Trail[] = [], extra: Partial<Receipt> = {}): Receipt => ({ v: 1, spec: "s", engine: "e", host: "node", headline: null, chips, par: null, ms: 0, trails, ...extra });
const ghostOf = (ticks: number) => ({ every: 4, ticks, xyz: [0, 0.9, 0, 1, 0.9, 0], dir: [0, 0, 0, 0], prog: [0, 0] });

describe("which runs red/green plays", () => {
  it("a headline jump claim that broke: its jump witness, green before and red after (the jump model's chip too)", () => {
    const before = receipt([chip("T1:x_roof", "verified"), chip("T3:x_roof", "played", 4, 4, "physics jump witness, 4 attempts per jump count")], [], { headline: { expect: "x_roof", text: "Rooftop lane needs double jump", status: "verified", method: "" } });
    const after = receipt([chip("T1:x_roof", "counterexample"), chip("T3:x_roof", "counterexample", 4, 4, "physics jump witness, 4 attempts per jump count")], [], { headline: { expect: "x_roof", text: "Rooftop lane needs double jump", status: "counterexample", method: "" } });
    expect(planPair(before, after)).toEqual({ ask: { kind: "jump", expect: "x_roof" }, green: "before", chips: ["T3:x_roof", "T1:x_roof"] });
    // and a repair the other way round: red before, green after
    expect(planPair(after, before)?.green).toBe("after");
  });

  it("runners that stop winning: the par runner, if it won before and lost after", () => {
    const before = receipt([chip("T3:win", "played", 4, 4)], runs([true, true, true, true]), { ghost: ghostOf(610) });
    expect(parRunner(before)).toBe(1);
    const after = receipt([chip("T3:win", "counterexample", 0, 4)], runs([false, false, false, false]));
    expect(planPair(before, after)).toEqual({ ask: { kind: "win", run: 1 }, green: "before", chips: ["T3:win"] });
    // a runner that still wins after isn't a red run: the first that won before and lost after is
    const some = receipt([chip("T3:win", "played", 3, 4)], runs([true, false, true, true]));
    expect(planPair(before, some)?.ask).toEqual({ kind: "win", run: 1 });
  });

  it("a repair that makes it winnable: the repaired world's par runner, red before and green after", () => {
    const broken = receipt([chip("T3:win", "counterexample", 0, 4)], runs([false, false, false, false]), { failRun: { run: 3, ghost: ghostOf(7200), end: { x: 1, z: 0, why: "got stuck", end: true } } });
    const fixed = receipt([chip("T3:win", "played", 3, 4)], runs([false, true, true, true]), { ghost: ghostOf(620) });
    expect(planPair(broken, fixed)).toEqual({ ask: { kind: "win", run: 2 }, green: "after", chips: ["T3:win"] });
    // alone, the failing run says which runner it is and where it fails
    expect(failingOnly(broken.failRun!, 4).caption.before).toBe("Red: AI runner 4 of 4, where it fails (got stuck, at 2:00)");
  });

  it("nothing moved between holding and failing: nothing to pair", () => {
    const a = receipt([chip("T3:win", "played", 4, 4)], runs([true, true, true, true]));
    expect(planPair(a, a)).toBeNull();
  });

  it("'super high jumps' on the CTF brief: the same one-jump attempt falls short before and lands on the roof after, and the caption says where they part", async () => {
    const world = buildWorld("", "ctf");
    const { text } = mergeFill(pinLayout(world.fill), '{"op":"law","player":{"jumpsMax":2,"jumpH":3.4}}', { edit: true });
    const high = worldFromFill(text, world.seed, undefined, world.bundle.pack.id, world.bundle.mode);
    const [a, b] = await Promise.all([prove(R, world.bundle, { engine: ENGINE_HASH, runs: 4 }), prove(R, high.bundle, { engine: ENGINE_HASH, runs: 4 })]);
    const plan = planPair(a, b)!;
    expect(plan.ask).toEqual({ kind: "jump", expect: "x_roof" });
    const pair = pairRuns(R, world.bundle, high.bundle, plan.ask)!;
    const rg = redGreenOf(pair, plan, high.bundle)!;
    expect(rg.caption.before).toBe("Green: before the change · red: after it · the same AI runner, the same seed");
    expect(rg.caption.parted).toMatch(/^They part here: the jump(, near the [\w ]+)? \(green rises 1\.\d m, red [23]\.\d m\)$/);
    expect(rg.parting!.how).toBe("jump");
  }, 180_000);
});

describe("the Host's flight", () => {
  const wall: Box = { min: [4, 0, -10], max: [5, 6, 10] };

  it("eases in and out", () => {
    expect([ease(0), ease(0.5), ease(1)]).toEqual([0, 0.5, 1]);
    expect(ease(0.1)).toBeLessThan(0.1);
    expect(ease(0.9)).toBeGreaterThan(0.9);
  });

  it("frames a place from the side the camera came from, clear of the walls", () => {
    const f = frameAt([0, 0, 0], [-20, 3, 0], []);
    expect(f.look).toEqual([0, 0.9, 0]);
    expect(f.pos[0]).toBeLessThan(-5); // back the way it came
    expect(f.pos[1]).toBeGreaterThan(4);
    // a wall right behind the place: the view comes from another side
    const g = frameAt([3, 0, 0], [12, 3, 0], [wall]);
    expect(g.pos[0]).toBeLessThan(4);
  });

  it("rises over a wall between where it is and where it goes, and flies straight when nothing is in the way", () => {
    const a = { pos: [10, 3, 0] as [number, number, number], look: [0, 0, 0] as [number, number, number] };
    const b = { pos: [-10, 3, 0] as [number, number, number], look: [0, 0, 0] as [number, number, number] };
    const over = flight(a, b, [{ min: [-1, 0, -10], max: [1, 8, 10] }]);
    expect(over(0).pos).toEqual(a.pos);
    expect(over(1).pos).toEqual(b.pos);
    expect(over(0.5).pos[1]).toBeGreaterThan(8);
    expect(flight(a, b, [])(0.5).pos[1]).toBeCloseTo(3, 5);
  });
});
