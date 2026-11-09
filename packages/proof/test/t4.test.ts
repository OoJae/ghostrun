// T4, the route model: a graph of the world's route plays a thousand modelled runs in
// milliseconds, anchored by the world's own expert runs, every number labelled modelled with its
// calibration error and set beside the physics runs it can be checked against. Never played.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { arena } from "@ghostrun/pack-arena";
import { cityBlock } from "@ghostrun/pack-city-block";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { anchorOf, english, FIT, MODEL_RUNS, modelBlock, modelLines, modelRuns, PARAMS, physicsOf, prove, routeOf, screen, t0, t4, type Receipt } from "../src";

const ENGINE = "e".repeat(64);
let R: Rapier;

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

function world(file: string, pack: "city" | "arena"): WorldBundle {
  const text = readFileSync(new URL(`../../ir/fixtures/${file}.jsonl`, import.meta.url), "utf8");
  const seed = (JSON.parse(text.split("\n", 1)[0]!) as { seed?: number }).seed ?? 7;
  const fill = parseFill(text, { seed });
  const at = { seed, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false };
  const layout = pack === "city" ? cityBlock.generate({ ...at, params: cityBlock.defaults }) : arena.generate({ ...at, params: arena.defaults });
  return placeWorld({ ...fill.draft, engine: ENGINE }, layout).bundle;
}

describe("T4 on coin rush (five coins against a clock, a lava pool, a jump pad)", () => {
  let b: WorldBundle;
  let r: Receipt;
  beforeAll(async () => {
    b = world("coin-rush", "arena");
    r = await prove(R, b, { engine: ENGINE, runs: 12, playtest: true, t4: true });
  }, 180_000);

  it("models 1,200 runs at three levels beside the playtest's physics runs, each number with its bench error", () => {
    const m = r.playtest!.model!;
    console.log(["", `coin rush · T4 in ${m.ms} ms`, ...modelBlock(m)].join("\n"));
    expect(m.runs).toBe(3 * MODEL_RUNS);
    expect(m.runs).toBeGreaterThanOrEqual(1000);
    expect(m.levels.map((l) => l.level)).toEqual(["novice", "average", "expert"]);
    for (const l of m.levels) {
      expect(l.p).toBeGreaterThanOrEqual(0);
      expect(l.p).toBeLessThanOrEqual(1);
      expect(l.err).toBe(FIT.win[l.level]);
      expect(l.physics).toEqual({ runs: r.playtest!.levels.find((x) => x.level === l.level)!.runs, won: r.playtest!.levels.find((x) => x.level === l.level)!.won });
    }
    expect(m.times!.err).toBe(FIT.times);
    expect(m.times!.lo).toBeLessThanOrEqual(m.times!.median);
    expect(m.times!.median).toBeLessThanOrEqual(m.times!.hi);
    expect(m.heat.length).toBeGreaterThan(0);
    // a thousand modelled runs well inside two seconds of CPU (the anchors' runs included)
    expect(m.ms).toBeLessThan(2000);
  });

  it("is labelled modelled, never played or verified, and a physics count under 30 stays k of n", () => {
    const m = r.playtest!.model!;
    const lines = modelLines(m, english);
    expect(lines[0]).toMatch(/^Win rate, modelled: novices \d+% ±24 \(physics \d of 6\) · average \d+% ±15 \(physics \d of 6\) · experts \d+% ±4 \(physics \d+ of 12\)$/);
    expect(lines[1]).toMatch(/^Clear times, modelled: median \d:\d\d ±11%/);
    expect(lines[2]).toMatch(/^Most time, modelled: near the .+ \(\d+% ±10\)/);
    for (const l of modelBlock(m)) expect(l).not.toMatch(/\b(played|verified)\b/);
    expect(modelBlock(m)[0]).toMatch(/^~ \[T4\] /);
  });

  it("is deterministic: the same world models the same, to the number", async () => {
    const again = await prove(R, b, { engine: ENGINE, runs: 12, playtest: true, t4: true });
    expect({ ...again.playtest!.model!, ms: 0 }).toEqual({ ...r.playtest!.model!, ms: 0 });
  }, 180_000);

  it("plays 1,200 modelled runs of one level in milliseconds", () => {
    const nav = buildNav(b);
    try {
      const route = routeOf(b, nav, t0(b).chain!)!;
      const t = performance.now();
      const runs = modelRuns(route, "novice", 1200, PARAMS, { scale: 1, risk: 1 }, 1);
      expect(runs).toHaveLength(1200);
      expect(performance.now() - t).toBeLessThan(500);
    } finally {
      nav.destroy();
    }
  });

  it("screens a changed copy on the world's anchors (no physics): a 5 s clock is modelled as lost", () => {
    const nav = buildNav(b);
    try {
      const chain = t0(b).chain!;
      const a = r.playtest!.model!.anchor;
      const same = screen(b, nav, chain, a, 400)!;
      expect(same.levels.expert).toBeGreaterThan(0.5);
      const rushed = structuredClone(b);
      for (const v of rushed.verbs) if (v.verb === "puzzle.timer") v.params = { ...v.params, seconds: 5 };
      const nav2 = buildNav(rushed);
      try {
        const s = screen(rushed, nav2, t0(rushed).chain!, a, 400)!;
        expect(s.levels.expert).toBeLessThan(same.levels.expert);
        expect(s.levels.novice).toBeLessThanOrEqual(same.levels.novice);
      } finally {
        nav2.destroy();
      }
    } finally {
      nav.destroy();
    }
  });

  it("anchors on the experts: their modelled median clear time is physics' (the time scale)", () => {
    const nav = buildNav(b);
    try {
      const route = routeOf(b, nav, t0(b).chain!)!;
      const phys = physicsOf(r, r.playtest!);
      const a = anchorOf(route, PARAMS, phys.expert, b.seed);
      const times = modelRuns({ ...route, timer: 0 }, "expert", 400, PARAMS, { ...a, risk: 0 }, 2).map((x) => x.s).sort((x, y) => x - y);
      const physMedian = [...phys.expert.times].sort((x, y) => x - y)[Math.floor((phys.expert.times.length - 1) / 2)]!;
      expect(Math.abs(times[200]! - physMedian) / physMedian).toBeLessThan(0.1);
    } finally {
      nav.destroy();
    }
  });
});

describe("T4's team fairness on the organizer's CTF brief", () => {
  it("plays red against blue from their spawns (each side's route to the other's flag and home), modelled with its ±", async () => {
    const b = world("ctf-neon", "city");
    const r = await prove(R, b, { engine: ENGINE, runs: 12, playtest: true, t4: true });
    const m = r.playtest!.model!;
    console.log(["", "CTF · T4", ...modelBlock(m)].join("\n"));
    expect(m.teams).not.toBeNull();
    expect(m.teams!.matches).toBe(3 * MODEL_RUNS);
    expect(m.teams!.red).toBeGreaterThanOrEqual(0);
    expect(m.teams!.red).toBeLessThanOrEqual(1);
    expect(modelLines(m).at(-1)).toMatch(/^Red vs blue from the spawns, modelled: red wins \d+% ±\d+ of 1200 modelled matches$/);
  }, 180_000);

  it("has no teams to weigh on a world played alone", async () => {
    const b = world("coin-rush", "arena");
    const r = await prove(R, b, { engine: ENGINE, runs: 6, playtest: true, skillRuns: 2, t4: true });
    expect(r.playtest!.model!.teams).toBeNull();
  }, 180_000);
});
