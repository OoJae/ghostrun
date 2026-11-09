// The camera's way to a place: where to watch it from (raised, clear of the walls) and the flight
// there over anything in the way (rise above, never through). Plain numbers, no three.js: the
// shots move the camera along it.
import type { Vec3 } from "@ghostrun/ir";
import { rayBox, type Box } from "../sim/aabb";

export interface Framing {
  pos: Vec3;
  look: Vec3;
}

const LOOK_H = 0.9; // the follow camera's own: a point above the capsule centre

/** Ease in and out (cubic): slow off the mark, slow into the shot. */
export const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - ((2 - 2 * t) * (2 - 2 * t) * (2 - 2 * t)) / 2);

/** Is the straight line between two points clear of every box (a box around `from` doesn't count)? */
function clear(from: Vec3, to: Vec3, boxes: readonly Box[]): boolean {
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-6) return true;
  const u: Vec3 = [d[0] / len, d[1] / len, d[2] / len];
  for (const b of boxes) {
    const inside = from[0] >= b.min[0] && from[0] <= b.max[0] && from[1] >= b.min[1] && from[1] <= b.max[1] && from[2] >= b.min[2] && from[2] <= b.max[2];
    if (!inside && rayBox(from, u, b, len) < len) return false;
  }
  return true;
}

/**
 * Where to watch a place from: back along the way the camera was looking at it, raised, with the
 * view clear of the walls (higher, then from the side, then from behind, until it is).
 */
export function frameAt(at: Vec3, from: Vec3, boxes: readonly Box[], dist = 9): Framing {
  const look: Vec3 = [at[0], at[1] + LOOK_H, at[2]];
  let dx = from[0] - at[0];
  let dz = from[2] - at[2];
  const l = Math.hypot(dx, dz);
  [dx, dz] = l > 0.5 ? [dx / l, dz / l] : [0, 1];
  const yaws = [0, Math.PI / 2, -Math.PI / 2, Math.PI];
  for (const pitch of [0.5, 0.8, 1.1]) {
    for (const turn of yaws) {
      const [c, s] = [Math.cos(turn), Math.sin(turn)];
      const [hx, hz] = [dx * c - dz * s, dx * s + dz * c];
      const pos: Vec3 = [look[0] + hx * dist * Math.cos(pitch), look[1] + dist * Math.sin(pitch), look[2] + hz * dist * Math.cos(pitch)];
      if (clear(look, pos, boxes)) return { pos, look };
    }
  }
  // nothing clear (a room with a ceiling): straight down from above it
  return { pos: [look[0], look[1] + dist, look[2] + 0.01], look };
}

/**
 * The flight from one framing to another: a curve over a midpoint raised above anything the
 * straight line would go through (rise above, never through a wall). `at(t)` for t in 0…1.
 */
export function flight(a: Framing, b: Framing, boxes: readonly Box[]): (t: number) => Framing {
  let top = Math.max(a.pos[1], b.pos[1]);
  if (!clear(a.pos, b.pos, boxes)) {
    // over the tallest thing in the way, with room to spare
    for (const x of boxes) if (!clear(a.pos, b.pos, [x])) top = Math.max(top, x.max[1] + 2.5);
  }
  const mid: Vec3 = [(a.pos[0] + b.pos[0]) / 2, top === Math.max(a.pos[1], b.pos[1]) ? (a.pos[1] + b.pos[1]) / 2 : 2 * top - (a.pos[1] + b.pos[1]) / 2, (a.pos[2] + b.pos[2]) / 2];
  const lerp = (p: Vec3, q: Vec3, t: number): Vec3 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  return (t) => {
    const u = 1 - t;
    // a quadratic curve through the raised midpoint's control point (its peak is the midpoint's height)
    const pos: Vec3 = [u * u * a.pos[0] + 2 * u * t * mid[0] + t * t * b.pos[0], u * u * a.pos[1] + 2 * u * t * mid[1] + t * t * b.pos[1], u * u * a.pos[2] + 2 * u * t * mid[2] + t * t * b.pos[2]];
    return { pos, look: lerp(a.look, b.look, t) };
  };
}
