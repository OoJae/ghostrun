// The sky, fog and a procedural environment map (PMREM of a tiny emissive scene) so glossy floors,
// wet asphalt and metal pick up the look's light without any asset files. One sky program serves
// every look: its gradient, sun or moon, stars, aurora, nebula and clouds are uniforms, and each
// layer is skipped in the shader when its amount is zero.
import { BackSide, BoxGeometry, Color, Fog, Mesh, MeshBasicNodeMaterial, PMREMGenerator, Scene, SphereGeometry, Vector3, type WebGPURenderer, type Texture } from "three/webgpu";
import { Fn, If, abs, exp, float, floor, fract, fwidth, hash, length, max, mix, mx_fractal_noise_float, mx_noise_float, oneMinus, positionWorldDirection, pow, sin, smoothstep, time, uniform, vec3 } from "three/tsl";
import type { LookStyle } from "./looks";
import { PALETTE, lin } from "./materials";

const GLOW = 0.075;

// Sky colours are uniforms, so each world's look restyles the sky without recompiling it.
const sky = {
  zenith: uniform(new Color(...lin(PALETTE.sky))),
  horizon: uniform(new Color(...lin(PALETTE.horizon))),
  glow: uniform(new Color(...lin(PALETTE.magenta, GLOW))),
  sunDir: uniform(new Vector3(0, 1, 0)),
  sunColor: uniform(new Color(0, 0, 0)),
  /** cos of the disc's angular radius */
  sunCos: uniform(0.9995),
  halo: uniform(0),
  stars: uniform(0),
  aurora: uniform(0),
  nebula: uniform(0),
  clouds: uniform(0),
  cloudColor: uniform(new Color(1, 1, 1)),
};

/** Gradient from a tinted horizon haze to the zenith, then whichever layers the look turns on. */
export function skyNode() {
  return Fn(() => {
    const d = positionWorldDirection;
    const y = d.y;
    const col = mix(sky.horizon, sky.zenith, smoothstep(-0.05, 0.42, y)).add(sky.glow.mul(exp(abs(y).mul(-12)))).toVar();
    const up = smoothstep(-0.02, 0.1, y);

    // the sun or the moon: a soft-edged disc and two halos
    const c = max(d.dot(sky.sunDir), 0);
    const disc = smoothstep(sky.sunCos.sub(0.00035), sky.sunCos, c).mul(up);
    col.addAssign(sky.sunColor.mul(disc.add(pow(c, 64).mul(sky.halo).mul(0.08)).add(pow(c, 6).mul(sky.halo).mul(0.012))));

    If(sky.stars.greaterThan(0), () => {
      // one star in some cells of a grid over the sky's directions, each its own brightness and twinkle
      const p = d.mul(115);
      const seed = floor(p.x).add(floor(p.y).mul(157)).add(floor(p.z).mul(113)).add(60000);
      const h = hash(seed);
      const at = vec3(hash(seed.add(17)), hash(seed.add(31)), hash(seed.add(53))).sub(0.5).mul(0.6);
      const w = fwidth(p.x).add(fwidth(p.y)).mul(0.5);
      const r = length(fract(p).sub(0.5).sub(at));
      const twinkle = sin(time.mul(hash(seed.add(71)).mul(3).add(1)).add(h.mul(40))).mul(0.3).add(0.7);
      const star = smoothstep(w.add(0.16), float(0), r).mul(smoothstep(0.92, 0.922, h)).mul(hash(seed.add(89)).mul(1.6).add(0.3)).mul(twinkle);
      col.addAssign(vec3(0.85, 0.9, 1).mul(star).mul(sky.stars).mul(smoothstep(0, 0.25, y)).mul(2.2));
    });

    If(sky.nebula.greaterThan(0), () => {
      // drifting gas clouds along a galactic band
      const band = exp(abs(d.dot(vec3(0.32, 0.88, -0.35))).mul(-4));
      const n = mx_fractal_noise_float(d.mul(2.2), 3, 2, 0.5);
      const tint = mx_noise_float(d.mul(3.1).add(7.3)).mul(0.5).add(0.5);
      const gas = smoothstep(-0.1, 0.55, n.add(band.mul(0.45))).mul(band.mul(0.7).add(0.3));
      col.addAssign(mix(vec3(0.32, 0.08, 0.45), vec3(0.04, 0.3, 0.42), tint).mul(gas).mul(sky.nebula).mul(0.5));
    });

    If(sky.aurora.greaterThan(0), () => {
      // green curtains folding over the sky, violet at their tops
      const q = d.xz.div(y.add(0.28));
      const n = mx_noise_float(vec3(q.x.mul(0.8), q.y.mul(0.8), time.mul(0.05)));
      const curtain = exp(abs(sin(q.x.mul(1.1).add(q.y.mul(0.5)).add(n.mul(3.2)))).mul(-5));
      const mask = smoothstep(0.06, 0.25, y).mul(oneMinus(smoothstep(0.45, 0.9, y)));
      const tint = mix(vec3(0.1, 1, 0.5), vec3(0.55, 0.2, 1), smoothstep(0.25, 0.65, y));
      col.addAssign(tint.mul(curtain).mul(mask).mul(n.mul(0.4).add(0.6)).mul(sky.aurora).mul(0.55));
    });

    If(sky.clouds.greaterThan(0), () => {
      // a layer of soft clouds overhead, thinning to the horizon
      const q = d.xz.div(max(y, 0.02).add(0.12)).mul(0.55);
      const n = mx_fractal_noise_float(vec3(q.x.add(time.mul(0.008)), q.y, 3.7), 3, 2, 0.5).mul(0.5).add(0.5);
      const cover = smoothstep(float(0.62).sub(sky.clouds.mul(0.42)), float(0.92).sub(sky.clouds.mul(0.3)), n);
      const fade = smoothstep(0.01, 0.2, y);
      col.assign(mix(col, sky.cloudColor.mul(n.mul(0.25).add(0.8)), cover.mul(fade).mul(sky.clouds.mul(1.3).min(0.95))));
    });
    return col;
  })();
}


const _dir = new Vector3();

/** Where a look's sun (or moon) is: the directional light comes from here too. */
export function sunDirection(look: LookStyle, out = _dir): Vector3 {
  const { elevation: e, azimuth: a } = look.sun;
  return out.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
}

/** Restyle the sky and fog for a world's look (the neon fog keeps its horizon-matched colour). */
export function applySky(look: LookStyle, fog: Fog) {
  const s = look.sky;
  sky.zenith.value.setRGB(...lin(s.zenith));
  sky.horizon.value.setRGB(...lin(s.horizon));
  sky.glow.value.setRGB(...lin(s.glow, s.glowScale));
  sky.sunDir.value.copy(sunDirection(look));
  sky.sunColor.value.setRGB(...lin(s.sun?.color ?? "#000000", s.sun?.scale ?? 0));
  sky.sunCos.value = Math.cos(s.sun?.size ?? 0.03);
  sky.halo.value = s.sun?.halo ?? 0;
  sky.stars.value = s.stars ?? 0;
  sky.aurora.value = s.aurora ?? 0;
  sky.nebula.value = s.nebula ?? 0;
  sky.clouds.value = s.clouds ?? 0;
  sky.cloudColor.value.setRGB(...lin(s.cloudColor ?? "#ffffff"));
  fog.color.copy(look.fog.color ? new Color(...lin(look.fog.color)) : makeFog().color);
  fog.near = look.fog.near;
  fog.far = look.fog.far;
}

/** Fog colour matched to the sky at the horizon so the skyline dissolves into the haze. */
export function makeFog(): Fog {
  const h = lin(PALETTE.horizon);
  const m = lin(PALETTE.magenta, GLOW);
  const c = new Color().setRGB(h[0] + m[0] * 0.7, h[1] + m[1] * 0.7, h[2] + m[2] * 0.7);
  return new Fog(c, 14, 100);
}

/** Small deterministic hash for cosmetic placement (not part of the simulation). */
const rnd = (i: number) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const NEON_LIGHTS = [[PALETTE.magenta, 3], [PALETTE.cyan, 3], ["#ffb070", 1.6]] as const;

/**
 * The reflection map: the current sky plus a ring of glowing panels in the look's light colours
 * (the neon city's magenta, cyan and sodium orange by default), prefiltered once per look.
 */
export function environment(renderer: WebGPURenderer, lights: readonly (readonly [string, number])[] = NEON_LIGHTS): { texture: Texture; dispose(): void } {
  const env = new Scene();
  const skyMat = new MeshBasicNodeMaterial({ side: BackSide });
  skyMat.colorNode = skyNode();
  const sphere = new Mesh(new SphereGeometry(60, 32, 16), skyMat);
  env.add(sphere);

  const box = new BoxGeometry(1, 1, 1);
  const mats = lights.map(([hex, scale]) => new MeshBasicNodeMaterial({ color: new Color(...lin(hex, scale)) }));
  const n = lights.length ? 28 : 0;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 26 + rnd(i) * 10;
    const w = 2 + rnd(i + 50) * 6;
    const h = 0.4 + rnd(i + 100) * 1.4;
    const y = 1 + rnd(i + 150) * 9;
    const m = new Mesh(box, mats[i % mats.length]!);
    m.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    m.scale.set(w, h, 0.3);
    m.lookAt(0, y, 0);
    env.add(m);
  }

  const pmrem = new PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.035, 0.1, 100);
  pmrem.dispose();
  skyMat.dispose();
  sphere.geometry.dispose();
  box.dispose();
  for (const m of mats) m.dispose();
  return { texture: rt.texture, dispose: () => rt.dispose() };
}

/** The neon city's reflection map (the one every world started with). */
export const neonEnvironment = (renderer: WebGPURenderer) => environment(renderer);
