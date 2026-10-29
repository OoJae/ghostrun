// Owns the renderer, the scene, the camera and the active FrameSource. The renderer reads entity
// transforms only from FrameSource poses (interpolated one tick behind for smooth display).
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { pass } from "three/tsl";
import {
  ACESFilmicToneMapping, BufferGeometry, CylinderGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, RenderPipeline, Scene, Vector3, WebGPURenderer,
} from "three/webgpu";
import { InputCollector } from "./input";
import type { WorldBundle } from "@ghostrun/ir";
import type { World } from "./pipeline";
import { probe } from "./probe";
import { FollowCamera } from "./render/camera";
import { ghostActor } from "./render/ghost";
import type { GhostTrack, Rival } from "./race";
import { combatView, type CombatView } from "./render/combat";
import { heatView, type HeatCells } from "./render/heat";
import { raceView, type RaceView } from "./render/vehicles";
import { lookOf, type LookStyle } from "./render/looks";
import { Materialise, type MaterialiseSpec } from "./render/materialise";
import { beamMaterial, PALETTE } from "./render/materials";
import { Atmosphere } from "./render/atmosphere";
import { ModelLayer, modelTier } from "./render/models";
import { buildWorldView, type WorldView } from "./render/world";
import { StubSim } from "./sim/stub";
import type { RapierSim } from "./sim/rapier";
import { PLAYER_ID, TICK_HZ, type FrameSource, type SimFrame } from "./sim/types";
import { EMPTY_HUD, type VrAction, type VrHud } from "./xr/model";
import { VrMode, type VrWorld } from "./xr/vr";

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
/** A build preview waits this long before drawing: a world that is already complete never pays for one. */
const PREVIEW_AFTER_MS = 120;
/** Where the ghost waits while there is nothing to race (far under the world, past the far plane). */
const PARKED_Y = -1e4;
const _q0 = new Quaternion();
const _q1 = new Quaternion();
const _ear = new Vector3();
const _look = new Vector3();

export class Engine {
  readonly backend: "webgpu" | "webgl2";
  /** Renderer init plus one-off GPU setup (environment map). */
  readonly initMs: number;
  readonly #renderer: WebGPURenderer;
  readonly #scene = new Scene();
  readonly #camera = new PerspectiveCamera(60, 1, 0.1, 400);
  /** VR: the camera rides this rig (at the player's feet); outside VR it stays at identity. */
  readonly #rig = new Group();
  #vr = false;
  /** The headset's controls, panels and comfort (xr/vr.ts), while a session runs. */
  #vrMode: VrMode | null = null;
  #vrHud: VrHud = EMPTY_HUD;
  readonly #pipeline: RenderPipeline | null;
  readonly #follow: FollowCamera;
  readonly #input = new InputCollector();
  /** Sky, fog, reflections and weather, restyled by each world's look. */
  readonly #air: Atmosphere;
  readonly #canvas: HTMLCanvasElement;

  #view: WorldView | null = null;
  /** Characters and props drawn as models once the world plays (?models=0 keeps the primitives). */
  #models: ModelLayer | null = null;
  readonly #modelTier = modelTier(window.location.search, window.matchMedia?.("(pointer: coarse)").matches ?? false);
  #combat: CombatView | null = null;
  #race: RaceView | null = null;
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
  /** Every simulation frame, as the renderer gets it (the sound reads the player's steps from it). */
  onFrame: ((f: SimFrame) => void) | undefined;
  /** B or Y on a VR controller (a fresh press): the sound's mute, where there is no keyboard. */
  onVrB: (() => void) | undefined;
  /** A panel button or a spoken prompt in VR: play again, or build a world. */
  onVrAction: ((a: VrAction) => void) | undefined;
  #bloom: ReturnType<typeof bloom> | null = null;
  /** Prewarmed sample worlds: never rendered, kept so their compiled programs stay cached. */
  readonly #warm: WorldView[] = [];
  #compiling = false;
  /** Logic X-ray focus: a light beam over the thing a hovered tile names. */
  #focus: string | null = null;
  readonly #beacon = (() => {
    const m = new Mesh(new CylinderGeometry(0.55, 0.55, 14, 24, 1, true), beamMaterial(PALETTE.cyan, 2.2, 0.55));
    m.visible = false;
    m.renderOrder = 2;
    return m;
  })();
  /** The ghost you race: parked out of sight when there is none (still drawn, so its shader is compiled with the world). */
  readonly #ghost = ghostActor();
  #ghostTrack: GhostTrack | null = null;
  #ghostShown = true;
  /** The world being built, shown in place of the current one until load() swaps the real one in. */
  #preview: Materialise | null = null;
  #previewAsk: { spec: MaterialiseSpec; at: number } | null = null;
  #previewDraft: WorldBundle | null = null;
  /** Bumped whenever a preview ends, so one still compiling is dropped. */
  #previewGen = 0;
  /** The shown world's look, put back when a preview ends without a new world. */
  #look: LookStyle | null = null;
  /** And where its weather stays out (a cut-away building) and its floor is. */
  #lookPlace: { shelter: WorldView["shelter"]; groundY: number } | null = null;
  #warmPreview: Materialise | null = null;

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
    const tEnv = performance.now();
    this.#air = new Atmosphere(renderer, s);
    this.initMs += performance.now() - tEnv;
    s.add(this.#beacon);
    this.#ghost.obj.position.set(0, PARKED_Y, 0);
    s.add(this.#ghost.obj);
    this.#rig.add(this.#camera);
    s.add(this.#rig);

    if (opts.bloom !== false) {
      const p = new RenderPipeline(renderer);
      const scenePass = pass(s, this.#camera, { samples: opts.msaa ?? 4 });
      const color = scenePass.getTextureNode("output");
      this.#bloom = bloom(color, 0.85, 0.45, 0.85);
      p.outputNode = color.add(this.#bloom);
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

  /** Can this browser open an immersive VR session? */
  async vrSupported(): Promise<boolean> {
    try {
      return Boolean(await navigator.xr?.isSessionSupported("immersive-vr"));
    } catch {
      return false;
    }
  }

  get presenting(): boolean {
    return this.#vr;
  }

  /**
   * Into VR, first person from the player's capsule. From the WebGPU backend the page reloads into
   * WebGL2 first (the steadier XR path on today's headsets); a session still needs a user gesture.
   */
  async enterVR(): Promise<"started" | "reload" | "failed"> {
    if (this.backend !== "webgl2") return "reload";
    try {
      const session = await navigator.xr!.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "layers"] });
      const xr = this.#renderer.xr;
      xr.enabled = true;
      xr.setReferenceSpaceType("local-floor");
      await xr.setSession(session);
      this.#vr = true;
      probe().vr = true;
      // facing where the desktop camera looked
      const vr = (this.#vrMode = new VrMode({ renderer: this.#renderer, scene: this.#scene, rig: this.#rig, input: this.#input }, this.#follow.yaw));
      vr.hud = this.#vrHud;
      vr.onAction = (a) => this.onVrAction?.(a);
      vr.onMute = () => this.onVrB?.();
      session.addEventListener("end", () => {
        this.#vr = false;
        probe().vr = false;
        xr.enabled = false;
        this.#vrMode?.dispose();
        this.#vrMode = null;
        this.#rig.position.set(0, 0, 0);
        this.#rig.rotation.set(0, 0, 0);
        const player = this.#view?.actors.get(PLAYER_ID);
        if (player) player.visible = true;
      });
      return "started";
    } catch (e) {
      console.warn("VR session failed", e);
      return "failed";
    }
  }

  /** What the headset's panels show (the HUD's facts as words); kept for a session that starts later. */
  vrHud(h: VrHud) {
    this.#vrHud = h;
    if (this.#vrMode) this.#vrMode.hud = h;
  }

  /** What a VR frame plays in (one object, refreshed each frame rather than made anew). */
  readonly #vrW: VrWorld = { view: null, sim: null, building: false };
  #vrWorld(): VrWorld {
    const w = this.#vrW;
    w.view = this.#view;
    w.sim = this.rapierSim;
    w.building = this.#preview !== null;
    return w;
  }

  #trails: Group | null = null;
  #cutaway = false;
  #beforeOverview: { pitch: number; dist: number } | null = null;

  /**
   * Where the AI runners went, as ribbons just above the ground they walked on (winning runs cyan,
   * the rest magenta), over the playtest's heat map when there is one, with the camera raised to
   * look down over them. null puts them away.
   */
  showTrails(trails: readonly { won: boolean; xyz: readonly number[] }[] | null, heat: HeatCells | null = null) {
    if (this.#trails) {
      this.#scene.remove(this.#trails);
      this.#trails.traverse((o) => {
        if (o instanceof Mesh) (o.geometry.dispose(), (o.material as MeshBasicMaterial).dispose());
      });
      this.#trails = null;
    }
    if (this.#beforeOverview && !trails?.length) {
      this.#follow.pitch = this.#beforeOverview.pitch;
      this.#follow.dist = this.#beforeOverview.dist;
      this.#follow.setColliders(this.#view && !this.#cutaway ? this.#view.colliders : []);
      this.#beforeOverview = null;
    }
    delete probe().overview;
    if (!trails?.length) return;
    const g = new Group();
    g.name = "trails";
    const hot = heat && heatView(heat);
    if (hot) g.add(hot);
    const W = 0.18; // half the ribbon's width (wide enough to read from the overview)
    for (const t of trails) {
      const p = t.xyz;
      if (p.length < 6) continue;
      const pos: number[] = [];
      for (let i = 0; i + 5 < p.length; i += 3) {
        const [ax, ay, az, bx, by, bz] = [p[i]!, p[i + 1]! + 0.06, p[i + 2]!, p[i + 3]!, p[i + 4]! + 0.06, p[i + 5]!];
        const dx = bx - ax;
        const dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (len < 0.01 || len > 6) continue; // standing still, or a respawn's jump across the map
        const [nx, nz] = [(-dz / len) * W, (dx / len) * W];
        pos.push(ax + nx, ay, az + nz, ax - nx, ay, az - nz, bx + nx, by, bz + nz, ax - nx, ay, az - nz, bx - nx, by, bz - nz, bx + nx, by, bz + nz);
      }
      if (!pos.length) continue;
      const geo = new BufferGeometry();
      geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
      g.add(new Mesh(geo, new MeshBasicMaterial({ color: t.won ? 0x19e3ff : 0xff3d8b, transparent: true, opacity: t.won ? 0.55 : 0.4, depthWrite: false, side: DoubleSide })));
    }
    this.#scene.add(g);
    this.#trails = g;
    probe().overview = { routes: g.children.length - (hot ? 1 : 0), heat: hot ? hot.geometry.getAttribute("position").count / 6 : 0 };
    // look down over the routes (and back as you were when they go)
    if (!this.#beforeOverview) this.#beforeOverview = { pitch: this.#follow.pitch, dist: this.#follow.dist };
    this.#follow.pitch = 1.05;
    this.#follow.dist = 30;
    this.#follow.setColliders([]);
  }

  /** Where the sound is heard from: the camera (the headset in VR), and the way it faces. */
  ear(): { p: [number, number, number]; yaw: number } {
    const cam = this.#vr ? this.#renderer.xr.getCamera() : this.#camera;
    cam.getWorldPosition(_ear);
    cam.getWorldDirection(_look);
    return { p: [_ear.x, _ear.y, _ear.z], yaw: Math.atan2(-_look.x, -_look.z) };
  }

  /**
   * Race a ghost: it runs beside the player by simulation tick from the start of the run (so its
   * clock is the result card's clock), translucent and outside the simulation. null puts it away.
   */
  setGhost(track: GhostTrack | null, kind: Rival["kind"] = "ai") {
    this.#ghostTrack = track;
    this.#ghost.setKind(kind);
    if (!track) this.#ghost.obj.position.set(0, PARKED_Y, 0);
  }

  /** Hide or show the ghost (it keeps its place in the run either way). */
  set ghostShown(on: boolean) {
    this.#ghostShown = on;
  }

  #placeGhost(now: number) {
    const track = this.#ghostTrack;
    const curr = this.#curr;
    const pr = probe();
    if (!track || !curr) {
      if (pr.ghost) delete pr.ghost;
      return;
    }
    const prev = this.#prev ?? curr;
    const a = Math.min(1, Math.max(0, (now - this.#currAt) / TICK_MS));
    const tick = prev.tick + (curr.tick - prev.tick) * a;
    const { p, yaw } = track.pose(tick);
    const g = this.#ghost.obj;
    // first person in VR: the ghost would stand in your eyes at the start, so it shows once it's a step away
    const player = this.#view?.actors.get(PLAYER_ID);
    const near = this.#vr && player ? Math.hypot(player.position.x - p[0], player.position.z - p[2]) < 1 : false;
    if (this.#ghostShown && !near) g.position.set(p[0], p[1], p[2]);
    else g.position.set(0, PARKED_Y, 0);
    g.rotation.set(0, yaw, 0);
    this.#ghost.setFade(tick >= track.ticks ? 0.4 : 1);
    pr.ghost = { shown: this.#ghostShown, tick: Math.round(tick), p: [round2(p[0]), round2(p[1]), round2(p[2])], finished: tick >= track.ticks };
  }

  /** Light up one thing (Logic X-ray hover); null puts the beam away. */
  highlight(id: string | null) {
    this.#focus = id;
    if (!id) this.#beacon.visible = false;
  }

  /** Touch controls feed the same input collector as the keyboard. */
  touchStick(x: number, y: number) {
    this.#input.setStick(x, y);
  }

  touchButton(bit: number, down: boolean) {
    this.#input.setButton(bit, down);
  }

  /**
   * Compile every look's and kit's shaders in the background (each sample world in its own scene,
   * so its light setup matches a real world's) and keep them alive, so a new world's first frame
   * reuses compiled programs instead of stalling on a cold compile.
   */
  async prewarm(bundles: WorldBundle[]): Promise<number> {
    const t0 = performance.now();
    for (const b of bundles) {
      // one sample world per idle slot, so a player moving around never feels it
      await new Promise<void>((resolve) => (typeof requestIdleCallback === "function" ? requestIdleCallback(() => resolve(), { timeout: 2000 }) : setTimeout(resolve, 50)));
      const view = buildWorldView(b, lookOf(b));
      const s = new Scene();
      s.fog = this.#scene.fog;
      s.environment = this.#scene.environment;
      s.add(view.root);
      try {
        await this.#renderer.compileAsync(s, this.#camera);
      } catch (e) {
        console.warn("prewarm skipped a world", e);
      }
      this.#warm.push(view);
    }
    // and the build preview's few programs, so the first reveal never waits on a compile
    if (!this.#warmPreview) {
      const p = (this.#warmPreview = Materialise.sample());
      const s = new Scene();
      s.fog = this.#scene.fog;
      s.add(p.root);
      await this.#renderer.compileAsync(s, this.#camera).catch((e: unknown) => console.warn("prewarm skipped the preview", e));
    }
    return performance.now() - t0;
  }

  /**
   * Show the world being built (render/materialise.ts) from its intent: ground and walls rise,
   * then entities pop in as materialiseLine() feeds the fill. load() swaps the real world in.
   */
  materialise(spec: MaterialiseSpec) {
    this.#stopPreview();
    this.#previewAsk = { spec, at: performance.now() };
  }

  /** The fill so far (the parser's growing draft). */
  materialiseLine(draft: WorldBundle) {
    this.#previewDraft = draft;
    const p = this.#preview;
    if (!p) return;
    const look = p.feed(draft);
    if (look) this.#applyLook(look);
    probe().materialise = p.counts;
  }

  /** Back to the world that was showing (the build was refused). */
  endPreview() {
    const shown = this.#preview !== null;
    this.#stopPreview();
    if (shown && this.#look) this.#applyLook(this.#look, this.#lookPlace);
  }

  async #startPreview(spec: MaterialiseSpec) {
    this.#previewAsk = null;
    const gen = this.#previewGen;
    const p = new Materialise(spec);
    // its programs compile off to the side (once a session, then shared), never on a frame
    const s = new Scene();
    s.fog = this.#scene.fog;
    s.add(p.root);
    await this.#renderer.compileAsync(s, this.#camera).catch(() => undefined);
    if (gen !== this.#previewGen) return p.dispose();
    if (this.#previewDraft) p.feed(this.#previewDraft);
    this.showTrails(null);
    for (const o of [this.#view?.root, this.#combat?.root, this.#ghost.obj]) if (o) o.visible = false;
    this.#beacon.visible = false;
    this.#scene.add(p.root);
    this.#applyLook(p.look);
    p.start(performance.now());
    this.#preview = p;
    probe().materialise = p.counts;
  }

  #stopPreview() {
    this.#previewGen++;
    this.#previewAsk = null;
    this.#previewDraft = null;
    const p = this.#preview;
    if (!p) return;
    this.#preview = null;
    p.dispose();
    for (const o of [this.#view?.root, this.#combat?.root, this.#ghost.obj]) if (o) o.visible = true;
    delete probe().materialise;
  }

  /** Sky, fog, reflections, weather (kept out of a building's footprint) and the grade, from a look. */
  #applyLook(look: LookStyle, place: { shelter: WorldView["shelter"]; groundY: number } | null = null) {
    this.#air.apply(look, place?.shelter ?? null, place?.groundY ?? 0);
    this.#renderer.toneMappingExposure = look.exposure;
    if (this.#bloom) {
      this.#bloom.strength.value = look.bloom;
      // by day a sunlit wall is already past the night's threshold and the whole frame hazes over:
      // only what truly glows (gates, bolts, flames) should bloom
      this.#bloom.threshold.value = look.night ? 0.85 : 1.4;
    }
  }

  /** Swap in a new world. Resolves after its first frame has been rendered. */
  async load(world: World, startedAt: number): Promise<LoadResult> {
    const splits: LoadResult["splits"] = [
      { label: "fill", ms: world.timings.fillMs },
      { label: "layout", ms: world.timings.layoutMs },
    ];
    const pr = probe();
    pr.ready = false;
    this.#stopPreview(); // the real world is here: the preview of it goes, whatever it had got to
    this.#unload();
    // Frames rendered while the new world compiles must not apply the old world's poses.
    this.#prev = this.#curr = null;

    let t = performance.now();
    const look = lookOf(world.bundle, world.cue);
    pr.look = look.variant ? `${look.id}/${look.variant}` : look.id;
    const view = buildWorldView(world.bundle, look);
    this.#look = look;
    this.#lookPlace = { shelter: view.shelter, groundY: view.groundY };
    this.#applyLook(look, this.#lookPlace);
    this.showTrails(null); // another world's routes
    this.setGhost(null); // and its ghost: the caller hands this world's rival in once it's loaded
    this.#scene.add(view.root);
    this.#view = view;
    // cutaway interiors: the camera looks down over the walls instead of bumping into them
    this.#cutaway = look.cutaway;
    this.#follow.setColliders(look.cutaway ? [] : view.colliders);
    const sim = this.simFactory ? this.simFactory(world.bundle) : new StubSim(world.bundle);
    this.rapierSim = this.simFactory ? (sim as RapierSim) : null;
    // a fight: shots, flashes and hit-point bars (worlds without weapons or hit points get none)
    this.#combat = this.rapierSim ? combatView(world.bundle, this.rapierSim.sim, !look.night) : null;
    if (this.#combat) this.#scene.add(this.#combat.root);
    // a race (or anything to drive): vehicles that steer and roll, the chase camera, the next gate
    this.#race = this.rapierSim ? raceView(world.bundle, this.rapierSim.sim, look.kick) : null;
    if (this.#race) this.#scene.add(this.#race.root);
    this.rapierSim?.subscribe((evs) => {
      for (const ev of evs) {
        if (ev.k === "state") view.setState(ev.a, String(ev.v));
        else if (ev.k === "destroy") view.gone(ev.a);
        else if (ev.k === "hit") this.#combat?.hit(ev.a);
      }
    });
    this.#follow.reset(sim.spawnYaw, look.cutaway ? 1.0 : 0.36);
    const player = view.actors.get(PLAYER_ID);
    if (player) this.#follow.update(0, player.position);
    splits.push({ label: "build", ms: performance.now() - t });

    t = performance.now();
    this.#compiling = true;
    try {
      await this.#renderer.compileAsync(this.#scene, this.#camera);
    } catch (e) {
      // in a headset a failed precompile mustn't end the session: the first frames compile instead
      if (!this.#vr) throw e;
      console.warn("precompile failed in VR", e);
    } finally {
      this.#compiling = false;
    }
    splits.push({ label: "compile", ms: performance.now() - t });

    this.#sim = sim;
    this.#vrMode?.loaded(sim.spawnYaw);
    sim.start((f) => {
      this.#prev = this.#curr ?? f;
      this.#curr = f;
      this.#currAt = performance.now();
      const pp = f.poses.get(PLAYER_ID);
      if (pp) pr.player = [round2(pp.p[0]), round2(pp.p[1]), round2(pp.p[2])];
      if (f.tick % 30 === 0 && this.rapierSim) {
        const cast: Record<string, [number, number]> = {};
        for (const id of this.rapierSim.sim.npcs.keys()) {
          const q = f.poses.get(id);
          if (q) cast[id] = [round2(q.p[0]), round2(q.p[2])];
        }
        pr.cast = cast;
      }
      pr.tick = f.tick;
      this.onFrame?.(f);
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
    // the world is playable: now the models load, each replacing its primitive when it's ready
    if (this.#modelTier !== "off") this.#models = new ModelLayer(world.bundle, view, this.rapierSim, { tier: this.#modelTier, night: look.night, ghost: this.#ghost.obj, role: world.intent.live?.role ?? "", compile: (o) => this.#renderer.compileAsync(o, this.#camera, this.#scene) });
    return { ttffMs, splits };
  }

  dispose() {
    void this.#renderer.setAnimationLoop(null);
    this.#stopPreview();
    this.#warmPreview?.dispose();
    this.#unload();
    this.#follow.dispose();
    this.#input.dispose();
    this.#air.dispose();
    this.#ghost.dispose();
    window.removeEventListener("resize", this.#onResize);
    this.#renderer.dispose();
    probe().ready = false;
  }

  #unload() {
    this.#sim?.stop();
    this.#sim = null;
    this.#combat?.dispose();
    this.#combat = null;
    this.#race?.dispose(this.#camera, this.#follow);
    this.#race = null;
    this.#models?.dispose();
    this.#models = null;
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
    const vr = this.#vrMode;
    const f = this.#input.sample((this.#curr?.tick ?? 0) + 1, vr ? vr.moveYaw : this.#follow.yaw);
    if (vr) f.aim = vr.aimYaw;
    this.#sim?.input(f);
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
    // While a new world compiles, render nothing: drawing it now would force every new shader to
    // compile synchronously on the main thread instead of in parallel (5 s instead of 0.2 s).
    if (this.#compiling) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.#lastT) / 1000);
    this.#lastT = now;

    const view = this.#view;
    const vr = this.#vrMode;
    if (vr) vr.before(now, this.#vrWorld());
    this.#pushInput();
    this.#applyPoses(now);
    this.#placeGhost(now);

    const ask = this.#previewAsk;
    if (ask && now - ask.at > PREVIEW_AFTER_MS) void this.#startPreview(ask.spec);
    const preview = this.#preview;
    const player = view?.actors.get(PLAYER_ID);
    if (preview) {
      // building: the camera circles the layout instead of following the player (in VR it says
      // where you stand to watch)
      preview.update(now, vr ? vr.eye : this.#camera);
      this.#air.follow(vr ? vr.eye.position : this.#camera.position);
    } else if (player && vr) {
      this.#air.follow(player.position);
    } else if (player) {
      this.#follow.update(dt, player.position);
      this.#air.follow(this.#camera.position);
    }
    view?.update(now / 1000);
    this.#models?.update(dt, now / 1000, this.#camera);
    if (view) this.#combat?.update(now / 1000, view.actors, this.#camera);
    // (in VR too: the vehicles turn and the gates show, without the chase camera)
    if (view) this.#race?.update(dt, now / 1000, view.actors, this.#camera, this.#follow, vr !== null);
    const focused = this.#focus ? view?.actors.get(this.#focus) : undefined;
    this.#beacon.visible = Boolean(focused);
    if (focused) this.#beacon.position.set(focused.position.x, focused.position.y + 6, focused.position.z);
    if (vr) {
      // first person: the rig stands on the player's feet (or in the seat); then the hands and panels
      const w = this.#vrWorld();
      vr.place(now, w);
      vr.after(now, dt, w);
    }

    // An immersive session's layer always has a framebuffer to draw into, except in an emulated
    // headset (IWER), whose layer's is null: three would run the whole scene pass, then throw drawing
    // it out, every frame, and with nothing ever shown nothing paces the GPU, which falls minutes
    // behind (the next page waits for it). With nowhere to draw, the frame isn't drawn.
    const layer = this.#vr ? this.#renderer.xr.getBaseLayer() : null;
    const nowhere = layer !== null && "framebuffer" in layer && layer.framebuffer === null;
    // (the frame's bookkeeping runs even when drawing throws, so a world loaded in VR still starts)
    try {
      if (this.#pipeline && !this.#vr) this.#pipeline.render();
      else if (!nowhere) this.#renderer.render(this.#scene, this.#camera);
    } finally {
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
