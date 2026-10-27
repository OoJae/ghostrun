// A minimal waypoint motor: turns a target point into a quantised world-space InputFrame.
// Used by T3 witnesses and tests; the planner (space-time A*) produces the waypoints.
import { BTN, type InputFrame } from "./types";

export interface Waypoint {
  x: number;
  z: number;
  /** Jump on arrival; "double" presses again at the apex. */
  jump?: "single" | "double";
}

/** Direction to (x, z) as int8 components, scaled so the larger axis is ±127. */
export function steerTo(tick: number, from: { x: number; z: number }, to: { x: number; z: number }, btn = 0): InputFrame {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const m = Math.max(Math.abs(dx), Math.abs(dz));
  if (m < 1e-6) return { tick, wx: 0, wz: 0, btn };
  return { tick, wx: Math.round((dx / m) * 127), wz: Math.round((dz / m) * 127), btn };
}

export { BTN };
