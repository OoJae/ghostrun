// The seam between input, simulation and rendering. The renderer reads entity poses only from a
// FrameSource; today that is the main-thread stub, later the deterministic Rapier Sim Worker.

/** One sampled input. mx = strafe (right +), my = forward (+), yaw = camera yaw in radians. */
export interface InputFrame {
  tick: number;
  mx: number;
  my: number;
  yaw: number;
  btn: number;
}

export const BTN_JUMP = 1;
export const BTN_USE = 2;

export interface Pose {
  p: [number, number, number];
  q: [number, number, number, number];
}

export interface SimFrame {
  tick: number;
  poses: Map<string, Pose>;
}

export interface FrameSource {
  start(onFrame: (f: SimFrame) => void): void;
  input(f: InputFrame): void;
  stop(): void;
}

/** Id the stub (and later the sim) uses for the local player's pose. */
export const PLAYER_ID = "player";

export const TICK_HZ = 60;
