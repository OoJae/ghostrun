// The route model's parameters and its calibration error, as `ghostrun calibrate` fitted and
// measured them on the committed bench worlds: 225 play worlds proved with their playtests (24
// physics runs each, at three skill levels), sorted by name, fitted on every other one (113) and
// measured on the rest (112, held out). Every T4 number carries these errors as its ±. Reproduce:
//   ghostrun calibrate tools/bench/worlds --data t4.json   (then: --fit --data t4.json)
import type { Level } from "./types";

export interface Params {
  /** Seconds a jump costs on the way, and a missed one gone back for. */
  jumpS: number;
  retryS: number;
  /** The share of missed jumps that end the run. */
  fatal: number;
  /** How much a leg's time wanders, ± (a share of it). */
  noise: number;
  /** Each level's pace (time × this) and its chances, per jump, per hazard passed, per rival per 10 s, per leg. */
  levels: Record<Level, { pace: number; jump: number; hazard: number; rival: number; leg: number }>;
}

export const PARAMS: Params = {
  jumpS: 0.6,
  retryS: 1.97,
  fatal: 0.465,
  noise: 0.386,
  levels: {
    novice: { pace: 1.478, jump: 0.221, hazard: 0.309, rival: 0.0084, leg: 0.0261 },
    average: { pace: 1.075, jump: 0.0475, hazard: 0.129, rival: 0.0045, leg: 0.0184 },
    expert: { pace: 1, jump: 0.01, hazard: 0.01, rival: 0.002, leg: 0.002 },
  },
};

/**
 * The calibration error on the 112 held-out bench worlds: the mean gap between the modelled win
 * rate and physics' k of 6 at each level (physics' own sampling noise alone accounts for 0.11 of
 * the novices' and 0.10 of the average players'; the experts' is the anchor, so in-sample), the
 * median relative gap in the novices' and average players' median clear time, and the mean gap in
 * the share of time spent near the busiest places.
 */
export const FIT = {
  win: { novice: 0.24, average: 0.15, expert: 0.04 } as Record<Level, number>,
  times: 0.11,
  heat: 0.1,
  /** The bench behind these: worlds fitted on, and held out. */
  bench: { fitted: 113, held: 112 },
};
