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
import type { InputCollector } from "../input";
import { probe } from "../probe";
import { GhostTrack, RaceTracker, raceClock, split } from "../race";
import type { Box } from "../sim/aabb";
import type { RapierSim } from "../sim/rapier";
import { BTN_JUMP, BTN_USE, PLAYER_ID } from "../sim/types";
import type { WorldView } from "../render/world";
import { Vignette } from "./comfort";
import { EMPTY_HUD, type VrAction, type VrHud, type VrResult } from "./model";
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
/** A grab reaches a pickup this far from you, within this angle of where the hand points. */
const GRAB_RANGE = 6;
const GRAB_CONE = 0.4;
/** Let go of the grip moving at least this fast (m/s) and it's a throw. */
const THROW_SPEED = 1.4;
/** Fonts on each panel: the smallest is ≥ 0.02 rad tall where that panel is read (panel.test.ts checks). */
export const PANELS = {
  wrist: { px: [768, 440] as [number, number], width: 0.26, at: 0.45, font: 28 },
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
}

interface Walk {
  kind: "teleport" | "grab";
  target: V3;
  item: string;
  until: number;
  best: number;
  bestAt: number;
}

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
    // say a world: hold the left grip (let go and it builds)
    if (L.pressed(GRIP)) this.#listen(now);
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
      const step = this.#walking(now, w);
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
        if (tgt) this.#go(tgt, now, w);
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
  #go(target: V3, now: number, w: VrWorld) {
    const me = this.#me(w);
    if (!me) return;
    const dist = Math.hypot(target[0] - me.x, target[2] - me.z);
    const speed = w.sim?.sim.laws.speed ?? 6;
    this.#walk = { kind: "teleport", target, item: "", until: now + (dist / Math.max(1, speed)) * 1000 + 800, best: Infinity, bestAt: now };
    this.#right.buzz(0.3, 20);
  }

  /** A teleport or a grab under way: the stick input that walks there, or null once it's over. */
  #walking(now: number, w: VrWorld): { mx: number; my: number; yaw: number } | null {
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
    if (d < walk.best - 0.05) ((walk.best = d), (walk.bestAt = now));
    // there, out of time, or not getting any closer (a wall the arc didn't see, a shelf too high)
    if ((walk.kind === "teleport" && d < 0.25) || now > walk.until || now - walk.bestAt > 450) return end();
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
        this.#walk = { kind: "grab", target: [p[0], p[1], p[2]], item, until: now + 3500, best: Infinity, bestAt: now };
        R.buzz(0.3, 20);
      }
    }
    // a throw only where the world has one for this thing (its own target: the sim's throw verb picks it)
    if (R.released(GRIP) && carrying && R.speed(now) >= THROW_SPEED) {
      const u = sim.usable();
      if (u && u.on === carrying && u.label === "throw") ((this.#useUntil = now + 60), R.buzz(0.8, 40));
    }
  }

  /** The pickup the right hand points at (within GRAB_CONE of its ray and GRAB_RANGE of you), or "". */
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
      _w.set(p[0] - ray.p.x, p[1] - ray.p.y, p[2] - ray.p.z);
      const d = _w.length();
      const angle = d > 1e-6 ? Math.acos(Math.max(-1, Math.min(1, _w.dot(ray.d) / d))) : 0;
      if (angle > GRAB_CONE) continue;
      const score = angle + d * 0.02;
      if (score < bestScore) ((bestScore = score), (best = id));
    }
    return best;
  }

  // ---- voice and the prompt sheet -------------------------------------------------------------

  /** Hold the left grip to say a world; where the browser can't listen, the sheet's chips instead. */
  #listen(now: number) {
    if (this.#hud.busy) return void (this.#own = { text: "Still building the last world…", until: now + 2500 });
    this.#sheetOpen = true;
    this.#placeAhead(this.#sheet, 1.25, -0.12);
    const Api = speechApi();
    if (!Api || this.#rec) return;
    const r = new Api();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = true; // keeps listening through a pause until the grip is let go
    this.#heard = "";
    this.#note = null;
    r.onresult = (e) => ((this.#heard = transcript(e)), this.#ver++);
    r.onerror = (e) => ((this.#note = voiceError(e.error, "say a world")), this.#ver++);
    r.onend = () => {
      this.#rec = null;
      this.#ver++;
      const text = this.#heard.trim();
      if (text) this.#build(text, performance.now());
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
    if (this.#hud.busy) return void (this.#own = { text: "Still building the last world…", until: now + 2500 });
    this.#sheetOpen = false;
    this.#heard = "";
    this.#own = { text: `Building: ${prompt.length > 80 ? `${prompt.slice(0, 78)}…` : prompt}`, until: now + 3000 };
    this.onAction?.({ k: "build", prompt: prompt.slice(0, 300) });
  }

  #click(id: string, now: number) {
    this.#ver++;
    if (id === "result:again") this.onAction?.({ k: "again" });
    else if (id === "result:world" || id === "wrist:world") {
      this.#sheetOpen = true;
      this.#placeAhead(this.#sheet, 1.25, -0.12);
    } else if (id === "wrist:move") {
      this.#smooth = !this.#smooth;
      store.set("gr_vr_move", this.#smooth ? "smooth" : "teleport");
    } else if (id === "wrist:vignette") {
      this.#vignetteOn = !this.#vignetteOn;
      store.set("gr_vr_vignette", this.#vignetteOn ? "on" : "off");
    } else if (id === "sheet:close") {
      this.#sheetOpen = false;
      this.#hush();
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
      return;
    }
    if (this.#stand) ((this.#stand = null), (this.#blinkUntil = now + 300));
    const player = w.view?.actors.get(PLAYER_ID);
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
    }
    this.#poll(now, w);
    this.#panelsFrame(now, dt, w);
    this.#pointers();
    this.#arcView();
    this.#carried(w);
    this.#grabView(w);
    this.#comfort(now, dt, w);
    this.#pad.visible = w.building;
    if (w.building) this.#pad.position.set(head.wp.x, rig.position.y + 0.01, head.wp.z);
    this.#time(now, this.#cpuMs + performance.now() - t0);
    if (now >= this.#probeAt) this.#probe(now);
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
    if (!this.#walk && sim && !sim.entity(PLAYER_ID)?.carrying && this.#pointedItem(w)) st.grab = "Right grip: grab it";
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
      p.translateY(0.045);
      p.translateZ(0.1);
      p.rotateX(-Math.PI / 4);
      _f.set(0, 0, 1).applyQuaternion(p.quaternion);
      _v.copy(head.wp).sub(p.position).normalize();
      if (this.#painted.wrist !== this.#ver) ((this.#painted.wrist = this.#ver), this.#paintWrist());
      this.#wrist.shown = _f.dot(_v) > 0.25;
    } else this.#wrist.shown = false;

    // the result card: in front of you when the run ends, and it stays there (until a new world is on its way)
    const res = this.#hud.result;
    if (res && !this.#sheetOpen && !this.#hud.busy) {
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
        inView = d < 18 && d > 0.5 && _f.dot(_v) / d > Math.cos(0.9);
      }
      this.#barkAt = npc && inView ? "head" : "front";
      if (npc && inView) {
        const s = Math.max(0.5, d / PANELS.bark.at);
        m.scale.setScalar(s);
        m.position.set(npc.position.x, npc.position.y + 1.05 + (this.#bark.heightM * s) / 2, npc.position.z);
        m.lookAt(head.wp);
      } else {
        m.scale.setScalar(1.6 / PANELS.bark.at);
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
    panel.mesh.position.set(_v.x - Math.sin(yaw) * dist, _v.y + dy, _v.z - Math.cos(yaw) * dist);
    panel.mesh.rotation.set(-0.08, yaw, 0, "YXZ");
    panel.mesh.scale.setScalar(1);
  }

  /** Lazily head-locked: `dist` ahead along the lazy gaze, `dy` under the eyes, tilted `tilt` back. */
  #ahead(m: Object3D, dist: number, dy: number, tilt: number) {
    const p = this.#head.wp;
    const yaw = this.#lazyYaw;
    m.position.set(p.x - Math.sin(yaw) * dist, p.y + dy, p.z - Math.cos(yaw) * dist);
    m.rotation.set(tilt, yaw, 0, "YXZ");
  }

  #paintWrist() {
    const hud = this.#hud;
    const st = this.#status;
    const key = JSON.stringify([hud.proof, hud.score, st, this.#smooth, this.#vignetteOn]);
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
      ui.button("wrist:world", "New world", { x: 18, y: by, w: 216, h: bh }, px, true);
      ui.button("wrist:move", this.#smooth ? "Move: smooth" : "Move: teleport", { x: 246, y: by, w: 252, h: bh }, px);
      ui.button("wrist:vignette", this.#vignetteOn ? "Vignette: on" : "Vignette: off", { x: 510, y: by, w: 240, h: bh }, px);
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
    const listening = this.#rec !== null;
    const speech = Boolean(speechApi());
    const key = JSON.stringify([hud.prompts, hud.busy, listening, this.#heard, this.#note, speech]);
    this.#sheet.show(key, (ui) => {
      ui.card("rgba(10, 7, 22, 0.93)");
      const px = PANELS.sheet.font;
      let y = ui.text(listening ? "Listening…" : "Say a world", 48, 34, 56, listening ? CYAN : INK, { weight: 800, max: 1 });
      const sub = listening ? this.#heard || "Say what to build, then let go of the grip." : this.#note ?? (speech ? "Hold the left grip and say it, or pick one:" : "This browser can't listen. Pick one:");
      y = ui.text(sub, 48, y + 10, px, listening && this.#heard ? INK : DIM, { max: 2 });
      const chips = hud.prompts.slice(0, 6);
      const cw = (ui.w - 48 * 2 - 20) / 2;
      const ch = 78;
      chips.forEach((c, i) => {
        const x = 48 + (i % 2) * (cw + 20);
        const cy = y + 24 + Math.floor(i / 2) * (ch + 16);
        ui.button(`sheet:chip:${i}`, c.label, { x, y: cy, w: cw, h: ch }, px);
      });
      ui.button("sheet:close", hud.busy ? "Building…" : "Close", { x: ui.w - 48 - 260, y: ui.h - 84 - 28, w: 260, h: 84 }, px);
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
      // a ray shows on a panel, while one is open to point at, or to aim a weapon
      const len = best ? best.t : open ? 2.5 : shooting && h === this.#right ? 8 : 0;
      ray.visible = h.connected && len > 0;
      tip.visible = Boolean(best);
      if (!ray.visible) continue;
      ray.material = best?.button ? this.#mats.rayOn : this.#mats.ray;
      ray.position.copy(h.wRay.p);
      ray.quaternion.copy(h.wRay.q);
      ray.scale.set(1, 1, len);
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
    const id = this.#walk?.kind === "grab" ? this.#walk.item : this.#status.grab ? this.#pointedItem(w) : "";
    const obj = id ? w.view?.actors.get(id) : undefined;
    this.#grabRing.visible = Boolean(obj);
    if (obj) this.#grabRing.position.set(obj.position.x, obj.position.y - 0.45, obj.position.z);
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
    this.#vignette.place(this.#head.wp, this.#head.wq);
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
  #probe(now: number) {
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
    };
  }

  dispose() {
    [window.requestAnimationFrame, window.cancelAnimationFrame] = this.#raf;
    this.#hush();
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
