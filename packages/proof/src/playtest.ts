// The playtest: after the proof's own runners (experts: they back "beatable", the par time and the
// ghost, and run first, so the receipt is out as soon as it is today), novices and average players
// play the same world. Their wins place it in a difficulty band; every run of every level feeds
// what the runners revealed (revealed.ts).
import type { WorldBundle } from "@ghostrun/ir";
import type { NavWorld } from "@ghostrun/nav";
import type { Rapier } from "@ghostrun/sim";
import { bandOf } from "./revealed";
import { skillRuns, stepName } from "./t3";
import type { PlanStep, WinChain } from "./t0";
import type { Playtest, Receipt } from "./types";

/** Runners per lower level: 6 novices and 6 average players beside the 12 experts. */
export const SKILL_RUNS = 6;

export function playtest(R: Rapier, b: WorldBundle, nav: NavWorld, chain: WinChain | null, receipt: Receipt, playerTeam: "red" | "blue" = "red", openers: ReadonlyMap<string, PlanStep[]> = new Map(), runs = SKILL_RUNS): Playtest | null {
  const win = receipt.chips.find((c) => c.id === "T3:win");
  if (!chain || !win || b.mode !== "play") return null;
  const t0 = globalThis.performance?.now?.() ?? 0;
  const tooEasy = receipt.chips.some((c) => c.id === "T3:too_easy");
  const steps = chain.steps.map((st) => stepName(b, st));
  // nobody won at the top level: the lower ones would only play out the clock (the experts'
  // runs still say where they all went wrong)
  if (win.k === 0) {
    const levels = [{ level: "expert" as const, runs: win.n, won: 0 }];
    return { levels, band: bandOf(levels, tooEasy), trails: [], steps, ms: 0 };
  }
  const novices = skillRuns(R, b, nav, chain, "novice", runs, playerTeam, openers);
  const average = skillRuns(R, b, nav, chain, "average", runs, playerTeam, openers);
  const levels = [
    { level: "novice" as const, runs, won: novices.filter((t) => t.won).length },
    { level: "average" as const, runs, won: average.filter((t) => t.won).length },
    { level: "expert" as const, runs: win.n, won: win.k },
  ];
  return { levels, band: bandOf(levels, tooEasy), trails: [...novices, ...average], steps, ms: Math.round((globalThis.performance?.now?.() ?? 0) - t0) };
}
