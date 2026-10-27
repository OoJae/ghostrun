// The proof's light half: labels and repair issues, without the simulation. The web shell imports
// this so its first chunk stays small; the ladder itself (T0–T3) runs in the proof worker.
export { chipLine, fraction, statusWord } from "./labels";
export { badness, better, issuesOf } from "./issues";
export type { Chip, ChipStatus, Counterexample, Receipt, Tier, Trail } from "./types";
export { insights, type Insights } from "./insights";
