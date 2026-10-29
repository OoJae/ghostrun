// Teleport, kept honest to the simulation: the arc finds a floor, and the move there is walked by
// the sim's own controller under logged stick input while the view blinks (a position is never
// written into the sim). So a target must be one a walk reaches: on a floor no higher than a step,
// no wall across the way and no hole in it, and not in a hazard.
import { groundBelow, rayBox, type Box } from "../sim/aabb";

export type V3 = [number, number, number];

/** Launch speed of the arc (m/s): level from the hand at 1.4 m it lands about 4 m away. */
export const ARC_SPEED = 7.5;
const G = 9.81;
const STEP_S = 0.035;
const STEPS = 48;
/** Farthest a teleport goes (horizontally), and the nearest worth a blink. */
export const TP_MAX = 9;
export const TP_MIN = 0.6;
/** Highest a target may sit above your feet: the controller's autostep climbs no more. */
export const TP_UP = 0.4;
/** Deepest drop a teleport may walk you off. */
export const TP_DOWN = 6;

export interface Arc {
  /** The arc's points, from the hand to where it stopped. */
  points: V3[];
  /** Where it lands on a floor (the floor's top), or null if it hit a wall or nothing. */
  target: V3 | null;
  /** A walk can take you there. */
  valid: boolean;
}

/** A parabola from `from` along unit `dir`, stopped by the first box it meets; valid only for a walkable floor. */
export function arc(colliders: readonly Box[], hazards: readonly Box[], from: V3, dir: V3, feet: V3): Arc {
  const points: V3[] = [[...from]];
  let p: V3 = [...from];
  let v: V3 = [dir[0] * ARC_SPEED, dir[1] * ARC_SPEED, dir[2] * ARC_SPEED];
  for (let i = 0; i < STEPS; i++) {
    const q: V3 = [p[0] + v[0] * STEP_S, p[1] + v[1] * STEP_S, p[2] + v[2] * STEP_S];
    v = [v[0], v[1] - G * STEP_S, v[2]];
    const seg: V3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const len = Math.hypot(seg[0], seg[1], seg[2]);
    const d: V3 = [seg[0] / len, seg[1] / len, seg[2] / len];
    let best = Infinity;
    let hit: Box | null = null;
    for (const b of colliders) {
      const t = rayBox(p, d, b, len);
      if (t < best) ((best = t), (hit = b));
    }
    if (hit) {
      const at: V3 = [p[0] + d[0] * best, p[1] + d[1] * best, p[2] + d[2] * best];
      points.push(at);
      // the top face of a box is a floor; a side is a wall (and a teleport into a wall goes nowhere)
      const top = d[1] < 0 && Math.abs(at[1] - hit.max[1]) < 0.03;
      if (!top) return { points, target: null, valid: false };
      const target: V3 = [at[0], hit.max[1], at[2]];
      return { points, target, valid: reachable(colliders, hazards, feet, target) };
    }
    points.push(q);
    p = q;
    if (p[1] < feet[1] - TP_DOWN - 4) break;
  }
  return { points, target: null, valid: false };
}

/** Could the player walk from `feet` straight to `target`? */
export function reachable(colliders: readonly Box[], hazards: readonly Box[], feet: V3, target: V3): boolean {
  const dx = target[0] - feet[0];
  const dz = target[2] - feet[2];
  const dist = Math.hypot(dx, dz);
  const dy = target[1] - feet[1];
  if (dist < TP_MIN || dist > TP_MAX || dy > TP_UP || dy < -TP_DOWN) return false;
  const inside = (h: Box) => target[0] >= h.min[0] && target[0] <= h.max[0] && target[2] >= h.min[2] && target[2] <= h.max[2] && target[1] >= h.min[1] - 0.5 && target[1] <= h.max[1] + 0.5;
  if (hazards.some(inside)) return false;
  // no wall across the way, at the knees or at the chest
  const d: V3 = [dx / dist, 0, dz / dist];
  for (const h of [0.55, 1.3]) {
    const o: V3 = [feet[0], feet[1] + h, feet[2]];
    for (const b of colliders) if (rayBox(o, d, b, dist) < dist - 0.2) return false;
  }
  // and no hole in it deeper than a step below the lower of the two ends
  const floor = Math.min(feet[1], target[1]) - 0.6;
  for (let s = 0.5; s < dist; s += 0.5) {
    const x = feet[0] + d[0] * s;
    const z = feet[2] + d[2] * s;
    if (groundBelow(colliders, x, Math.max(feet[1], target[1]) + TP_UP, z) < floor) return false;
  }
  return true;
}
