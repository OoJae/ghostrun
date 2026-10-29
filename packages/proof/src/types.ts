import type { Vec3 } from "@ghostrun/ir";
import type { Ghost } from "./ghost";

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
}

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
}
