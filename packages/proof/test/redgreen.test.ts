import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { cityBlock } from "@ghostrun/pack-city-block";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { ghostAt, pairRuns, partLine, parting, pickFailing, prove, runnerRun, t0, thin, type Ghost, type Receipt } from "../src";

const ctf = readFileSync(new URL("../../ir/fixtures/ctf-neon.jsonl", import.meta.url), "utf8");
const ENGINE = "e".repeat(64);
let R: Rapier;
let world: WorldBundle;
let receipt: Receipt;
/** The CTF brief with red's goal ring 40 m up (as "Try to fool it" plants it): red can't score, so no runner wins. */
let sky: WorldBundle;
let skyReceipt: Receipt;

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
  const fill = parseFill(ctf, { seed: 7 });
  const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  world = placeWorld({ ...fill.draft, engine: ENGINE }, layout).bundle;
  receipt = await prove(R, world, { engine: ENGINE, runs: 12 });
  sky = structuredClone(world);
  const goal = sky.entities.find((e) => e.id === "goal_red")!;
  goal.pos = [goal.pos[0], goal.pos[1] + 40, goal.pos[2]];
  skyReceipt = await prove(R, sky, { engine: ENGINE, runs: 12 });
}, 240_000);

/** A ghost from positions, one sample every 4 ticks. */
const ghostOf = (pts: [number, number, number][]): Ghost => ({ every: 4, ticks: (pts.length - 1) * 4, xyz: pts.flat(), dir: pts.flatMap(() => [0, 0]), prog: pts.map(() => 0) });

describe("the failing run a receipt keeps", () => {
  it("a won world keeps none: its par runner is its ghost", () => {
    expect(receipt.chips.find((c) => c.id === "T3:win")?.status).toBe("played");
    expect(receipt.failRun).toBeUndefined();
    expect(receipt.ghost).toBeDefined();
  });

  it("a world nobody wins keeps one runner's run whole, from the spawn to where it ended", () => {
    const win = skyReceipt.chips.find((c) => c.id === "T3:win")!;
    expect(win.status).toBe("counterexample");
    const f = skyReceipt.failRun!;
    expect(f).toBeDefined();
    const trail = skyReceipt.trails![f.run]!;
    expect(trail.won).toBe(false);
    // the run the receipt describes: its length, and its end as the playtest report says it
    expect(f.ghost.ticks).toBe(trail.ticks);
    expect(trail.falls?.findLast((x) => x.end)).toEqual(f.end);
    const spawn = sky.entities.find((e) => e.kind === "spawn" && e.team === "red")!;
    expect(Math.hypot(f.ghost.xyz[0]! - spawn.pos[0], f.ghost.xyz[2]! - spawn.pos[2])).toBeLessThan(0.5);
    const last = ghostAt(f.ghost, f.ghost.ticks);
    expect(Math.hypot(last[0] - f.end.x, last[2] - f.end.z)).toBeLessThan(1);
    // the ending most runs had (what the receipt says), and small enough to keep with it
    const ends = skyReceipt.trails!.map((t) => t.falls?.findLast((x) => x.end)?.why ?? "");
    expect(ends.filter((w) => w === f.end.why).length).toBe(Math.max(...ends.map((w) => ends.filter((x) => x === w).length)));
    expect(JSON.stringify(f).length).toBeLessThan(60_000);
  });

  it("is exactly that runner's run: played again on its own, it is the same run", () => {
    const f = skyReceipt.failRun!;
    const nav = buildNav(sky);
    const s0 = t0(sky);
    try {
      const again = runnerRun(R, sky, nav, s0.chain!, f.run, "red", s0.openers);
      expect(again.ok).toBe(false);
      expect(again.ghost).toEqual(f.ghost);
      expect(again.end).toEqual(f.end);
    } finally {
      nav.destroy();
    }
  });

  it("the par runner played on its own is the receipt's ghost", () => {
    const run = receipt.trails!.findIndex((t) => t.won && t.ticks === receipt.ghost!.ticks);
    const nav = buildNav(world);
    const s0 = t0(world);
    try {
      const again = runnerRun(R, world, nav, s0.chain!, run, "red", s0.openers);
      expect(again.ok).toBe(true);
      expect(again.ghost).toEqual(receipt.ghost);
    } finally {
      nav.destroy();
    }
  });

  it("picks the commonest ending, then the run that got furthest, then the first", () => {
    expect(pickFailing([{ why: "hit the lava", prog: 9 }, { why: "got stuck", prog: 1 }, { why: "got stuck", prog: 4 }, { why: "got stuck", prog: 4 }])).toBe(2);
    expect(pickFailing([{ why: "b", prog: 0 }, { why: "a", prog: 0 }])).toBe(1);
    expect(pickFailing([{ why: "x", prog: 3 }])).toBe(0);
  });

  it("a long run is thinned to at most so many samples, keeping the start, the end and the ticks", () => {
    const g = ghostOf(Array.from({ length: 5001 }, (_, i) => [i / 10, 0, 0]));
    const t = thin(g, 1801);
    expect(t.prog.length).toBeLessThanOrEqual(1801);
    expect(t.ticks).toBe(g.ticks);
    expect(ghostAt(t, 0)).toEqual([0, 0, 0]);
    expect(ghostAt(t, g.ticks)).toEqual(ghostAt(g, g.ticks));
    expect(ghostAt(t, 4000)[0]).toBeCloseTo(ghostAt(g, 4000)[0], 5);
    expect(thin(g, 6000)).toBe(g);
  });
});

describe("where two runs part", () => {
  const flat = Array.from({ length: 40 }, (_, i): [number, number, number] => [i * 0.3, 0.9, 0]);

  it("the same run either way never parts", () => {
    expect(parting(ghostOf(flat), ghostOf(flat))).toBeNull();
  });

  it("one rising where the other doesn't is a jump, named at the moment they left the ground together", () => {
    const up = flat.map((p, i): [number, number, number] => [p[0], i < 20 ? 0.9 : 0.9 + Math.min(3, (i - 20) * 0.4), 0]);
    const p = parting(ghostOf(up), ghostOf(flat))!;
    expect(p.how).toBe("jump");
    expect(p.tick).toBe(80);
    expect(p.rise[0]).toBeGreaterThan(2.5);
    expect(p.rise[1]).toBe(0);
    expect(p.midair).toBe(false);
    expect(partLine(p, 1)).toBe("They part here: the jump (green rises 3 m, red 0 m)");
  });

  it("one that stops while the other goes on ends there", () => {
    const short = ghostOf(flat.slice(0, 15));
    const p = parting(short, ghostOf(flat))!;
    expect(p.how).toBe("end");
    expect(p.ended).toBe(0);
    expect(partLine(p, 0, "Neon plaza", "got stuck on the way to the glowing orb")).toBe("They part here: the red run ends (got stuck on the way to the glowing orb), near the Neon plaza");
  });

  it("ways that split sideways are a split", () => {
    const side = flat.map((p, i): [number, number, number] => [p[0], 0.9, i < 10 ? 0 : (i - 10) * 0.3]);
    const p = parting(ghostOf(side), ghostOf(flat))!;
    expect(p.how).toBe("way");
    expect(p.tick).toBe(40);
  });
});

describe("red/green pairs from the proof's own runs", () => {
  it("a higher jump flips the rooftop's one-jump witness: it falls short before and lands after", () => {
    const high = structuredClone(world);
    high.laws = { ...high.laws, jumpH: 3.4 };
    const pair = pairRuns(R, world, high, { kind: "jump", expect: "x_roof" })!;
    expect(pair).not.toBeNull();
    expect(pair.ask).toMatchObject({ kind: "jump", jumps: 1, attempt: 0 });
    expect([pair.a.ok, pair.b.ok]).toEqual([false, true]);
    const p = parting(pair.a.ghost, pair.b.ghost)!;
    expect(p.how).toBe("jump");
    expect(p.rise[1]).toBeGreaterThan(p.rise[0] + 1);
  });

  it("the par runner wins before the goal is moved out of reach and fails after", () => {
    const run = receipt.trails!.findIndex((t) => t.won && t.ticks === receipt.ghost!.ticks);
    const pair = pairRuns(R, world, sky, { kind: "win", run })!;
    expect([pair.a.ok, pair.b.ok]).toEqual([true, false]);
    expect(pair.a.ghost).toEqual(receipt.ghost);
    expect(pair.b.ghost.ticks).toBe(skyReceipt.trails![run]!.ticks);
    expect(parting(pair.a.ghost, pair.b.ghost)).not.toBeNull();
  });
});
