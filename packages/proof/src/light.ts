// The proof's light half: labels and repair issues, without the simulation. The web shell imports
// this so its first chunk stays small; the ladder itself (T0–T3) runs in the proof worker.
export { chipLine, fraction, statusWord } from "./labels";
export { badness, better, issuesOf } from "./issues";
export type { Chip, ChipStatus, Counterexample, Receipt, Tier, Trail } from "./types";
export { insights, type Insights } from "./insights";
// racing a ghost reads the player's progress on the main thread (no simulation imports in there)
export { GHOST_EVERY, Progress, secretsOf, type Ghost, type ProgressSim } from "./ghost";
