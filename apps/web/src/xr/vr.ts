// VR that plays like the rest of the game: the HUD as panels you can read and point at (a watch on
// the left wrist, the result card in front of you, who's talking over their head), controllers in
// your hands, teleport and smooth walking, grabbing and throwing, driving from the seat, firing
// where you point, and saying a world to build it. Every action reaches the simulation as the same
// quantised stick and button input the keyboard gives (a teleport is a walk, a grab is a walk to
// it and the sim's own pickup), so runs replay exactly. Nothing here writes simulation state.
import {
  AdditiveBlending, BoxGeometry, CircleGeometry, CylinderGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, RingGeometry,
  SphereGeometry, TorusGeometry, Vector3, type Object3D, type Scene, type WebGPURenderer,
} from "three/webgpu";
import { speechApi, transcript, voiceError, type Recognition } from "../hud/listen";
import { locale, t } from "../i18n";
import type { InputCollector } from "../input";
import { probe, type XrProbe } from "../probe";
import { GhostTrack, RaceTracker, raceClock, split } from "../race";
import type { Box } from "../sim/aabb";
import type { RapierSim } from "../sim/rapier";
import { BTN_JUMP, BTN_USE, PLAYER_ID } from "../sim/types";
import type { WorldView } from "../render/world";
import { Vignette } from "./comfort";
import { aimed, dioramaFit, editWaysLine, keyboardHere, toPlay, waysLine, type Diorama, type Ways } from "./create";
import { EMPTY_HUD, type VrAction, type VrHud, type VrResult, type VrSpot } from "./model";
import { CYAN, DIM, INK, Panel, TONE } from "./panel";
import { arc, type Arc, type V3 } from "./teleport";

// xr-standard gamepad buttons (Quest Touch: trigger, grip, -, stick press, A/X, B/Y)
const TRIGGER = 0;
const GRIP = 1;
const FACE_1 = 4;
const FACE_2 = 5;
const DEAD = 0.15;
/** A snap turn: 30°. */
const SNAP = Math.PI / 6;
/** A grab reaches a pickup this far from you. */
const GRAB_RANGE = 6;
/**
 * And it is pointed at when it lies within GRAB_CONE of the hand's ray sideways (or above it), and up
 * to GRAB_DROP below it: a hand held level still means the thing on the floor in front of you.
 */
const GRAB_CONE = 0.4;
const GRAB_DROP = 0.8;

/** How well a ray (origin, unit direction) points at a spot, lower is better; null if it doesn't. */
export function aimScore(o: readonly number[], d: readonly number[], at: readonly number[]): number | null {
  const [dx, dy, dz] = [at[0]! - o[0]!, at[1]! - o[1]!, at[2]! - o[2]!];
  const dist = Math.hypot(dx, dy, dz);
  const flat = Math.hypot(d[0]!, d[2]!);
  const far = Math.hypot(dx, dz);
  if (dist < 1e-6) return 0;
  // a ray pointed steeply up or down has no sideways: a plain cone then
  if (flat < 0.3 || far < 0.05) {
    const angle = Math.acos(Math.max(-1, Math.min(1, (dx * d[0]! + dy * d[1]! + dz * d[2]!) / dist)));
    return angle > GRAB_CONE ? null : angle + dist * 0.02;
  }
  const side = Math.acos(Math.max(-1, Math.min(1, (dx * d[0]! + dz * d[2]!) / (far * flat))));
  const below = Math.atan2(d[1]!, flat) - Math.atan2(dy, far);
  if (side > GRAB_CONE || below > GRAB_DROP || below < -GRAB_CONE) return null;
  return side + Math.abs(below) * 0.5 + dist * 0.02;
}
/** Let go of the grip moving at least this fast (m/s) and it's a throw. */
const THROW_SPEED = 1.4;
/** In the diorama, a free anchor within this angle (rad, about 9°) of the ray is where a held thing goes. */
const PICK_SPOT = 0.15;
/** Fonts on each panel: the smallest is ≥ 0.02 rad tall where that panel is read (panel.test.ts checks). */
export const PANELS = {
  wrist: { px: [768, 640] as [number, number], width: 0.26, at: 0.45, font: 28 },
  result: { px: [1024, 720] as [number, number], width: 1.0, at: 1.4, font: 32 },
  sheet: { px: [1024, 660] as [number, number], width: 1.0, at: 1.25, font: 32 },
  toast: { px: [1024, 160] as [number, number], width: 0.9, at: 1.5, font: 38 },
  bark: { px: [1280, 300] as [number, number], width: 1.0, at: 2.2, font: 60 },
};

export interface VrHost {
  renderer: WebGPURenderer;
  scene: Scene;
  /** The camera rides it: VR stands it on the player's feet (or in the seat). */
  rig: Group;
  input: InputCollector;
}

/** What a frame of VR plays in. */
export interface VrWorld {
  view: WorldView | null;
  sim: RapierSim | null;
  /** A world is being built and its reveal is on show (stand and watch: no input reaches the old one). */
  building: boolean;
  /** The simulation's tick on the latest frame drawn. */
  tick: number;
}

/**
 * A teleport or a grab walking you somewhere. Its clock is the simulation's ticks, not the wall's:
 * a frame that stalls (a shader compiling on its first draw) is time the sim didn't walk, and must
 * not count against the walk or end it as stuck.
 */
interface Walk {
  kind: "teleport" | "grab";
  target: V3;
  item: string;
  /** Gives up at this tick, or when no nearer for STUCK_TICKS. */
  until: number;
  best: number;
  bestAt: number;
}
/** A walk that has got no nearer for this many ticks (0.45 s) is blocked. */
const STUCK_TICKS = 27;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const dead = (x: number) => (Math.abs(x) > DEAD ? x : 0);
/** The heading of a rotation (three.js yaw: 0 looks down −z). */
const yawOf = (q: Quaternion) => {
  _f.set(0, 0, -1).applyQuaternion(q);
  return Math.atan2(-_f.x, -_f.z);
};
/** (x, z) turned by a yaw, as a three.js rotation.y turns it. */
const turnXZ = (x: number, z: number, yaw: number): [number, number] => [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // storage blocked: the choice lasts the session
    }
  },
};

const _f = new Vector3();
const _v = new Vector3();
const _w = new Vector3();
const _m = new Matrix4();
const _rigQ = new Quaternion();

/** One controller: its poses in the play space, its buttons with their edges, how fast it moves. */
class Hand {
  connected = false;
  readonly ray = { p: new Vector3(), q: new Quaternion() };
  readonly grip = { p: new Vector3(), q: new Quaternion() };
  /** The same, in the world (after the rig), refreshed once the rig is placed. */
  readonly wRay = { p: new Vector3(), d: new Vector3(), q: new Quaternion() };
  readonly wGrip = { p: new Vector3(), q: new Quaternion() };
  ax = 0;
  ay = 0;
  /** The trigger went to a panel: it does nothing else until it is let go. */
  clicked = false;
  hover: { panel: Panel; button: string | null; t: number } | null = null;
  #now: boolean[] = [];
  #was: boolean[] = [];
  #src: XRInputSource | null = null;
  readonly #trail: { t: number; p: Vector3 }[] = Array.from({ length: 8 }, () => ({ t: -1, p: new Vector3() }));
  #ti = 0;

  constructor(readonly side: "left" | "right") {}

  read(src: XRInputSource, frame: XRFrame, ref: XRReferenceSpace, now: number) {
    this.#src = src;
    const ray = frame.getPose(src.targetRaySpace, ref);
    const grip = src.gripSpace ? frame.getPose(src.gripSpace, ref) : ray;
    this.connected = Boolean(ray);
    if (ray) set(this.ray, ray.transform);
    if (grip) set(this.grip, grip.transform);
    else if (ray) (this.grip.p.copy(this.ray.p), this.grip.q.copy(this.ray.q));
    const g = src.gamepad!;
    [this.#was, this.#now] = [this.#now, this.#was];
    this.#now.length = g.buttons.length;
    for (let i = 0; i < g.buttons.length; i++) this.#now[i] = g.buttons[i]!.pressed;
    this.ax = g.axes[2] ?? 0;
    this.ay = g.axes[3] ?? 0;
    const s = this.#trail[this.#ti]!;
    s.t = now;
    s.p.copy(this.grip.p);
    this.#ti = (this.#ti + 1) % this.#trail.length;
  }

  lost() {
    this.connected = false;
    this.#src = null;
    [this.#was, this.#now] = [this.#now, this.#was];
    this.#now.length = 0;
    this.ax = this.ay = 0;
    this.hover = null;
  }

  down(i: number): boolean {
    return this.#now[i] === true;
  }
  pressed(i: number): boolean {
    return this.#now[i] === true && this.#was[i] !== true;
  }
  released(i: number): boolean {
    return this.#now[i] !== true && this.#was[i] === true;
  }

  /** How fast the grip moved over about the last tenth of a second (m/s, in the play space). */
  speed(now: number): number {
    const last = this.#trail[(this.#ti + this.#trail.length - 1) % this.#trail.length]!;
    let first = last;
    for (const s of this.#trail) if (s.t >= 0 && now - s.t <= 120 && s.t < first.t) first = s;
    const dt = (last.t - first.t) / 1000;
    return dt > 0.02 ? last.p.distanceTo(first.p) / dt : 0;
  }

  /** A short buzz (a hover, a click); headsets without haptics ignore it. */
  buzz(strength: number, ms: number) {
    const act = (this.#src?.gamepad as unknown as { hapticActuators?: { pulse?: (v: number, ms: number) => Promise<boolean> }[] } | undefined)?.hapticActuators?.[0];
    void act?.pulse?.(strength, ms)?.catch(() => undefined);
  }
}

function set(to: { p: Vector3; q: Quaternion }, t: XRRigidTransform) {
  to.p.set(t.position.x, t.position.y, t.position.z);
  to.q.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
}

/** A Touch-like controller, built from a few shapes: a handle and its tracking ring. */
function controllerModel(side: "left" | "right", mats: { body: MeshBasicMaterial; ring: MeshBasicMaterial }, geos: { handle: CylinderGeometry; ring: TorusGeometry }): Group {
  const g = new Group();
  g.name = `controller:${side}`;
  const handle = new Mesh(geos.handle, mats.body);
  handle.rotation.x = -0.45;
  handle.position.set(0, -0.015, 0.03);
  const ring = new Mesh(geos.ring, mats.ring);
  ring.rotation.set(-0.35, side === "left" ? 0.4 : -0.4, 0);
  ring.position.set(side === "left" ? -0.012 : 0.012, 0.02, -0.035);
  g.add(handle, ring);
  return g;
}

export class VrMode {
  /** The yaw that movement is relative to: where you look, a teleport's way, a vehicle's nose. */
  moveYaw = 0;
  /** Where a shot goes: the yaw of the controller that fired last. */
  aimYaw = 0;
  onAction: ((a: VrAction) => void) | undefined;
  onMute: (() => void) | undefined;
  /** The build reveal's camera: it says where the reveal is seen from, and you stand there. */
  readonly eye = new PerspectiveCamera();

  readonly #h: VrHost;
  readonly #root = new Group();
  readonly #left = new Hand("left");
  readonly #right = new Hand("right");
  readonly #head = { p: new Vector3(0, 1.6, 0), q: new Quaternion(), ok: false, wp: new Vector3(), wq: new Quaternion() };
  /** Your heading on foot, and where the play space stands off the capsule (kept through turns). */
  #yaw = 0;
  readonly #off = { x: 0, z: 0 };
  #centred = false;
  #faceTo: number | null = null;
  #snapArmed = true;
  #hud: VrHud = EMPTY_HUD;
  /** Bumped whenever what a panel says may have changed; a panel repaints (if its words differ) only then. */
  #ver = 0;
  readonly #painted = { wrist: -1, result: -1, sheet: -1 };

  readonly #wrist = new Panel("wrist", PANELS.wrist.px, PANELS.wrist.width, false);
  readonly #result = new Panel("result", PANELS.result.px, PANELS.result.width);
  readonly #sheet = new Panel("sheet", PANELS.sheet.px, PANELS.sheet.width);
  readonly #toast = new Panel("toast", PANELS.toast.px, PANELS.toast.width);
  readonly #bark = new Panel("bark", PANELS.bark.px, PANELS.bark.width);
  readonly #panels = [this.#wrist, this.#result, this.#sheet, this.#toast, this.#bark];
  /** The panels with buttons to point at. */
  readonly #targets = [this.#wrist, this.#result, this.#sheet];
  readonly #hands = [this.#left, this.#right] as const;
  readonly #vignette = new Vignette();
  readonly #models: Record<"left" | "right", Group>;
  readonly #rays: Record<"left" | "right", Mesh>;
  readonly #tips: Record<"left" | "right", Mesh>;
  readonly #dots: InstancedMesh;
  readonly #marker: Mesh;
  readonly #pad: Mesh;
  readonly #grabRing: Mesh;
  readonly #mats: Record<"body" | "ring" | "ray" | "rayOn" | "ok" | "no", MeshBasicMaterial>;
  readonly #geos: { dispose(): void }[] = [];

  #smooth = store.get("gr_vr_move") !== "teleport";
  #vignetteOn = store.get("gr_vr_vignette") !== "off";
  #aiming = false;
  #arc: Arc | null = null;
  #walk: Walk | null = null;
  #useUntil = 0;
  #aimHand: Hand;
  #moving = 0;
  #seat: { vehicle: string; head: Vector3; headYaw: number; eye: number; yaw: number } | null = null;
  #stand: { p: Vector3; yaw: number; head: Vector3; headYaw: number } | null = null;
  #blinkUntil = 0;
  #sheetOpen = false;
  #rec: Recognition | null = null;
  #heard = "";
  #note: string | null = null;
  #own: { text: string; until: number } | null = null;
  #resultTick = -1;
  #carrying = "";
  #barkAt: "head" | "front" | null = null;
  #lastSeatYaw = 0;
  #lastSpeed = 0;
  #lazyYaw = 0;
  #pollAt = 0;
  #raceAt = 0;
  #status = { lap: "", hp: "", race: "", hint: "", grab: "" };
  #tracker: { sim: RapierSim; ghost: unknown; t: RaceTracker } | null = null;
  #hazards: { view: WorldView; boxes: Box[] } | null = null;
  #probeAt = 0;
  readonly #raf: [typeof window.requestAnimationFrame, typeof window.cancelAnimationFrame];
  readonly #cpu = new Float32Array(240);
  #cpuN = 0;
  #cpuMs = 0;
  #cpuStats = { p50: 0, p95: 0 };
  #cpuAt = 0;
  // ---- making and changing worlds (ff.vr_create) ----
  /** The watch's face: the game's facts, or the tools to change the world. */
  #page: "play" | "make" = "play";
  /** What the words being listened to are for: a new world, or a change to this one. */
  #listenFor: "world" | "edit" = "world";
  /** The world as a model on a table in front of you (null: life size), and the view it was fitted to. */
  #dio: (Diorama & { view: WorldView | null }) | null = null;
  /** What the diorama's hand holds, and the free anchor its ray picks out to put it on. */
  #held: { id: string; spot: VrSpot | null } | null = null;
  /** The movable thing the ray points at, in the diorama (for the ring and the watch's hint). */
  #aimedAt = "";
  /** The fog as the world set it, and as the diorama scaled it (it is restored on the way out). */
  #fog: { near: number; far: number; setNear: number; setFar: number } | null = null;
  /** The text field the headset's keyboard types into, and what for (null: not typing). */
  #kbd: HTMLInputElement | null = null;
  #typing: "world" | "edit" | null = null;
  readonly #onSelect = () => this.#typeOnSelect();

  constructor(host: VrHost, yaw: number) {
    this.#h = host;
    this.#yaw = yaw;
    this.#lazyYaw = yaw;
    this.#faceTo = yaw;
    this.#aimHand = this.#right;
    this.#root.name = "vr";
    const basic = (color: string, opacity = 1, glow = false) => new MeshBasicMaterial({ color, transparent: opacity < 1 || glow, opacity, fog: false, toneMapped: false, depthWrite: !glow, ...(glow ? { blending: AdditiveBlending } : {}) });
    this.#mats = { body: basic("#262b38"), ring: basic(CYAN, 1, true), ray: basic(CYAN, 0.35, true), rayOn: basic("#ffffff", 0.85, true), ok: basic(CYAN, 0.9, true), no: basic("#ff3b5c", 0.8, true) };
    const geo = { handle: new CylinderGeometry(0.016, 0.021, 0.11, 12), ring: new TorusGeometry(0.036, 0.0055, 8, 28), ray: new BoxGeometry(0.004, 0.004, 1), tip: new SphereGeometry(0.012, 10, 8), dot: new SphereGeometry(0.035, 8, 6), marker: new RingGeometry(0.28, 0.4, 32), pad: new CircleGeometry(0.55, 32), grab: new RingGeometry(0.42, 0.5, 32) };
    geo.ray.translate(0, 0, -0.5); // grows out along −z from the hand
    for (const k of ["marker", "pad", "grab"] as const) geo[k].rotateX(-Math.PI / 2);
    this.#geos.push(...Object.values(geo));
    this.#models = { left: controllerModel("left", this.#mats, geo), right: controllerModel("right", this.#mats, geo) };
    const ray = (side: "left" | "right") => {
      const m = new Mesh(geo.ray, this.#mats.ray);
      m.name = `ray:${side}`;
      m.renderOrder = 25;
      m.frustumCulled = false;
      return m;
    };
    this.#rays = { left: ray("left"), right: ray("right") };
    this.#tips = { left: new Mesh(geo.tip, this.#mats.rayOn), right: new Mesh(geo.tip, this.#mats.rayOn) };
    this.#dots = new InstancedMesh(geo.dot, this.#mats.ok, 49);
    this.#dots.frustumCulled = false;
    this.#marker = new Mesh(geo.marker, this.#mats.ok);
    this.#pad = new Mesh(geo.pad, this.#mats.ray);
    this.#grabRing = new Mesh(geo.grab, this.#mats.ok);
    for (const o of [this.#models.left, this.#models.right, this.#rays.left, this.#rays.right, this.#tips.left, this.#tips.right, this.#dots, this.#marker, this.#pad, this.#grabRing, this.#vignette.mesh, ...this.#panels.map((p) => p.mesh)]) {
      o.visible = false;
      this.#root.add(o);
    }
    host.scene.add(this.#root);
    // A headset may stop the page's own animation frames while a session runs (WebXR allows it), and
    // three polls its shader compiles with them: a world built in VR would wait for its shaders for
    // ever. A timer stands in for them until the session ends.
    this.#raf = [window.requestAnimationFrame, window.cancelAnimationFrame];
    window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 16);
    window.cancelAnimationFrame = (id) => window.clearTimeout(id);
    // a trigger pull is a user gesture only inside the session's select event: where the headset
    // has a keyboard, a text field focused there brings it up
    (host.renderer.xr.getSession() as XRSession | null)?.addEventListener("select", this.#onSelect);
  }

  /** The ways this browser can take words in the headset. */
  #ways(): Ways {
    return { speech: Boolean(speechApi()), keyboard: keyboardHere(navigator.userAgent) };
  }

  /** The creation tools are on (ff.vr_create). */
  get #making(): boolean {
    return this.#hud.make.on;
  }

  /** The app's facts for the panels (painted only where they changed). */
  set hud(h: VrHud) {
    this.#hud = h;
    this.#ver++;
  }

  /** A new world: face the way it starts you, with your head over the spawn, through a blink. */
  loaded(spawnYaw: number) {
    this.#faceTo = spawnYaw;
    this.#centred = false;
    this.#walk = null;
    this.#aiming = false;
    this.#seat = null;
    this.#tracker = null;
    this.#blinkUntil = performance.now() + 300;
    // an edit made in the diorama comes back as a new world: it stands on the same table
    this.#held = null;
    if (this.#dio) this.#dio.view = null;
  }

  // ---- input --------------------------------------------------------------------------------

  /** Before the frame's input is sampled: the controllers, and what they ask the simulation for. */
  before(now: number, w: VrWorld) {
    const t0 = performance.now();
    const xr = this.#h.renderer.xr;
    const frame = xr.getFrame() as XRFrame | null;
    const ref = xr.getReferenceSpace();
    const session = xr.getSession();
    if (frame && ref && session) {
      const vp = frame.getViewerPose(ref);
      if (vp) (set(this.#head, vp.transform), (this.#head.ok = true));
      let left = false;
      let right = false;
      for (const src of session.inputSources) {
        if (!src.gamepad) continue;
        if (src.handedness === "left" && !left) ((left = true), this.#left.read(src, frame, ref, now));
        if (src.handedness === "right" && !right) ((right = true), this.#right.read(src, frame, ref, now));
      }
      if (!left) this.#left.lost();
      if (!right) this.#right.lost();
    }
    this.#controls(now, w);
    this.#cpuMs = performance.now() - t0;
  }

  #controls(now: number, w: VrWorld) {
    const L = this.#left;
    const R = this.#right;
    const input = this.#h.input;
    if (L.pressed(FACE_2) || R.pressed(FACE_2)) this.onMute?.();
    // the trigger on a panel clicks the button there, and is no shot or use until it is let go
    for (const h of this.#hands) {
      if (h.pressed(TRIGGER) && h.hover) {
        h.clicked = true;
        if (h.hover.button) (h.buzz(0.6, 30), this.#click(h.hover.button, now));
      }
      if (!h.down(TRIGGER)) h.clicked = false;
      if (h.pressed(TRIGGER) && !h.clicked) this.#aimHand = h;
    }
    const trigL = L.down(TRIGGER) && !L.clicked;
    const trigR = R.down(TRIGGER) && !R.clicked;
    // say a world: hold the left grip (let go and it builds); on the watch's Change it face, or over
    // the diorama, what you say is a change to this world instead
    if (L.pressed(GRIP)) this.#listen(now, this.#making && (this.#page === "make" || this.#dio !== null) ? "edit" : "world", true);
    if (L.released(GRIP)) this.#rec?.stop();

    const sim = w.sim;
    const ride = sim?.sim.ride(PLAYER_ID);
    const headYaw = (this.#seat ? this.#seat.yaw : this.#yaw) + yawOf(this.#head.q);
    let mx = 0;
    let my = 0;
    let yaw = headYaw;
    let jump = L.down(FACE_1) || R.down(FACE_1);
    let use = false;
    if (w.building) {
      // watching a world rise: nothing reaches the one it replaces
      ((jump = false), (this.#aiming = false), (this.#walk = null));
    } else if (this.#dio) {
      // over the model: you stand still in it, and the right hand moves things about
      ((jump = false), (this.#aiming = false), (this.#walk = null));
      this.#godHand(w);
    } else if (ride) {
      // at the wheel: the stick steers from the nose, the right trigger boosts, the left one gets out
      this.#aiming = false;
      this.#walk = null;
      mx = dead(L.ax);
      my = dead(-L.ay);
      yaw = Math.atan2(-ride.hx, -ride.hz);
      jump = jump || trigR;
      use = trigL;
    } else if (this.#walk) {
      const step = this.#walking(w);
      if (step) ({ mx, my, yaw } = step);
      jump = false;
    } else {
      if (this.#smooth) ((mx = dead(L.ax)), (my = dead(-L.ay)));
      // the right stick: a flick left or right turns 30°; held forward it aims a teleport, let go to go
      const rx = R.ax;
      const ry = R.ay;
      if (Math.abs(rx) > 0.7 && Math.abs(ry) < 0.6 && this.#snapArmed) {
        this.#turnTo(this.#yaw - Math.sign(rx) * SNAP);
        this.#snapArmed = false;
      }
      if (Math.abs(rx) < 0.3) this.#snapArmed = true;
      const aimR = ry < -0.6 && Math.abs(rx) < 0.7;
      const aimL = !this.#smooth && L.ay < -0.6 && Math.abs(L.ax) < 0.7;
      if (aimR || aimL) {
        this.#aiming = true;
        this.#arc = this.#arcFrom(aimR ? R : L, w);
      } else if (this.#aiming) {
        this.#aiming = false;
        const tgt = this.#arc?.valid ? this.#arc.target : null;
        if (tgt) this.#go(tgt, w);
        this.#arc = null;
      }
      this.#grab(now, w);
      use = trigL || trigR || now < this.#useUntil;
    }
    this.#moving = Math.min(1, Math.hypot(mx, my));
    this.moveYaw = yaw;
    const ah = this.#aimHand.connected ? this.#aimHand : R.connected ? R : null;
    this.aimYaw = ah ? (this.#seat ? this.#seat.yaw : this.#yaw) + yawOf(ah.ray.q) : headYaw;
    input.setStick(mx, my);
    input.setButton(BTN_JUMP, jump);
    input.setButton(BTN_USE, use);
  }

  /** Turn about the head, not the play space's middle: the view turns where you stand. */
  #turnTo(yaw: number) {
    const h = this.#head.p;
    const [ax, az] = turnXZ(h.x, h.z, this.#yaw);
    const [bx, bz] = turnXZ(h.x, h.z, yaw);
    this.#off.x += ax - bx;
    this.#off.z += az - bz;
    this.#yaw = wrap(yaw);
  }

  /** Where the player is drawn (the sim's pose, a tick behind), or null. */
  #me(w: VrWorld): Vector3 | null {
    return w.view?.actors.get(PLAYER_ID)?.position ?? null;
  }

  #arcFrom(h: Hand, w: VrWorld): Arc | null {
    const me = this.#me(w);
    if (!me || !w.view) return null;
    const rig = this.#h.rig;
    rig.updateMatrixWorld();
    _v.copy(h.ray.p).applyMatrix4(rig.matrixWorld);
    _f.set(0, 0, -1).applyQuaternion(h.ray.q).applyQuaternion(rig.quaternion);
    return arc(w.view.colliders, this.#hazardsOf(w), [_v.x, _v.y, _v.z], [_f.x, _f.y, _f.z], [me.x, me.y - 0.9, me.z]);
  }

  /** Lava and the like: a teleport never ends in one. */
  #hazardsOf(w: VrWorld): Box[] {
    const view = w.view!;
    if (this.#hazards?.view === view) return this.#hazards.boxes;
    const boxes: Box[] = [];
    const sim = w.sim?.sim;
    for (const id of sim?.order ?? []) {
      const e = sim!.entity(id);
      if (e?.kind !== "hazard" || e.destroyed) continue;
      const p = sim!.pos(id);
      boxes.push({ min: [p[0] - e.size[0] / 2, p[1] - e.size[1] / 2, p[2] - e.size[2] / 2], max: [p[0] + e.size[0] / 2, p[1] + e.size[1] / 2, p[2] + e.size[2] / 2] });
    }
    this.#hazards = { view, boxes };
    return boxes;
  }

  /** Teleport: walked there by the sim under logged input while the view blinks. */
  #go(target: V3, w: VrWorld) {
    const me = this.#me(w);
    if (!me) return;
    const dist = Math.hypot(target[0] - me.x, target[2] - me.z);
    const speed = w.sim?.sim.laws.speed ?? 6;
    this.#walk = { kind: "teleport", target, item: "", until: w.tick + Math.ceil((dist / Math.max(1, speed)) * 60) + 48, best: Infinity, bestAt: w.tick };
    this.#right.buzz(0.3, 20);
  }

  /** A teleport or a grab under way: the stick input that walks there, or null once it's over. */
  #walking(w: VrWorld): { mx: number; my: number; yaw: number } | null {
    const walk = this.#walk!;
    const me = this.#me(w);
    const end = () => ((this.#walk = null), null);
    if (!me) return end();
    if (walk.kind === "grab") {
      const sim = w.sim?.sim;
      const item = sim?.entity(walk.item);
      // done: it's yours (the sim picked it up), someone else has it, or you let go of the grip
      if (!sim || !item || item.destroyed || item.carrier || sim.entity(PLAYER_ID)?.carrying || !this.#right.down(GRIP)) return end();
      const p = sim.pos(walk.item);
      walk.target = [p[0], p[1], p[2]];
    }
    const dx = walk.target[0] - me.x;
    const dz = walk.target[2] - me.z;
    const d = Math.hypot(dx, dz);
    if (d < walk.best - 0.05) ((walk.best = d), (walk.bestAt = w.tick));
    // there, out of time, or not getting any closer (a wall the arc didn't see, a shelf too high)
    if ((walk.kind === "teleport" && d < 0.25) || w.tick > walk.until || w.tick - walk.bestAt > STUCK_TICKS) return end();
    return { mx: 0, my: Math.min(1, d / 0.3), yaw: Math.atan2(-dx, -dz) };
  }

  /** The right grip: on a pickup it points at, a walk to it (the sim picks it up); a flick as you let go throws it. */
  #grab(now: number, w: VrWorld) {
    const R = this.#right;
    const sim = w.sim?.sim;
    if (!sim) return;
    const carrying = sim.entity(PLAYER_ID)?.carrying ?? "";
    if (R.pressed(GRIP) && !carrying) {
      const item = this.#pointedItem(w);
      if (item) {
        const p = sim.pos(item);
        this.#walk = { kind: "grab", target: [p[0], p[1], p[2]], item, until: w.tick + 210, best: Infinity, bestAt: w.tick };
        R.buzz(0.3, 20);
      }
    }
    // a throw only where the world has one for this thing (its own target: the sim's throw verb picks it)
    if (R.released(GRIP) && carrying && R.speed(now) >= THROW_SPEED) {
      const u = sim.usable();
      if (u && u.on === carrying && u.label === "throw") ((this.#useUntil = now + 60), R.buzz(0.8, 40));
    }
  }

  /** The pickup the right hand points at (see aimScore), within GRAB_RANGE of you, or "". */
  #pointedItem(w: VrWorld): string {
    const sim = w.sim?.sim;
    const me = this.#me(w);
    if (!sim || !me || !this.#right.connected) return "";
    const ray = this.#right.wRay;
    let best = "";
    let bestScore = Infinity;
    for (const id of sim.order) {
      const e = sim.entity(id);
      if (!e?.carryable || e.carrier || e.destroyed) continue;
      const p = sim.pos(id);
      if (Math.hypot(p[0] - me.x, p[2] - me.z) > GRAB_RANGE) continue;
      const score = aimScore([ray.p.x, ray.p.y, ray.p.z], [ray.d.x, ray.d.y, ray.d.z], p);
      if (score !== null && score < bestScore) ((bestScore = score), (best = id));
    }
    return best;
  }

  // ---- the diorama ----------------------------------------------------------------------------

  /** Life size, or the world as a model on a table in front of you (the play space scaled up round it). */
  #toggleDiorama(now: number) {
    this.#held = null;
    this.#blinkUntil = now + 250;
    // (the sheet stands where it was opened, at the size it was: it closes rather than float about)
    this.#sheetOpen = false;
    this.#hush();
    if (this.#dio) {
      this.#dio = null;
      return;
    }
    if (!this.#hud.make.bounds) return void (this.#own = { text: t("This world has no layout to make a model of."), until: now + 2500 });
    this.#page = "make";
    this.#walk = null;
    this.#seat = null;
    // fitted on the next place(), where the head and the world are known
    this.#dio = { scale: 1, yaw: this.#h.rig.rotation.y, pos: [0, 0, 0], table: [Number.NaN, 0, 0], view: null };
  }

  /** The right ray's origin and direction in the world. */
  #rayOf(h: Hand): [readonly [number, number, number], readonly [number, number, number]] {
    return [[h.wRay.p.x, h.wRay.p.y, h.wRay.p.z], [h.wRay.d.x, h.wRay.d.y, h.wRay.d.z]];
  }

  /** The movable thing the right hand's ray points at in the model, or "". */
  #aimedThing(w: VrWorld): string {
    const R = this.#right;
    if (!R.connected || !w.view) return "";
    const carried = w.sim?.sim.entity(PLAYER_ID)?.carrying;
    const pts = this.#hud.make.movable.flatMap((m) => {
      const a = m.id === carried ? undefined : w.view!.actors.get(m.id);
      return a?.visible === false || !a ? [] : [{ key: m.id, at: [a.position.x, a.position.y, a.position.z] as const }];
    });
    return aimed(...this.#rayOf(R), pts) ?? "";
  }

  /**
   * The god hand: the right grip on a thing in the model picks it up (in view only: the simulation
   * isn't touched), its ray picks the free anchor it would go on, and letting go there asks for the
   * move, which comes back as an edit, re-proved, with Undo.
   */
  #godHand(w: VrWorld) {
    const R = this.#right;
    const aimedAt = this.#held ? "" : this.#aimedThing(w);
    if (aimedAt !== this.#aimedAt) ((this.#aimedAt = aimedAt), this.#ver++); // (the watch names it)
    if (R.pressed(GRIP) && !this.#held && this.#aimedAt) {
      this.#held = { id: this.#aimedAt, spot: null };
      R.buzz(0.4, 25);
      this.#ver++;
    }
    const held = this.#held;
    if (!held) return;
    if (R.down(GRIP)) {
      const high = this.#hud.make.movable.find((m) => m.id === held.id)?.high ?? false;
      const spot = aimed(...this.#rayOf(R), this.#hud.make.spots.filter((s) => s.high === high).map((s) => ({ key: s, at: s.at })), PICK_SPOT);
      if (spot !== held.spot) ((held.spot = spot), this.#ver++, spot && R.buzz(0.12, 10));
      return;
    }
    // let go
    this.#held = null;
    this.#ver++;
    const thing = this.#hud.make.movable.find((m) => m.id === held.id)?.label ?? held.id;
    const now = performance.now();
    if (!held.spot) return void (this.#own = { text: t("Nowhere to put the {thing} there: it stays where it was.", { thing }), until: now + 2500 });
    this.#own = { text: t("Moving the {thing} to the {where}…", { thing, where: held.spot.label }), until: now + 2500 };
    R.buzz(0.7, 40);
    this.onAction?.({ k: "move", id: held.id, zone: held.spot.zone, anchor: held.spot.anchor });
  }

  // ---- voice and the prompt sheet -------------------------------------------------------------

  /**
   * Listen for a world (the sheet opens: where the browser can't listen, its chips instead) or for a
   * change to this one (on the watch). `hold`: the left grip, held for as long as you speak; else a
   * button, and it stops at a pause (or at the button's Done).
   */
  #listen(now: number, purpose: "world" | "edit", hold: boolean) {
    if (this.#hud.busy) return void (this.#own = { text: t("Still building the last world…"), until: now + 2500 });
    if (purpose === "edit" && !this.#hud.make.live) return void (this.#own = { text: t("Edits in words need the live AI. The diorama still moves things."), until: now + 3000 });
    if (purpose === "world") {
      this.#sheetOpen = true;
      this.#placeAhead(this.#sheet, 1.25, -0.12);
    }
    const Api = speechApi();
    if (!Api || this.#rec) return void this.#ver++;
    const r = new Api();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = hold; // the grip keeps it listening through a pause until it is let go
    this.#listenFor = purpose;
    this.#heard = "";
    this.#note = null;
    r.onresult = (e) => ((this.#heard = transcript(e)), this.#ver++);
    r.onerror = (e) => ((this.#note = voiceError(e.error, purpose === "world" ? "say a world" : "say a change")), this.#ver++);
    r.onend = () => {
      this.#rec = null;
      this.#ver++;
      const text = this.#heard.trim();
      if (!text) return;
      if (purpose === "world") this.#build(text, performance.now());
      else this.#edit(text, performance.now());
    };
    try {
      r.start();
      this.#rec = r;
    } catch {
      this.#rec = null;
    }
    this.#ver++;
  }

  /** Stop listening without building what was heard (the sheet closed, the session ended). */
  #hush() {
    const r = this.#rec;
    if (!r) return;
    r.onend = r.onresult = null;
    r.stop();
    this.#rec = null;
  }

  #build(prompt: string, now: number) {
    if (this.#hud.busy) return void (this.#own = { text: t("Still building the last world…"), until: now + 2500 });
    this.#sheetOpen = false;
    this.#heard = "";
    this.#endTyping();
    // a new world is met life size, where its reveal is watched from
    if (this.#dio) ((this.#dio = null), (this.#held = null));
    this.#own = { text: t("Building: {prompt}", { prompt: prompt.length > 80 ? `${prompt.slice(0, 78)}…` : prompt }), until: now + 3000 };
    this.onAction?.({ k: "build", prompt: prompt.slice(0, 300) });
  }

  /** A change to this world, in words: the desktop's edit, re-proved, shown on the watch. */
  #edit(change: string, now: number) {
    this.#heard = "";
    this.#endTyping();
    if (!this.#hud.make.live) return void (this.#own = { text: t("Edits in words need the live AI. The diorama still moves things."), until: now + 3000 });
    if (this.#hud.busy) return void (this.#own = { text: t("Still building the last world…"), until: now + 2500 });
    this.#page = "make";
    this.onAction?.({ k: "edit", change: change.slice(0, 300) });
  }

  // ---- the headset's keyboard (where the browser has one) ---------------------------------------

  /** Typing a world or a change: a text field the headset's keyboard types into (focused in a select event). */
  #startTyping(purpose: "world" | "edit") {
    this.#hush();
    this.#typing = purpose;
    let k = this.#kbd;
    if (!k) {
      k = this.#kbd = document.createElement("input");
      k.type = "text";
      k.maxLength = 300;
      k.setAttribute("aria-label", t("Type it"));
      k.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;";
      k.addEventListener("input", () => ((this.#heard = k!.value), this.#ver++));
      k.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const text = k!.value.trim();
        const p = this.#typing;
        k!.value = "";
        if (!text || !p) return;
        if (p === "world") this.#build(text, performance.now());
        else this.#edit(text, performance.now());
      });
      document.body.appendChild(k);
    }
    k.value = "";
    this.#heard = "";
    k.focus();
  }

  #endTyping() {
    if (!this.#typing) return;
    this.#typing = null;
    this.#kbd?.blur();
  }

  /** The session's select (a user gesture): a trigger pulled on a Type button focuses the field there. */
  #typeOnSelect() {
    const b = this.#right.hover?.button ?? this.#left.hover?.button;
    if (b === "sheet:type") this.#startTyping("world");
    else if (b === "wrist:type") this.#startTyping("edit");
  }

  #click(id: string, now: number) {
    this.#ver++;
    if (id === "result:again") this.onAction?.({ k: "again" });
    else if (id === "result:world" || id === "wrist:world") {
      this.#sheetOpen = true;
      this.#placeAhead(this.#sheet, 1.25, -0.12);
      // New world on the watch listens at once (where the browser can): say it, and it builds
      if (id === "wrist:world" && this.#making) this.#listen(now, "world", false);
    } else if (id === "sheet:listen") this.#listen(now, "world", false);
    else if (id === "sheet:go" || id === "wrist:send") this.#rec?.stop();
    else if (id === "sheet:type") this.#startTyping("world");
    else if (id === "wrist:type") this.#startTyping("edit");
    else if (id === "wrist:make") this.#page = "make";
    else if (id === "wrist:back") ((this.#page = "play"), this.#hush(), this.#endTyping(), this.#dio && this.#toggleDiorama(now));
    else if (id === "wrist:diorama") this.#toggleDiorama(now);
    else if (id === "wrist:say") this.#listen(now, "edit", false);
    else if (id === "wrist:undo") this.onAction?.({ k: "undo" });
    else if (id.startsWith("wrist:chip:")) {
      const c = this.#hud.make.chips[Number(id.slice(11))];
      if (c) this.#edit(c, now);
    } else if (id === "wrist:move") {
      this.#smooth = !this.#smooth;
      store.set("gr_vr_move", this.#smooth ? "smooth" : "teleport");
    } else if (id === "wrist:vignette") {
      this.#vignetteOn = !this.#vignetteOn;
      store.set("gr_vr_vignette", this.#vignetteOn ? "on" : "off");
    } else if (id === "sheet:close") {
      this.#sheetOpen = false;
      this.#hush();
      this.#endTyping();
    } else if (id.startsWith("sheet:chip:")) {
      const p = this.#hud.prompts[Number(id.slice(11))];
      if (p) this.#build(p.prompt, now);
    }
  }

  // ---- where you stand ------------------------------------------------------------------------

  /** After the world's poses: stand the rig on the player's feet, in the seat, or where the reveal is watched from. */
  place(now: number, w: VrWorld) {
    const rig = this.#h.rig;
    const hl = this.#head.p;
    if (w.building) {
      if (!this.#stand) {
        // the reveal's own camera says where it is seen from: stand there, facing its middle
        const f = this.eye.getWorldDirection(_v);
        this.#stand = { p: this.eye.position.clone(), yaw: Math.atan2(-f.x, -f.z), head: hl.clone(), headYaw: yawOf(this.#head.q) };
        this.#blinkUntil = now + 250;
      }
      const s = this.#stand;
      const yaw = s.yaw - s.headYaw;
      const [hx, hz] = turnXZ(s.head.x, s.head.z, yaw);
      rig.rotation.set(0, yaw, 0);
      rig.position.set(s.p.x - hx, s.p.y - s.head.y, s.p.z - hz);
      rig.scale.setScalar(1);
      return;
    }
    if (this.#stand) ((this.#stand = null), (this.#blinkUntil = now + 300));
    const player = w.view?.actors.get(PLAYER_ID);
    const dio = this.#dio;
    if (dio && !this.#hud.make.bounds) this.#dio = null; // (a world with no layout to model)
    else if (dio) {
      if (!w.view) return; // (between worlds: stay over the table)
      // the model on the table: fitted once (and again for each world an edit brings), then still,
      // so you can lean in and walk round it
      if (dio.view !== w.view) {
        const fit = dioramaFit(this.#hud.make.bounds!, w.view.groundY, [hl.x, hl.y, hl.z], yawOf(this.#head.q), dio.yaw, Number.isNaN(dio.table[0]) ? undefined : dio.table);
        Object.assign(dio, fit, { view: w.view });
      }
      rig.rotation.set(0, dio.yaw, 0);
      rig.scale.setScalar(dio.scale);
      rig.position.set(dio.pos[0], dio.pos[1], dio.pos[2]);
      if (player) player.visible = true; // you, in the model
      return;
    }
    rig.scale.setScalar(1);
    if (!player) return;
    player.visible = false; // first person: your own figure would stand in your eyes
    if (this.#faceTo !== null && this.#head.ok) {
      this.#turnTo(this.#faceTo - yawOf(this.#head.q));
      this.#faceTo = null;
    }
    if (!this.#centred && this.#head.ok) {
      // the head over the capsule to begin with; the room's offset is kept from then on
      const [hx, hz] = turnXZ(hl.x, hl.z, this.#yaw);
      this.#off.x = -hx;
      this.#off.z = -hz;
      this.#centred = true;
    }
    const ride = w.sim?.sim.ride(PLAYER_ID);
    const vehicle = ride && w.view?.actors.get(ride.vehicle);
    if (ride && vehicle) {
      // the seat: facing the vehicle's nose as the race layer turns it, eyes just over its top
      if (this.#seat?.vehicle !== ride.vehicle) {
        const size = w.sim!.sim.entity(ride.vehicle)?.size ?? [1, 1, 1];
        this.#seat = { vehicle: ride.vehicle, head: hl.clone(), headYaw: yawOf(this.#head.q), eye: Math.max(1.05, size[1] + 0.35), yaw: this.#yaw };
        this.#blinkUntil = now + 250;
      }
      const seat = this.#seat;
      seat.yaw = yawOf(vehicle.quaternion) - seat.headYaw;
      const [hx, hz] = turnXZ(seat.head.x, seat.head.z, seat.yaw);
      rig.rotation.set(0, seat.yaw, 0);
      rig.position.set(player.position.x - hx, player.position.y - 0.9 + seat.eye - seat.head.y, player.position.z - hz);
      return;
    }
    if (this.#seat) {
      // out of the seat: on foot, facing the way you were, standing where the seat was
      this.#yaw = this.#seat.yaw;
      this.#seat = null;
      this.#blinkUntil = now + 250;
      const [hx, hz] = turnXZ(hl.x, hl.z, this.#yaw);
      this.#off.x = -hx;
      this.#off.z = -hz;
    }
    rig.rotation.set(0, this.#yaw, 0);
    rig.position.set(player.position.x + this.#off.x, player.position.y - 0.9, player.position.z + this.#off.z);
  }

  // ---- what you see ---------------------------------------------------------------------------

  /** The rest of the frame: hands, panels, pointers, the arc, the vignette (and the probe). */
  after(now: number, dt: number, w: VrWorld) {
    const t0 = performance.now();
    const rig = this.#h.rig;
    rig.updateMatrixWorld(true);
    _rigQ.copy(rig.quaternion);
    const head = this.#head;
    head.wp.copy(head.p).applyMatrix4(rig.matrixWorld);
    head.wq.copy(_rigQ).multiply(head.q);
    for (const h of this.#hands) {
      h.wRay.p.copy(h.ray.p).applyMatrix4(rig.matrixWorld);
      h.wRay.q.copy(_rigQ).multiply(h.ray.q);
      h.wRay.d.set(0, 0, -1).applyQuaternion(h.wRay.q);
      h.wGrip.p.copy(h.grip.p).applyMatrix4(rig.matrixWorld);
      h.wGrip.q.copy(_rigQ).multiply(h.grip.q);
      const m = this.#models[h.side];
      m.visible = h.connected;
      m.position.copy(h.wGrip.p);
      m.quaternion.copy(h.wGrip.q);
      m.scale.setScalar(this.#k);
    }
    this.#poll(now, w);
    this.#panelsFrame(now, dt, w);
    this.#pointers();
    this.#arcView();
    this.#carried(w);
    this.#grabView(w);
    this.#heldView(w);
    this.#fogFor(this.#k);
    this.#comfort(now, dt, w);
    this.#pad.visible = w.building;
    if (w.building) this.#pad.position.set(head.wp.x, rig.position.y + 0.01, head.wp.z);
    this.#time(now, this.#cpuMs + performance.now() - t0);
    if (now >= this.#probeAt) this.#probe(now, w);
  }

  /** How many world metres the play space's one is now: 1 life size, the diorama's scale over the model. */
  get #k(): number {
    return this.#h.rig.scale.x;
  }

  /** Where the sky and the weather centre (the engine asks): your head over the model, else null (the player). */
  get skyAt(): Vector3 | null {
    return this.#dio ? this.#head.wp : null;
  }

  /** In the diorama the fog's distances scale with the world, so the model isn't lost in it (restored after). */
  #fogFor(k: number) {
    const fog = this.#h.scene.fog as { near?: number; far?: number } | null;
    if (!fog || typeof fog.near !== "number" || typeof fog.far !== "number") return;
    const f = this.#fog;
    if (k === 1) {
      if (f && fog.near === f.setNear && fog.far === f.setFar) ((fog.near = f.near), (fog.far = f.far));
      this.#fog = null;
      return;
    }
    // (a world loaded or restyled meanwhile set its own: that is the one to scale)
    const g = f && fog.near === f.setNear && fog.far === f.setFar ? f : (this.#fog = { near: fog.near, far: fog.far, setNear: 0, setFar: 0 });
    g.setNear = fog.near = g.near * k;
    g.setFar = fog.far = g.far * k;
  }

  /** What the diorama's hand holds is drawn on the anchor it would go on (or at the ray's end): the view only. */
  #heldView(w: VrWorld) {
    const h = this.#held;
    const obj = h ? w.view?.actors.get(h.id) : undefined;
    if (!h || !obj) return;
    if (h.spot) obj.position.set(h.spot.at[0], h.spot.at[1] + 0.5, h.spot.at[2]);
    else {
      const R = this.#right.wRay;
      obj.position.copy(R.p).addScaledVector(R.d, 0.35 * this.#k);
    }
  }

  /** A few times a second, from the simulation: the lap, your hit points, the ghost's split, what the buttons do. */
  #poll(now: number, w: VrWorld) {
    if (now < this.#pollAt) return;
    this.#pollAt = now + 250;
    const rs = w.sim;
    const sim = rs?.sim;
    const st = { lap: "", hp: "", race: "", hint: "", grab: "" };
    const race = sim?.raceOf("player");
    const track = sim?.verbs.find((v) => v.plugin.id === "racing.track");
    if (sim && race && track) {
      const laps = Math.max(1, Number(track.bound.params.laps) || 1);
      const order = sim.standings();
      st.lap = `LAP ${Math.min(laps, race.laps + 1)}/${laps}${order.length > 1 ? ` · ${ordinal(order.indexOf("player") + 1)} of ${order.length}` : ""} · gate ${race.passed}/${race.gates}`;
    }
    const max = sim?.maxHp("player") ?? null;
    if (sim && max !== null) st.hp = `HP ${Math.ceil(sim.hp("player") ?? 0)}/${max}`;
    const r = this.#hud.race;
    // (the split moves all the time: once a second is plenty for a watch, and keeps its repaints rare)
    if (r && rs && now < this.#raceAt && !this.#hud.result) st.race = this.#status.race;
    else if (r && rs) {
      this.#raceAt = now + 1000;
      if (this.#tracker?.sim !== rs || this.#tracker.ghost !== r.rival.ghost) this.#tracker = { sim: rs, ghost: r.rival.ghost, t: new RaceTracker(new GhostTrack(r.rival.ghost), r.secrets) };
      const res = this.#hud.result;
      const d = res ? null : this.#tracker.t.delta(rs.sim);
      const you = res?.k === "lose" ? "you didn't finish" : res ? `you ${raceClock(res.tick)} (${split((res.tick - r.rival.ghost.ticks) / 60)})` : d === null ? "you: off its route" : `you ${split(d)}`;
      st.race = `${r.rival.name} ${raceClock(r.rival.ghost.ticks)} · ${you}`;
    }
    if (sim?.ride(PLAYER_ID)) st.hint = "Right trigger: boost · left trigger: get out";
    else if (this.#hud.hint) st.hint = `Trigger: ${this.#hud.hint}`;
    if (!this.#walk && !this.#dio && sim && !sim.entity(PLAYER_ID)?.carrying && this.#pointedItem(w)) st.grab = "Right grip: grab it";
    const o = this.#status;
    if (st.lap !== o.lap || st.hp !== o.hp || st.race !== o.race || st.hint !== o.hint || st.grab !== o.grab) ((this.#status = st), this.#ver++);
  }

  #panelsFrame(now: number, dt: number, w: VrWorld) {
    const head = this.#head;
    const hy = yawOf(head.wq);
    // the toast and subtitles follow your gaze lazily: only once it has moved well away
    const off = wrap(hy - this.#lazyYaw);
    if (Math.abs(off) > 0.45) this.#lazyYaw = wrap(this.#lazyYaw + off * (1 - Math.exp(-dt * 3)));

    // the watch: on the left wrist, shown while you look at it
    const L = this.#left;
    if (L.connected) {
      const p = this.#wrist.mesh;
      p.position.copy(L.wGrip.p);
      p.quaternion.copy(L.wGrip.q);
      p.scale.setScalar(this.#k);
      p.translateY(0.045 * this.#k);
      p.translateZ(0.1 * this.#k);
      p.rotateX(-Math.PI / 4);
      _f.set(0, 0, 1).applyQuaternion(p.quaternion);
      _v.copy(head.wp).sub(p.position).normalize();
      if (this.#painted.wrist !== this.#ver) ((this.#painted.wrist = this.#ver), this.#paintWrist());
      this.#wrist.shown = _f.dot(_v) > 0.25;
    } else this.#wrist.shown = false;

    // the result card: in front of you when the run ends, and it stays there (until a new world is on its way)
    const res = this.#hud.result;
    if (res && !this.#sheetOpen && !this.#hud.busy && !this.#dio) {
      if (res.tick !== this.#resultTick) ((this.#resultTick = res.tick), this.#placeAhead(this.#result, PANELS.result.at, -0.1));
      if (this.#painted.result !== this.#ver) ((this.#painted.result = this.#ver), this.#paintResult(res));
      this.#result.shown = true;
    } else this.#result.shown = false;
    if (!res) this.#resultTick = -1;

    if (this.#sheetOpen) {
      if (this.#painted.sheet !== this.#ver) ((this.#painted.sheet = this.#ver), this.#paintSheet());
      this.#sheet.shown = true;
    } else this.#sheet.shown = false;

    // brief words: the build, a notice, your own (head-locked, lazily, and only for a few seconds)
    const own = this.#own && now < this.#own.until ? this.#own.text : null;
    const toast = own ?? this.#hud.toast;
    if (toast) {
      this.#ahead(this.#toast.mesh, 1.5, -0.3, 0.18);
      this.#toast.mesh.scale.setScalar(this.#k);
      this.#toast.show(`t:${toast}`, (ui) => {
        ui.card("rgba(10, 7, 22, 0.86)");
        const px = PANELS.toast.font;
        const lines = ui.wrap(toast, px, ui.w - 80, 2);
        ui.text(toast, ui.w / 2, (ui.h - lines.length * px * 1.25) / 2, px, INK, { maxW: ui.w - 80, max: 2, align: "center" });
      });
    } else this.#toast.shown = false;

    // who's talking: over their head, sized for the distance; out of sight, a subtitle in front
    const bark = this.#hud.bark;
    if (bark && Date.now() - bark.at < 6000) {
      const m = this.#bark.mesh;
      const npc = w.view?.actors.get(bark.npc);
      let d = 0;
      let inView = false;
      if (npc) {
        _v.copy(npc.position).sub(head.wp);
        d = _v.length();
        _f.set(0, 0, -1).applyQuaternion(head.wq);
        inView = !this.#dio && d < 18 && d > 0.5 && _f.dot(_v) / d > Math.cos(0.9);
      }
      this.#barkAt = npc && inView ? "head" : "front";
      if (npc && inView) {
        const s = Math.max(0.5, d / PANELS.bark.at);
        m.scale.setScalar(s);
        m.position.set(npc.position.x, npc.position.y + 1.05 + (this.#bark.heightM * s) / 2, npc.position.z);
        m.lookAt(head.wp);
      } else {
        m.scale.setScalar((1.6 / PANELS.bark.at) * this.#k);
        this.#ahead(m, 1.6, toast ? -0.5 : -0.38, 0.2);
      }
      this.#bark.show(`b:${bark.at}:${bark.name}:${bark.line}`, (ui) => {
        // as tall as the words: the card sits on the panel's bottom edge, just over their head
        const px = PANELS.bark.font;
        const said = `${bark.name}: ${bark.line}`;
        const top = ui.h - ui.wrap(said, px, ui.w - 80, 3).length * px * 1.25 - 56;
        ui.card("rgba(10, 7, 22, 0.86)", undefined, Math.max(0, top));
        ui.text(said, 40, Math.max(0, top) + 28, px, INK, { maxW: ui.w - 80, max: 3 });
      });
    } else ((this.#bark.shown = false), (this.#barkAt = null));
  }

  /** A panel in front of you at `dist`, `dy` under your eyes, facing you (world-locked from then on). */
  #placeAhead(panel: Panel, dist: number, dy: number) {
    const head = this.#head;
    const rig = this.#h.rig;
    rig.updateMatrixWorld();
    _v.copy(head.p).applyMatrix4(rig.matrixWorld);
    const yaw = rig.rotation.y + yawOf(head.q);
    const k = this.#k; // (over the diorama the play space is that much bigger)
    panel.mesh.position.set(_v.x - Math.sin(yaw) * dist * k, _v.y + dy * k, _v.z - Math.cos(yaw) * dist * k);
    panel.mesh.rotation.set(-0.08, yaw, 0, "YXZ");
    panel.mesh.scale.setScalar(k);
  }

  /** Lazily head-locked: `dist` ahead along the lazy gaze, `dy` under the eyes, tilted `tilt` back. */
  #ahead(m: Object3D, dist: number, dy: number, tilt: number) {
    const p = this.#head.wp;
    const yaw = this.#lazyYaw;
    const k = this.#k;
    m.position.set(p.x - Math.sin(yaw) * dist * k, p.y + dy * k, p.z - Math.cos(yaw) * dist * k);
    m.rotation.set(tilt, yaw, 0, "YXZ");
  }

  #paintWrist() {
    if (this.#making && (this.#page === "make" || this.#dio)) return this.#paintMake();
    const hud = this.#hud;
    const st = this.#status;
    const key = JSON.stringify([hud.proof, hud.score, st, this.#smooth, this.#vignetteOn, this.#making, locale()]);
    this.#wrist.show(key, (ui) => {
      ui.card();
      const px = PANELS.wrist.font;
      ui.dot(38, 24 + px * 0.6, 10, TONE[hud.proof.tone] ?? TONE.pending!);
      let y = ui.text(hud.proof.text, 60, 22, px, INK, { max: 2 });
      if (hud.score) y = ui.text(hud.score, 28, y + 6, px + 4, INK, { weight: 800, max: 1 });
      const stats = [st.lap, st.hp].filter(Boolean).join(" · ");
      if (stats) y = ui.text(stats, 28, y + 4, px, "#ffb02e", { max: 1 });
      if (st.race) y = ui.text(st.race, 28, y + 4, px, CYAN, { max: 1 });
      for (const h of [st.hint, st.grab]) if (h) y = ui.text(h, 28, y + 4, px, DIM, { max: 1 });
      const bh = 66;
      const by = ui.h - bh - 18;
      if (this.#making) {
        // the world's own tools: change it in words, or as a model on the table
        ui.button("wrist:make", t("Change it"), { x: 18, y: by - bh - 10, w: 360, h: bh }, px, true);
        ui.button("wrist:diorama", t("Diorama"), { x: 390, y: by - bh - 10, w: 360, h: bh }, px);
      }
      ui.button("wrist:world", t("New world"), { x: 18, y: by, w: 216, h: bh }, px, true);
      ui.button("wrist:move", this.#smooth ? t("Move: smooth") : t("Move: teleport"), { x: 246, y: by, w: 252, h: bh }, px);
      ui.button("wrist:vignette", this.#vignetteOn ? t("Vignette: on") : t("Vignette: off"), { x: 510, y: by, w: 240, h: bh }, px);
    });
  }

  /**
   * The watch's Change it face: what the latest edit did (the summary line, the headline's status),
   * three changes to try, say one, Undo; over the diorama, what the hand holds and where it would go.
   */
  #paintMake() {
    const hud = this.#hud;
    const make = hud.make;
    const ways = this.#ways();
    const listening = this.#rec !== null && this.#listenFor === "edit";
    const typing = this.#typing === "edit";
    const held = this.#held;
    const thing = held ? (make.movable.find((m) => m.id === held.id)?.label ?? held.id) : "";
    const aimedAt = !held && this.#aimedAt ? (make.movable.find((m) => m.id === this.#aimedAt)?.label ?? "") : "";
    const dio = this.#dio !== null;
    const key = JSON.stringify([hud.proof, make.edit, make.chips, make.canUndo, make.live, listening, typing, this.#heard, this.#note, held?.id, held?.spot?.zone, held?.spot?.anchor, aimedAt, dio, hud.busy, ways, locale()]);
    this.#wrist.show(key, (ui) => {
      ui.card();
      const px = PANELS.wrist.font;
      const bh = 66;
      const by = ui.h - bh - 18;
      const row2 = by - bh - 10;
      const chipH = 50;
      const chipsAt = row2 - 3 * (chipH + 8);
      let y = ui.text(dio ? t("Diorama") : t("Change this world"), 28, 18, px + 6, INK, { weight: 800, max: 1 });
      const e = make.edit;
      // what is happening now: your words, the edit under way or done, or how to ask for one
      const [line, tone] = listening
        ? [this.#heard || t("Listening… say a change."), this.#heard ? INK : CYAN]
        : typing
          ? [this.#heard || t("Type a change, then Enter. No keyboard opened? This browser has none in VR."), this.#heard ? INK : CYAN]
          : this.#note
            ? [this.#note, TONE.warn!]
            : e
              ? [e.line, e.status === "failed" ? TONE.bad! : e.status === "done" ? TONE.good! : CYAN]
              : [dio ? t("Right grip on a thing in the model picks it up; let go where it goes.") : editWaysLine(ways, make.live), DIM];
      y = ui.text(line, 28, y + 4, px, tone, { max: 2 });
      if (e?.summary && !listening && !typing) y = ui.text(e.summary, 28, y + 2, px, INK, { max: 1 });
      if (e?.receipt && !listening && !typing) y = ui.text(e.receipt, 28, y + 2, px, INK, { max: 2 });
      if (dio && held) y = ui.text(held.spot ? t("Let go to put the {thing} in the {where}.", { thing, where: held.spot.label }) : t("Point at a free spot for the {thing}.", { thing }), 28, y + 4, px, held.spot ? CYAN : TONE.warn!, { max: 2 });
      else if (dio && aimedAt) y = ui.text(t("Right grip: pick up the {thing}", { thing: aimedAt }), 28, y + 4, px, CYAN, { max: 1 });
      // the headline and its status, as the receipt has it now
      // (as many lines as there is room for, up to two)
      const room = Math.min(2, Math.floor(((dio ? row2 : chipsAt) - 8 - (y + 8)) / (px * 1.25)));
      if (room > 0) {
        ui.dot(38, y + 8 + px * 0.6, 9, TONE[hud.proof.tone] ?? TONE.pending!);
        ui.text(hud.proof.text, 58, y + 8, px, DIM, { max: room });
      }
      if (!dio && make.live) make.chips.slice(0, 3).forEach((c, i) => ui.button(`wrist:chip:${i}`, c, { x: 18, y: chipsAt + i * (chipH + 8), w: ui.w - 36, h: chipH }, px));
      ui.button("wrist:diorama", dio ? t("Life size") : t("Diorama"), { x: 18, y: row2, w: 360, h: bh }, px, dio);
      if (ways.keyboard && make.live) ui.button("wrist:type", t("Type it"), { x: 390, y: row2, w: 360, h: bh }, px);
      if (listening) ui.button("wrist:send", t("Done"), { x: 18, y: by, w: 252, h: bh }, px, true);
      else if (ways.speech && make.live) ui.button("wrist:say", t("Say a change"), { x: 18, y: by, w: 252, h: bh }, px, true);
      if (make.canUndo && !hud.busy) ui.button("wrist:undo", t("Undo"), { x: 282, y: by, w: 216, h: bh }, px);
      ui.button("wrist:back", t("Back"), { x: 510, y: by, w: 240, h: bh }, px);
    });
  }

  #paintResult(r: VrResult) {
    this.#result.show(JSON.stringify([r, this.#hud.busy]), (ui) => {
      const win = r.k === "win";
      ui.card("rgba(10, 7, 22, 0.92)", win ? "rgba(61, 255, 168, 0.55)" : "rgba(255, 59, 92, 0.55)");
      const px = PANELS.result.font;
      let y = ui.text(r.head, 52, 36, 80, win ? TONE.good : TONE.bad, { weight: 800, max: 1 });
      y = ui.text(r.time, 52, y + 6, px + 6, INK, { max: 1 });
      if (r.par) y = ui.text(r.par, 52, y + 12, px, DIM, { max: 2 });
      if (r.race) y = ui.text(r.race, 52, y + 8, px, CYAN, { max: 1 });
      y = ui.text(`Host: ${r.recap}`, 52, y + 22, px, INK, { max: 4 });
      const bh = 84;
      const by = ui.h - bh - 34;
      // what led to it, as far as there's room above the buttons
      for (const m of r.moments) if (y + px * 1.3 < by - 16) y = ui.text(m, 52, y + 8, px, DIM, { max: 1 });
      ui.button("result:again", "Play again", { x: 52, y: by, w: 420, h: bh }, px + 4, true);
      ui.button("result:world", "New world", { x: 500, y: by, w: 470, h: bh }, px + 4);
    });
  }

  #paintSheet() {
    const hud = this.#hud;
    const listening = this.#rec !== null && this.#listenFor === "world";
    const typing = this.#typing === "world";
    const ways = this.#ways();
    const held = this.#rec?.continuous === true; // (the grip, rather than a button)
    const key = JSON.stringify([hud.prompts, hud.busy, listening, typing, held, this.#heard, this.#note, ways, this.#making, locale()]);
    this.#sheet.show(key, (ui) => {
      ui.card("rgba(10, 7, 22, 0.93)");
      const px = PANELS.sheet.font;
      let y = ui.text(listening ? t("Listening…") : typing ? t("Type a world") : t("Say a world"), 48, 34, 56, listening || typing ? CYAN : INK, { weight: 800, max: 1 });
      // which ways this browser has, said plainly: voice, the headset's keyboard, and always the starters
      const sub = listening
        ? this.#heard || (held ? t("Say what to build, then let go of the grip.") : t("Say what to build: it builds when you stop."))
        : typing
          ? this.#heard || t("Type it, then Enter. No keyboard opened? This browser has none in VR: pick one.")
          : (this.#note ?? waysLine(ways, !this.#making));
      y = ui.text(sub, 48, y + 10, px, (listening || typing) && this.#heard ? INK : DIM, { max: 2 });
      const chips = hud.prompts.slice(0, 6);
      const cw = (ui.w - 48 * 2 - 20) / 2;
      const ch = 78;
      chips.forEach((c, i) => {
        const x = 48 + (i % 2) * (cw + 20);
        const cy = y + 24 + Math.floor(i / 2) * (ch + 16);
        ui.button(`sheet:chip:${i}`, c.label, { x, y: cy, w: cw, h: ch }, px);
      });
      const by = ui.h - 84 - 28;
      if (listening && !held && this.#heard) ui.button("sheet:go", t("Build it"), { x: 48, y: by, w: 300, h: 84 }, px, true);
      else if (!listening && ways.speech && this.#making && !hud.busy) ui.button("sheet:listen", t("Listen"), { x: 48, y: by, w: 300, h: 84 }, px, true);
      if (ways.keyboard && !typing && !hud.busy) ui.button("sheet:type", t("Type it"), { x: 368, y: by, w: 300, h: 84 }, px);
      ui.button("sheet:close", hud.busy ? t("Building…") : t("Close"), { x: ui.w - 48 - 260, y: by, w: 260, h: 84 }, px);
    });
  }

  /** Rays from the controllers: what they point at on a panel lights up, and the trigger clicks it. */
  #pointers() {
    const shooting = /shoot/.test(this.#hud.hint ?? "");
    const open = this.#result.shown || this.#sheet.shown;
    for (const h of this.#hands) {
      const ray = this.#rays[h.side];
      const tip = this.#tips[h.side];
      let best: Hand["hover"] = null;
      if (h.connected) {
        for (const p of this.#targets) {
          if (!p.shown || (h.side === "left" && p === this.#wrist)) continue; // (the hand the watch is on can't point at it)
          const hit = p.hit(h.wRay.p, h.wRay.d);
          if (hit && (!best || hit.t < best.t)) best = { panel: p, button: hit.button, t: hit.t };
        }
      }
      if (best?.button && best.button !== h.hover?.button) h.buzz(0.15, 12);
      h.hover = best;
      // a ray shows on a panel, while one is open to point at, to aim a weapon, or over the diorama
      // (the god hand's); its lengths are the play space's, so over the model they scale with it
      const k = this.#k;
      const len = best ? best.t : (open ? 2.5 : this.#dio && h === this.#right ? 1.2 : shooting && h === this.#right ? 8 : 0) * k;
      ray.visible = h.connected && len > 0;
      tip.visible = Boolean(best);
      tip.scale.setScalar(k);
      if (!ray.visible) continue;
      ray.material = best?.button || (this.#dio && h === this.#right && (this.#aimedAt || this.#held?.spot)) ? this.#mats.rayOn : this.#mats.ray;
      ray.position.copy(h.wRay.p);
      ray.quaternion.copy(h.wRay.q);
      ray.scale.set(k, k, len);
      if (best) tip.position.copy(h.wRay.p).addScaledVector(h.wRay.d, best.t);
    }
    // (the right hand's button wins when both point at the same panel)
    const R = this.#right.hover;
    const L = this.#left.hover;
    for (const p of this.#targets) p.hover = (R?.panel === p ? R.button : null) ?? (L?.panel === p ? L.button : null);
  }

  /** The teleport arc as dots, and a ring where it lands (cyan: you can go there). */
  #arcView() {
    const a = this.#aiming ? this.#arc : null;
    this.#dots.visible = Boolean(a);
    this.#marker.visible = Boolean(a?.target);
    if (!a) return;
    const n = Math.min(a.points.length, 49);
    for (let i = 0; i < n; i++) {
      const p = a.points[i]!;
      const s = 1 - (i / n) * 0.5;
      _m.makeScale(s, s, s).setPosition(p[0], p[1], p[2]);
      this.#dots.setMatrixAt(i, _m);
    }
    this.#dots.count = n;
    this.#dots.instanceMatrix.needsUpdate = true;
    this.#dots.material = a.valid ? this.#mats.ok : this.#mats.no;
    if (a.target) {
      this.#marker.position.set(a.target[0], a.target[1] + 0.02, a.target[2]);
      this.#marker.material = a.valid ? this.#mats.ok : this.#mats.no;
    }
  }

  /** What you carry is drawn in your right hand (the sim keeps it where it always does: this is the view only). */
  #carried(w: VrWorld) {
    const item = w.sim?.sim.entity(PLAYER_ID)?.carrying;
    this.#carrying = item ?? "";
    const obj = item ? w.view?.actors.get(item) : undefined;
    const R = this.#right;
    if (!obj || !R.connected) return;
    obj.position.copy(R.wGrip.p).addScaledVector(_f.set(0, 0, -1).applyQuaternion(R.wGrip.q), 0.07);
    obj.quaternion.copy(R.wGrip.q);
  }

  /** A ring under what the grip would grab (and under what it's walking you to). */
  #grabView(w: VrWorld) {
    const ring = this.#grabRing;
    if (this.#dio) {
      // over the model: under what the hand would pick up, or on the anchor a held thing would go on
      // (a few centimetres across on the table, whatever the scale)
      const spot = this.#held?.spot;
      const obj = !this.#held && this.#aimedAt ? w.view?.actors.get(this.#aimedAt) : undefined;
      ring.visible = Boolean(spot || obj);
      ring.scale.setScalar(this.#k * 0.06);
      if (spot) ring.position.set(spot.at[0], spot.at[1] + 0.05, spot.at[2]);
      else if (obj) ring.position.set(obj.position.x, obj.position.y - 0.3, obj.position.z);
      return;
    }
    ring.scale.setScalar(1);
    const id = this.#walk?.kind === "grab" ? this.#walk.item : this.#status.grab ? this.#pointedItem(w) : "";
    const obj = id ? w.view?.actors.get(id) : undefined;
    ring.visible = Boolean(obj);
    if (obj) ring.position.set(obj.position.x, obj.position.y - 0.45, obj.position.z);
  }

  /** The vignette while you move without moving (the stick, a vehicle), the blink for a teleport or a swap. */
  #comfort(now: number, dt: number, w: VrWorld) {
    const ride = w.sim?.sim.ride(PLAYER_ID);
    let s = 0;
    if (ride && this.#seat && dt > 0) {
      // at the wheel it's the turns and the surges that unsettle, more than a steady speed
      const turn = Math.abs(wrap(this.#seat.yaw - this.#lastSeatYaw)) / dt;
      const surge = Math.abs(ride.speed - this.#lastSpeed) / dt;
      s = Math.min(1, Math.min(1, turn / 1.2) * 0.8 + Math.min(1, surge / 10) * 0.4 + Math.min(1, Math.abs(ride.speed) / Math.max(1, ride.feel.speed)) * 0.25);
      this.#lastSpeed = ride.speed;
    } else if (!this.#walk) s = this.#moving * 0.8;
    this.#lastSeatYaw = this.#seat?.yaw ?? 0;
    if (!this.#vignetteOn) s = 0;
    const blink = this.#walk?.kind === "teleport" || now < this.#blinkUntil ? 1 : 0;
    this.#vignette.set(s, blink, dt);
    this.#vignette.place(this.#head.wp, this.#head.wq, this.#k);
  }

  #time(now: number, ms: number) {
    this.#cpu[this.#cpuN++ % this.#cpu.length] = ms;
    if (now < this.#cpuAt) return;
    this.#cpuAt = now + 1000;
    const n = Math.min(this.#cpuN, this.#cpu.length);
    const xs = Array.from(this.#cpu.subarray(0, n)).sort((a, b) => a - b);
    this.#cpuStats = { p50: round3(xs[Math.floor(n * 0.5)] ?? 0), p95: round3(xs[Math.floor(n * 0.95)] ?? 0) };
  }

  /** For the tests (and a curious console): what each panel says, where its buttons are in the play space. */
  #probe(now: number, w: VrWorld) {
    this.#probeAt = now + 100;
    const rig = this.#h.rig;
    _m.copy(rig.matrixWorld).invert();
    const buttons: Record<string, [number, number, number]> = {};
    for (const p of this.#panels) {
      if (!p.shown) continue;
      for (const b of p.buttons) {
        const c = p.centreOf(b.id, _w);
        if (c) (c.applyMatrix4(_m), (buttons[b.id] = [round3(c.x), round3(c.y), round3(c.z)]));
      }
    }
    const a = this.#arc;
    probe().xr = {
      panels: Object.fromEntries(this.#panels.map((p) => [p.id, { shown: p.shown, draws: p.draws, words: [...p.words] }])),
      buttons,
      hover: this.#right.hover?.button ?? this.#left.hover?.button ?? null,
      move: this.#smooth ? "smooth" : "teleport",
      vignette: this.#vignetteOn,
      teleport: { aiming: this.#aiming, valid: Boolean(a?.valid), target: a?.target ? [round3(a.target[0]), round3(a.target[1]), round3(a.target[2])] : null, walking: this.#walk?.kind === "teleport" },
      grab: this.#walk?.kind === "grab" ? this.#walk.item : null,
      carrying: this.#carrying,
      seat: this.#seat ? { vehicle: this.#seat.vehicle, yaw: round3(this.#seat.yaw) } : null,
      bark: this.#barkAt,
      listening: this.#rec !== null,
      watching: this.#stand !== null,
      sheet: this.#sheetOpen,
      cpu: this.#cpuStats,
      page: this.#making && (this.#page === "make" || this.#dio) ? "make" : "play",
      listenFor: this.#rec ? this.#listenFor : null,
      typing: this.#typing,
      diorama: this.#dioProbe(w),
    };
  }

  /** The diorama for the probe: its scale, what is held and where it would go, and where things and free spots show on the table (in the play space). */
  #dioProbe(w: VrWorld): XrProbe["diorama"] {
    const d = this.#dio;
    if (!d || !w.view) return null;
    const play = (p: readonly [number, number, number]): [number, number, number] => toPlay(d, p).map(round3) as [number, number, number];
    const items: Record<string, [number, number, number]> = {};
    for (const m of this.#hud.make.movable) {
      const a = m.id === this.#held?.id ? undefined : w.view.actors.get(m.id);
      if (a) items[m.id] = play([a.position.x, a.position.y, a.position.z]);
    }
    // (while something is held, only the spots it can go on: the floor's, or the walls' for a painting)
    const h = this.#held;
    const high = h ? (this.#hud.make.movable.find((m) => m.id === h.id)?.high ?? false) : null;
    const spots: Record<string, [number, number, number]> = {};
    for (const s of this.#hud.make.spots) if (high === null || s.high === high) spots[`${s.zone}/${s.anchor}`] = play(s.at);
    return { scale: round3(d.scale), held: h?.id ?? null, target: h?.spot ? `${h.spot.zone}/${h.spot.anchor}` : null, aimed: this.#aimedAt || null, items, spots };
  }

  dispose() {
    [window.requestAnimationFrame, window.cancelAnimationFrame] = this.#raf;
    this.#hush();
    (this.#h.renderer.xr.getSession() as XRSession | null)?.removeEventListener("select", this.#onSelect);
    this.#kbd?.remove();
    this.#fogFor(1);
    this.#h.rig.scale.setScalar(1);
    this.#root.removeFromParent();
    for (const p of this.#panels) p.dispose();
    this.#vignette.dispose();
    this.#dots.dispose();
    for (const g of this.#geos) g.dispose();
    for (const m of Object.values(this.#mats)) m.dispose();
    this.#h.input.setStick(0, 0);
    this.#h.input.setButton(BTN_JUMP, false);
    this.#h.input.setButton(BTN_USE, false);
    delete probe().xr;
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
