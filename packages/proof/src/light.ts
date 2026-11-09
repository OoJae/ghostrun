// The proof's light half: labels and repair issues, without the simulation. The web shell imports
// this so its first chunk stays small; the ladder itself (T0–T3) runs in the proof worker.
export { bandLine, bandMethod, bandSaid, chipLine, chipLineAt, chipLineIn, clock, crossLine, english, failLine, failRunLine, fengShuiFix, fengShuiHead, fengShuiLine, fengShuiWhy, fightLine, fightLineIn, fraction, modelBlock, modelLines, modelMethod, paceLine, pairLine, partLine, statusWord, timesLine, whereWord, type CrossCheck, type Words } from "./labels";
// a cloud receipt is checked against this device's on the main thread
export { comparable, receiptHash } from "./cross";
// which later tiers run (T3h, T4): the client asks the edge, and proves the same
export { flagOn, TIERS, type Tiers } from "./tiers";
// T4's calibration error on the bench, for "Why trust this?"
export { FIT } from "./t4-fit";
export { badness, better, issuesOf } from "./issues";
export type { Band, Chip, ChipStatus, Counterexample, FailRun, Fall, Level, Model, Playtest, Receipt, Tier, Trail } from "./types";
export { insights, type Insights } from "./insights";
// the playtest report reads the receipt it already has (the runs themselves played in the worker)
export { allRuns, BANDS, bandOf, placeOf, reportLines, revealed, type FailSpot, type FightSpot, type Heat, type Revealed } from "./revealed";
// racing a ghost reads the player's progress on the main thread (no simulation imports in there)
export { GHOST_EVERY, Progress, secretsOf, type Ghost, type ProgressSim } from "./ghost";
// red/green: where the same runner's two runs part (the runs come from the proof worker)
export { ghostAt, parting, pickFailing, type Parting } from "./redgreen";
export type { Pair, PairAsk } from "./pair";
export type { KeptRun } from "./t3";
