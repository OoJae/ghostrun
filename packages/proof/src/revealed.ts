// What the AI runners revealed: a playtest report from every run of every level (the proof's
// experts, the playtest's novices and average players). The questions a designer asks of real
// playtests, asked of runs that really played the level: where players spend their time, where
// runs go wrong and why, where the fights are, how long each step of the win takes, how hard it
// is. No simulation imports: the receipt panel works this out from the receipt it already has.
import type { WorldBundle } from "@ghostrun/ir";
import { insights } from "./insights";
import { bandLine, failLine, fightLine, paceLine, share, timesLine } from "./labels";
import type { Band, Level, Playtest, Receipt, Trail } from "./types";

/** Where runners spent their time: cells of `cell` metres, as x, y, z (the ground they stood on) and a weight 0…1. */
export interface Heat {
  cell: number;
  cells: number[];
}

/** A place on the ground, named by what is near it ("" when nothing is). */
export interface Spot {
  x: number;
  z: number;
  near: string;
}

export interface FailSpot extends Spot {
  /** Times something went wrong here, in how many runs, and why (most common first). */
  n: number;
  runs: number;
  why: [string, number][];
}

export interface FightSpot extends Spot {
  hits: number;
  kos: number;
}

export interface Revealed {
  /** Runs behind the report, at every level, and the positions sampled from them. */
  runs: number;
  samples: number;
  heat: Heat;
  /** The places where the most runs went wrong (up to three). */
  fails: FailSpot[];
  /** Where the fights cluster, in a world with weapons. */
  fights: { spots: FightSpot[]; hits: number; kos: number } | null;
  /** When runners first did each step of the win chain (median of the runs that did), then the win. */
  pace: { step: string; s: number; k: number }[];
  /** Winning runs' clear times, s: the median and range, and each level's median. */
  times: { median: number; lo: number; hi: number; n: number; by: { level: Level; median: number; n: number }[] } | null;
}

const HEAT_CELL = 1.5;
const SPOT_CELL = 4;

/** The middle value (the lower of the two middle ones for an even count). */
export const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};

/**
 * The band from the win rates (k of n at each level). Monotone in how far down the levels a win
 * reaches: most novices win (very easy), half of them (easy), half the average players (normal),
 * some below the experts (hard), only experts (expert only). A win over before it starts (the T3
 * too-easy flag) is very easy whatever the rates say.
 */
export function bandOf(levels: Playtest["levels"], tooEasy = false): Band {
  const at = (l: Level) => levels.find((x) => x.level === l) ?? { runs: 0, won: 0 };
  const [nov, avg, exp] = [at("novice"), at("average"), at("expert")];
  if (exp.won === 0) return "Unbeaten";
  if (tooEasy) return "Very easy";
  if (nov.runs && nov.won * 6 >= nov.runs * 5) return "Very easy";
  if (nov.runs && nov.won * 2 >= nov.runs) return "Easy";
  if (avg.runs && avg.won * 2 >= avg.runs) return "Normal";
  if (avg.won + nov.won > 0) return "Hard";
  return "Expert only";
}

/** Bands from easiest to hardest (a candidate one step harder sits one place further on). */
export const BANDS: readonly Band[] = ["Very easy", "Easy", "Normal", "Hard", "Expert only", "Unbeaten"];

/** Every run with its level: the receipt's own runners are experts. */
export function allRuns(r: Receipt): Trail[] {
  return [...(r.trails ?? []), ...(r.playtest?.trails ?? [])];
}

/** What a place is near: the nearest named thing within 6 m, else the zone of the ground there. */
function placeOf(b: WorldBundle, x: number, z: number): string {
  let best = "";
  let bestD = 36;
  for (const e of b.entities) {
    if (e.kind === "spawn" || e.tags.includes("bonus") || e.tags.includes("area")) continue;
    const d = (x - e.pos[0]) * (x - e.pos[0]) + (z - e.pos[2]) * (z - e.pos[2]);
    if (d < bestD) ((bestD = d), (best = e.noun || e.id.replace(/_/g, " ")));
  }
  if (best) return best;
  // the smallest piece of ground under it (a ledge before the street it stands in)
  let zone = "";
  let area = Infinity;
  for (const s of b.statics) {
    if (s.surf === "wall" || Math.abs(x - s.pos[0]) > s.size[0] / 2 || Math.abs(z - s.pos[2]) > s.size[2] / 2) continue;
    const a = s.size[0] * s.size[2];
    if (a < area) ((area = a), (zone = s.zone));
  }
  const named = b.zones.find((q) => q.id === zone);
  return named ? (named.name || named.id.replace(/^z_/, "").replace(/_/g, " ")).replace(/^the\s+/i, "") : "";
}

/** Group points into places (by what they're near, else a 4 m cell): busiest first. */
function cluster<T extends { x: number; z: number }>(b: WorldBundle, pts: readonly T[]): { x: number; z: number; near: string; of: T[] }[] {
  const by = new Map<string, { x: number; z: number; near: string; of: T[] }>();
  for (const p of pts) {
    const near = placeOf(b, p.x, p.z);
    const key = near || `${Math.floor(p.x / SPOT_CELL)},${Math.floor(p.z / SPOT_CELL)}`;
    const g = by.get(key);
    if (g) g.of.push(p);
    else by.set(key, { x: p.x, z: p.z, near, of: [p] });
  }
  return [...by.entries()].sort((u, v) => v[1].of.length - u[1].of.length || (u[0] < v[0] ? -1 : 1)).map(([, g]) => g);
}

export function revealed(b: WorldBundle, r: Receipt): Revealed | null {
  const runs = allRuns(r);
  if (!runs.length) return null;
  // the heat map: time spent per cell, on the ground each cell's samples stood on
  const cells = new Map<string, { n: number; x: number; y: number; z: number }>();
  let samples = 0;
  for (const t of runs) {
    for (let i = 0; i + 2 < t.xyz.length; i += 3) {
      const [x, y, z] = [t.xyz[i]!, t.xyz[i + 1]!, t.xyz[i + 2]!];
      const [cx, cz] = [Math.floor(x / HEAT_CELL), Math.floor(z / HEAT_CELL)];
      const key = `${cx},${cz},${Math.round(y)}`;
      const c = cells.get(key);
      if (c) ((c.n += 1), (c.y += y));
      else cells.set(key, { n: 1, x: (cx + 0.5) * HEAT_CELL, y, z: (cz + 0.5) * HEAT_CELL });
      samples++;
    }
  }
  const top = Math.max(1, ...[...cells.values()].map((c) => c.n));
  const heat: Heat = { cell: HEAT_CELL, cells: [...cells.values()].flatMap((c) => [c.x, Math.round((c.y / c.n) * 10) / 10, c.z, Math.round((c.n / top) * 1000) / 1000]) };

  // where runs went wrong: losses, getting stuck, knock-outs, hazards that sent them back
  const falls = runs.flatMap((t, run) => (t.falls ?? []).map((f) => ({ ...f, run })));
  const fails = cluster(b, falls)
    .slice(0, 3)
    .map((g): FailSpot => {
      const why = new Map<string, number>();
      for (const f of g.of) why.set(f.why, (why.get(f.why) ?? 0) + 1);
      return { x: g.x, z: g.z, near: g.near, n: g.of.length, runs: new Set(g.of.map((f) => f.run)).size, why: [...why].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)) };
    });

  // the fight, by place: hits and knock-outs
  const blows: { x: number; z: number; ko: boolean }[] = [];
  for (const t of runs) for (let i = 0; i + 2 < (t.fights?.length ?? 0); i += 3) blows.push({ x: t.fights![i]!, z: t.fights![i + 1]!, ko: t.fights![i + 2] === 1 });
  const fights = blows.length
    ? {
        spots: cluster(b, blows).slice(0, 3).map((g): FightSpot => ({ x: g.x, z: g.z, near: g.near, hits: g.of.filter((x) => !x.ko).length, kos: g.of.filter((x) => x.ko).length })),
        hits: blows.filter((x) => !x.ko).length,
        kos: blows.filter((x) => x.ko).length,
      }
    : null;

  // pacing: each step's first time (the median of the runs that got that far), then the win
  const steps = r.playtest?.steps ?? [];
  const pace: Revealed["pace"] = [];
  const timed = runs.filter((t) => t.at);
  if (timed.length) {
    const seen = new Set<string>();
    steps.forEach((step, i) => {
      if (!step || seen.has(step)) return;
      seen.add(step);
      const ts = timed.map((t) => t.at![i] ?? -1).filter((x) => x >= 0);
      if (ts.length) pace.push({ step, s: median(ts) / 60, k: ts.length });
    });
  }
  const wins = runs.filter((t) => t.won && t.ticks !== undefined);
  const won = { step: "won", s: median(wins.map((t) => t.ticks!)) / 60, k: wins.length };
  // the win itself, unless the last step is the win (a horde knocked out is the game over)
  const last = pace.at(-1);
  if (wins.length && last && !(last.k === won.k && Math.abs(last.s - won.s) < 0.5)) pace.push(won);

  const secs = (ts: readonly Trail[]) => ts.map((t) => t.ticks! / 60);
  const times = wins.length
    ? {
        median: median(secs(wins)),
        lo: Math.min(...secs(wins)),
        hi: Math.max(...secs(wins)),
        n: wins.length,
        by: (["expert", "average", "novice"] as const).map((level) => ({ level, w: wins.filter((t) => (t.level ?? "expert") === level) })).filter((x) => x.w.length).map(({ level, w }) => ({ level, median: median(secs(w)), n: w.length })),
      }
    : null;
  return { runs: runs.length, samples, heat, fails, fights, pace, times };
}

/** The report as lines (the CLI, the exported report): the band and clear times, then what the runs revealed. */
export function reportLines(b: WorldBundle, r: Receipt): string[] {
  const rv = revealed(b, r);
  if (!rv) return [];
  const out: string[] = [];
  if (r.playtest) out.push(`Difficulty: ${bandLine(r.playtest, r)}`);
  if (rv.times) out.push(timesLine(rv.times));
  out.push(`What the AI runners revealed (${rv.runs} runs, ${rv.samples} positions):`);
  const seen = insights(b, allRuns(r));
  const hot = seen.hot.filter((h) => h.share >= 0.03 && h.near);
  if (hot.length) out.push(`  Most time: ${hot.map((h) => `near the ${h.near} (${share(h.share)})`).join(", ")}`);
  if (rv.fails.length) out.push(`  Where runs went wrong: ${rv.fails.map((f) => failLine(f, rv.runs)).join("; ")}`);
  if (rv.fights) out.push(`  Fights: ${rv.fights.spots.map(fightLine).join("; ")} (${fightLine(rv.fights)} in all)`);
  if (rv.pace.length) out.push(`  Pacing (median first times): ${paceLine(rv.pace, rv.runs)}`);
  const unused = [...new Set(seen.unused.map((u) => u.noun))];
  out.push(unused.length ? `  Nobody went near: ${unused.slice(0, 4).map((u) => `the ${u}`).join(", ")}${unused.length > 4 ? ` and ${unused.length - 4} more` : ""}` : "  Every route passed everything there is to use.");
  return out;
}
