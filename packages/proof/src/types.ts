import type { Vec3 } from "@ghostrun/ir";
import type { Ghost } from "./ghost";

/** How well an AI runner plays: experts are the proof's own runners, the others the playtest's. */
export type Level = "novice" | "average" | "expert";

export type Tier = "T0" | "T1" | "T2" | "T3";
export type ChipStatus = "verified" | "played" | "modelled" | "not_checkable" | "counterexample";

export interface Counterexample {
  where: Vec3 | null;
  have: number;
  need: number;
  unit: string;
  text: string; // e.g. "apex 1.6 m < ledge 2.6 m"
}

export interface Chip {
  id: string;
  tier: Tier;
  subject: { kind: "rule" | "property" | "world"; id: string };
  status: ChipStatus;
  /** Always present: how the claim was established. */
  method: string;
  n: number; // trials, where applicable
  k: number; // successes
  text: string;
  cx: Counterexample | null;
  src: "template" | "ai" | "user" | "";
  ms: number;
}

/** Where one AI runner went: its feet every 20 ticks, as x, y, z triples (0.1 m). */
export interface Trail {
  won: boolean;
  xyz: number[];
  /** Its skill (absent: an expert, one of the proof's own runners). */
  level?: Level;
  /** Ticks the run lasted. */
  ticks?: number;
  /** The tick each step of the win chain was first done, in chain order (−1: never). */
  at?: number[];
  /** Where it went wrong: a loss, getting stuck, a knock-out, a hazard that sent it back. */
  falls?: Fall[];
  /** The fight, by place: x, z (0.1 m) and 0 for a hit, 1 for a knock-out, for everyone in it. */
  fights?: number[];
}

/** One place a run went wrong, and why, in the causal log's words ("hit the lava"). */
export interface Fall {
  x: number;
  z: number;
  why: string;
  /** It ended the run (a loss, stuck, out of time); else the runner went on (knocked out and back). */
  end: boolean;
}

/** The playtest: runners at lower skill levels play the world after the proof's own (experts). */
export interface Playtest {
  /** Runs and wins at each level, novices first; the experts are the proof's T3 runners. */
  levels: { level: Level; runs: number; won: number }[];
  band: Band;
  /** The novice and average runs (the experts' are the receipt's trails). */
  trails: Trail[];
  /** The win chain's steps, named, in order: what the pacing strip times. */
  steps: string[];
  ms: number;
}

export type Band = "Very easy" | "Easy" | "Normal" | "Hard" | "Expert only" | "Unbeaten";

export interface Receipt {
  v: 1;
  spec: string;
  engine: string;
  host: "node" | "edge" | "device";
  headline: { expect: string; text: string; status: ChipStatus; method: string } | null;
  chips: Chip[];
  par: { goldS: number; runs: number; won: number } | null;
  ms: number;
  /** The AI runners' routes (play analytics: where they went, what nobody went near). */
  trails?: Trail[];
  /** The par runner's run, sampled for racing it (present when a runner won). */
  ghost?: Ghost;
  /** Novice and average runners after the proof's own: the difficulty band and the playtest report. */
  playtest?: Playtest;
}
