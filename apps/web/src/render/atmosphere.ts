// The air around a world: its sky and fog, the reflection map its glossy surfaces pick up, and what
// falls or drifts through it (rain, snow, dust, embers, bubbles…). One per engine; each world's look
// restyles it. Rain and snow follow the camera and stay outside a cut-away building's walls.
import { BackSide, Mesh, MeshBasicNodeMaterial, SphereGeometry, type Fog, type Scene, type Texture, type Vector3, type WebGPURenderer } from "three/webgpu";
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
  /**
   * The sky as a dome around the camera drawn after everything opaque, so its stars, clouds and
   * aurora are shaded only where sky shows (a scene background is shaded under every pixel).
   */
  readonly #sky: Mesh;
  #floorY = 0;

  constructor(renderer: WebGPURenderer, scene: Scene) {
    this.#renderer = renderer;
    this.#scene = scene;
    const dome = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false });
    dome.fog = false;
    dome.colorNode = skyNode();
    this.#sky = new Mesh(new SphereGeometry(1, 32, 16), dome);
    this.#sky.scale.setScalar(300); // inside the camera's far plane, beyond anything a world places
    this.#sky.renderOrder = 1e6;
    this.#sky.frustumCulled = false;
    this.#sky.name = "sky";
    scene.add(this.#sky);
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
      try {
        env = environment(this.#renderer, look.envLights);
        this.#envs.set(key, env);
      } catch (e) {
        // (an emulated headset can't render off screen while it presents): the last reflections stay
        console.warn("reflection map skipped", e);
      }
    }
    if (env) this.#scene.environment = env.texture;
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
    this.#sky.position.copy(p);
    this.#rain.follow(p);
    for (const d of this.#drift.values()) if (d.object.visible) d.follow(p, this.#floorY);
  }

  dispose() {
    this.#sky.geometry.dispose();
    (this.#sky.material as MeshBasicNodeMaterial).dispose();
    this.#rain.dispose();
    for (const d of this.#drift.values()) d.dispose();
    for (const e of this.#envs.values()) e.dispose();
  }
}
