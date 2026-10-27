// Stub FrameSource: a fixed-60 Hz main-thread loop that moves only the player, with gravity,
// (double) jump from the world's laws, coyote time, a jump buffer and crude AABB collision.
// Every other entity is reported at its placed pose. The deterministic Rapier Sim Worker
// replaces this file; nothing in the renderer depends on how poses are produced.
import { clampLaws, isZeroG, type Laws, type WorldBundle } from "@ghostrun/ir";
import { collidersOf, type Box } from "./aabb";
import { BTN_JUMP, PLAYER_ID, TICK_HZ, type FrameSource, type InputFrame, type Pose, type SimFrame } from "./types";

const DT = 1 / TICK_HZ;
/** Gamey gravity (m/s²): ~2.2 g keeps the 1.6 m jump snappy. The real sim owns the true value. */
const G = 9.81 * 2.2;
const HALF: [number, number, number] = [0.35, 0.9, 0.35]; // player capsule as a box
const EPS = 1e-4;
const MAX_CATCHUP_TICKS = 15; // 250 ms: survive slow (software-GL) frames without losing sim time

const yawQuat = (yaw: number): Pose["q"] => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];

export interface StubOptions {
  spawnId?: string;
}

export class StubSim implements FrameSource {
  readonly #laws: Laws;
  readonly #boxes: Box[];
  readonly #statics = new Map<string, Pose>();
  readonly #spawn: [number, number, number];
  readonly #spawnYaw: number;

  #p: [number, number, number];
  #v: [number, number, number] = [0, 0, 0];
  #facing: number;
  #grounded = false;
  #jumpsUsed = 0;
  #coyote = 0;
  #buffer = 0;
  #lastBtn = 0;
  #pressQueued = false;
  #in: InputFrame = { tick: 0, mx: 0, my: 0, yaw: 0, btn: 0 };

  #tick = 0;
  #acc = 0;
  #last = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #onFrame: ((f: SimFrame) => void) | undefined;

  constructor(bundle: WorldBundle, opts: StubOptions = {}) {
    this.#laws = clampLaws(bundle.laws);
    this.#boxes = collidersOf(bundle);
    for (const e of bundle.entities) this.#statics.set(e.id, { p: [...e.pos], q: yawQuat(e.rotY) });

    const spawn = bundle.entities.find((e) => e.id === (opts.spawnId ?? "sp_red")) ?? bundle.entities.find((e) => e.kind === "spawn");
    this.#spawn = spawn ? [spawn.pos[0], spawn.pos[1] + HALF[1] + 0.02, spawn.pos[2]] : [0, HALF[1] + 0.02, 0];
    // Face the world centre from the spawn (city_block bases sit on the x axis).
    this.#spawnYaw = Math.atan2(-(0 - this.#spawn[0]), -(0 - this.#spawn[2]));
    this.#p = [...this.#spawn];
    this.#facing = this.#spawnYaw;
  }

  get spawnYaw() {
    return this.#spawnYaw;
  }

  start(onFrame: (f: SimFrame) => void): void {
    this.#onFrame = onFrame;
    this.#last = performance.now();
    this.#emit();
    // Poll faster than the tick rate; the accumulator keeps ticks at exactly 1/60 s of sim time.
    this.#timer = setInterval(() => this.#pump(), 4);
  }

  input(f: InputFrame): void {
    // Latch rising edges so a tap shorter than one tick still jumps.
    if (f.btn & BTN_JUMP && !(this.#lastBtn & BTN_JUMP)) this.#pressQueued = true;
    this.#lastBtn = f.btn;
    this.#in = f;
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#onFrame = undefined;
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

  #emit() {
    if (!this.#onFrame) return;
    const poses = new Map(this.#statics);
    poses.set(PLAYER_ID, { p: [...this.#p], q: yawQuat(this.#facing) });
    this.#onFrame({ tick: this.#tick, poses });
  }

  #step() {
    this.#tick++;
    const L = this.#laws;
    const inp = this.#in;
    const zeroG = isZeroG(L);
    const g = zeroG ? 0 : G * L.gravityScale;

    // Wish direction relative to the camera yaw (three.js: yaw 0 looks down -z).
    const s = Math.sin(inp.yaw);
    const c = Math.cos(inp.yaw);
    let wx = -s * inp.my + c * inp.mx;
    let wz = -c * inp.my - s * inp.mx;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) {
      wx /= wl;
      wz /= wl;
    }
    const speed = L.speed;
    const response = this.#grounded ? 14 : 14 * L.airControl;
    const k = 1 - Math.exp(-response * DT);
    this.#v[0] += (wx * speed - this.#v[0]) * k;
    this.#v[2] += (wz * speed - this.#v[2]) * k;
    if (wl > 0.1) {
      const target = Math.atan2(-wx, -wz);
      let d = target - this.#facing;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.#facing += d * Math.min(1, 16 * DT);
    }

    // Jump: buffered press, coyote time on the ground jump, extra air jumps up to jumpsMax.
    if (this.#pressQueued) {
      this.#buffer = L.bufferMs / 1000;
      this.#pressQueued = false;
    }
    if (this.#grounded) {
      this.#coyote = L.coyoteMs / 1000;
      this.#jumpsUsed = 0;
    } else {
      this.#coyote = Math.max(0, this.#coyote - DT);
      if (this.#coyote === 0 && this.#jumpsUsed === 0) this.#jumpsUsed = 1; // walked off: ground jump spent
    }
    if (zeroG) {
      if (inp.btn & BTN_JUMP) this.#v[1] = Math.min(this.#v[1] + L.thrust * DT, L.thrust);
      else this.#v[1] *= 0.98;
    } else if (this.#buffer > 0) {
      const canGround = this.#jumpsUsed === 0 && (this.#grounded || this.#coyote > 0);
      const canAir = this.#jumpsUsed > 0 && this.#jumpsUsed < L.jumpsMax;
      if (L.jumpsMax > 0 && (canGround || canAir)) {
        this.#v[1] = Math.sqrt(2 * g * L.jumpH);
        this.#jumpsUsed = canGround ? 1 : this.#jumpsUsed + 1;
        this.#coyote = 0;
        this.#buffer = 0;
        this.#grounded = false;
      }
    }
    this.#buffer = Math.max(0, this.#buffer - DT);

    this.#v[1] = Math.max(this.#v[1] - g * DT, -40);
    this.#grounded = false;
    this.#move(0, this.#v[0] * DT);
    this.#move(2, this.#v[2] * DT);
    this.#move(1, this.#v[1] * DT);

    if (this.#p[1] < -30) {
      this.#p = [...this.#spawn];
      this.#v = [0, 0, 0];
    }
  }

  /** Move along one axis and push out of any box the player now overlaps. */
  #move(axis: 0 | 1 | 2, delta: number) {
    if (delta === 0) {
      if (axis === 1) this.#grounded = this.#touchingGround();
      return;
    }
    const p = this.#p;
    p[axis] += delta;
    for (const b of this.#boxes) {
      if (
        p[0] + HALF[0] <= b.min[0] || p[0] - HALF[0] >= b.max[0] ||
        p[1] + HALF[1] <= b.min[1] || p[1] - HALF[1] >= b.max[1] ||
        p[2] + HALF[2] <= b.min[2] || p[2] - HALF[2] >= b.max[2]
      ) continue;
      if (delta > 0) p[axis] = b.min[axis] - HALF[axis] - EPS;
      else p[axis] = b.max[axis] + HALF[axis] + EPS;
      this.#v[axis] = 0;
      if (axis === 1 && delta < 0) this.#grounded = true;
    }
  }

  #touchingGround(): boolean {
    const p = this.#p;
    const feet = p[1] - HALF[1];
    return this.#boxes.some(
      (b) =>
        Math.abs(b.max[1] - feet) < 0.01 &&
        p[0] + HALF[0] > b.min[0] && p[0] - HALF[0] < b.max[0] &&
        p[2] + HALF[2] > b.min[2] && p[2] - HALF[2] < b.max[2],
    );
  }
}
