// Plugin contracts (draft; freezes Thu 29 18:00 once the testkit is green on jump, double jump and
// city-block). Only the lead session edits this file.
import type { EntityKind, Laws, Lit, Static, Vec3 } from "@ghostrun/ir";

export type Params = Record<string, string | number | boolean>;

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** One addressable region of a pack: the fill names it by `slot`, entities name an `anchor` in it. */
export interface ZoneSpec {
  slot: string;
  tag: string;
  bounds: Aabb;
  floorY: number;
  anchors: Record<string, Vec3>;
}

/** Pack geometry before it is bound to the fill's zone ids. */
export type PackStatic = Omit<Static, "id" | "src" | "layer" | "zone"> & { zoneSlot: string };

export interface PackLayout {
  packId: string;
  version: string;
  zones: ZoneSpec[];
  statics: PackStatic[];
  cameraBounds: Aabb;
  notes: string[]; // e.g. "orrery: distances scaled"
}

export interface GenerateInput<P extends Params = Params> {
  seed: number;
  params: P;
  sub: string[]; // requested sub-zone packs, e.g. ["rooftop"]
  laws: Laws;
  harder: boolean; // relaxes the 0.8 × max-jump gap rule
}

export interface LayoutPack<P extends Params = Params> {
  id: string;
  version: string;
  modes: ("play" | "wander")[];
  defaults: P;
  /** Pure and deterministic: same input → same layout on every runtime. No trig, no Math.random. */
  generate(input: GenerateInput<P>): PackLayout;
  ci: { seeds: number[] };
}

// ---- Verb kits -----------------------------------------------------------------------------------
// A verb never decides consequences itself: it produces events (state changes, touches, hits,
// timer ends) and the world's rules turn events into effects. That keeps one proof path for
// everything: T0 regresses over triggers, T2 forces them, T3 runners perform each verb's cause.

/** What a verb's runtime may read and do inside the deterministic tick (no trig, no clocks). */
export interface VerbCtx {
  readonly tick: number;
  readonly laws: Laws;
  pos(id: string): Vec3;
  ent(id: string): VerbEnt | undefined;
  /** "player" and the NPC characters, in id order. */
  agents(): readonly string[];
  near(a: string, b: string, r: number): boolean;
  /** Is the mover's centre inside the entity's box? */
  inside(mover: string, box: string): boolean;
  /** Is the character standing on top of the entity? */
  standingOn(agent: string, box: string): boolean;
  /** Sets the state and pushes a state event (rules with state_is fire on it). */
  setState(id: string, s: string): void;
  setSolid(id: string, solid: boolean): void;
  emit(k: string, a: string, b?: string, v?: number | string): void;
  destroy(id: string): void;
  teleport(id: string, p: Vec3): void;
  /** Characters: vertical launch speed in m/s (jump pads). */
  launch(id: string, vy: number): void;
  /** Characters: extra horizontal velocity for this tick only (wind, conveyors). */
  shove(id: string, vx: number, vz: number): void;
  /** Characters: back to the last checkpoint (or spawn); a carried item goes home. */
  respawn(id: string): void;
  setCheckpoint(id: string, p: Vec3): void;
}

export interface VerbEnt {
  readonly id: string;
  readonly kind: EntityKind | "player";
  readonly team: string;
  readonly state: string;
  readonly carrier: string;
  readonly carrying: string;
  readonly destroyed: boolean;
  readonly home: Vec3;
  readonly size: Vec3;
}

/** A verb bound in this world: clamped params, and scratch memory only its runtime touches. */
export interface Bound {
  readonly id: string;
  readonly on: string;
  readonly params: Readonly<Record<string, Lit>>;
  readonly mem: Record<string, number | string | boolean>;
}

/** What an agent does to make a verb produce an event: the T0 plan step and the T3 motor. */
export type Cause =
  | { do: "use"; at: string; holding?: string } // stand within reach of `at` (holding an item) and press USE
  | { do: "enter"; at: string } // move into `at`
  | { do: "touch"; at: string }; // touch `at` (it is collected or inspected)

/** An event a bound verb can produce. `cause` null: no agent causes it (a timer running out). */
export interface Produces {
  k: "state" | "touch" | "hit" | "timer_end" | "enter";
  a: string;
  b?: string;
  s?: string;
  cause: Cause | null;
}

export interface ParamSpec {
  def: Lit;
  min?: number;
  max?: number;
  one?: readonly string[];
}

export interface VerbPlugin {
  id: string; // kit.verb
  /** One line for the fill LLM, ≤120 chars. */
  line: string;
  on: readonly ("player" | EntityKind)[];
  params: Readonly<Record<string, ParamSpec>>;
  /** The body the bound entity needs (a plate must be a sensor); the placer repairs it, logged. */
  body?: "sensor" | "fixed" | "kinematic" | "dynamic";
  /** State the bound entity starts in when the fill gave none ("off" for a switch). */
  initial?: string;
  /** Entities this binding makes carryable (a lock's key). */
  carries?(b: Bound): string[];
  /** USE within `radius` of the bound entity runs this; the HUD shows `label` ("flip switch"). */
  use?: { radius: number; label: string; run(c: VerbCtx, b: Bound, actor: string): void };
  init?(c: VerbCtx, b: Bound): void;
  /** Once per tick after physics, in binding-id order. */
  tick?(c: VerbCtx, b: Bound): void;
  produces?(b: Bound): Produces[];
}

/** Clamp, never reject: unknown keys dropped, numbers into range, enums to their default. */
export function clampParams(spec: Readonly<Record<string, ParamSpec>>, params: Readonly<Record<string, Lit>>): Record<string, Lit> {
  const out: Record<string, Lit> = {};
  for (const [k, sp] of Object.entries(spec)) {
    const raw = params[k];
    if (typeof sp.def === "number") {
      const n = typeof raw === "number" && Number.isFinite(raw) ? raw : Number(raw);
      const v = Number.isFinite(n) ? n : sp.def;
      out[k] = Math.min(sp.max ?? v, Math.max(sp.min ?? v, v));
    } else if (typeof sp.def === "boolean") {
      out[k] = typeof raw === "boolean" ? raw : raw === "true" ? true : raw === "false" ? false : sp.def;
    } else {
      const s = typeof raw === "string" ? raw : sp.def;
      out[k] = sp.one && !sp.one.includes(s) ? sp.def : s;
    }
  }
  return out;
}
