// The proof's light half: labels and repair issues, without the simulation. The web shell imports
// this so its first chunk stays small; the ladder itself (T0–T3) runs in the proof worker.
export { bandLine, bandMethod, bandSaid, chipLine, chipLineIn, clock, english, failLine, fengShuiFix, fengShuiHead, fengShuiLine, fengShuiWhy, fightLine, fightLineIn, fraction, paceLine, statusWord, timesLine, type Words } from "./labels";
export { badness, better, issuesOf } from "./issues";
export type { Band, Chip, ChipStatus, Counterexample, Fall, Level, Playtest, Receipt, Tier, Trail } from "./types";
export { insights, type Insights } from "./insights";
// the playtest report reads the receipt it already has (the runs themselves played in the worker)
export { allRuns, BANDS, bandOf, reportLines, revealed, type FailSpot, type FightSpot, type Heat, type Revealed } from "./revealed";
// racing a ghost reads the player's progress on the main thread (no simulation imports in there)
export { GHOST_EVERY, Progress, secretsOf, type Ghost, type ProgressSim } from "./ghost";
