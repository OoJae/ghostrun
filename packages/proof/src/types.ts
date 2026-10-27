import type { Vec3 } from "@ghostrun/ir";

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

export interface Receipt {
  v: 1;
  spec: string;
  engine: string;
  host: "node" | "edge" | "device";
  headline: { expect: string; text: string; status: ChipStatus; method: string } | null;
  chips: Chip[];
  par: { goldS: number; runs: number; won: number } | null;
  ms: number;
}
