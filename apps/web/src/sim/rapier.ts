// RapierSim: the product's deterministic SimWorld behind the renderer's FrameSource seam.
// Camera-relative input (mx, my, yaw) becomes a quantised int8 world-space move vector here on the
// main thread, so the trigonometry never enters the simulation: only the int8 frames are logged
// and replayed, and they replay bit-exactly on every runtime (docs/gates.md, S0c).
import type { WorldBundle } from "@ghostrun/ir";
import { BTN, SimWorld, type InputFrame as SimInput, type Rapier, type SimEvent } from "@ghostrun/sim";
import { BTN_JUMP, BTN_USE, PLAYER_ID, TICK_HZ, type FrameSource, type InputFrame, type Pose, type SimFrame } from "./types";

const DT = 1 / TICK_HZ;
const MAX_CATCHUP_TICKS = 15;

const q8 = (x: number) => Math.max(-127, Math.min(127, Math.round(x * 127)));

export class RapierSim implements FrameSource {
  readonly sim: SimWorld;
  readonly spawnYaw: number;
  /** Every tick's input as the simulation saw it (for replays and share links). */
  readonly inputs: SimInput[] = [];
  onEvents: ((evs: SimEvent[]) => void) | undefined;

  #in: InputFrame = { tick: 0, mx: 0, my: 0, yaw: 0, btn: 0 };
  #lastBtn = 0;
  #pressQueued = false;
  #facing = 0;
  #acc = 0;
  #last = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #onFrame: ((f: SimFrame) => void) | undefined;

  constructor(R: Rapier, bundle: WorldBundle) {
    this.sim = new SimWorld(R, bundle);
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

  input(f: InputFrame): void {
    if (f.btn & BTN_JUMP && !(this.#lastBtn & BTN_JUMP)) this.#pressQueued = true;
    this.#lastBtn = f.btn;
    this.#in = f;
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#onFrame = undefined;
    this.sim.free();
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
    this.inputs.push(frame);
    const evs = this.sim.step(frame);
    if (evs.length) this.onEvents?.(evs);
  }

  #emit() {
    if (!this.#onFrame) return;
    const poses = new Map<string, Pose>();
    for (const id of this.sim.order) {
      const pose = this.sim.pose(id);
      poses.set(id, id === PLAYER_ID ? { p: pose.p, q: [0, Math.sin(this.#facing / 2), 0, Math.cos(this.#facing / 2)] } : pose);
    }
    this.#onFrame({ tick: this.sim.tick, poses });
  }
}
