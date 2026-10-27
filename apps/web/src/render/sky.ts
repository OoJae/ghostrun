// Night sky, fog and a procedural neon environment map (PMREM of a tiny emissive scene) so wet
// asphalt and building glass pick up magenta/cyan reflections without any asset files.
import { BackSide, BoxGeometry, Color, Fog, Mesh, MeshBasicNodeMaterial, PMREMGenerator, Scene, SphereGeometry, type WebGPURenderer, type Texture } from "three/webgpu";
import { abs, exp, mix, positionWorldDirection, smoothstep, uniform, vec3 } from "three/tsl";
import type { LookStyle } from "./looks";
import { PALETTE, lin } from "./materials";

const v3 = (hex: string, scale = 1) => {
  const [r, g, b] = lin(hex, scale);
  return vec3(r, g, b);
};

const GLOW = 0.075;

// Sky colours are uniforms, so each world's look restyles the sky without recompiling it.
const sky = {
  zenith: uniform(new Color(...lin(PALETTE.sky))),
  horizon: uniform(new Color(...lin(PALETTE.horizon))),
  glow: uniform(new Color(...lin(PALETTE.magenta, GLOW))),
};

/** Gradient from a tinted horizon haze to the zenith (neon: magenta haze, near-black zenith). */
export function skyNode() {
  const y = positionWorldDirection.y;
  const base = mix(sky.horizon, sky.zenith, smoothstep(-0.05, 0.42, y));
  return base.add(sky.glow.mul(exp(abs(y).mul(-12))));
}

/** Restyle the sky and fog for a world's look (the neon fog keeps its horizon-matched colour). */
export function applySky(look: LookStyle, fog: Fog) {
  sky.zenith.value.setRGB(...lin(look.sky.zenith));
  sky.horizon.value.setRGB(...lin(look.sky.horizon));
  sky.glow.value.setRGB(...lin(look.sky.glow, look.sky.glowScale));
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

export function neonEnvironment(renderer: WebGPURenderer): { texture: Texture; dispose(): void } {
  const env = new Scene();
  const skyMat = new MeshBasicNodeMaterial({ side: BackSide });
  skyMat.colorNode = skyNode();
  const sky = new Mesh(new SphereGeometry(60, 32, 16), skyMat);
  env.add(sky);

  const box = new BoxGeometry(1, 1, 1);
  const mats = [
    new MeshBasicNodeMaterial({ color: new Color(...lin(PALETTE.magenta, 3)) }),
    new MeshBasicNodeMaterial({ color: new Color(...lin(PALETTE.cyan, 3)) }),
    new MeshBasicNodeMaterial({ color: new Color(...lin("#ffb070", 1.6)) }),
  ];
  const n = 28;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 26 + rnd(i) * 10;
    const w = 2 + rnd(i + 50) * 6;
    const h = 0.4 + rnd(i + 100) * 1.4;
    const y = 1 + rnd(i + 150) * 9;
    const m = new Mesh(box, mats[i % 3]!);
    m.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    m.scale.set(w, h, 0.3);
    m.lookAt(0, y, 0);
    env.add(m);
  }

  const pmrem = new PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.035, 0.1, 100);
  pmrem.dispose();
  skyMat.dispose();
  sky.geometry.dispose();
  box.dispose();
  for (const m of mats) m.dispose();
  return { texture: rt.texture, dispose: () => rt.dispose() };
}
