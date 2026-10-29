// The air around a world: its sky and fog, the reflection map its glossy surfaces pick up, and what
// falls or drifts through it (rain, snow, dust, embers, bubbles…). One per engine; each world's look
// restyles it. Rain and snow follow the camera and stay outside a cut-away building's walls.
import type { Fog, Scene, Texture, Vector3, WebGPURenderer } from "three/webgpu";
import type { Drift, LookStyle } from "./looks";
import { makeParticles, type Particles } from "./particles";
import { makeRain } from "./rain";
import { applySky, environment, makeFog, skyNode } from "./sky";

type Box2 = { minX: number; maxX: number; minZ: number; maxZ: number };

export class Atmosphere {
  readonly #renderer: WebGPURenderer;
  readonly #scene: Scene;
  readonly #rain = makeRain();
  readonly #drift = new Map<Exclude<Drift, "">, Particles>();
  /** Reflection maps by look, made the first time a look is seen (the neon one at boot). */
  readonly #envs = new Map<string, { texture: Texture; dispose(): void }>();
  #floorY = 0;

  constructor(renderer: WebGPURenderer, scene: Scene) {
    this.#renderer = renderer;
    this.#scene = scene;
    scene.backgroundNode = skyNode();
    scene.fog = makeFog();
    const env = environment(renderer);
    this.#envs.set("neon", env);
    scene.environment = env.texture;
    scene.environmentIntensity = 0.8;
    scene.add(this.#rain.object);
  }

  /** Restyle for a world's look: sky, fog, reflections, rain and drift (`shelter`: the building's walls). */
  apply(look: LookStyle, shelter: Box2 | null, floorY: number) {
    applySky(look, this.#scene.fog as Fog);
    const key = look.id === "neon" ? "neon" : `${look.id}:${look.variant}:${look.phase}:${look.rain ? "wet" : ""}`;
    let env = this.#envs.get(key);
    if (!env) {
      env = environment(this.#renderer, look.envLights);
      this.#envs.set(key, env);
    }
    this.#scene.environment = env.texture;
    this.#scene.environmentIntensity = look.env;
    this.#rain.object.visible = look.rain;
    this.#rain.shelter(look.indoor ? shelter : null);
    this.#floorY = floorY;
    for (const p of this.#drift.values()) p.object.visible = false;
    if (look.drift) {
      let p = this.#drift.get(look.drift);
      if (!p) {
        p = makeParticles(look.drift);
        this.#drift.set(look.drift, p);
        this.#scene.add(p.object);
      }
      p.object.visible = true;
      p.shelter(look.indoor ? shelter : null);
    }
  }

  /** Where the camera (or headset) is: the weather's box follows it. */
  follow(p: Vector3) {
    this.#rain.follow(p);
    for (const d of this.#drift.values()) if (d.object.visible) d.follow(p, this.#floorY);
  }

  dispose() {
    this.#rain.dispose();
    for (const d of this.#drift.values()) d.dispose();
    for (const e of this.#envs.values()) e.dispose();
  }
}
