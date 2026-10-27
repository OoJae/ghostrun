// Axis-aligned boxes derived from the placed bundle. Shared by the stub sim (collision) and the
// follow camera (occlusion). Statics are boxes with pos = centre and size = full extents; rotY is
// ignored here because city_block emits none (the real sim uses proper Rapier colliders).
import type { WorldBundle } from "@ghostrun/ir";

export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

const toBox = (pos: readonly number[], size: readonly number[]): Box => ({
  min: [pos[0]! - size[0]! / 2, pos[1]! - size[1]! / 2, pos[2]! - size[2]! / 2],
  max: [pos[0]! + size[0]! / 2, pos[1]! + size[1]! / 2, pos[2]! + size[2]! / 2],
});

/** Solid boxes a walker collides with: every static plus fixed/kinematic platforms. */
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
