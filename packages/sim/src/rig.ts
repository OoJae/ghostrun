// The player's controller and camera rig, as pure arithmetic: what the browser does with a
// player's keys and where its follow camera stands. The web client calls these (with its own
// Math.sin and Math.cos of the camera yaw: the trigonometry stays on the client), and T3h drives
// the same functions with synthetic keys, so what the proof checks is what players get. Nothing
// here is transcendental: a yaw comes in as its sine and cosine.
import type { WorldBundle } from "@ghostrun/ir";

/** An axis-aligned box: what the camera pulls in for and the stub sim collides with. */
export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

const toBox = (pos: readonly number[], size: readonly number[]): Box => ({
  min: [pos[0]! - size[0]! / 2, pos[1]! - size[1]! / 2, pos[2]! - size[2]! / 2],
  max: [pos[0]! + size[0]! / 2, pos[1]! + size[1]! / 2, pos[2]! + size[2]! / 2],
});

/**
 * Solid boxes as the client sees them: every static box plus platforms and doors (rotY is ignored:
 * the packs emit none for these). The follow camera pulls in for exactly these.
 */
export function collidersOf(bundle: WorldBundle): Box[] {
  const out = bundle.statics.filter((s) => s.shape === "box").map((s) => toBox(s.pos, s.size));
  for (const e of bundle.entities) {
    if (e.kind === "platform" || e.kind === "door") out.push(toBox(e.pos, e.size));
  }
  return out;
}

/** Ray vs box (slab test). Returns entry distance along the unit ray, or Infinity. */
export function rayBox(o: readonly number[], d: readonly number[], b: Box, maxT: number): number {
  let t0 = 0;
  let t1 = maxT;
  for (let a = 0; a < 3; a++) {
    const inv = 1 / (d[a]! || 1e-9);
    let tn = (b.min[a]! - o[a]!) * inv;
    let tf = (b.max[a]! - o[a]!) * inv;
    if (tn > tf) [tn, tf] = [tf, tn];
    t0 = Math.max(t0, tn);
    t1 = Math.min(t1, tf);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** Top of the highest box under (x, z) whose top is at or below y; -Infinity if none. */
export function groundBelow(boxes: readonly Box[], x: number, y: number, z: number): number {
  let best = -Infinity;
  for (const b of boxes) {
    if (x < b.min[0] || x > b.max[0] || z < b.min[2] || z > b.max[2]) continue;
    const top = b.max[1];
    if (top <= y + 0.05 && top > best) best = top;
  }
  return best;
}

// ---- the follow camera ------------------------------------------------------------------------

/** The follow camera's numbers (render/camera.ts uses these). */
export const CAM = {
  PITCH: 0.36,
  /** The cut-away interiors' pitch: the camera looks down over the walls. */
  PITCH_CUTAWAY: 1.0,
  DIST: 7,
  /** It looks at a point this far above the capsule's centre. */
  LOOK_H: 0.9,
  /** Closest it pulls in to the look point, and how far in front of what blocks it it stops. */
  MIN_PULL: 0.8,
  MARGIN: 0.25,
  /** It never goes below this height. */
  FLOOR_Y: 0.35,
  /** The near plane (the engine's PerspectiveCamera(60, …, 0.1, 400)). */
  NEAR: 0.1,
} as const;

/**
 * How far the camera stands from its look point along `dir` (unit, from the look point toward the
 * camera): `dist`, pulled in to just in front of the first box in the way (never closer than
 * MIN_PULL).
 */
export function boomLength(target: readonly number[], dir: readonly number[], dist: number, boxes: readonly Box[]): number {
  let d = dist;
  for (const b of boxes) {
    const t = rayBox(target, dir, b, d);
    if (t < d) d = Math.max(CAM.MIN_PULL, t - CAM.MARGIN);
  }
  return d;
}

// ---- the controller ---------------------------------------------------------------------------

/**
 * The stick (mx strafe right +, my forward +, each −1…1) turned into a world-space move by the
 * camera yaw, given as its sine and cosine (three.js yaw 0 looks down −z: forward = (−sin, −cos),
 * right = (cos, −sin)); longer than 1 (a diagonal) is cut to 1.
 */
export function stickToWorld(mx: number, my: number, s: number, c: number): [number, number] {
  let x = mx * c - my * s;
  let z = -mx * s - my * c;
  const len = Math.sqrt(x * x + z * z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  return [x, z];
}

/** A shot fired where the camera (or a controller) aims: a short push that way (sine and cosine of the aim yaw). */
export const aimPush = (s: number, c: number): [number, number] => [-s * 0.2, -c * 0.2];

/** A move component −1…1 as the int8 an InputFrame carries. */
export const q8 = (x: number) => Math.max(-127, Math.min(127, Math.round(x * 127)));
