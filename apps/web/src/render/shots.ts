// Shots: the camera taken for a while, to show something. Red/green plays one AI runner's two runs
// side by side (before and after a change) with the camera framing both; the Host flies to the
// moment it cites, rising over walls rather than through them, and holds it while the replay plays.
// Any input or Esc hands the camera back (the engine ends the shot). Cosmetic: nothing here reaches
// the simulation.
import { AdditiveBlending, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, RingGeometry, type Object3D, type PerspectiveCamera } from "three/webgpu";
import type { Vec3 } from "@ghostrun/ir";
import type { Ghost, Parting } from "@ghostrun/proof/light";
import { probe } from "../probe";
import { GhostTrack } from "../race";
import type { Box } from "../sim/aabb";
import { ease, flight, frameAt, type Framing } from "./flight";
import { ghostActor, GHOST_HEX } from "./ghost";
import { beamMaterial } from "./materials";

export interface Shot {
  /** What it adds to the scene while it plays (red/green's two ghosts), if anything. */
  readonly root: Object3D | null;
  /** World loads it lasts through (the Host's replay rebuilds the world once under it). */
  keep: number;
  /** Places the camera for this frame; false once it's over. */
  frame(now: number, dt: number, cam: PerspectiveCamera): boolean;
  dispose(): void;
}

/** What a shot can use: the walls (to rise over), the models' knight for a ghost, a compile off the frame. */
export interface Stage {
  readonly colliders: readonly Box[];
  /** The knight of light for a ghost (none without models); returns what takes it off again. */
  dress(obj: Object3D, key: string): () => void;
  compile(obj: Object3D): Promise<unknown>;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const v2 = (p: { x: number; y: number; z: number } | Vec3): [number, number, number] => (Array.isArray(p) ? [r2(p[0]), r2(p[1]), r2(p[2])] : [r2(p.x), r2(p.y), r2(p.z)]);

/** Where the camera looks now (a point `dist` ahead of it). */
function lookOf(cam: PerspectiveCamera, dist: number): Vec3 {
  const e = cam.matrixWorld.elements;
  return [cam.position.x - e[8]! * dist, cam.position.y - e[9]! * dist, cam.position.z - e[10]! * dist];
}

/**
 * The Host's fly-to: from wherever the camera is to a framing of the place, in about 1.2 s (eased
 * in and out, over walls), then held there (the replay plays under it) until any input or Esc.
 */
export class FlyShot implements Shot {
  readonly root = null;
  keep = 0;
  readonly #to: Vec3;
  readonly #ms: number;
  readonly #boxes: readonly Box[];
  readonly #arrive: (() => void) | undefined;
  readonly #end: (() => void) | undefined;
  #path: ((t: number) => Framing) | null = null;
  #t0 = 0;
  #arrived = false;

  constructor(stage: Stage, at: Vec3, opts: { ms?: number; onArrive?: () => void; onEnd?: () => void } = {}) {
    this.#to = at;
    this.#ms = opts.ms ?? 1200;
    this.#boxes = stage.colliders;
    this.#arrive = opts.onArrive;
    this.#end = opts.onEnd;
  }

  frame(now: number, _dt: number, cam: PerspectiveCamera): boolean {
    if (!this.#path) {
      const from: Framing = { pos: [cam.position.x, cam.position.y, cam.position.z], look: lookOf(cam, 7) };
      this.#path = flight(from, frameAt(this.#to, from.pos, this.#boxes), this.#boxes);
      this.#t0 = now;
    }
    const k = Math.min(1, (now - this.#t0) / this.#ms);
    const f = this.#path(ease(k));
    cam.position.set(f.pos[0], f.pos[1], f.pos[2]);
    cam.lookAt(f.look[0], f.look[1], f.look[2]);
    if (k >= 1 && !this.#arrived) {
      this.#arrived = true;
      this.#arrive?.();
    }
    probe().shot = { kind: "fly", to: v2(this.#to), cam: v2(cam.position), arrived: this.#arrived };
    return true;
  }

  dispose() {
    delete probe().shot;
    this.#end?.();
  }
}

export interface RedGreenPlay {
  /** Null: the red run alone (a world's own failing run, with no other version to set it beside). */
  green: Ghost | null;
  red: Ghost;
  /** Where they part (null: they never do), and the caption for before and after it. */
  parting: Parting | null;
  caption: { before: string; parted: string };
  /** The HUD's caption line (null when the shot ends). */
  onCaption: (text: string | null) => void;
}

/** Ticks of sim time a frame's worth of real time is: twice as fast until just before they part. */
const FAST = 2;

/**
 * Red/green: the same runner's two runs as two knights of light, green and red, played side by side
 * from the start, the camera framing both; where they part lights up and the caption names it.
 */
export class RedGreenShot implements Shot {
  readonly root: Group;
  keep = 0;
  readonly #play: RedGreenPlay;
  readonly #tracks: [GhostTrack, GhostTrack];
  readonly #actors = [ghostActor(), ghostActor()] as const;
  readonly #undress: (() => void)[] = [];
  readonly #boxes: readonly Box[];
  readonly #marker: Group;
  readonly #end: number;
  #tick = 0;
  #last = -1;
  #caption: string | null = null;
  #cam: Framing | null = null;

  constructor(stage: Stage, play: RedGreenPlay) {
    this.#play = play;
    this.#boxes = stage.colliders;
    // (alone, the red run stands in for both: the camera frames it, and green isn't drawn)
    const g = play.green ?? play.red;
    this.#tracks = [new GhostTrack(g), new GhostTrack(play.red)];
    this.#end = Math.max(g.ticks, play.red.ticks) + 150; // and a moment at the end to see where each got to
    this.root = new Group();
    this.root.name = "redgreen";
    const [green, red] = this.#actors;
    green.setKind("green");
    red.setKind("red");
    this.root.add(red.obj);
    if (play.green) this.root.add(green.obj);
    this.#undress.push(stage.dress(red.obj, "red"), ...(play.green ? [stage.dress(green.obj, "green")] : []));
    // where they part: a ring on the ground and a beam over it, lit once they get there
    this.#marker = new Group();
    const ring = new Mesh(new RingGeometry(0.7, 0.85, 40), new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.8, side: DoubleSide, depthWrite: false, blending: AdditiveBlending }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.85;
    const beam = new Mesh(new CylinderGeometry(0.35, 0.35, 10, 20, 1, true), beamMaterial(GHOST_HEX.green, 1.6, 0.45));
    beam.position.y = 4.2;
    this.#marker.add(ring, beam);
    this.#marker.visible = false;
    const p = play.parting?.at;
    if (p) this.#marker.position.set(p[0], p[1], p[2]);
    this.root.add(this.#marker);
    for (const m of [ring, beam]) ((m.renderOrder = 3), (m.frustumCulled = false));
  }

  frame(now: number, dt: number, cam: PerspectiveCamera): boolean {
    const part = this.#play.parting?.tick ?? Infinity;
    this.#last = this.#last < 0 ? now : this.#last;
    const rate = this.#tick < part - 90 ? FAST : 1;
    this.#tick += ((now - this.#last) / 1000) * 60 * rate;
    this.#last = now;
    if (this.#tick > this.#end) return false;
    const [g, r] = [this.#tracks[0].pose(this.#tick), this.#tracks[1].pose(this.#tick)];
    for (const [i, q] of [g, r].entries()) {
      const o = this.#actors[i]!.obj;
      o.position.set(q.p[0], q.p[1], q.p[2]);
      o.rotation.set(0, q.yaw, 0);
      this.#actors[i]!.setFade(this.#tick >= this.#tracks[i]!.ticks ? 0.45 : 1);
    }
    const parted = this.#tick >= part;
    this.#marker.visible = parted;
    // what the two are, always; and once they have parted, where
    this.#say(parted && this.#play.parting ? `${this.#play.caption.before} · ${this.#play.caption.parted}` : this.#play.caption.before);
    // frame both: from the side of the line between them, back far enough for the gap
    const mid: Vec3 = [(g.p[0] + r.p[0]) / 2, (g.p[1] + r.p[1]) / 2, (g.p[2] + r.p[2]) / 2];
    const [sx, sz] = [r.p[0] - g.p[0], r.p[2] - g.p[2]];
    const gap = Math.hypot(sx, sz, r.p[1] - g.p[1]);
    const cur: Vec3 = [cam.position.x, cam.position.y, cam.position.z];
    let side: Vec3 = cur;
    if (Math.hypot(sx, sz) > 1) {
      // the side of the gap the camera is on already, so it never swings across
      const [nx, nz] = [-sz, sx];
      const s = (cur[0] - mid[0]) * nx + (cur[2] - mid[2]) * nz >= 0 ? 1 : -1;
      side = [mid[0] + nx * s, mid[1], mid[2] + nz * s];
    }
    const want = frameAt(mid, side, this.#boxes, Math.min(30, 8 + gap * 0.9));
    const k = this.#cam ? 1 - Math.exp(-dt * 2.5) : 1;
    const lerp = (p: Vec3, q: Vec3): Vec3 => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
    this.#cam = this.#cam ? { pos: lerp(this.#cam.pos, want.pos), look: lerp(this.#cam.look, want.look) } : want;
    cam.position.set(...this.#cam.pos);
    cam.lookAt(...this.#cam.look);
    probe().redgreen = { tick: Math.round(this.#tick), parted, caption: this.#caption ?? "", green: v2(g.p), red: v2(r.p), cam: v2(cam.position) };
    return true;
  }

  #say(text: string) {
    if (text === this.#caption) return;
    this.#caption = text;
    this.#play.onCaption(text);
  }

  dispose() {
    for (const u of this.#undress) u();
    for (const a of this.#actors) a.dispose();
    this.#marker.traverse((o) => {
      if (o instanceof Mesh) (o.geometry.dispose(), (o.material as MeshBasicMaterial).dispose());
    });
    this.#play.onCaption(null);
    delete probe().redgreen;
  }
}
