// The playtest: novice and average runners after the proof's own experts, the difficulty band from
// all three levels, and what every run revealed (the heat map, where runs went wrong, the fights,
// the pacing). The experts' receipt must come out first and exactly as it is without them.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { arena } from "@ghostrun/pack-arena";
import { cityBlock } from "@ghostrun/pack-city-block";
import { floorPlan } from "@ghostrun/pack-floor-plan";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { bandLine, bandOf, clock, failLine, fraction, paceLine, prove, reportLines, revealed, skillRuns, t0, timesLine, type Receipt } from "../src";

const ENGINE = "e".repeat(64);
let R: Rapier;

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

function world(file: string, pack: "city" | "arena" | "floor"): WorldBundle {
  const text = readFileSync(new URL(`../../ir/fixtures/${file}.jsonl`, import.meta.url), "utf8");
  const seed = (JSON.parse(text.split("\n", 1)[0]!) as { seed?: number }).seed ?? 7;
  const fill = parseFill(text, { seed });
  const at = { seed, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false };
  const layout = pack === "city" ? cityBlock.generate({ ...at, params: cityBlock.defaults }) : pack === "arena" ? arena.generate({ ...at, params: arena.defaults }) : floorPlan.generate({ ...at, params: floorPlan.defaults });
  return placeWorld({ ...fill.draft, engine: ENGINE }, layout).bundle;
}

/** A receipt without its timings (they are the only thing allowed to differ between two proofs). */
const still = (r: Receipt) => ({ ...r, ms: 0, chips: r.chips.map((c) => ({ ...c, ms: 0 })), playtest: undefined });

describe("the playtest on the organizer's CTF brief", () => {
  it("leaves the proof's own runners exactly as they were, hands the receipt over first, then bands the world", async () => {
    const b = world("ctf-neon", "city");
    const plain = await prove(R, b, { engine: ENGINE, runs: 12 });
    let first: Receipt | null = null;
    const full = await prove(R, b, { engine: ENGINE, runs: 12, playtest: true, onReceipt: (r) => void (first = r) });
    // the receipt handed over before the playtest is today's, to the chip, the par and the ghost
    expect(first).not.toBeNull();
    expect(first!.playtest).toBeUndefined();
    expect(still(first!)).toEqual(still(plain));
    expect(still(full)).toEqual(still(plain));
    const pt = full.playtest!;
    console.log(["", `CTF playtest · receipt ${full.ms} ms, playtest ${pt.ms} ms more`, ...reportLines(b, full)].join("\n"));
    expect(pt.levels.map((l) => [l.level, l.runs])).toEqual([["novice", 6], ["average", 6], ["expert", 12]]);
    expect(pt.levels.at(-1)!.won).toBe(full.chips.find((c) => c.id === "T3:win")!.k);
    expect(pt.trails.map((t) => t.level)).toEqual([...Array(6).fill("novice"), ...Array(6).fill("average")]);
    // the bots beat the slower hands some of the time: the CTF is no walk-over for a novice
    expect(["Normal", "Hard", "Expert only"]).toContain(pt.band);
    expect(pt.steps).toEqual(["glowing orb", "neon goal ring"]);
    const rv = revealed(b, full)!;
    expect(rv.runs).toBe(24);
    expect(rv.pace[0]).toMatchObject({ step: "glowing orb" });
    expect(rv.pace.at(-1)).toMatchObject({ step: "won" });
    // the heat map is normalised to the busiest cell, drawn on the ground each cell stood on
    const w = rv.heat.cells.filter((_, i) => i % 4 === 3);
    expect(Math.max(...w)).toBe(1);
    expect(w.every((x) => x > 0 && x <= 1)).toBe(true);
    // runs that didn't win say where and why, in the causal log's words
    expect(rv.fails.length).toBeGreaterThan(0);
    expect(rv.fails[0]!.why[0]![0]).toMatch(/blue reached 3|no win in|got stuck/);
  }, 180_000);
});

describe("the playtest's runners", () => {
  it("are seeded: the same world plays the same at every level, run for run", async () => {
    const b = world("coin-rush", "arena");
    const nav = buildNav(b);
    try {
      const s0 = t0(b);
      const a = skillRuns(R, b, nav, s0.chain!, "novice", 3, "red", s0.openers);
      const c = skillRuns(R, b, nav, s0.chain!, "novice", 3, "red", s0.openers);
      expect(c).toEqual(a);
      // and a novice is not an expert: slower to the last coin
      const experts = (await prove(R, b, { engine: ENGINE, runs: 3 })).trails!;
      const fastest = (ts: { ticks?: number; won: boolean }[]) => ts.filter((t) => t.won).map((t) => t.ticks!).sort((x, y) => x - y)[0] ?? Infinity;
      expect(fastest(a)).toBeGreaterThan(fastest(experts));
    } finally {
      nav.destroy();
    }
  }, 120_000);

  it("a zombie horde: fights by place, knock-outs where runs went wrong, the band from the win rates", async () => {
    const b = world("zombie-survival", "arena");
    const r = await prove(R, b, { engine: ENGINE, runs: 12, playtest: true });
    console.log(["", "zombie horde playtest", ...reportLines(b, r)].join("\n"));
    const rv = revealed(b, r)!;
    expect(rv.fights!.hits).toBeGreaterThan(0);
    expect(rv.fights!.kos).toBeGreaterThan(0);
    expect(rv.fights!.spots[0]!.near).not.toBe("");
    // a novice's shots go wide: the horde gets to some of them
    expect(r.playtest!.levels[0]!.won).toBeLessThan(6);
    expect(rv.fails.some((f) => f.why.some(([w]) => w.startsWith("knocked out")))).toBe(true);
    expect(r.playtest!.band).toBe(bandOf(r.playtest!.levels));
  }, 180_000);

  it("a win over before it starts (a heist that needs nothing) is very easy, and the band says why", async () => {
    const b = world("heist-live-1", "floor");
    const r = await prove(R, b, { engine: ENGINE, runs: 4, playtest: true });
    expect(r.chips.find((c) => c.id === "T3:too_easy")?.status).toBe("counterexample");
    expect(r.playtest!.band).toBe("Very easy");
    expect(bandLine(r.playtest!, r)).toMatch(/^Very easy \(won in [\d.]+ s: over almost before it starts\): novices \d of 6/);
  }, 120_000);
});

describe("the band and its labels", () => {
  const lv = (n: number, a: number, e = 12) => [{ level: "novice" as const, runs: 6, won: n }, { level: "average" as const, runs: 6, won: a }, { level: "expert" as const, runs: 12, won: e }];
  it("goes from very easy to expert only by how far down the levels a win reaches", () => {
    expect(bandOf(lv(6, 6))).toBe("Very easy");
    expect(bandOf(lv(5, 6))).toBe("Very easy");
    expect(bandOf(lv(3, 6))).toBe("Easy");
    expect(bandOf(lv(2, 5))).toBe("Normal");
    expect(bandOf(lv(0, 3))).toBe("Normal");
    expect(bandOf(lv(1, 2))).toBe("Hard");
    expect(bandOf(lv(0, 0))).toBe("Expert only");
    expect(bandOf(lv(0, 0, 0))).toBe("Unbeaten");
    expect(bandOf(lv(0, 0), true)).toBe("Very easy"); // the too-easy flag wins
  });

  it("prints k of n below 30 trials (never a percentage), and clock times", () => {
    const line = bandLine({ levels: lv(2, 5), band: "Normal", trails: [], steps: [], ms: 0 });
    expect(line).toBe("Normal: novices 2 of 6 · average 5 of 6 · experts 12 of 12  (physics, 24 AI runners at 3 skill levels)");
    expect(line).not.toMatch(/%/);
    expect(fraction(19, 24)).toBe("19 of 24");
    expect(clock(7.4)).toBe("0:07");
    expect(clock(102)).toBe("1:42");
    expect(timesLine({ median: 31, lo: 22, hi: 58, n: 19, by: [{ level: "expert", median: 24, n: 12 }, { level: "novice", median: 47, n: 2 }] })).toBe("Clear times: median 0:31, 0:22 to 0:58 (19 winning runs) · experts 0:24 · novices 0:47");
    expect(paceLine([{ step: "orb", s: 12, k: 24 }, { step: "goal", s: 31, k: 19 }], 24)).toBe("orb at 0:12 · goal at 0:31 (19 of 24)");
    expect(failLine({ x: 0, z: 0, near: "lava pit", n: 4, runs: 4, why: [["hit the lava", 4]] }, 24)).toBe("near the lava pit: hit the lava ×4 (4 of 24 runs)");
  });
});
