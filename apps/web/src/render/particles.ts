// What drifts in the air (snow, dust, embers, motes, sparkles, bubbles, fireflies, ash, spores): one
// instanced sprite draw per kind, animated entirely in the vertex shader from a per-instance hash
// and `time`, wrapping in a box that follows the camera like the rain does. The CPU cost is a uniform
// update per frame. Cosmetic only: nothing here is seen by the simulation.
import { AdditiveBlending, NormalBlending, Sprite, SpriteNodeMaterial, Vector3, Vector4 } from "three/webgpu";
import { float, fract, hash, instanceIndex, length, mix, oneMinus, select, sin, smoothstep, step, time, uniform, uv, varying, vec2, vec3 } from "three/tsl";
import type { Drift } from "./looks";
import { lin } from "./materials";

interface Kind {
  count: number;
  /** The box around the camera the particles wrap in (x, y, z), metres. */
  box: [number, number, number];
  size: [number, number];
  /** Width over height on screen (wind-blown sand streaks). */
  stretch?: number;
  colors: readonly string[];
  /** HDR scale: above 1 blooms. */
  scale: number;
  additive: boolean;
  motion: "fall" | "rise" | "float";
  /** m/s along the motion; for "float", how far each one bobs. */
  speed: number;
  /** Side-to-side wander, metres. */
  sway: number;
  /** Wind along x, m/s. */
  wind?: number;
  /** Measured from the floor rather than the camera. */
  ground?: boolean;
  opacity: number;
  twinkle?: boolean;
  ring?: boolean;
  /** Kept outside the building's walls (weather, not air). */
  outside?: boolean;
}

const KINDS: Record<Exclude<Drift, "">, Kind> = {
  snow: { count: 1500, box: [44, 22, 44], size: [0.05, 0.11], colors: ["#ffffff"], scale: 1.4, additive: false, motion: "fall", speed: 1.3, sway: 0.6, wind: 0.4, opacity: 0.9, outside: true },
  dust: { count: 260, box: [36, 10, 36], size: [0.02, 0.05], colors: ["#fff0d0"], scale: 1.6, additive: true, motion: "float", speed: 0.5, sway: 1.2, wind: 0.6, ground: true, opacity: 0.5 },
  sandstorm: { count: 1800, box: [40, 14, 40], size: [0.025, 0.07], stretch: 5, colors: ["#d8a868", "#c08a50"], scale: 1.1, additive: false, motion: "float", speed: 0.8, sway: 0.4, wind: 13, ground: true, opacity: 0.4, outside: true },
  embers: { count: 170, box: [34, 9, 34], size: [0.03, 0.07], colors: ["#ff8a2a", "#ffc04a"], scale: 5, additive: true, motion: "rise", speed: 0.7, sway: 0.7, ground: true, opacity: 0.9, twinkle: true },
  motes: { count: 240, box: [30, 7, 30], size: [0.02, 0.045], colors: ["#fff4e0", "#cfe8ff"], scale: 2.2, additive: true, motion: "float", speed: 0.25, sway: 0.5, ground: true, opacity: 0.55 },
  sparkles: { count: 230, box: [34, 9, 34], size: [0.04, 0.09], colors: ["#ff8ad8", "#8affe0", "#ffe46a"], scale: 4, additive: true, motion: "float", speed: 0.35, sway: 0.6, ground: true, opacity: 0.9, twinkle: true },
  bubbles: { count: 260, box: [30, 14, 30], size: [0.05, 0.16], colors: ["#d8fbff"], scale: 1.3, additive: false, motion: "rise", speed: 1.1, sway: 0.25, ground: true, opacity: 0.7, ring: true },
  fireflies: { count: 110, box: [36, 5, 36], size: [0.05, 0.08], colors: ["#d9ff7a", "#a8ff9a"], scale: 7, additive: true, motion: "float", speed: 0.4, sway: 1.1, ground: true, opacity: 1, twinkle: true },
  ash: { count: 320, box: [36, 12, 36], size: [0.025, 0.06], colors: ["#c8c4d8", "#8a8698"], scale: 1, additive: false, motion: "fall", speed: 0.35, sway: 0.9, wind: 0.5, opacity: 0.55, outside: true },
  spores: { count: 260, box: [34, 8, 34], size: [0.025, 0.055], colors: ["#fff2a0", "#d8ff9a"], scale: 2.6, additive: true, motion: "float", speed: 0.35, sway: 0.8, wind: 0.3, ground: true, opacity: 0.7 },
};

export interface Particles {
  object: Sprite;
  /** Where the camera (or headset) is, and the floor under the world. */
  follow(p: Vector3, floorY: number): void;
  /** The building's footprint the weather stays out of (null: none). */
  shelter(box: { minX: number; maxX: number; minZ: number; maxZ: number } | null): void;
  dispose(): void;
}

export function makeParticles(kind: Exclude<Drift, "">): Particles {
  const k = KINDS[kind];
  const centre = uniform(new Vector3());
  const floor = uniform(0);
  const roof = uniform(new Vector4(0, 0, 0, 0)); // minX, minZ, maxX, maxZ
  const roofOn = uniform(0);
  const [bx, by, bz] = k.box;

  const i = instanceIndex.toFloat();
  const s1 = hash(i.add(0.37));
  const s2 = hash(i.add(17.71));
  const s3 = hash(i.add(41.29));
  const s4 = hash(i.add(73.93));
  const t = time;
  const wander = (ph: typeof s1, f: number) => sin(t.mul(float(f).add(s3.mul(f))).add(ph.mul(6.283))).mul(k.sway);

  // world-fixed modulo the box, so walking through them reads as moving through the air
  const fx = fract(s1.sub(centre.x.div(bx)).add(t.mul((k.wind ?? 0) / bx)));
  const fz = fract(s3.sub(centre.z.div(bz)));
  const fy = k.motion === "fall" ? fract(s2.sub(t.mul(k.speed / by))) : k.motion === "rise" ? fract(s2.add(t.mul(k.speed / by))) : s2;
  const baseY = k.ground ? floor.add(0.15) : centre.y.sub(by * 0.35);
  let y = fy.mul(by).add(baseY);
  if (k.motion === "float") y = y.add(sin(t.mul(float(0.4).add(s4.mul(0.6))).add(s1.mul(6.283))).mul(k.speed));
  const x = fx.sub(0.5).mul(bx).add(centre.x).add(wander(s2, 0.3));
  const z = fz.sub(0.5).mul(bz).add(centre.z).add(wander(s4, 0.23));
  // weather stays outside the walls: drops inside the building are moved out of sight
  const inside = roofOn.mul(step(roof.x, x)).mul(step(x, roof.z)).mul(step(roof.y, z)).mul(step(z, roof.w));
  const pos = vec3(x, select(inside.greaterThan(0.5), float(-1000), y), z);

  // fade at the box's faces so nothing pops in or out
  const edge = (f: typeof fx) => smoothstep(0, 0.08, f).mul(oneMinus(smoothstep(0.92, 1, f)));
  const fade = varying(edge(fx).mul(edge(fz)).mul(k.motion === "float" ? smoothstep(0, 0.1, fy) : edge(fy)));
  const seedV = varying(vec3(s1, s3, s4));

  const m = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: k.additive ? AdditiveBlending : NormalBlending });
  m.fog = !k.additive; // fog would add its own colour to an additive glow
  m.positionNode = pos;
  const size = mix(float(k.size[0]), float(k.size[1]), s4);
  m.scaleNode = vec2(size.mul(k.stretch ?? 1), size);
  const c = k.colors.map((h) => vec3(...lin(h, k.scale)));
  const pick = seedV.x;
  const col = c.length === 1 ? c[0]! : c.length === 2 ? mix(c[0]!, c[1]!, step(0.5, pick)) : mix(mix(c[0]!, c[1]!, step(0.34, pick)), c[2]!, step(0.67, pick));
  m.colorNode = col.mul(seedV.y.mul(0.4).add(0.8));
  const r = length(uv().sub(0.5)).mul(2);
  const shape = k.ring ? smoothstep(0.55, 0.85, r).mul(oneMinus(smoothstep(0.85, 1, r))).add(oneMinus(smoothstep(0, 0.25, length(uv().sub(vec2(0.36, 0.64))).mul(2))).mul(0.8)) : oneMinus(smoothstep(0, 1, r)).pow(1.6);
  const twinkle = k.twinkle ? sin(t.mul(seedV.z.mul(4).add(2.5)).add(seedV.x.mul(40))).mul(0.5).add(0.5).pow(2).mul(0.85).add(0.15) : float(1);
  m.opacityNode = shape.mul(fade).mul(twinkle).mul(k.opacity);

  const object = new Sprite(m);
  object.count = k.count;
  object.frustumCulled = false;
  object.renderOrder = 10;
  object.name = `drift:${kind}`;
  return {
    object,
    follow: (p, floorY) => {
      centre.value.copy(p);
      floor.value = floorY;
    },
    shelter: (b) => {
      roofOn.value = b ? 1 : 0;
      if (b) roof.value.set(b.minX, b.minZ, b.maxX, b.maxZ);
    },
    dispose: () => m.dispose(),
  };
}
