// T3h, human-controller witnesses: the experts' own route planner plays the world again, but its
// moves go in as a player's would, through the browser's controller and camera rig (@ghostrun/sim
// rig.ts, the same arithmetic the client runs). The synthetic player holds WASD (eight digital
// directions, relative to the camera), turns the camera toward where it wants to go at the Q/E
// rate, re-decides its keys every few ticks, its hand on the camera never quite still, and fires
// only once it has turned to look. Every tick the follow camera is stood where the client would
// stand it. What only a human controller hits is flagged: the camera inside geometry, stuck frames
// over 0.5 s (keys held, the player going nowhere) and capsule traps (stuck for good), each only
// where the experts' own runners got through without stalling.
import { stream, type Rng } from "@ghostrun/detmath";
import type { Vec3, WorldBundle } from "@ghostrun/ir";
import { aimPush, BTN, boomLength, CAM, collidersOf, q8, stickToWorld, type Box, type InputFrame, type SimWorld } from "@ghostrun/sim";
import { placeOf } from "./revealed";
import type { Chip } from "./types";

/** Human-controller runs per world. */
export const HUMAN_RUNS = 6;

// The browser's per-frame easing at 60 frames a second, worked out once (1 − e^(−14/60) and
// 1 − e^(−4/60): render/camera.ts eases its look point and its pull back out by these per frame).
const TARGET_EASE = 0.20811043366321835;
const PULL_EASE = 0.06449301496838222;
// cos and sin of the camera's pitch: the follow rig's 0.36 rad, the cut-away interiors' 1.0 rad
const PITCH = { follow: [0.9358968236779348, 0.35227423327508994], cutaway: [0.5403023058681398, 0.8414709848078965] } as const;
// Q/E turn the camera 2.4 rad/s: 0.04 rad a tick (its cosine and sine)
const COS_T = 0.9992001066609779;
const SIN_T = 0.03998933418663416;
/** The player fires once the camera looks within 8° of the target (cos 8°). */
const COS_AIM = 0.9902680687415704;
/** Keys held for 2 to 4 ticks before the next choice; the camera hand wobbles up to ±0.6° a tick. */
const HOLD = [2, 3] as const;
const TREMOR = 0.01;
/** A push this small (of 127) is a nudge, not a walk: the touch stick gives it as it is. */
const NUDGE = 64;
/**
 * A player notices going nowhere after about a sixth of a second and steps aside for a fifth:
 * right, left, back and right, back and left (relative to the camera), in turn until it moves.
 */
const NOTICE = 8;
const ESCAPE_TICKS = 12;
const ESCAPES: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [1, -1], [-1, -1], [0, -1]];
/** Reaction time: a tenth of a second (an attentive player's; the playtest's average player is 8 ticks). */
const LAG = 6;
/** A player hops onto what is in the way up to this share of a jump's height (what a jump clears with room). */
const HOP = 0.8;
/**
 * How far ahead a player sees a wall coming (the probe's centre from the capsule's): the reaction lag is to
 * the plan, not to walls in plain view, which a player steers round before reaching them.
 */
const LOOK_M = 1.05;
/** Opt-in trace of the synthetic player's keys and the runs' reports (diagnosis only: `ghostrun human --rig`; it never changes a run). */
let DEBUG: ((s: string) => void) | null = null;
export const debugRig = (f: ((s: string) => void) | null) => void (DEBUG = f);
export const debugReports = (r: readonly HumanReport[], experts: readonly number[]) => DEBUG?.(`REPORT ${JSON.stringify(r.map((x) => ({ cam: x.cam, stalls: x.stalls })))} EXPERTS ${JSON.stringify(experts)}`);

/**
 * Stuck frames: the stick held into solid geometry (blockedAhead) over the last STALL_TICKS ticks,
 * and under PROGRESS_M made the way it pushed (stepping aside and back, pinned in a corner, pushing
 * into a slit: all the same). Waiting at a door, riding a jump pad or chasing someone who runs
 * faster is not stuck.
 */
export const STALL_TICKS = 30;
const PROGRESS_M = 0.3;
/** A stall this long is a trap whether or not it ends (3 s of trying), or one the run never left (1 s). */
const TRAP_TICKS = 180;
const TRAP_END_TICKS = 60;
/** The camera inside something over half a second is flagged (as stuck frames are: a glimpse is a pop, this is a view). */
export const CAM_TICKS = 30;
/** An expert stalled this near a human's stall is said to stall there too. */
const EXPERT_NEAR_M = 1.5;
/** A flag counts once this many of the runs hit the same place (within SAME_PLACE_M). */
const CONFIRM = 3;
const SAME_PLACE_M = 3;
/** Stalls this near each other in one run are one place (a player stepping aside and back at a slit). */
const PLACE_M = 2;

/**
 * Where a run's player went nowhere with the stick pushed: x, z (0.1 m), ticks (the window
 * included), and 1 if it never got going again (the run ended there) else 0, four numbers a stall.
 * Read off positions and the stick only.
 */
export class StallMeter {
  readonly spots: number[] = [];
  /** The last STALL_TICKS ticks' progress along the stick (m), or NaN where it wasn't pushed. */
  readonly #ring = new Float64Array(STALL_TICKS);
  /** And the same ticks' change in height (m): a lift or a ramp is going somewhere, a hop in place is not. */
  readonly #rise = new Float64Array(STALL_TICKS);
  #i = 0;
  #sum = 0;
  #up = 0;
  #held = 0;
  #lx = 0;
  #ly = 0;
  #lz = 0;
  #first = true;
  #start = -1;
  #at: [number, number] = [0, 0];

  /** One tick: where the player is now, and the way it was pushed (a unit x, z), or null. */
  step(tick: number, p: Vec3, dir: readonly [number, number] | null) {
    const step = this.#first ? 0 : dir ? (p[0] - this.#lx) * dir[0] + (p[2] - this.#lz) * dir[1] : 0;
    const dy = this.#first ? 0 : p[1] - this.#ly;
    this.#first = false;
    [this.#lx, this.#ly, this.#lz] = [p[0], p[1], p[2]];
    const old = this.#ring[this.#i]!;
    if (!Number.isNaN(old)) this.#sum -= old;
    else this.#held--;
    this.#ring[this.#i] = dir ? step : Number.NaN;
    if (dir) this.#sum += step;
    else this.#held++;
    this.#up += dy - this.#rise[this.#i]!;
    this.#rise[this.#i] = dy;
    this.#i = (this.#i + 1) % STALL_TICKS;
    // (#held counts the window's unpushed ticks: none, and it is a full window of pushing)
    const stuck = this.#held === 0 && this.#sum + Math.abs(this.#up) < PROGRESS_M;
    if (stuck && this.#start < 0) ((this.#start = tick - STALL_TICKS), (this.#at = [p[0], p[2]]));
    else if (!stuck) this.#close(tick, false);
  }

  #close(tick: number, end: boolean) {
    if (this.#start >= 0) this.spots.push(r1(this.#at[0]), r1(this.#at[1]), tick - this.#start, end ? 1 : 0);
    this.#start = -1;
  }

  /** The run is over: a stall still open is one it never left. */
  finish(tick: number): number[] {
    this.#close(tick, true);
    return this.spots;
  }

  constructor() {
    // the window starts unpushed
    this.#ring.fill(Number.NaN);
    this.#held = STALL_TICKS;
  }
}

/** The way a frame pushes the stick (unit x, z), or null for none or a nudge (turning to face, a lean). */
export function pushOf(f: InputFrame | null): [number, number] | null {
  const wx = f?.wx ?? 0;
  const wz = f?.wz ?? 0;
  const l = Math.sqrt(wx * wx + wz * wz);
  return l >= NUDGE ? [wx / l, wz / l] : null;
}

/**
 * Solid geometry right in front of a player pushing `dir` (unit x, z) from `p` (the capsule's
 * centre): box statics and fixed solid things, at the height of the body above the step the
 * controller climbs (0.4 m) and below the head. Doors (they open), anything moving and anyone
 * else are not snags: a push into one is waiting, not stuck.
 */
const blockerCache = new WeakMap<WorldBundle, { pos: Vec3; half: Vec3 }[]>();
export function blockedAhead(b: WorldBundle, p: Vec3, dir: readonly [number, number], reach = 0.45): boolean {
  return blockerTop(b, p, dir, reach) > -Infinity;
}

/** The top of the highest solid thing right in front (blockedAhead's), or -Infinity: whether a hop gets onto it. */
export function blockerTop(b: WorldBundle, p: Vec3, dir: readonly [number, number], reach = 0.45): number {
  let boxes = blockerCache.get(b);
  if (!boxes) {
    boxes = [
      ...b.statics.filter((s) => s.shape === "box" && s.rotY === 0).map((s) => ({ pos: s.pos, half: [s.size[0] / 2, s.size[1] / 2, s.size[2] / 2] as Vec3 })),
      ...b.entities.filter((e) => e.shape === "box" && e.rotY === 0 && e.body === "fixed" && e.kind !== "door" && e.kind !== "npc" && e.kind !== "spawn").map((e) => ({ pos: e.pos, half: [e.size[0] / 2, e.size[1] / 2, e.size[2] / 2] as Vec3 })),
    ];
    blockerCache.set(b, boxes);
  }
  // a probe 0.25 m square, its centre just past the capsule's front (radius 0.35 + 0.1)
  const [cx, cz] = [p[0] + dir[0] * reach, p[2] + dir[1] * reach];
  const [lo, hi] = [p[1] - 0.9 + 0.45, p[1] + 0.8];
  let top = -Infinity;
  for (const x of boxes) if (Math.abs(cx - x.pos[0]) < x.half[0] + 0.125 && Math.abs(cz - x.pos[2]) < x.half[2] + 0.125 && x.pos[1] - x.half[1] < hi && x.pos[1] + x.half[1] > lo) top = Math.max(top, x.pos[1] + x.half[1]);
  return top;
}

/** What one human-controller run hit: camera episodes (x, z of the player, 0.1 m; ticks; what it was in) and its stalls. */
export interface HumanReport {
  /** Camera inside geometry: x, z, ticks per episode (at least CAM_TICKS), and what it was inside, in order. */
  cam: number[];
  camIn: string[];
  /** Its stalls (StallMeter's four numbers each). */
  stalls: number[];
  /** Ticks on foot (the rig was checked) and in all. */
  foot: number;
  ticks: number;
}

interface Solid {
  id: string;
  /** What it is, as a flag says it ("ceiling", "wall", "the crate"). */
  what: string;
  half: Vec3;
  /** Where it is: fixed, or read off the sim each tick (a moving platform). */
  at: Vec3 | null;
}

/** The geometry a camera can end up inside: box statics (not rotated), and solid boxes that stand or move on a track. */
function solidsOf(b: WorldBundle, cutaway: boolean): Solid[] {
  const out: Solid[] = [];
  for (const s of b.statics) {
    if (s.shape !== "box" || s.rotY !== 0 || (cutaway && s.surf === "roof")) continue;
    out.push({ id: s.id, what: s.surf === "roof" && s.pos[1] - s.size[1] / 2 > 1 ? "ceiling" : s.surf, half: [s.size[0] / 2, s.size[1] / 2, s.size[2] / 2], at: s.pos });
  }
  for (const e of b.entities) {
    if (e.shape !== "box" || e.rotY !== 0 || (e.body !== "fixed" && e.body !== "kinematic") || e.kind === "npc" || e.kind === "spawn" || e.kind === "vehicle") continue;
    out.push({ id: e.id, what: `the ${e.noun || e.id.replace(/_/g, " ")}`, half: [e.size[0] / 2, e.size[1] / 2, e.size[2] / 2], at: e.body === "kinematic" ? null : e.pos });
  }
  return out;
}

/** The camera rig a world gets on the client: the cut-away interiors (the floor plan pack) look down over their walls. */
const cutawayOf = (b: WorldBundle) => b.pack.id === "floor_plan";

/** A unit vector turned by the angle whose tangent is t. */
function turn(x: number, z: number, t: number): [number, number] {
  const c = 1 / Math.sqrt(1 + t * t);
  const s = t * c;
  return [x * c - z * s, x * s + z * c];
}

const KEYS: readonly (readonly [number, number])[] = [[0, 1], [1, 1], [-1, 1], [1, 0], [-1, 0], [0, -1], [1, -1], [-1, -1]];

/**
 * A synthetic player on the client's controls for one run: `keys` turns what the planner wants
 * this tick into the frame the player's keys and camera produce; `look` stands the camera after
 * the tick and notes where it is inside something.
 */
export class HumanRig {
  // the camera's forward (unit, x z) and its look point and pull, as render/camera.ts keeps them
  #fx = 0;
  #fz = -1;
  #tx = 0;
  #ty = 0;
  #tz = 0;
  #pulled = 0;
  #snap = true;
  #keys: readonly [number, number] = [0, 0];
  #nextChoice = 0;
  // going nowhere with the keys held, and the way out being tried
  #lx = 0;
  #ly = 0;
  #lz = 0;
  #still = 0;
  #escapeUntil = 0;
  #tries = 0;
  /** What the planner meant, tick by tick, until the player acts on it. */
  readonly #seen: [number, number, number][] = [];
  readonly #rng: Rng;
  readonly #boxes: Box[];
  readonly #solids: Solid[];
  readonly #pitch: readonly [number, number];
  readonly #cutaway: boolean;
  // camera inside: the episode under way
  #inside = 0;
  #inWhat = "";
  #inAt: [number, number] = [0, 0];
  readonly cam: number[] = [];
  readonly camIn: string[] = [];
  foot = 0;
  /** The way the player meant to go with the keys held this tick (unit x, z), or null: what a stall is measured on. */
  pushing: [number, number] | null = null;

  constructor(readonly b: WorldBundle, sim: SimWorld, seed: number, readonly climbing: () => boolean = () => false) {
    this.#rng = stream(seed, "t3h:hands");
    this.#cutaway = cutawayOf(b);
    this.#boxes = this.#cutaway ? [] : collidersOf(b);
    this.#solids = solidsOf(b, this.#cutaway);
    this.#pitch = this.#cutaway ? PITCH.cutaway : PITCH.follow;
    // the client starts the camera facing the first pickup or goal from the spawn (RapierSim.spawnYaw)
    const p = sim.pos("player");
    const t = b.entities.find((e) => e.kind === "pickup") ?? b.entities.find((e) => e.kind === "goal");
    if (t) {
      const [x, z] = [t.pos[0] - p[0], t.pos[2] - p[2]];
      const l = Math.sqrt(x * x + z * z);
      if (l > 1e-6) [this.#fx, this.#fz] = [x / l, z / l];
    }
  }

  /** The frame the player's keys produce for what the planner meant (null: hands off). */
  keys(sim: SimWorld, want: InputFrame | null): InputFrame {
    const tick = sim.tick + 1;
    const btn = want?.btn ?? 0;
    // at the wheel the vehicle has its own controls and the chase camera: passed on as it is
    if (sim.ride("player")) {
      this.pushing = null;
      return { tick, wx: want?.wx ?? 0, wz: want?.wz ?? 0, btn };
    }
    // a player reacts a little late: the stick and jumps act on what it saw LAG ticks ago (USE
    // goes at once: a switch pressed late would be pressed again, and switched back off)
    this.#seen.push([want?.wx ?? 0, want?.wz ?? 0, btn & BTN.JUMP]);
    const [wx, wz, jump] = this.#seen.length > LAG ? this.#seen.shift()! : [0, 0, 0];
    const l = Math.sqrt(wx * wx + wz * wz);
    // the hand on the camera is never quite still
    [this.#fx, this.#fz] = turn(this.#fx, this.#fz, (this.#rng() * 2 - 1) * TREMOR);
    let out: [number, number] = [0, 0];
    let b = (btn & ~(BTN.USE | BTN.JUMP)) | jump;
    const shooting = (btn & BTN.USE) !== 0 && sim.usable()?.label === "shoot";
    if (shooting && l === 0) {
      // a shot with nowhere new to aim goes where the camera looks
      this.#keys = [0, 0];
      out = aimPush(-this.#fx, -this.#fz);
      b |= BTN.USE;
    } else if (l > 0 && l < NUDGE && !shooting) {
      // a nudge (turning to face something, a lean into the wind): the stick, a touch, as meant
      this.#keys = [0, 0];
      out = [wx / 127, wz / 127];
    } else if (l > 0) {
      const [dx, dz] = [wx / l, wz / l];
      this.#face(dx, dz);
      if (shooting) {
        // a shot goes where the camera looks: fire once it looks at the target, the keys let go
        this.#keys = [0, 0];
        if (this.#fx * dx + this.#fz * dz >= COS_AIM) {
          out = aimPush(-this.#fx, -this.#fz);
          b |= BTN.USE;
        }
      } else {
        // where the keys held now go, through the camera: a turn of more than 45° is answered at once
        const [hx, hz] = stickToWorld(this.#keys[0], this.#keys[1], -this.#fx, -this.#fz);
        const hl = Math.sqrt(hx * hx + hz * hz);
        const off = hl === 0 || (hx * dx + hz * dz) / hl < 0.7071;
        if (tick < this.#escapeUntil) {
          // still getting round whatever stopped it
        } else if (this.#still >= NOTICE) {
          // going nowhere with the keys held: as a player would, step aside (one way, then the
          // other, then back off and aside) for a moment
          // (first to the side the way on lies: right of the camera's line, or left)
          const right = -this.#fz * dx + this.#fx * dz >= 0 ? 1 : -1;
          const [ex, ey] = ESCAPES[this.#tries++ % ESCAPES.length]!;
          this.#keys = [ex * right, ey];
          this.#escapeUntil = tick + ESCAPE_TICKS;
          this.#still = 0;
        } else if (off || tick >= this.#nextChoice || (this.#keys[0] === 0 && this.#keys[1] === 0)) {
          const here = sim.pos("player");
          // something low in the way (above the step the controller climbs, under a jump): hop onto it
          const top = sim.player.grounded ? blockerTop(this.b, here, [dx, dz]) : -Infinity;
          const feet = here[1] - 0.9;
          const hop = top > feet + 0.45 && top <= feet + sim.laws.jumpH * HOP;
          if (hop) b |= BTN.JUMP;
          // a wall where it means to go, there or coming up: steer round it (a low one is hopped instead)
          // (unless the plan is climbing onto it: then it is where the player means to go)
          const wall = !hop && !this.climbing() && (top > feet + 0.45 || blockerTop(this.b, here, [dx, dz], LOOK_M) > feet + sim.laws.jumpH * HOP);
          this.#keys = this.#choose(dx, dz, wall ? here : null);
          this.#nextChoice = tick + HOLD[0] + Math.floor(this.#rng() * HOLD[1]);
        }
        out = stickToWorld(this.#keys[0], this.#keys[1], -this.#fx, -this.#fz);
      }
    } else this.#keys = [0, 0];
    // going nowhere: ticks the keys are held and the player moves under 2 cm
    const p = sim.pos("player");
    const moved = (p[0] - this.#lx) * (p[0] - this.#lx) + (p[1] - this.#ly) * (p[1] - this.#ly) + (p[2] - this.#lz) * (p[2] - this.#lz) > 0.02 * 0.02;
    [this.#lx, this.#ly, this.#lz] = [p[0], p[1], p[2]];
    if (moved || (this.#keys[0] === 0 && this.#keys[1] === 0)) this.#still = 0;
    else this.#still++;
    if (moved && tick >= this.#escapeUntil) this.#tries = 0;
    if (btn & BTN.USE && !shooting) b |= BTN.USE; // a switch, a pickup, a word: pressed as meant
    this.pushing = (this.#keys[0] !== 0 || this.#keys[1] !== 0) && l > 0 ? [wx / l, wz / l] : null;
    const fr = { tick, wx: q8(out[0]), wz: q8(out[1]), btn: b };
    if (DEBUG && tick % 5 === 0) DEBUG(`t${tick} want ${wx},${wz},${btn} keys ${this.#keys} cam ${this.#fx.toFixed(2)},${this.#fz.toFixed(2)} → ${fr.wx},${fr.wz},${fr.btn} at ${sim.pos("player").map((x) => x.toFixed(2))} shoot ${shooting}`);
    return fr;
  }

  /** Turn the camera toward (dx, dz) at the Q/E rate (sine and cosine of yaw are −forward). */
  #face(dx: number, dz: number) {
    const cos = this.#fx * dx + this.#fz * dz;
    if (cos >= COS_T) {
      [this.#fx, this.#fz] = [dx, dz];
      return;
    }
    const sgn = this.#fx * dz - this.#fz * dx >= 0 ? 1 : -1;
    const [x, z] = [this.#fx * COS_T - this.#fz * SIN_T * sgn, this.#fx * SIN_T * sgn + this.#fz * COS_T];
    const n = Math.sqrt(x * x + z * z);
    [this.#fx, this.#fz] = [x / n, z / n];
  }

  /** The keys whose move, through the camera, goes most nearly the way it wants. */
  #choose(dx: number, dz: number, p: Vec3 | null): readonly [number, number] {
    let best = KEYS[0]!;
    let bestDot = -Infinity;
    for (const k of KEYS) {
      const [x, z] = stickToWorld(k[0], k[1], -this.#fx, -this.#fz);
      const n = Math.sqrt(x * x + z * z) || 1;
      // (a way into something solid is passed over while one going roughly the right way is clear)
      const dot = (x * dx + z * dz) / n - (p && (blockedAhead(this.b, p, [x / n, z / n]) || blockedAhead(this.b, p, [x / n, z / n], LOOK_M)) ? 1.2 : 0);
      if (dot > bestDot + 1e-9) ((best = k), (bestDot = dot));
    }
    return best;
  }

  /** After the tick: stand the camera where the client would and note what it is inside. */
  look(sim: SimWorld) {
    if (sim.ride("player")) return this.#out();
    this.foot++;
    const p = sim.pos("player");
    const [gx, gy, gz] = [p[0], p[1] + CAM.LOOK_H, p[2]];
    if (this.#snap) [this.#tx, this.#ty, this.#tz] = [gx, gy, gz];
    else {
      this.#tx += (gx - this.#tx) * TARGET_EASE;
      this.#ty += (gy - this.#ty) * TARGET_EASE;
      this.#tz += (gz - this.#tz) * TARGET_EASE;
    }
    const [cp, sp] = this.#pitch;
    const dir: Vec3 = [-this.#fx * cp, sp, -this.#fz * cp];
    const d = boomLength([this.#tx, this.#ty, this.#tz], dir, CAM.DIST, this.#boxes);
    this.#pulled = this.#snap || d < this.#pulled ? d : this.#pulled + (d - this.#pulled) * PULL_EASE;
    this.#snap = false;
    const c: Vec3 = [this.#tx + dir[0] * this.#pulled, Math.max(this.#ty + dir[1] * this.#pulled, CAM.FLOOR_Y), this.#tz + dir[2] * this.#pulled];
    const g = 0; // strictly inside (the near plane brushing a wall is not counted)
    let what = "";
    for (const s of this.#solids) {
      const e = s.at ? null : sim.entity(s.id);
      if (e?.destroyed || (e && e.col && !e.col.isEnabled())) continue;
      const at = s.at ?? sim.pos(s.id);
      if (Math.abs(c[0] - at[0]) < s.half[0] + g && Math.abs(c[1] - at[1]) < s.half[1] + g && Math.abs(c[2] - at[2]) < s.half[2] + g) {
        what = s.what;
        break;
      }
    }
    if (!what) return this.#out();
    if (!this.#inside) ((this.#inWhat = what), (this.#inAt = [p[0], p[2]]));
    this.#inside++;
  }

  #out() {
    if (this.#inside > CAM_TICKS) {
      this.cam.push(r1(this.#inAt[0]), r1(this.#inAt[1]), this.#inside);
      this.camIn.push(this.#inWhat);
    }
    this.#inside = 0;
  }

  report(stalls: number[], ticks: number): HumanReport {
    this.#out();
    return { cam: this.cam, camIn: this.camIn, stalls, foot: this.foot, ticks };
  }
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const near2 = (ax: number, az: number, bx: number, bz: number, m: number) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz) <= m * m;
const secs = (ticks: number) => Math.round((ticks / 60) * 10) / 10;

/** One kind of flag across the runs: how many runs were clean of it, and the worst case. */
interface Flagged {
  clean: number;
  worst: { x: number; z: number; ticks: number; what: string; runs: number } | null;
}

/**
 * One kind of flag across the runs. A place counts once it repeats: hit in at least CONFIRM runs
 * (as the repair loop trusts a physics failure only once it repeats across seeds); a run is clean
 * of it when it hit none of those places. The worst is the longest hit at a place that counts.
 */
function tally(reports: readonly HumanReport[], hits: (r: HumanReport) => { x: number; z: number; ticks: number; what: string }[]): Flagged {
  const all: { x: number; z: number; ticks: number; what: string; run: number }[] = [];
  reports.forEach((r, run) => {
    for (const x of hits(r)) all.push({ ...x, run });
  });
  const runsAt = (x: { x: number; z: number }) => new Set(all.filter((y) => near2(y.x, y.z, x.x, x.z, SAME_PLACE_M)).map((y) => y.run));
  const counted = all.filter((x) => runsAt(x).size >= Math.min(CONFIRM, reports.length));
  const hitRuns = new Set(counted.map((x) => x.run));
  const clean = reports.length - hitRuns.size;
  if (!counted.length) return { clean, worst: null };
  const w = counted.reduce((a, x) => (x.ticks > a.ticks ? x : a));
  return { clean, worst: { x: w.x, z: w.z, ticks: w.ticks, what: w.what, runs: runsAt(w).size } };
}

/**
 * T3h's chips from the human-controller runs: what only the player's controls hit. A stall where
 * the experts' own runners stall too (their StallMeter spots from T3's runs) is the plan's or the
 * level's, inherited by any runner that follows the plan (a climb the planner makes in tries, a
 * wait at a door), and isn't counted here; and every flag must repeat across runs.
 */
export function t3hChips(b: WorldBundle, reports: readonly HumanReport[], expertStalls: readonly number[], ms = 0): Chip[] {
  if (!reports.length) return [];
  const n = reports.length;
  const experts: [number, number][] = [];
  for (let i = 0; i + 3 < expertStalls.length; i += 4) experts.push([expertStalls[i]!, expertStalls[i + 1]!]);
  const alsoExperts = (w: { x: number; z: number }) => experts.some(([ex, ez]) => near2(w.x, w.z, ex, ez, EXPERT_NEAR_M));
  // one run's stalls by place: each place's longest stall, all its stalled time, and whether the run ended in one there
  const stallsOf = (r: HumanReport) => {
    const places: { x: number; z: number; ticks: number; all: number; end: boolean }[] = [];
    for (let i = 0; i + 3 < r.stalls.length; i += 4) {
      const [x, z, ticks, end] = [r.stalls[i]!, r.stalls[i + 1]!, r.stalls[i + 2]!, r.stalls[i + 3] === 1];
      const at = places.find((q) => near2(q.x, q.z, x, z, PLACE_M));
      if (at) ((at.ticks = Math.max(at.ticks, ticks)), (at.all += ticks), (at.end ||= end && ticks >= TRAP_END_TICKS));
      else places.push({ x, z, ticks, all: ticks, end: end && ticks >= TRAP_END_TICKS });
    }
    return places.filter((q) => q.ticks > STALL_TICKS && !alsoExperts(q));
  };
  // stuck fast: 3 s of trying at one place in all, or the run ended stuck there
  const trapped = (s: { all: number; end: boolean }) => s.all >= TRAP_TICKS || s.end;
  const cam = tally(reports, (r) => {
    const out: { x: number; z: number; ticks: number; what: string }[] = [];
    for (let i = 0, j = 0; i + 2 < r.cam.length; i += 3, j++) out.push({ x: r.cam[i]!, z: r.cam[i + 1]!, ticks: r.cam[i + 2]!, what: r.camIn[j] ?? "" });
    return out;
  });
  const stall = tally(reports, (r) => stallsOf(r).filter((s) => !trapped(s)).map((s) => ({ ...s, what: "" })));
  const trap = tally(reports, (r) => stallsOf(r).filter(trapped).map((s) => ({ ...s, ticks: s.all, what: "" })));
  const foot = reports.reduce((a, r) => a + r.foot, 0);
  const method = `physics, ${n} runs through the player's keys and camera (noisy synthetic input on the experts' routes)`;
  const base = { tier: "T3h" as const, subject: { kind: "world" as const, id: "controls" }, method, n, src: "" as const, ms };
  const where = (w: NonNullable<Flagged["worst"]>): Vec3 => [w.x, 0, w.z];
  const near = (w: NonNullable<Flagged["worst"]>) => {
    const p = placeOf(b, w.x, w.z);
    return p ? ` near the ${p}` : "";
  };
  const runsOf = (w: NonNullable<Flagged["worst"]>) => `${w.runs} of ${n} runs`;
  const chips: Chip[] = [];
  // a world played at the wheel the whole way has no camera of this rig to check
  if (foot > 0) {
    const w = cam.worst;
    chips.push({
      ...base, id: "T3h:camera", k: cam.clean, status: w ? "counterexample" : "played",
      text: "the camera stays out of walls and ceilings",
      cx: w ? { where: where(w), have: secs(w.ticks), need: 0, unit: "s", text: `the camera sat inside ${w.what === "wall" || w.what === "ceiling" || w.what === "roof" || w.what === "floor" || w.what === "ledge" ? `the ${w.what}` : w.what} for ${secs(w.ticks)} s${near(w)} (${runsOf(w)})` } : null,
    });
  }
  const s = stall.worst;
  chips.push({
    ...base, id: "T3h:stall", k: stall.clean, status: s ? "counterexample" : "played",
    text: "no stuck frames over 0.5 s with the keys held",
    cx: s ? { where: where(s), have: secs(s.ticks), need: 0.5, unit: "s", text: `stuck ${secs(s.ticks)} s with the keys held${near(s)}, stepping aside and back (${runsOf(s)}; ${alsoExperts(s) ? "the experts' runners stall here too" : "the experts' runners walk on"})` } : null,
  });
  const t = trap.worst;
  chips.push({
    ...base, id: "T3h:trap", k: trap.clean, status: t ? "counterexample" : "played",
    text: "nothing traps the player's capsule",
    cx: t ? { where: where(t), have: secs(t.ticks), need: 0, unit: "s", text: `the capsule stuck fast${near(t)} for ${secs(t.ticks)} s of trying every way out (${runsOf(t)}; ${alsoExperts(t) ? "the experts' runners stall here too" : "the experts' runners get through"})` } : null,
  });
  return chips;
}
