// `ghostrun calibrate`: T4's route model fitted to, and measured against, physics on the committed
// bench worlds. Collecting proves every play world with its playtest (24 physics runs at three
// levels) and T3h, and keeps what the model needs (its route graph) beside what physics did (wins
// and clear times by level, where the time went, T3h's chips). Fitting sorts the worlds by name,
// fits the model's parameters on every other one and measures its error on the rest (held out):
// the errors every T4 number carries (packages/proof/src/t4-fit.ts).
import type { Level, Params, Route } from "@ghostrun/proof";
import { anchorOf, modelRuns, PARAMS } from "@ghostrun/proof";

export interface Row {
  id: string;
  seed: number;
  pack: string;
  route: Omit<Route, "legs"> & { legs: Omit<Route["legs"][number], "pts">[] };
  physics: Record<Level, { runs: number; won: number; times: number[] }>;
  /** Physics' "Most time" (the receipt's own measure) and the modelled one at the time of collecting. */
  heat: { near: string; share: number }[];
  modelHeat: { near: string; share: number }[];
  /** T3h's chips: id, status, k of n, and the counterexample's words. */
  human: { id: string; status: string; k: number; n: number; cx: string }[];
  ms: { playtest: number; t3h: number; t4: number };
}

const winShare = (xs: readonly { won: boolean }[]) => (xs.length ? xs.filter((x) => x.won).length / xs.length : 0);
const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};
const asRoute = (r: Row["route"]): Route => ({ ...r, legs: r.legs.map((l) => ({ ...l, pts: [] })) });

/** The model against one world's physics: modelled win rate per level and median clear time per level. */
function predict(row: Row, p: Params, n = 200) {
  const route = asRoute(row.route);
  const a = anchorOf(route, p, row.physics.expert, row.seed);
  const out = {} as Record<Level, { p: number; t: number }>;
  for (const l of ["novice", "average", "expert"] as const) {
    const rs = modelRuns(route, l, n, p, a, row.seed);
    out[l] = { p: winShare(rs), t: median(rs.filter((r) => r.won).map((r) => r.s)) };
  }
  return out;
}

/** The fit's objective on a set of worlds: squared win-rate gaps (novice, average) and log clear-time gaps. */
function loss(rows: readonly Row[], p: Params): number {
  let e = 0;
  for (const row of rows) {
    const m = predict(row, p, 150);
    for (const l of ["novice", "average"] as const) {
      const ph = row.physics[l];
      if (ph.runs) e += (m[l].p - ph.won / ph.runs) * (m[l].p - ph.won / ph.runs);
      if (ph.times.length && m[l].t > 0) {
        const g = Math.log(m[l].t / median(ph.times));
        e += 0.25 * g * g;
      }
    }
  }
  return e / Math.max(1, rows.length);
}

type Knob = { get: (p: Params) => number; set: (p: Params, v: number) => void; lo: number; hi: number };
const knobs: Knob[] = [];
for (const l of ["novice", "average"] as const) {
  for (const k of ["pace", "jump", "hazard", "rival", "leg"] as const) {
    knobs.push({ get: (p) => p.levels[l][k], set: (p, v) => void (p.levels[l][k] = v), lo: k === "pace" ? 1 : 0.0005, hi: k === "pace" ? 4 : 0.6 });
  }
}
knobs.push({ get: (p) => p.noise, set: (p, v) => void (p.noise = v), lo: 0.02, hi: 0.6 });
knobs.push({ get: (p) => p.retryS, set: (p, v) => void (p.retryS = v), lo: 0.5, hi: 12 });
knobs.push({ get: (p) => p.fatal, set: (p, v) => void (p.fatal = v), lo: 0.05, hi: 1 });

const clone = (p: Params): Params => JSON.parse(JSON.stringify(p)) as Params;

/** Coordinate descent, multiplicative steps that shrink each sweep. */
export function fit(rows: readonly Row[], log: (s: string) => void, sweeps = 4): Params {
  let best = clone(PARAMS);
  let bestLoss = loss(rows, best);
  log(`  start: loss ${bestLoss.toFixed(4)}`);
  let step = 1.6;
  for (let s = 0; s < sweeps; s++) {
    for (const k of knobs) {
      for (const dir of [step, 1 / step]) {
        const p = clone(best);
        k.set(p, Math.min(k.hi, Math.max(k.lo, k.get(p) * dir)));
        const l = loss(rows, p);
        if (l < bestLoss - 1e-6) ((best = p), (bestLoss = l));
      }
    }
    log(`  sweep ${s + 1}: loss ${bestLoss.toFixed(4)}`);
    step = 1 + (step - 1) / 2;
  }
  return best;
}

/** The expected gap between a level's k of n and its true rate p: physics' own sampling noise. */
function samplingGap(p: number, n: number): number {
  let e = 0;
  let c = 1;
  for (let k = 0; k <= n; k++) {
    if (k > 0) c = (c * (n - k + 1)) / k;
    e += c * Math.pow(p, k) * Math.pow(1 - p, n - k) * Math.abs(k / n - p);
  }
  return e;
}

/** The model's errors on a set of worlds (held out from the fit). */
export function measure(rows: readonly Row[], p: Params) {
  const gaps: Record<Level, number[]> = { novice: [], average: [], expert: [] };
  const noise: Record<Level, number[]> = { novice: [], average: [], expert: [] };
  const times: number[] = [];
  const heat: number[] = [];
  for (const row of rows) {
    const m = predict(row, p, 400);
    for (const l of ["novice", "average", "expert"] as const) {
      const ph = row.physics[l];
      if (!ph.runs) continue;
      gaps[l].push(Math.abs(m[l].p - ph.won / ph.runs));
      noise[l].push(samplingGap(m[l].p, ph.runs));
      // (the experts' clear time is what anchors the model: only the other levels' are a test of it)
      if (l !== "expert" && ph.times.length && m[l].t > 0) times.push(Math.abs(m[l].t - median(ph.times)) / median(ph.times));
    }
    const names = [...new Set([...row.heat.slice(0, 3), ...row.modelHeat.slice(0, 3)].map((x) => x.near))];
    const of = (xs: readonly { near: string; share: number }[], n: string) => xs.find((x) => x.near === n)?.share ?? 0;
    if (names.length) heat.push(names.reduce((s, n) => s + Math.abs(of(row.heat, n) - of(row.modelHeat, n)), 0) / names.length);
  }
  const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);
  return {
    worlds: rows.length,
    win: { novice: mean(gaps.novice), average: mean(gaps.average), expert: mean(gaps.expert) },
    sampling: { novice: mean(noise.novice), average: mean(noise.average), expert: mean(noise.expert) },
    times: median(times),
    heat: mean(heat),
  };
}
