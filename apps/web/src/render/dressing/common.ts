// What every look's dressing shares: which static is what (a floor, a path, a pillar, a perimeter
// wall, low cover), instanced props, merged multi-colour prop geometry, and a ring of distant
// silhouettes. Colliders are never changed: each static keeps its exact box, and props are drawn
// on, around or beyond it, never where they would hide a box the player collides with.
import type { Static, WorldBundle } from "@ghostrun/ir";
import {
  BufferGeometry, Color, Euler, Float32BufferAttribute, Group, InstancedMesh, Matrix4, Mesh, PointLight, Quaternion, Vector3, type Material,
} from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BoxBatch } from "../boxes";
import { INDOOR_PACKS } from "../pick";
import { CLS } from "../surfaces";

export interface Ctx {
  keep<T extends BufferGeometry | Material>(x: T): T;
  animated: ((t: number) => void)[];
  root: Group;
}

export type V3 = [number, number, number];
export type Box2 = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Cosmetic hash in [0, 1) (rendering only; the sim never sees it). */
export const rnd = (i: number) => {
  const x = Math.sin(i * 63.7264 + 10.873) * 43758.5453;
  return x - Math.floor(x);
};

export type Kind = "ground" | "floor" | "path" | "mound" | "water" | "hazard" | "ledge" | "trunk" | "boundary" | "wall" | "lintel" | "cover" | "block";

export interface Piece {
  s: Static;
  i: number;
  kind: Kind;
  min: V3;
  max: V3;
  top: number;
}

/** Walls of a cut-away interior draw to this height (the collider keeps its full height). */
export const CUT_H = 1.25;

/** Each static, named for what its shape is. */
export function classify(b: WorldBundle): { pieces: Piece[]; bounds: Box2; groundY: number } {
  const rooms = INDOOR_PACKS.has(b.pack.id) || b.pack.id === "maze";
  let main = { area: -1, top: 0, bounds: { minX: -30, maxX: 30, minZ: -30, maxZ: 30 } };
  for (const s of b.statics) {
    const area = s.size[0] * s.size[2];
    if (s.surf === "floor" && area > main.area) {
      main = { area, top: s.pos[1] + s.size[1] / 2, bounds: { minX: s.pos[0] - s.size[0] / 2, maxX: s.pos[0] + s.size[0] / 2, minZ: s.pos[2] - s.size[2] / 2, maxZ: s.pos[2] + s.size[2] / 2 } };
    }
  }
  const pieces = b.statics.map((s, i): Piece => {
    const [x, y, z] = s.pos;
    const [w, h, d] = s.size;
    const min: V3 = [x - w / 2, y - h / 2, z - d / 2];
    const max: V3 = [x + w / 2, y + h / 2, z + d / 2];
    const top = max[1];
    const kind = ((): Kind => {
      if (s.surf === "floor") return w * d >= main.area ? "ground" : h < 0.06 ? "path" : !rooms && top > main.top + 0.05 ? "mound" : "floor";
      if (s.surf === "water") return "water";
      if (s.surf === "hazard") return "hazard";
      if (s.surf === "ledge" || s.surf === "roof") return "ledge";
      if (rooms && h >= 1.6) return "wall";
      // the piece of wall over a doorway: above a cut-away's walls, so it is not drawn there
      if (rooms && min[1] >= main.top + CUT_H) return "lintel";
      if (Math.max(w, d) <= 1.0 && h >= 3) return "trunk";
      if (Math.min(w, d) <= 1.5 && Math.max(w, d) >= 8 && h >= 2.5) return "boundary";
      if (h < 2.5) return "cover";
      return "block";
    })();
    return { s, i, kind, min, max, top };
  });
  return { pieces, bounds: main.bounds, groundY: main.top };
}

/** The style a box carries into its look's statics material: class, seed, extra, alt. */
export const style = (cls: number, seed: number, extra = 0, alt = 0): [number, number, number, number] => [cls, seed, extra, alt];

/** A wall of a cut-away interior, drawn to CUT_H on its batch (the collider keeps its height). */
export function cutWall(batch: BoxBatch, p: Piece, rgb: V3, alt = 0) {
  const [x, , z] = p.s.pos;
  const [w, h, d] = p.s.size;
  const cut = Math.min(h, CUT_H);
  batch.add([x, p.min[1] + cut / 2, z], [w, cut, d], rgb, style(CLS.wall, p.i, h, alt));
}

export interface Item {
  p: V3;
  s: V3;
  /** Yaw. */
  r?: number;
  /** Lean, about x then z. */
  tilt?: [number, number];
  /** Per-instance colour (sRGB hex), optionally HDR-scaled. */
  color?: string;
  scale?: number;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _v = new Vector3();
const _s = new Vector3();
const _c = new Color();

/** Instances of one geometry and material (one draw call), with per-instance colours if any item has one. */
export function instances(c: Ctx, geo: BufferGeometry, mat: Material, items: readonly Item[], name = ""): InstancedMesh | null {
  if (!items.length) return null; // never uploaded, so nothing to free
  const mesh = new InstancedMesh(c.keep(geo), c.keep(mat), items.length);
  const coloured = items.some((it) => it.color);
  items.forEach((it, i) => {
    _e.set(it.tilt?.[0] ?? 0, it.r ?? 0, it.tilt?.[1] ?? 0, "YXZ");
    _q.setFromEuler(_e);
    mesh.setMatrixAt(i, _m.compose(_v.set(...it.p), _q, _s.set(...it.s)));
    if (coloured) mesh.setColorAt(i, _c.set(it.color ?? "#ffffff").multiplyScalar(it.scale ?? 1));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = name;
  c.root.add(mesh);
  return mesh;
}

export interface Part {
  geo: BufferGeometry;
  /** sRGB hex, or omitted for white (the instance colour then tints it). */
  color?: string;
  at?: V3;
  rot?: V3;
  scale?: V3;
}

/** One geometry from parts, each with its own vertex colour: a multi-colour prop in one draw. */
export function merged(parts: readonly Part[]): BufferGeometry {
  const geos = parts.map((p) => {
    const g = (p.geo.index ? p.geo.toNonIndexed() : p.geo.clone()) as BufferGeometry;
    for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k);
    _e.set(...(p.rot ?? [0, 0, 0]));
    g.applyMatrix4(_m.compose(_v.set(...(p.at ?? [0, 0, 0])), _q.setFromEuler(_e), _s.set(...(p.scale ?? [1, 1, 1]))));
    const col = _c.set(p.color ?? "#ffffff");
    const n = g.attributes.position!.count;
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) rgb.set([col.r, col.g, col.b], i * 3);
    g.setAttribute("color", new Float32BufferAttribute(rgb, 3));
    return g;
  });
  const out = mergeGeometries(geos, false)!;
  for (const g of geos) g.dispose();
  for (const p of parts) p.geo.dispose();
  out.computeBoundingSphere();
  return out;
}

/**
 * Points on a ring around the play area (for distant silhouettes the fog dissolves), between
 * `near` and `near + depth` metres beyond its edge.
 */
export function ring(bounds: Box2, count: number, near: number, depth: number, seed: number): { x: number; z: number; k: number }[] {
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const half = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2;
  return Array.from({ length: count }, (_, k) => {
    const a = (k / count) * Math.PI * 2 + rnd(seed + k) * 0.08;
    const r = half + near + rnd(seed + k * 3 + 1) * depth;
    return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r, k: seed + k };
  });
}

/** Up to `max` warm point lights (the world keeps eight in all, so the props' glow does the rest). */
export function lamps(c: Ctx, at: readonly V3[], hex: string, intensity: number, distance: number, max: number, flicker = 0): PointLight[] {
  const out = at.slice(0, max).map((p, i) => {
    const l = new PointLight(hex, intensity, distance, 1.6);
    l.position.set(...p);
    c.root.add(l);
    if (flicker > 0) c.animated.push((t) => (l.intensity = intensity * (1 - flicker + flicker * (0.6 + 0.25 * Math.sin(t * 9.3 + i * 4.1) + 0.15 * Math.sin(t * 23.7 + i)))));
    return l;
  });
  return out;
}

/** The parts of a look's dressing world.ts needs back. */
export interface Dressed {
  floorTops: number[];
  groundY: number;
  bounds: Box2;
  groundHex: string;
  ground?: Material;
  /** The building's footprint the weather stays out of. */
  shelter?: Box2 | null;
}

/** Add a batch as a mesh (skipped when empty). */
export function batchMesh(c: Ctx, batch: BoxBatch, mat: Material, name: string): Mesh | null {
  if (!batch.count) return null;
  const m = new Mesh(c.keep(batch.build()), c.keep(mat));
  m.name = name;
  c.root.add(m);
  return m;
}

/** Is (x, z) clear of every collider's footprint by `pad` metres? (props must not hide a wall) */
export function clear(pieces: readonly Piece[], x: number, z: number, pad: number, kinds: readonly Kind[] = ["wall", "boundary", "block", "cover", "ledge", "trunk"]): boolean {
  return !pieces.some((p) => kinds.includes(p.kind) && x > p.min[0] - pad && x < p.max[0] + pad && z > p.min[2] - pad && z < p.max[2] + pad);
}
