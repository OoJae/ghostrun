// Node materials for the Neon look. Everything is TSL built from core nodes that compile to both
// WGSL (WebGPU) and GLSL ES 3.0 (WebGL2 fallback). No textures except one canvas-drawn sign.
import { AdditiveBlending, Color, DoubleSide, MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import {
  Fn, abs, attribute, float, floor, fract, fwidth, hash, mix, mx_noise_float, normalView, normalWorld, oneMinus,
  positionViewDirection, positionWorld, select, sin, smoothstep, step, time, uv, vec3, vertexColor,
} from "three/tsl";

/** Palette (sRGB hex). Team colours are the brief's; neon pair is magenta + cyan. */
export const PALETTE = {
  red: "#ff3b5c",
  blue: "#3bb8ff",
  magenta: "#ff2bd6",
  cyan: "#19e3ff",
  orb: "#ffe45c",
  sky: "#04040b",
  horizon: "#171033",
  fog: "#110c24",
  asphalt: "#4a4a5a",
} as const;

/** Linear RGB triple of a palette colour, scaled (scale > 1 = HDR emissive that blooms). */
export function lin(hex: string, scale = 1): [number, number, number] {
  const c = new Color(hex);
  return [c.r * scale, c.g * scale, c.b * scale];
}

const v3 = (hex: string, scale = 1) => {
  const [r, g, b] = lin(hex, scale);
  return vec3(r, g, b);
};

/**
 * Dark building blocks with a procedural lit-window grid on the side faces.
 * aStyle: x = window amount (0 = none), y = per-box seed (integer), z = neon hue (0 magenta → 1 cyan).
 */
export function buildingMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: 0.62, metalness: 0.25 });
  const style = attribute("aStyle", "vec4");
  m.colorNode = vertexColor();
  m.emissiveNode = Fn(() => {
    const p = positionWorld;
    const n = normalWorld;
    const side = float(1).sub(step(0.5, abs(n.y)));
    const along = select(abs(n.x).greaterThan(abs(n.z)), p.z, p.x);
    const u = along.div(1.7);
    const v = p.y.sub(0.3).div(1.4);
    const fu = fract(u);
    const fv = fract(v);
    // Anti-aliased window pulse; fades to its average once a cell shrinks to a few pixels.
    const wu = fwidth(u).max(1e-4);
    const wv = fwidth(v).max(1e-4);
    const pulse = (f: typeof fu, w: typeof wu, a: number, b: number) =>
      smoothstep(float(a).sub(w), float(a).add(w), f).mul(oneMinus(smoothstep(float(b).sub(w), float(b).add(w), f)));
    const winU = pulse(fu, wu, 0.2, 0.8);
    const winV = pulse(fv, wv, 0.32, 0.8);
    // Integer cell id kept below 2^24; the seed is rounded because interpolated attributes jitter.
    const seed = floor(style.y.add(0.5));
    const cell = floor(u).add(2048).add(floor(v).add(32).mul(4096)).add(floor(hash(seed).mul(2048)).mul(262144).mod(8388608));
    const h = hash(cell);
    const h2 = hash(cell.add(7919));
    const lit = step(0.62, h);
    const neon = mix(v3(PALETTE.magenta), v3(PALETTE.cyan), style.z);
    const warm = vec3(1.0, 0.5, 0.22);
    const cool = vec3(0.55, 0.75, 1.0);
    const tint = mix(mix(warm, cool, step(0.6, h2)), neon.mul(1.3), step(0.8, h2));
    const flicker = float(0.85).add(step(0.985, h2).mul(fract(time.mul(1.7).add(h)).mul(0.6)));
    const near = winU.mul(winV).mul(lit).mul(flicker);
    const far = float(0.29 * 0.38 * 0.85);
    const lod = smoothstep(0.18, 0.45, wu.max(wv));
    const windows = mix(near, far, lod);
    const avgTint = mix(tint, vec3(0.75, 0.6, 0.55), lod);
    const aboveStreet = step(2.6, p.y);
    return avgTint.mul(windows.mul(side).mul(aboveStreet).mul(style.x).mul(0.9));
  })();
  return m;
}

/** Lit body with a fresnel rim in `rim` colour (the player reads against any background). */
export function rimBodyMaterial(hex: string, rim: string, rimScale: number): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ color: new Color(hex), roughness: 0.32, metalness: 0.1 });
  const f = oneMinus(abs(normalView.dot(positionViewDirection.negate()))).pow(2.5);
  m.emissiveNode = v3(rim, rimScale).mul(f);
  return m;
}

/** Wet asphalt: low-frequency puddle mask drives roughness down and darkens the base colour. */
export function groundMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0.0 });
  const xz = positionWorld.xz;
  const big = mx_noise_float(vec3(xz.x.mul(0.16), xz.y.mul(0.16), 0.5));
  const fine = mx_noise_float(vec3(xz.x.mul(1.3), xz.y.mul(1.3), 2.1));
  const puddle = smoothstep(0.16, 0.36, big.add(fine.mul(0.12)));
  const grain = fine.mul(0.5).add(0.5);
  // Coarse slab variation so the asphalt reads as a surface even from straight above.
  const slab = mx_noise_float(vec3(xz.x.mul(0.45), xz.y.mul(0.45), 7.3)).mul(0.5).add(0.5);
  m.colorNode = mix(v3(PALETTE.asphalt).mul(grain.mul(0.45).add(0.6)).mul(slab.mul(0.5).add(0.75)), vec3(0.012, 0.012, 0.02), puddle);
  m.roughnessNode = mix(float(0.62).add(grain.mul(0.2)), float(0.04), puddle);
  m.metalnessNode = mix(float(0.1), float(0.55), puddle);
  return m;
}

/** Unlit emissive using the HDR vertex colour (neon strips, ground markings). */
export function stripMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.colorNode = vertexColor();
  return m;
}

/** Unlit HDR colour, optionally additive/transparent (halos, ring glows). */
export function glowMaterial(hex: string, scale: number, opacity = 1): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ color: new Color(...lin(hex, scale)) });
  if (opacity < 1) {
    m.transparent = true;
    m.opacity = opacity;
    m.depthWrite = false;
  }
  return m;
}

/** Lit matte body (NPC / player capsules, platform slab). */
export function bodyMaterial(hex: string, roughness = 0.45, metalness = 0.2): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({ color: new Color(hex), roughness, metalness });
}

/** Additive light column that fades upward (spawn beacons). Cylinder uv.y is 0 at the bottom. */
export function beamMaterial(hex: string, scale: number, strength: number): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending });
  const fade = oneMinus(uv().y);
  const shimmer = sin(time.mul(2.2).add(uv().y.mul(14))).mul(0.15).add(0.85);
  m.colorNode = v3(hex, scale);
  m.opacityNode = fade.mul(fade).mul(shimmer).mul(strength);
  return m;
}
