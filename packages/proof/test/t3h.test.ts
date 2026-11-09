// T3h, the player's controls and camera: the experts' plan through a player's keys and the
// client's camera rig. A world with nothing in the way is flagged nowhere; each planted trap a
// human controller falls into is caught where it is (a low ceiling the camera ends up inside, a
// narrow gap that snags the capsule, a corner where the keys stall), and the experts still win
// every planted world (T3 alone says nothing is wrong with any of them).
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type Vec3, type WorldBundle } from "@ghostrun/ir";
import { arena } from "@ghostrun/pack-arena";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import type { Rapier } from "@ghostrun/sim";
import { aimPush, boomLength, CAM, q8, stickToWorld } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { chipLine, comparable, prove, t3hChips, witnesses, witnessKey, t0, type Chip, type HumanReport } from "../src";

const ENGINE = "e".repeat(64);
let R: Rapier;

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

/** Reach the far end: the spawn in the west, a goal ring on the east base, nothing planted in the way. */
const FILL = [
  { op: "meta", mode: "play", lang: "en", pack: "arena", sub: [], seed: 5, look: "neon", mood: [0.5, 0.5, 0.2], timeOfDay: 14, weather: "clear" },
  { op: "zone", id: "z_west", slot: "west_half", tag: "base", name: "West end" },
  { op: "zone", id: "z_east", slot: "east_half", tag: "base", name: "East end" },
  { op: "spawn", id: "sp_red", zone: "z_west", anchor: "spawn_pad", team: "red" },
  { op: "goal", id: "goal_e", zone: "z_east", anchor: "goal_ring", noun: "finish ring", hyper: "ring", team: "" },
  { op: "rule", id: "r_win", when: { t: "enter", a: "player", b: "goal_e" }, then: [{ e: "win", target: "player" }], once: true },
  { op: "expect", id: "x_win", prop: "win_reachable", a: "sp_red", b: "z_east", headline: true, text: "Reach the finish ring" },
  { op: "end", layer: "gameplay" },
  { op: "end", layer: "cosmetic" },
]
  .map((x) => JSON.stringify(x))
  .join("\n");

function base(): WorldBundle {
  const fill = parseFill(FILL, { seed: 5 });
  const layout = arena.generate({ seed: 5, params: arena.defaults, sub: [], laws: fill.draft.laws, harder: false });
  return placeWorld({ ...fill.draft, engine: ENGINE }, layout).bundle;
}

/** Halfway along the experts' way (the spawn to the ring), the way's direction there, and the floor's height. */
const frames = new WeakMap<WorldBundle, { p: Vec3; u: [number, number]; n: [number, number] }>();
function midway(b: WorldBundle): { p: Vec3; u: [number, number]; n: [number, number] } {
  const known = frames.get(b);
  if (known) return known;
  const nav = buildNav(b);
  try {
    const sp = b.entities.find((e) => e.kind === "spawn")!.pos;
    const g = b.entities.find((e) => e.id === "goal_e")!.pos;
    expect(nav.path(sp, g)).not.toBeNull();
    const l = Math.hypot(g[0] - sp[0], g[2] - sp[2]);
    const u: [number, number] = [(g[0] - sp[0]) / l, (g[2] - sp[2]) / l];
    const f = { p: [(sp[0] + g[0]) / 2, sp[1], (sp[2] + g[2]) / 2] as Vec3, u, n: [-u[1], u[0]] as [number, number] };
    frames.set(b, f);
    return f;
  } finally {
    nav.destroy();
  }
}

/** Plant a box (`fwd` along the way from midway, `side` across it, `y` over the floor; each a [from, to] span). */
function plant(b: WorldBundle, id: string, fwd: [number, number], side: [number, number], y: [number, number], surf: "wall" | "roof" = "wall") {
  const { p, u, n } = midway(b);
  const [f, s] = [(fwd[0] + fwd[1]) / 2, (side[0] + side[1]) / 2];
  const [lf, ls] = [fwd[1] - fwd[0], side[1] - side[0]];
  const pos: Vec3 = [p[0] + u[0] * f + n[0] * s, p[1] + (y[0] + y[1]) / 2, p[2] + u[1] * f + n[1] * s];
  const size: Vec3 = [Math.abs(u[0]) * lf + Math.abs(n[0]) * ls, y[1] - y[0], Math.abs(u[1]) * lf + Math.abs(n[1]) * ls];
  b.statics.push({ id, src: "template", layer: "gameplay", zone: b.statics.find((x) => x.surf === "floor")!.zone, shape: "box", pos, rotY: 0, size, surf } as WorldBundle["statics"][number]);
}

async function t3h(b: WorldBundle): Promise<{ chips: Chip[]; won: number; t3: Chip[] }> {
  const r = await prove(R, b, { engine: ENGINE, runs: 6, playtest: true, skillRuns: 1, t3h: true });
  return { chips: r.playtest?.human ?? [], won: r.chips.find((c) => c.id === "T3:win")?.k ?? 0, t3: r.chips.filter((c) => c.tier === "T3") };
}
const flagged = (cs: Chip[]) => cs.filter((c) => c.status === "counterexample").map((c) => c.id);

describe("the controller and camera rig the client runs (@ghostrun/sim rig.ts)", () => {
  it("turns keys by the camera yaw exactly as the client always did, and pulls the camera in front of walls", () => {
    // the client's former arithmetic, inline in RapierSim: x = mx·c − my·s, z = −mx·s − my·c, cut to 1
    for (const yaw of [0, 0.7, -2.1, 3.0]) {
      const [s, c] = [Math.sin(yaw), Math.cos(yaw)];
      for (const [mx, my] of [[0, 1], [1, 1], [-1, 0], [1, -1]] as const) {
        let x = mx * c - my * s;
        let z = -mx * s - my * c;
        const len = Math.sqrt(x * x + z * z);
        if (len > 1) ((x /= len), (z /= len));
        expect(stickToWorld(mx, my, s, c)).toEqual([x, z]);
        expect([q8(x), q8(z)]).toEqual(stickToWorld(mx, my, s, c).map(q8));
      }
      expect(aimPush(s, c)).toEqual([-Math.sin(yaw) * 0.2, -Math.cos(yaw) * 0.2]);
    }
    // a wall 2 m behind the look point: the camera stops 0.25 m in front of it; one 0.3 m behind: 0.8 m (inside it)
    const wall = (d: number) => [{ min: [-5, -5, d] as [number, number, number], max: [5, 5, d + 1] as [number, number, number] }];
    expect(boomLength([0, 0, 0], [0, 0, 1], CAM.DIST, wall(2))).toBeCloseTo(1.75);
    expect(boomLength([0, 0, 0], [0, 0, 1], CAM.DIST, wall(0.3))).toBe(CAM.MIN_PULL);
    expect(boomLength([0, 0, 0], [0, 0, 1], CAM.DIST, [])).toBe(CAM.DIST);
  });
});

describe("T3h on a world with nothing in the way", () => {
  it("drives the keys and the camera along the experts' way, and flags nothing", async () => {
    const b = base();
    expect(t0(b).chain).not.toBeNull();
    const { chips, won } = await t3h(b);
    console.log(["", "T3h, nothing planted:", ...chips.map(chipLine)].join("\n"));
    expect(won).toBe(6);
    expect(chips.map((c) => [c.id, c.status, c.k, c.n])).toEqual([
      ["T3h:camera", "played", 6, 6],
      ["T3h:stall", "played", 6, 6],
      ["T3h:trap", "played", 6, 6],
    ]);
    expect(chips[0]!.method).toBe("physics, 6 runs through the player's keys and camera (noisy synthetic input on the experts' routes)");
  }, 120_000);

  it("runs as witnesses a cloud shard can play (keyed, after the playtest's), and the comparison leaves its timings out", async () => {
    const b = base();
    const ws = witnesses(b, t0(b).chain, 2, "red", 1, 6);
    const human = ws.filter((w) => w.kind === "human");
    expect(human.map(witnessKey)).toEqual(Array.from({ length: 6 }, (_, i) => `human:${b.seed * 1000 + 900 + i}:red`));
    const r = await prove(R, b, { engine: ENGINE, runs: 2, playtest: true, skillRuns: 1, t3h: true, t4: true });
    const slow = { ...r, playtest: { ...r.playtest!, human: r.playtest!.human!.map((c) => ({ ...c, ms: c.ms + 999 })), model: { ...r.playtest!.model!, ms: 999 } } };
    expect(comparable(slow)).toEqual(comparable(r));
  }, 120_000);
});

describe("T3h catches what a human controller hits (and T3's experts still win every one)", () => {
  it("a low ceiling over the way: the camera ends up inside it", async () => {
    const b = base();
    // a slab 2.05 m over the floor (the 1.8 m capsule passes under it), 8 m along the way, 6 m across
    plant(b, "low_ceiling", [-4, 4], [-3, 3], [2.05, 2.55], "roof");
    const { chips, won, t3 } = await t3h(b);
    console.log(["", "T3h, a low ceiling:", ...t3.map(chipLine), ...chips.map(chipLine)].join("\n"));
    expect(won).toBeGreaterThanOrEqual(5);
    expect(t3.filter((c) => c.status === "counterexample")).toEqual([]);
    expect(flagged(chips)).toContain("T3h:camera");
    expect(chips.find((c) => c.id === "T3h:camera")!.cx!.text).toMatch(/^the camera sat inside the ceiling for [\d.]+ s/);
  }, 120_000);

  it("a narrow gap that snags the capsule: a slit the navmesh goes through (it keeps 0.3 m off walls) that the 0.7 m capsule can't", async () => {
    const b = base();
    // a 1.35 m wall right across the arena (over the hop a player makes at once, under a full jump), a 0.66 m slit on the way
    plant(b, "wall_l", [-0.15, 0.15], [-15, -0.33], [0, 1.35]);
    plant(b, "wall_r", [-0.15, 0.15], [0.33, 15], [0, 1.35]);
    const { chips, won, t3 } = await t3h(b);
    console.log(["", "T3h, a narrow gap:", ...t3.map(chipLine), ...chips.map(chipLine)].join("\n"));
    expect(won).toBeGreaterThanOrEqual(5);
    expect(t3.filter((c) => c.status === "counterexample")).toEqual([]);
    expect(flagged(chips)).toContain("T3h:stall");
    expect(chips.find((c) => c.id === "T3h:stall")!.cx!.text).toMatch(/^stuck [\d.]+ s with the keys held near the West end, stepping aside and back \(\d of 6 runs/);
  }, 120_000);

  it("a corner where the keys stall: beside the slit, a wall along the way makes an inside corner a player looking for the way past is pinned in", async () => {
    const b = base();
    plant(b, "wall_l", [-0.15, 0.15], [-15, -0.33], [0, 1.35]);
    plant(b, "wall_r", [-0.15, 0.15], [0.33, 15], [0, 1.35]);
    // a wall along the way, 3.8 m to one side of the slit: the corner it makes with the cross wall
    plant(b, "along", [-2, -0.15], [3.83, 4.13], [0, 1.35]);
    const { chips, won, t3 } = await t3h(b);
    console.log(["", "T3h, a corner:", ...t3.map(chipLine), ...chips.map(chipLine)].join("\n"));
    expect(won).toBeGreaterThanOrEqual(5);
    expect(t3.filter((c) => c.status === "counterexample")).toEqual([]);
    expect(flagged(chips)).toContain("T3h:stall");
    // pinned in the corner, not at the slit (where the experts stall too, before hopping the wall)
    const where = chips.find((c) => c.id === "T3h:stall")!.cx!.where!;
    const { p, n } = midway(b);
    expect((where[0] - p[0]) * n[0] + (where[2] - p[2]) * n[1]).toBeGreaterThan(2);
  }, 120_000);
});

describe("T3h's chips from the runs' reports", () => {
  const clean: HumanReport = { cam: [], camIn: [], stalls: [], foot: 600, ticks: 600 };
  const b = base();
  const six = (...rs: HumanReport[]) => [...rs, ...Array(6 - rs.length).fill(clean)];

  it("count a place once it repeats in 3 runs, report the worst and how many runs hit it, and leave out where the experts stall too", () => {
    const stuck: HumanReport = { ...clean, stalls: [-2, 3.5, 56, 0] };
    const cs = t3hChips(b, six(stuck, stuck, stuck), []);
    expect(cs.map((c) => [c.id, c.status, c.k, c.n])).toEqual([
      ["T3h:camera", "played", 6, 6],
      ["T3h:stall", "counterexample", 3, 6],
      ["T3h:trap", "played", 6, 6],
    ]);
    expect(cs[1]!.cx).toMatchObject({ have: 0.9, need: 0.5, unit: "s" });
    expect(cs[1]!.cx!.text).toMatch(/^stuck 0.9 s with the keys held near .*, stepping aside and back \(3 of 6 runs; the experts' runners walk on\)$/);
    // twice in six runs is not yet a place that counts
    expect(t3hChips(b, six(stuck, stuck), [])[1]!.status).toBe("played");
    // the experts stall there too: the plan's (or the level's), not the controls'
    expect(t3hChips(b, six(stuck, stuck, stuck), [-2, 2.5, 140, 0])[1]!.status).toBe("played");
    // half a second exactly is not over half a second
    const half: HumanReport = { ...clean, stalls: [0, 0, 30, 0] };
    expect(t3hChips(b, six(half, half, half), [])[1]!.status).toBe("played");
  });

  it("call it a trap when the stalls at one place add up to 3 s, or the run ends stuck there", () => {
    const pinned: HumanReport = { ...clean, stalls: [5, 1, 70, 0, 5.5, 1.2, 70, 0, 6, 1, 60, 0] };
    const ended: HumanReport = { ...clean, stalls: [5, 1, 61, 1] };
    const cs = t3hChips(b, six(pinned, ended, ended), []);
    expect(cs.find((c) => c.id === "T3h:trap")).toMatchObject({ status: "counterexample", k: 3, n: 6 });
    expect(cs.find((c) => c.id === "T3h:trap")!.cx!.text).toMatch(/^the capsule stuck fast near .* for 3.3 s of trying every way out \(3 of 6 runs; the experts' runners get through\)$/);
    expect(cs.find((c) => c.id === "T3h:stall")!.status).toBe("played");
  });

  it("flag the camera only inside something for over half a second, and say what it was", () => {
    const inside: HumanReport = { ...clean, cam: [1, 2, 45], camIn: ["ceiling"] };
    const cs = t3hChips(b, six(inside, inside, inside), []);
    expect(cs[0]).toMatchObject({ id: "T3h:camera", status: "counterexample", k: 3, n: 6 });
    expect(cs[0]!.cx!.text).toMatch(/^the camera sat inside the ceiling for 0.8 s/);
  });
});
