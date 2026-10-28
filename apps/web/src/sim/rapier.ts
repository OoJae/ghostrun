// RapierSim: the product's deterministic SimWorld behind the renderer's FrameSource seam.
// Camera-relative input (mx, my, yaw) becomes a quantised int8 world-space move vector here on the
// main thread, so the trigonometry never enters the simulation: only the int8 frames are logged
// and replayed, and they replay bit-exactly on every runtime (docs/gates.md, S0c).
import { castBrain, type CastBrain } from "@ghostrun/bots";
import type { WorldBundle } from "@ghostrun/ir";
import { buildNav, type NavWorld } from "@ghostrun/nav";
import { BTN, SimWorld, type InputFrame as SimInput, type Rapier, type SimEvent } from "@ghostrun/sim";
import { BTN_JUMP, BTN_USE, PLAYER_ID, TICK_HZ, type FrameSource, type InputFrame, type Pose, type SimFrame } from "./types";

const DT = 1 / TICK_HZ;

export interface MindChoice {
  tick: number;
  npc: string;
  option: string;
}
const MAX_CATCHUP_TICKS = 15;

const q8 = (x: number) => Math.max(-127, Math.min(127, Math.round(x * 127)));

export class RapierSim implements FrameSource {
  readonly sim: SimWorld;
  /** The cast's brain (null if the navmesh couldn't load): minds switch NPC options through it. */
  readonly brain: CastBrain | null;
  readonly spawnYaw: number;
  /** Every tick's input as the simulation saw it (for replays and share links). */
  readonly inputs: SimInput[] = [];
  onEvents: ((evs: SimEvent[]) => void) | undefined;
  /** The nearest thing the player could USE changed ("flip switch"), or null. */
  onHint: ((label: string | null) => void) | undefined;
  #subs = new Set<(evs: SimEvent[]) => void>();
  #replay: SimInput[] | null = null;
  #ri = 0;
  /** Mind choices as the sim applied them, tick by tick: replays and share links feed them back. */
  readonly minds: MindChoice[] = [];
  /** Where the player went, every half second (the Director reads it between runs). */
  readonly trail: [number, number, number][] = [];
  #pendingMinds: { npc: string; option: string }[] = [];
  #replayMinds: MindChoice[] = [];
  /** Fires when a replay ends or the player takes over. */
  onReplayEnd: (() => void) | undefined;
  #hint: string | null = null;

  #in: InputFrame = { tick: 0, mx: 0, my: 0, yaw: 0, btn: 0 };
  #lastBtn = 0;
  #activeTick = 0;
  #pressQueued = false;
  #facing = 0;
  readonly #npcFacing = new Map<string, number>();
  readonly #nav: NavWorld | null;
  #acc = 0;
  #last = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #onFrame: ((f: SimFrame) => void) | undefined;

  constructor(R: Rapier, bundle: WorldBundle, bots = true) {
    this.#nav = bots ? buildNav(bundle) : null;
    this.brain = this.#nav ? castBrain(this.#nav, bundle) : null;
    this.sim = new SimWorld(R, bundle, this.brain ? { brain: this.brain } : {});
    // face the first goal or pickup from the spawn
    const p = this.sim.pos(PLAYER_ID);
    const target = bundle.entities.find((e) => e.kind === "pickup") ?? bundle.entities.find((e) => e.kind === "goal");
    this.spawnYaw = target ? Math.atan2(-(target.pos[0] - p[0]), -(target.pos[2] - p[2])) : 0;
    this.#facing = this.spawnYaw;
  }

  start(onFrame: (f: SimFrame) => void): void {
    this.#onFrame = onFrame;
    this.#last = performance.now();
    this.#emit();
    this.#timer = setInterval(() => this.#pump(), 4);
  }

  /**
   * Play back a recorded run frame by frame (a share link), minds included; any input takes over.
   * `from` fast-forwards to that tick first (the Host's "show me"): every event still reaches the
   * subscribers, so the scene is exactly as it was at that moment.
   */
  replay(frames: readonly SimInput[], minds: readonly MindChoice[] = [], from = 0) {
    this.#replay = [...frames];
    this.#ri = 0;
    this.#replayMinds = [...minds];
    while (this.#replay && this.sim.tick < from && !this.sim.result) this.#step();
  }

  /** A mind picked a menu option: it takes effect on the next tick (and is logged with it). */
  queueMind(npc: string, option: string) {
    this.#pendingMinds.push({ npc, option });
  }

  /** The option an NPC is playing now. */
  optionOf(npc: string): string {
    return this.brain?.bots.find((b) => b.id === npc)?.option ?? "";
  }

  #applyMinds(tick: number) {
    if (this.#replay) {
      for (const m of this.#replayMinds) if (m.tick === tick) this.brain?.choose(m.npc, m.option);
      return;
    }
    for (const m of this.#pendingMinds) if (this.brain?.choose(m.npc, m.option)) this.minds.push({ tick, npc: m.npc, option: m.option });
    this.#pendingMinds = [];
  }

  get replaying(): boolean {
    return this.#replay !== null;
  }

  #endReplay() {
    this.#replay = null;
    this.onReplayEnd?.();
  }

  /** Ticks since the player last touched the controls. */
  get idleTicks(): number {
    return this.sim.tick - this.#activeTick;
  }

  input(f: InputFrame): void {
    if (f.mx !== 0 || f.my !== 0 || f.btn !== 0) this.#activeTick = this.sim.tick;
    if (this.#replay && (f.mx !== 0 || f.my !== 0 || f.btn !== 0)) this.#endReplay();
    if (f.btn & BTN_JUMP && !(this.#lastBtn & BTN_JUMP)) this.#pressQueued = true;
    this.#lastBtn = f.btn;
    this.#in = f;
  }

  /** Renderer hook for sim events (state changes, removals); returns an unsubscribe. */
  subscribe(fn: (evs: SimEvent[]) => void): () => void {
    this.#subs.add(fn);
    return () => this.#subs.delete(fn);
  }

  /** Seconds left on the world's countdown (a timer verb), or null if it has none. */
  get countdown(): number | null {
    const v = this.sim.verbs.find((x) => x.plugin.id === "puzzle.timer");
    return v ? Math.max(0, (Number(v.bound.mem.end) - this.sim.tick) / 60) : null;
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#onFrame = undefined;
    this.sim.free();
    this.#nav?.destroy();
  }

  #pump() {
    const now = performance.now();
    this.#acc = Math.min(this.#acc + (now - this.#last) / 1000, MAX_CATCHUP_TICKS * DT);
    this.#last = now;
    while (this.#acc >= DT) {
      this.#acc -= DT;
      this.#step();
      this.#emit();
    }
  }

  #step() {
    if (this.#replay) {
      // the recorded frames are exactly what the sim saw, so feeding them back is bit-exact
      const tick = this.sim.tick + 1;
      while (this.#ri < this.#replay.length && this.#replay[this.#ri]!.tick < tick) this.#ri++;
      const rec = this.#replay[this.#ri];
      if (!rec) {
        this.#endReplay();
      } else {
        const frame = rec.tick === tick ? rec : { tick, wx: 0, wz: 0, btn: 0 };
        if (frame.wx || frame.wz) this.#facing = Math.atan2(-frame.wx, -frame.wz);
        this.#applyMinds(tick);
        this.inputs.push(frame);
        const evs = this.sim.step(frame);
        if (evs.length) {
          this.onEvents?.(evs);
          for (const f of this.#subs) f(evs);
        }
        return;
      }
    }
    const i = this.#in;
    // three.js camera yaw 0 looks down −z: forward = (−sin, −cos), right = (cos, −sin)
    const s = Math.sin(i.yaw);
    const c = Math.cos(i.yaw);
    let x = i.mx * c - i.my * s;
    let z = -i.mx * s - i.my * c;
    const len = Math.sqrt(x * x + z * z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    if (len > 0.01) this.#facing = Math.atan2(-x, -z);
    let btn = i.btn & ~BTN_JUMP;
    if (this.#pressQueued || i.btn & BTN_JUMP) btn |= BTN.JUMP;
    this.#pressQueued = false;
    if (i.btn & BTN_USE) btn |= BTN.USE;
    // a held jump must release for one tick before it counts again (fresh-press semantics)
    const frame: SimInput = { tick: this.sim.tick + 1, wx: q8(x), wz: q8(z), btn };
    if (frame.tick % 30 === 0) this.trail.push(this.sim.pos(PLAYER_ID));
    this.#applyMinds(frame.tick);
    this.inputs.push(frame);
    const evs = this.sim.step(frame);
    if (evs.length) {
      this.onEvents?.(evs);
      for (const f of this.#subs) f(evs);
    }
    const label = this.sim.usable()?.label ?? (this.sim.entity(PLAYER_ID)?.carrying ? "drop" : null);
    if (label !== this.#hint) {
      this.#hint = label;
      this.onHint?.(label);
    }
  }

  #emit() {
    if (!this.#onFrame) return;
    // NPCs face where they walk (cosmetic: main thread only, never fed back into the sim)
    for (const [id, c] of this.sim.npcs) if (c.vx * c.vx + c.vz * c.vz > 0.04) this.#npcFacing.set(id, Math.atan2(-c.vx, -c.vz));
    const poses = new Map<string, Pose>();
    for (const id of this.sim.order) {
      const pose = this.sim.pose(id);
      const yaw = id === PLAYER_ID ? this.#facing : this.#npcFacing.get(id);
      poses.set(id, yaw === undefined ? pose : { p: pose.p, q: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] });
    }
    this.#onFrame({ tick: this.sim.tick, poses });
  }
}
