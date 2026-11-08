// Red/green: two runs of one runner on the same seed, before and after a change, played side by
// side. Which failing run a receipt keeps, and where two runs part. No simulation imports: the web
// shell finds the parting from the runs it already has, on the main thread.
import type { Vec3 } from "@ghostrun/ir";
import type { Ghost } from "./ghost";

/**
 * The failing run a receipt keeps (of runs that all failed): one that ended the way most of them
 * did (what the receipt says: "12 got stuck"), and of those the one that got furthest along the
 * win before it did (it shows the failure itself, not a slip on the way), the first of equals.
 * Returns its index.
 */
export function pickFailing(runs: readonly { why: string; prog: number }[]): number {
  const n = new Map<string, number>();
  for (const r of runs) n.set(r.why, (n.get(r.why) ?? 0) + 1);
  let best = -1;
  for (const [i, r] of runs.entries()) {
    const b = runs[best];
    if (!b) {
      best = i;
      continue;
    }
    const [nr, nb] = [n.get(r.why)!, n.get(b.why)!];
    if (nr > nb || (nr === nb && r.why < b.why) || (r.why === b.why && r.prog > b.prog)) best = i;
  }
  return Math.max(0, best);
}

/** Where a ghost was at a (whole or fractional) tick, held where it ended. */
export function ghostAt(g: Ghost, tick: number): Vec3 {
  const n = g.prog.length;
  if (n < 2) return [g.xyz[0] ?? 0, g.xyz[1] ?? 0, g.xyz[2] ?? 0];
  const t = Math.max(0, Math.min(tick, g.ticks));
  const i = Math.max(0, Math.min(n - 2, Math.floor(t / g.every)));
  const t0 = i * g.every;
  const t1 = i + 1 >= n - 1 ? g.ticks : (i + 1) * g.every;
  const f = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 1;
  const k = (j: number) => g.xyz[i * 3 + j]! + (g.xyz[(i + 1) * 3 + j]! - g.xyz[i * 3 + j]!) * f;
  return [k(0), k(1), k(2)];
}

/** How two runs part: one goes up where the other doesn't, one ends while the other goes on, or their ways split. */
export interface Parting {
  /** The last tick they were together (the moment they part), and where they were. */
  tick: number;
  at: Vec3;
  how: "jump" | "end" | "way";
  /** Both were already in the air: it is a jump on top of a jump (a double jump). */
  midair: boolean;
  /** How high each rose over the next second and a half, above where they parted (m). */
  rise: [number, number];
  /** Which one ended there (how: "end"), else null. */
  ended: 0 | 1 | null;
}

/** Further apart than this (m) is apart: more than a stride's wobble. */
const APART = 0.6;
/** And for this long (ticks): brushing past each other isn't parting. */
const HOLD = 30;
/** Together means closer than this (m). */
const TOGETHER = 0.15;

// squared distances, compared with squared thresholds: no transcendental Math in the proof package (the lint)
const d2 = (p: Vec3, q: Vec3) => (p[0] - q[0]) * (p[0] - q[0]) + (p[1] - q[1]) * (p[1] - q[1]) + (p[2] - q[2]) * (p[2] - q[2]);

/**
 * Where two runs of the same runner part: the last moment they were together before they went
 * apart (and stayed apart). Null when they never part: the same run either way.
 */
export function parting(a: Ghost, b: Ghost): Parting | null {
  const step = Math.min(a.every, b.every);
  const end = Math.max(a.ticks, b.ticks);
  const d = (t: number) => d2(ghostAt(a, t), ghostAt(b, t));
  let first = -1;
  for (let t = 0; t <= end && first < 0; t += step) {
    if (d(t) <= APART * APART) continue;
    let held = true;
    for (let u = t; u <= Math.min(end, t + HOLD); u += step) if (d(u) <= APART * APART) held = false;
    if (held) first = t;
  }
  if (first < 0) return null;
  let tick = first;
  while (tick > 0 && d(tick) > TOGETHER * TOGETHER) tick -= step;
  const at = ghostAt(a, tick);
  const peak = (g: Ghost) => {
    let top = -Infinity;
    for (let t = tick; t <= tick + 90; t += step) top = Math.max(top, ghostAt(g, t)[1]);
    return Math.round((top - at[1]) * 10) / 10;
  };
  const rise: [number, number] = [peak(a), peak(b)];
  // one stopped (stuck, lost) as they parted, while the other went on
  const stop = (g: Ghost, o: Ghost) => g.ticks <= first + HOLD && o.ticks > g.ticks + HOLD;
  const ended = stop(a, b) ? 0 : stop(b, a) ? 1 : null;
  const [pa, pb] = [ghostAt(a, first + HOLD), ghostAt(b, first + HOLD)];
  const dy = pa[1] - pb[1];
  const up = dy * dy >= (pa[0] - pb[0]) * (pa[0] - pb[0]) + (pa[2] - pb[2]) * (pa[2] - pb[2]) && Math.abs(rise[0] - rise[1]) >= 0.5;
  // in the air already: the height changed over the moment before they parted
  const before = ghostAt(a, Math.max(0, tick - 12));
  const midair = Math.abs(at[1] - before[1]) > 0.2;
  return { tick, at, how: ended !== null ? "end" : up ? "jump" : "way", midair, rise, ended };
}
