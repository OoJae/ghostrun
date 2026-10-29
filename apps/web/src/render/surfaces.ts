// Procedural surfaces for the looks' statics and grounds: world-space patterns (strata, masonry,
// planks, panels, stripes, ripples) computed in the shader from position and normal, so a box of
// any size reads as stone, wood or metal without a texture or a UV. All TSL from core nodes, so
// every pattern compiles to WGSL and to GLSL ES 3.0 alike.
import { Color, MeshStandardNodeMaterial, type Node } from "three/webgpu";
import {
  abs, attribute, cross, dFdx, dFdy, dot, float, floor, fract, fwidth, hash, max, mix, mx_noise_float, normalView, normalWorld, normalize,
  oneMinus, positionView, positionWorld, select, sign, smoothstep, step, time, vec3, vertexColor,
} from "three/tsl";

export type N = Node<"float">;
export type N3 = Node<"vec3">;

/** Statics classes, written into each box's aStyle.x so one material dresses them all differently. */
export const CLS = { ground: 0, path: 1, wall: 2, ledge: 3, cover: 4, trim: 5 } as const;

/** What a surface is at one point: its colour (times the box's vertex colour), finish and relief. */
export interface Paint {
  color: N3;
  roughness?: N;
  metalness?: N;
  emissive?: N3;
  /** A height (metres) whose slope bends the normal: grooves, seams, ripples. */
  bump?: N;
}

/** Where a fragment is, for a paint function. */
export interface At {
  p: N3;
  n: N3;
  /** 1 on an upward face, 0 on a side. */
  top: N;
  /** A face's own 2D coordinates: along a wall and up it, or x and z on a top (for masonry, planks). */
  along: N;
  up: N;
  cls: N;
  seed: N;
  /** aStyle.z: a wall's full height (cut-away walls), else free per look. */
  extra: N;
  /** aStyle.w: free per look (a pattern switch). */
  alt: N;
}

/** 1 where the class is `k`. */
export const is = (cls: N, k: number) => step(k - 0.5, cls).mul(step(cls, k + 0.5));

/** Anti-aliased band [a, b] of a repeating 0..1 coordinate (fades to its average when tiny). */
export function band(f: N, w: N, a: number, b: number): N {
  return smoothstep(float(a).sub(w), float(a).add(w), f).mul(oneMinus(smoothstep(float(b).sub(w), float(b).add(w), f)));
}

/** Seams of a grid of cells (0 inside a cell, 1 on a seam), anti-aliased. */
export function seams(u: N, v: N, width: number): N {
  const wu = fwidth(u).max(1e-4);
  const wv = fwidth(v).max(1e-4);
  const su = oneMinus(band(fract(u), wu, width, 1 - width));
  const sv = oneMinus(band(fract(v), wv, width, 1 - width));
  // far away the seams melt into the cell colour instead of shimmering
  const lod = oneMinus(smoothstep(0.15, 0.45, max(wu, wv)));
  return max(su, sv).mul(lod);
}

/** Running-bond masonry: the mortar mask and a per-block hash (block w × h metres). */
export function masonry(u: N, v: N, w: number, h: number, mortar = 0.05) {
  const row = floor(v.div(h));
  const uu = u.div(w).add(row.mul(0.5));
  const vv = v.div(h);
  return { mortar: seams(uu, vv, mortar), id: hash(floor(uu).add(row.mul(131)).add(5000)) };
}

/** Planks along u (each `w` wide, ends staggered every `len`): the seam mask and a per-plank hash. */
export function planks(u: N, v: N, w: number, len: number) {
  const row = floor(v.div(w));
  const uu = u.div(len).add(hash(row.add(77)).mul(3));
  return { seam: seams(uu, v.div(w), 0.02), id: hash(floor(uu).add(row.mul(57)).add(9000)) };
}

/** Value noise, 0..1. */
export const noise01 = (p: N3, scale: number, offset = 0) => mx_noise_float(p.mul(scale).add(offset)).mul(0.5).add(0.5);

/** A normal bent by the slope of `h` (screen-space derivatives: works on any procedural height). */
export function bumped(h: N, strength: number): N3 {
  const dpdx = dFdx(positionView);
  const dpdy = dFdy(positionView);
  const n = normalView;
  const r1 = cross(dpdy, n);
  const r2 = cross(n, dpdx);
  const det = dot(dpdx, r1);
  const grad = sign(det).mul(dFdx(h).mul(strength).mul(r1).add(dFdy(h).mul(strength).mul(r2)));
  return normalize(abs(det).mul(n).sub(grad));
}

/**
 * The material for a look's batched statics: vertex colour times the look's paint, which can tell
 * a top from a side and one class of static from another (aStyle: x class, y seed, z extra).
 */
export function staticsMaterial(paint: (at: At) => Paint, o: { roughness?: number; metalness?: number; bump?: number } = {}): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: o.roughness ?? 0.85, metalness: o.metalness ?? 0 });
  const style = attribute("aStyle", "vec4");
  const p = positionWorld;
  const n = normalWorld;
  const at: At = {
    p,
    n,
    top: step(0.5, n.y),
    along: select(n.y.greaterThan(0.5), p.x, select(abs(n.x).greaterThan(abs(n.z)), p.z, p.x)),
    up: select(n.y.greaterThan(0.5), p.z, p.y),
    cls: style.x,
    seed: floor(style.y.add(0.5)),
    extra: style.z,
    alt: style.w,
  };
  const out = paint(at);
  m.colorNode = vertexColor().mul(out.color);
  if (out.roughness) m.roughnessNode = out.roughness;
  if (out.metalness) m.metalnessNode = out.metalness;
  if (out.emissive) m.emissiveNode = out.emissive;
  if (out.bump && o.bump) m.normalNode = bumped(out.bump, o.bump);
  return m;
}

/** A ground plane's material from a paint function (no vertex colours: the paint is the colour). */
export function groundMaterial(paint: (p: N3) => Paint, o: { roughness?: number; metalness?: number; bump?: number } = {}): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: o.roughness ?? 0.9, metalness: o.metalness ?? 0 });
  const res = paint(positionWorld);
  m.colorNode = res.color;
  if (res.roughness) m.roughnessNode = res.roughness;
  if (res.metalness) m.metalnessNode = res.metalness;
  if (res.emissive) m.emissiveNode = res.emissive;
  if (res.bump && o.bump) m.normalNode = bumped(res.bump, o.bump);
  return m;
}

/**
 * Water, ice, lava, slime: a flat surface with slow moving ripples. With `glow` it lights itself
 * (lava, plasma, a bioluminescent pool); with a low `flow` it barely moves (ice).
 */
export function liquidMaterial(o: { deep: string; shallow: string; glow?: string; glowScale?: number; roughness?: number; metalness?: number; flow?: number }): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: o.roughness ?? 0.08, metalness: o.metalness ?? 0.1 });
  const p = positionWorld;
  const t = time.mul(o.flow ?? 1);
  const a = mx_noise_float(vec3(p.x.mul(0.45).add(t.mul(0.12)), p.z.mul(0.45), t.mul(0.1)));
  const b = mx_noise_float(vec3(p.x.mul(1.3), p.z.mul(1.3).sub(t.mul(0.2)), t.mul(0.17).add(4)));
  const ripple = a.mul(0.6).add(b.mul(0.4)).mul(0.5).add(0.5);
  m.colorNode = mix(hex3(o.deep), hex3(o.shallow), ripple);
  if (o.glow) m.emissiveNode = hex3(o.glow, o.glowScale ?? 1).mul(ripple.pow(2).mul(0.8).add(0.2));
  m.normalNode = bumped(ripple, 0.06);
  return m;
}

/** A colour constant for a paint function (sRGB hex, optionally HDR-scaled). */
export const hex3 = (hex: string, scale = 1) => {
  const c = new Color(hex);
  return vec3(c.r * scale, c.g * scale, c.b * scale);
};

/** Rows of book spines up a wall: a tone and a tint, each book its own height and colour. */
export function books(along: N, up: N) {
  const row = floor(up.div(0.42));
  const spine = floor(along.div(0.07).add(hash(row).mul(10)));
  const hb = hash(spine.add(row.mul(97)));
  const f = fract(up.div(0.42));
  const shelf = smoothstep(0.06, 0.0, f);
  const tall = step(f, hb.mul(0.25).add(0.7));
  const tone = mix(float(0.22), mix(float(0.55), float(1.15), hb), tall).mul(oneMinus(shelf.mul(0.6)));
  const tint = mix(hex3("#9a3a2a"), mix(hex3("#2a5a3a"), hex3("#2a3a7a"), step(0.5, hash(spine.mul(3)))), step(0.4, hb));
  return { tone, tint: mix(tint, hex3("#c8a060"), step(0.85, hash(spine.mul(5)))) };
}
