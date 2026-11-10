import type { Vec3 } from "@ghostrun/ir";

export const DT = 1 / 60;

/** Button bits in InputFrame.btn. */
/** DOWN: crouch, which dives when flying or swimming (and does nothing on foot). */
export const BTN = { JUMP: 1, USE: 2, TALK: 4, SPRINT: 8, DOWN: 16 } as const;

/**
 * One tick of player input. The move vector is already in world space (the camera lives on the
 * client), quantised to int8, so the simulation needs no trigonometry and replays bit-exactly.
 */
export interface InputFrame {
  tick: number;
  wx: number; // −127…127, world +x
  wz: number; // −127…127, world +z
  btn: number;
}

export interface SimEvent {
  tick: number;
  k: string; // enter | exit | pickup | touch | jump | air_jump | land | score | win | lose | state | emit | reset | unsupported
  a: string;
  b: string;
  v: number | string;
  rule: string; // rule id when the event came from a rule effect
  cause: number; // index of the event that caused this one, −1 if none
  /** A spoken event's speech act (offer, book…); no other event has one. */
  act?: string;
}

export interface Pose {
  p: Vec3;
  q: [number, number, number, number];
}

export type Result = "win" | "lose" | null;
