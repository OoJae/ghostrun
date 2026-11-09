import type { Vec3 } from "@ghostrun/ir";
import type { Ghost } from "./ghost";

/** How well an AI runner plays: experts are the proof's own runners, the others the playtest's. */
export type Level = "novice" | "average" | "expert";

export type Tier = "T0" | "T1" | "T2" | "T3" | "T3h" | "T4";
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

/**
 * A failing run kept whole (when no AI runner won): which runner it was, the run sampled as a ghost
 * is, from the spawn to where it ended, and how it ended. The same runner plays the same seed on a
 * changed world, so red/green can play it beside its run there.
 */
export interface FailRun {
  /** Which of T3's runners (0-based; its seed is the world's seed × 1000 + run). */
  run: number;
  ghost: Ghost;
  /** Where and how it ended, as the playtest report says it ("got stuck on the way to the orb"). */
  end: Fall;
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
  /** T3h: the experts' plan through the player's keys and camera (camera, stuck frames, capsule traps). */
  human?: Chip[];
  /** T4: the route model, calibrated on these runs; every number in it is modelled, never played. */
  model?: Model;
}

/**
 * T4, the route model (t4.ts): modelled, never played. Each number carries its calibration error
 * (measured on the bench: t4-fit.ts) and, where this world has one, its physics check.
 */
export interface Model {
  /** Modelled runs in all (an equal share at each level). */
  runs: number;
  /** Each level's modelled win rate (0…1), its ± (bench), and this world's physics runs at that level. */
  levels: { level: Level; p: number; err: number; physics: { runs: number; won: number } }[];
  /** Modelled clear times (s): median, 10th to 90th percentile, the relative ± (bench), and physics' median here. */
  times: { median: number; lo: number; hi: number; err: number; physics: number } | null;
  /** Where modelled runners spend their time: the busiest places and their shares, the ± (bench) and the gap to physics here. */
  heat: { near: string; share: number }[];
  heatErr: number;
  heatGap: number;
  /** A team map: the share of modelled matches red wins from its spawn, and its ±. */
  teams: { red: number; err: number; matches: number } | null;
  /** The anchors from this world's experts (time scale, risk): candidates of it are screened on these. */
  anchor: { scale: number; risk: number };
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
  /** A representative failing run, kept whole (present when no runner won): where it fails. */
  failRun?: FailRun;
  /** Novice and average runners after the proof's own: the difficulty band and the playtest report. */
  playtest?: Playtest;
}
