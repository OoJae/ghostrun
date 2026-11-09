// Red/green runs: the same runner on the same seed, on two versions of a world (before and after a
// change), each kept whole, so the two can be played side by side and the moment they part named.
// The runs are the proof's own (T3's runner, or its jump witness) replayed exactly, not new ones.
import type { WorldBundle } from "@ghostrun/ir";
import { buildNav } from "@ghostrun/nav";
import type { Rapier } from "@ghostrun/sim";
import { t0 } from "./t0";
import { jumpRun, runnerRun, type KeptRun } from "./t3";

/** Which run to pair: one of T3's runners, or the jump witness of a "requires jumps" expectation. */
export type PairAsk = { kind: "win"; run: number } | { kind: "jump"; expect: string };

export interface Pair {
  /** What was played: for a jump witness, the attempt and jump count whose outcome the change flipped. */
  ask: PairAsk & { jumps?: number; attempt?: number };
  /** The run on the first world, and on the second. */
  a: KeptRun;
  b: KeptRun;
}

/** As T3 tries each jump count (see t3's jump witness). */
const ATTEMPTS = 4;

/**
 * The pair: T3's runner `run` on both worlds; or, for a jump expectation, the first attempt (fewer
 * jumps first) that reached the top on one world and not on the other. Null when there is nothing
 * to pair (no win chain, no such expectation, or no attempt the change flipped).
 */
export function pairRuns(R: Rapier, a: WorldBundle, b: WorldBundle, ask: PairAsk, playerTeam: "red" | "blue" = "red"): Pair | null {
  const navs = [buildNav(a), buildNav(b)] as const;
  try {
    if (ask.kind === "win") {
      const [ca, cb] = [t0(a, playerTeam), t0(b, playerTeam)];
      if (!ca.chain || !cb.chain) return null;
      return { ask, a: runnerRun(R, a, navs[0], ca.chain, ask.run, playerTeam, ca.openers), b: runnerRun(R, b, navs[1], cb.chain, ask.run, playerTeam, cb.openers) };
    }
    const x = b.expects.find((e) => e.id === ask.expect) ?? a.expects.find((e) => e.id === ask.expect);
    const k = Number(/^jumps>=(\d+)$/.exec((x?.need ?? []).map((n) => n.replace(/\s/g, "")).find((n) => n.startsWith("jumps>=")) ?? "")?.[1]);
    if (!k) return null;
    for (const jumps of [k - 1, k]) {
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const ra = jumpRun(R, a, navs[0], ask.expect, jumps, attempt, playerTeam);
        const rb = jumpRun(R, b, navs[1], ask.expect, jumps, attempt, playerTeam);
        if (!ra || !rb) return null;
        if (ra.ok !== rb.ok) return { ask: { ...ask, jumps, attempt }, a: ra, b: rb };
      }
    }
    return null;
  } finally {
    for (const n of navs) n.destroy();
  }
}
