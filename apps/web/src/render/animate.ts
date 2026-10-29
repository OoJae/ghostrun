// Characters in motion: which clip a character plays, chosen from what the renderer already sees
// (how fast it moves, whether it is on the ground, what it carries, what just happened to it).
// Cosmetic only: an animator reads motion and never feeds anything back into the simulation.
import { AnimationClip, AnimationMixer, LoopOnce, LoopRepeat, type AnimationAction, type Interpolant, type KeyframeTrack, type Object3D } from "three/webgpu";

/** What the whole body does. */
export type Base = "idle" | "move" | "air" | "ko" | "cheer";
/** A one-off the arms play over whatever the legs are doing. */
export type Cue = "hit" | "use" | "shoot" | "punch";

export interface Motion {
  /** Ground speed, m/s (smoothed). */
  speed: number;
  /** Vertical speed, m/s. */
  vy: number;
  /** On the ground as the simulation says, or null where it can't (the stub): then guessed from vy. */
  grounded: boolean | null;
  /** Seconds since it last stood on something. */
  airTime: number;
  carrying: boolean;
  /** Knocked out (lying down until it gets up or respawns). */
  ko: boolean;
  /** Its side won: it celebrates once it stands still. */
  cheer: boolean;
}

/** Below this it stands; the walk takes over from the idle by WALK_FULL. */
export const MOVE_MIN = 0.15;
const WALK_FULL = 1.1;
/** Walk to run, between these ground speeds. */
const RUN_FROM = 2.4;
const RUN_FULL = 4.2;
/** The ground speeds the walk and run clips were made for, at the size characters are drawn. */
export const WALK_SPEED = 1.45;
export const RUN_SPEED = 4.6;
/** A short hop off a kerb doesn't count as a jump. */
const AIR_AFTER = 0.12;

export function baseOf(m: Motion): Base {
  if (m.ko) return "ko";
  const air = m.grounded === null ? Math.abs(m.vy) > 1.5 : !m.grounded && m.airTime > AIR_AFTER;
  if (air) return "air";
  if (m.speed > MOVE_MIN) return "move";
  return m.cheer ? "cheer" : "idle";
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Idle, walk and run weights for a ground speed (they sum to 1), and how fast the walk and run play. */
export function gait(speed: number): { idle: number; walk: number; run: number; walkRate: number; runRate: number } {
  const moving = smooth(MOVE_MIN, WALK_FULL, speed);
  const running = smooth(RUN_FROM, RUN_FULL, speed);
  return {
    idle: 1 - moving,
    walk: moving * (1 - running),
    run: moving * running,
    walkRate: Math.min(1.6, Math.max(0.6, speed / WALK_SPEED)),
    runRate: Math.min(1.5, Math.max(0.75, speed / RUN_SPEED)),
  };
}

/** Each base action's target weight for a state (idle and move share the gait blend). */
export function targets(base: Base, speed: number): Record<"idle" | "walk" | "run" | "air" | "ko" | "cheer", number> {
  const t = { idle: 0, walk: 0, run: 0, air: 0, ko: 0, cheer: 0 };
  if (base === "idle" || base === "move") {
    const g = gait(base === "idle" ? 0 : speed);
    t.idle = g.idle;
    t.walk = g.walk;
    t.run = g.run;
  } else {
    t[base] = 1;
  }
  return t;
}

/** The clips a character's animator plays, by role (names are the KayKit clip names). */
export interface ClipNames {
  idle: string;
  walk: string;
  run: string;
  air: string;
  ko: string;
  cheer: string;
  cues: Record<Cue, string>;
  /** Arms up for carrying overhead: one pose taken from this clip at `carryAt` seconds. */
  carry: string;
  carryAt: number;
}

export const CLIPS: ClipNames = {
  idle: "Idle",
  walk: "Walking_A",
  run: "Running_A",
  air: "Jump_Idle",
  ko: "Death_A",
  cheer: "Cheer",
  cues: { hit: "Hit_A", use: "Interact", shoot: "1H_Ranged_Shoot", punch: "Unarmed_Melee_Attack_Punch_A" },
  // both fists up by the head, early in the cheer: hoisting what rides overhead
  carry: "Cheer",
  carryAt: 0.3,
};

// track names are "<bone>.<property>" with the loader's sanitised bone names ("upperarm.l" → "upperarml")
const boneOf = (t: KeyframeTrack) => t.name.slice(0, t.name.lastIndexOf("."));
const UPPER = /^(spine|chest|head|upperarm|lowerarm|wrist|hand)/;
const ARMS = /^(upperarm|lowerarm|wrist|hand)/;

const upperCache = new WeakMap<AnimationClip, AnimationClip>();
/** The clip's upper body only, so the legs keep walking under it. */
export function upperBody(clip: AnimationClip): AnimationClip {
  let c = upperCache.get(clip);
  if (!c) {
    c = new AnimationClip(`${clip.name}:upper`, clip.duration, clip.tracks.filter((t) => UPPER.test(boneOf(t))));
    upperCache.set(clip, c);
  }
  return c;
}

const poseCache = new WeakMap<AnimationClip, AnimationClip>();
/** The arms of one frame of a clip, held: a pose the mixer can blend in like any clip. */
export function armsPose(clip: AnimationClip, at: number): AnimationClip {
  let c = poseCache.get(clip);
  if (!c) {
    const tracks = clip.tracks.filter((t) => ARMS.test(boneOf(t))).map((t) => {
      // (createInterpolant is set on every track at runtime; the typings leave it out)
      const lerp = (t as KeyframeTrack & { createInterpolant(): Interpolant }).createInterpolant();
      const v = Array.from(lerp.evaluate(Math.min(at, clip.duration)) as ArrayLike<number>);
      const Track = t.constructor as new (name: string, times: number[], values: number[]) => KeyframeTrack;
      return new Track(t.name, [0], v);
    });
    // one key, any length: a looping action over a zero-length clip would divide by zero
    c = new AnimationClip(`${clip.name}:pose`, 1, tracks);
    poseCache.set(clip, c);
  }
  return c;
}

/** How strongly an arm cue or the carry pose wins over the gait's arms (mixer weights average). */
const UPPER_W = 6;
const EASE = 12;
const CUE_IN = 0.08;
const CUE_OUT = 0.18;

type BaseKey = "idle" | "walk" | "run" | "air" | "ko" | "cheer";

/** One character's mixer: the base blend, the carry pose and arm cues on top. */
export class Animator {
  readonly mixer: AnimationMixer;
  readonly #base: Record<BaseKey, AnimationAction | null>;
  readonly #w: Record<BaseKey, number> = { idle: 1, walk: 0, run: 0, air: 0, ko: 0, cheer: 0 };
  readonly #carry: AnimationAction | null;
  #carryW = 0;
  readonly #cues = new Map<Cue, AnimationAction>();
  #cue: { action: AnimationAction; t: number; dur: number } | null = null;
  #state: Base = "idle";

  constructor(root: Object3D, clips: ReadonlyMap<string, AnimationClip>, names: ClipNames = CLIPS) {
    const mixer = (this.mixer = new AnimationMixer(root));
    const action = (name: string, loop = true) => {
      const clip = clips.get(name);
      if (!clip) return null;
      const a = mixer.clipAction(clip);
      a.setLoop(loop ? LoopRepeat : LoopOnce, Infinity);
      a.clampWhenFinished = !loop;
      return a;
    };
    this.#base = {
      idle: action(names.idle),
      walk: action(names.walk),
      run: action(names.run),
      air: action(names.air),
      ko: action(names.ko, false),
      cheer: action(names.cheer),
    };
    for (const k of ["idle", "walk", "run", "air", "cheer"] as const) {
      const a = this.#base[k];
      if (a) a.setEffectiveWeight(this.#w[k]).play();
    }
    const carry = clips.get(names.carry);
    this.#carry = carry ? mixer.clipAction(armsPose(carry, names.carryAt)) : null;
    this.#carry?.setEffectiveWeight(0).play();
    for (const [cue, name] of Object.entries(names.cues) as [Cue, string][]) {
      const clip = clips.get(name);
      if (!clip) continue;
      const a = mixer.clipAction(upperBody(clip));
      a.setLoop(LoopOnce, 1);
      this.#cues.set(cue, a);
    }
  }

  get state(): Base {
    return this.#state;
  }

  /** Play an arm cue now (a newer one cuts the last short). */
  cue(c: Cue) {
    const a = this.#cues.get(c);
    if (!a || this.#state === "ko") return;
    if (this.#cue && this.#cue.action !== a) this.#cue.action.stop();
    a.reset().setEffectiveWeight(0).play();
    this.#cue = { action: a, t: 0, dur: a.getClip().duration };
  }

  update(dt: number, m: Motion) {
    const base = baseOf(m);
    if (base === "ko" && this.#state !== "ko") this.#base.ko?.reset().play();
    if (base !== "ko" && this.#state === "ko") this.#base.ko?.stop();
    this.#state = base;
    const want = targets(base, m.speed);
    const k = 1 - Math.exp(-EASE * dt);
    for (const key of Object.keys(want) as BaseKey[]) {
      // a knock-out drops at once: easing out of a fall would float
      this.#w[key] = base === "ko" ? want[key] : this.#w[key] + (want[key] - this.#w[key]) * k;
      this.#base[key]?.setEffectiveWeight(this.#w[key]);
    }
    const g = gait(m.speed);
    const walk = this.#base.walk;
    const run = this.#base.run;
    if (walk) walk.timeScale = g.walkRate;
    if (run) run.timeScale = g.runRate;
    // the run's feet land where the walk's do, so blending the two never scissors the legs
    if (walk && run && this.#w.walk > 0.05 && this.#w.run > 0.05) run.time = (walk.time / walk.getClip().duration) * run.getClip().duration;

    // an arm cue takes the arms from the gait and from the carry pose while it plays
    const c = this.#cue;
    let env = 0;
    if (c) {
      c.t += dt;
      env = Math.min(clamp01(c.t / CUE_IN), clamp01((c.dur - c.t) / CUE_OUT));
      c.action.setEffectiveWeight(UPPER_W * 1.5 * env);
      if (c.t >= c.dur) {
        c.action.stop();
        this.#cue = null;
      }
    }
    this.#carryW += ((m.carrying && base !== "ko" ? UPPER_W : 0) - this.#carryW) * k;
    this.#carry?.setEffectiveWeight(this.#carryW * (1 - env));
    this.mixer.update(dt);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
  }
}
