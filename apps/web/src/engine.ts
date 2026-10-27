// Owns the renderer, the scene, the camera and the active FrameSource. The renderer reads entity
// transforms only from FrameSource poses (interpolated one tick behind for smooth display).
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { pass } from "three/tsl";
import {
  ACESFilmicToneMapping, PerspectiveCamera, Quaternion, RenderPipeline, Scene, WebGPURenderer,
} from "three/webgpu";
import { InputCollector } from "./input";
import type { World } from "./pipeline";
import { probe } from "./probe";
import { FollowCamera } from "./render/camera";
import { makeRain } from "./render/rain";
import { makeFog, neonEnvironment, skyNode } from "./render/sky";
import { buildWorldView, type WorldView } from "./render/world";
import { StubSim } from "./sim/stub";
import type { RapierSim } from "./sim/rapier";
import { PLAYER_ID, TICK_HZ, type FrameSource, type SimFrame } from "./sim/types";

export type SimFactory = (bundle: World["bundle"]) => RapierSim;

export interface EngineOptions {
  forceWebGL?: boolean;
  bloom?: boolean;
  /** Pin the pixel ratio (disables the resolution governor). Default: min(devicePixelRatio, 2). */
  pixelRatio?: number;
  /** MSAA samples for the scene pass (0 or 4). Default 4. */
  msaa?: number;
}

export interface LoadResult {
  ttffMs: number;
  splits: { label: string; ms: number }[];
}

const TICK_MS = 1000 / TICK_HZ;
const _q0 = new Quaternion();
const _q1 = new Quaternion();

export class Engine {
  readonly backend: "webgpu" | "webgl2";
  /** Renderer init plus one-off GPU setup (environment map). */
  readonly initMs: number;
  readonly #renderer: WebGPURenderer;
  readonly #scene = new Scene();
  readonly #camera = new PerspectiveCamera(60, 1, 0.1, 400);
  readonly #pipeline: RenderPipeline | null;
  readonly #follow: FollowCamera;
  readonly #input = new InputCollector();
  readonly #rain = makeRain();
  readonly #env: { dispose(): void };
  readonly #canvas: HTMLCanvasElement;

  #view: WorldView | null = null;
  #sim: FrameSource | null = null;
  /** Set once Rapier has loaded; until then (or if it fails) the stub keeps the world walkable. */
  simFactory: SimFactory | null = null;
  /** The live deterministic sim of the current world, when the factory is set. */
  rapierSim: RapierSim | null = null;
  #prev: SimFrame | null = null;
  #curr: SimFrame | null = null;
  #currAt = 0;
  #lastT = 0;
  #frames = 0;
  #fpsT0 = 0;
  #slowWindows = 0;
  readonly #dts: number[] = [];
  #governAfter = 0;
  readonly #pinned: boolean;
  #firstFrame: ((t: number) => void) | null = null;
  #onResize = () => this.#resize();

  onInput: (() => void) | undefined;

  private constructor(canvas: HTMLCanvasElement, renderer: WebGPURenderer, opts: EngineOptions, initMs: number) {
    this.#canvas = canvas;
    this.#renderer = renderer;
    this.initMs = initMs;
    this.backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl2";

    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    this.#pinned = opts.pixelRatio !== undefined;
    renderer.setPixelRatio(opts.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2));

    const s = this.#scene;
    s.backgroundNode = skyNode();
    s.fog = makeFog();
    const tEnv = performance.now();
    const env = neonEnvironment(renderer);
    this.initMs += performance.now() - tEnv;
    s.environment = env.texture;
    s.environmentIntensity = 0.8;
    this.#env = env;
    s.add(this.#rain.object);

    if (opts.bloom !== false) {
      const p = new RenderPipeline(renderer);
      const scenePass = pass(s, this.#camera, { samples: opts.msaa ?? 4 });
      const color = scenePass.getTextureNode("output");
      p.outputNode = color.add(bloom(color, 0.85, 0.45, 0.85));
      this.#pipeline = p;
    } else {
      this.#pipeline = null;
    }

    this.#follow = new FollowCamera(this.#camera, canvas);
    this.#follow.onUserOrbit = () => this.#input.markInput();
    this.#input.onInput = () => this.onInput?.();
    this.#input.onChange = () => this.#pushInput();

    window.addEventListener("resize", this.#onResize);
    this.#resize();

    const pr = probe();
    pr.backend = this.backend;
    pr.ready = false;
    pr.fps = 0;
  }

  static async create(canvas: HTMLCanvasElement, opts: EngineOptions = {}): Promise<Engine> {
    const t0 = performance.now();
    const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: opts.forceWebGL === true, powerPreference: "high-performance" });
    await renderer.init();
    return new Engine(canvas, renderer, opts, performance.now() - t0);
  }

  /** Swap in a new world. Resolves after its first frame has been rendered. */
  async load(world: World, startedAt: number): Promise<LoadResult> {
    const splits: LoadResult["splits"] = [
      { label: "fill", ms: world.timings.fillMs },
      { label: "layout", ms: world.timings.layoutMs },
    ];
    const pr = probe();
    pr.ready = false;
    this.#unload();
    // Frames rendered while the new world compiles must not apply the old world's poses.
    this.#prev = this.#curr = null;

    let t = performance.now();
    const view = buildWorldView(world.bundle);
    this.#scene.add(view.root);
    this.#view = view;
    this.#follow.setColliders(view.colliders);
    const sim = this.simFactory ? this.simFactory(world.bundle) : new StubSim(world.bundle);
    this.rapierSim = this.simFactory ? (sim as RapierSim) : null;
    this.#follow.reset(sim.spawnYaw);
    const player = view.actors.get(PLAYER_ID);
    if (player) this.#follow.update(0, player.position);
    splits.push({ label: "build", ms: performance.now() - t });

    t = performance.now();
    await this.#renderer.compileAsync(this.#scene, this.#camera);
    splits.push({ label: "compile", ms: performance.now() - t });

    this.#sim = sim;
    sim.start((f) => {
      this.#prev = this.#curr ?? f;
      this.#curr = f;
      this.#currAt = performance.now();
      const pp = f.poses.get(PLAYER_ID);
      if (pp) pr.player = [round2(pp.p[0]), round2(pp.p[1]), round2(pp.p[2])];
      pr.tick = f.tick;
    });

    t = performance.now();
    const firstAt = await new Promise<number>((resolve) => {
      this.#firstFrame = resolve;
      if (!this.#renderer.getAnimationLoop()) {
        this.#lastT = performance.now();
        this.#fpsT0 = this.#lastT;
        void this.#renderer.setAnimationLoop(() => this.#frame());
      }
    });
    splits.push({ label: "frame", ms: firstAt - t });
    const ttffMs = firstAt - startedAt;
    pr.ttffMs = Math.round(ttffMs);
    pr.splits = Object.fromEntries([["gpu init", Math.round(this.initMs)], ...splits.map((x) => [x.label, Math.round(x.ms)])]);
    // Shader warm-up frames are slow by nature; let the resolution governor settle first.
    this.#governAfter = performance.now() + 3000;
    this.#slowWindows = 0;
    pr.ready = true;
    return { ttffMs, splits };
  }

  dispose() {
    void this.#renderer.setAnimationLoop(null);
    this.#unload();
    this.#follow.dispose();
    this.#input.dispose();
    this.#rain.dispose();
    this.#env.dispose();
    window.removeEventListener("resize", this.#onResize);
    this.#renderer.dispose();
    probe().ready = false;
  }

  #unload() {
    this.#sim?.stop();
    this.#sim = null;
    this.#view?.dispose();
    this.#view = null;
  }

  #resize() {
    const w = this.#canvas.clientWidth || window.innerWidth;
    const h = this.#canvas.clientHeight || window.innerHeight;
    this.#renderer.setSize(w, h, false);
    this.#camera.aspect = w / Math.max(1, h);
    this.#camera.updateProjectionMatrix();
  }

  #pushInput() {
    this.#sim?.input(this.#input.sample((this.#curr?.tick ?? 0) + 1, this.#follow.yaw));
  }

  #applyPoses(now: number) {
    const view = this.#view;
    const curr = this.#curr;
    if (!view || !curr) return;
    const prev = this.#prev ?? curr;
    const a = Math.min(1, Math.max(0, (now - this.#currAt) / TICK_MS));
    for (const [id, pc] of curr.poses) {
      const obj = view.actors.get(id);
      if (!obj) continue;
      const pp = prev.poses.get(id) ?? pc;
      obj.position.set(
        pp.p[0] + (pc.p[0] - pp.p[0]) * a,
        pp.p[1] + (pc.p[1] - pp.p[1]) * a,
        pp.p[2] + (pc.p[2] - pp.p[2]) * a,
      );
      _q0.set(pp.q[0], pp.q[1], pp.q[2], pp.q[3]);
      _q1.set(pc.q[0], pc.q[1], pc.q[2], pc.q[3]);
      obj.quaternion.slerpQuaternions(_q0, _q1, a);
    }
  }

  #frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.#lastT) / 1000);
    this.#lastT = now;

    const view = this.#view;
    this.#pushInput();
    this.#applyPoses(now);

    const player = view?.actors.get(PLAYER_ID);
    if (player) {
      this.#follow.update(dt, player.position);
      this.#rain.follow(this.#camera.position);
    }
    view?.update(now / 1000);

    if (this.#pipeline) this.#pipeline.render();
    else this.#renderer.render(this.#scene, this.#camera);

    const pr = probe();
    this.#frames++;
    if (this.#dts.length < 512) this.#dts.push(dt);
    if (now - this.#fpsT0 >= 1000) {
      pr.fps = Math.round((this.#frames * 1000) / (now - this.#fpsT0));
      pr.drawCalls = this.#renderer.info.render.drawCalls;
      this.#frames = 0;
      this.#fpsT0 = now;
      this.#governor();
      pr.pixelRatio = this.#renderer.getPixelRatio();
    }

    if (this.#firstFrame) {
      const resolve = this.#firstFrame;
      this.#firstFrame = null;
      resolve(performance.now());
    }
  }

  /**
   * Dynamic resolution: drop the pixel ratio in 0.25 steps after two seconds whose median frame
   * time is over 20 ms (< 50 fps). The median ignores one-off stalls (GC, tab switches, captures).
   */
  #governor() {
    const dts = this.#dts.sort((a, b) => a - b);
    const median = dts[dts.length >> 1] ?? 0;
    dts.length = 0;
    if (this.#pinned || performance.now() < this.#governAfter) return;
    const pr = this.#renderer.getPixelRatio();
    if (median > 0.02 && pr > 1) {
      if (++this.#slowWindows >= 2) {
        this.#renderer.setPixelRatio(Math.max(1, pr - 0.25));
        this.#slowWindows = 0;
      }
    } else {
      this.#slowWindows = 0;
    }
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;
