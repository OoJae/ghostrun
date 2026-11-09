// Locomotion through air and water: a jetpack (wings, a space suit) with a thrust budget, and water
// volumes you swim in on one breath. The movement itself is the character controller's (the sim);
// these are the vocabulary, the clamped numbers and the one model of reach every tier shares, so
// T1's straight lines, T2's forced test and T3's runners agree on what a jetpack can do.
//
// The laws: holding jump climbs at `climb` m/s, crouch (C) dives, neither sinks slowly; fuel burns
// every tick in the air under power and refills the moment you land. Out of fuel you fall. Below
// 0.05 g there is no fuel at all unless a suit binds one: the zero-g thrust law accelerates you at
// `thrust` m/s² toward where the stick (and jump / crouch) point, in straight lines. In water you
// swim at 60 % of your speed; jump rises, crouch dives, and you float up to the surface by
// yourself; a breath lasts `breath` seconds with your head under (0: as long as you like), and
// when it runs out you come back at your last checkpoint. A jump press at the surface climbs out.
import type { Laws, WorldBundle } from "@ghostrun/ir";
import { clampParams, type VerbPlugin } from "@ghostrun/plugin-api";

export const FLY = "locomotion.fly";
export const SWIM = "locomotion.swim";

export const flyVerb: VerbPlugin = {
  id: FLY,
  line: 'on "player": a jetpack, wings or space suit; hold jump to climb, crouch to dive, landing refuels; params {"kind":"jetpack"|"wings"|"suit","climb":1-8 m/s,"fuel":1-60 s}',
  on: ["player", "npc"],
  params: { kind: { def: "jetpack", one: ["jetpack", "wings", "suit"] }, climb: { def: 3, min: 1, max: 8 }, fuel: { def: 6, min: 1, max: 60 } },
};

export const swimVerb: VerbPlugin = {
  id: SWIM,
  line: 'on a prop covering a body of water (body sensor, its size the water): swim in it, jump rises, crouch dives; params {"breath":0-120 s, 0 no limit}',
  on: ["prop", "hazard", "plate", "platform"],
  params: { breath: { def: 20, min: 0, max: 120 } },
  body: "sensor",
};

export const FLIGHT: VerbPlugin[] = [flyVerb, swimVerb];

/** How fast a character's velocity closes on what the stick asks for in flight and water, per tick. */
export const FLY_K = 0.2;
export const SWIM_K = 0.12;
/** Sinking with neither jump nor crouch held under power, m/s; diving at least this fast. */
export const SINK = 1;
export const DIVE = 4;
/** Swimming: a share of the run speed; up and down, m/s; the centre floats this far under the surface. */
export const SWIM_SPEED = 0.6;
export const SWIM_UP = 2.5;
export const SWIM_DOWN = 2.5;
export const FLOAT_DEPTH = 0.3;
/** The capsule's centre to the top of its head. */
export const HEAD_UP = 0.9;

/** A jetpack as bound (clamped): what it is, how fast it climbs, and how long its fuel lasts. */
export interface Flight {
  /** The binding's id. */
  id: string;
  kind: string;
  climb: number;
  /** Seconds of powered flight from a landing (Infinity: the zero-g law with no suit bound). */
  fuel: number;
}

/** A water volume as bound: its box and how long a breath lasts there (0: no limit). */
export interface Water {
  id: string;
  /** The verb binding's id. */
  verb: string;
  min: [number, number, number];
  max: [number, number, number];
  breath: number;
}

const ZERO_G = 0.05;

/** What `who` flies with in this world: its own fly verb, else the zero-g law's thrust, else null. */
export function flightOf(b: Pick<WorldBundle, "verbs" | "laws">, who = "player"): Flight | null {
  const v = [...b.verbs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).find((x) => x.verb === FLY && x.on === who);
  if (v) {
    const p = clampParams(flyVerb.params, v.params);
    return { id: v.id, kind: String(p.kind), climb: Number(p.climb), fuel: Number(p.fuel) };
  }
  return zeroG(b.laws) ? { id: "", kind: "suit", climb: 0, fuel: Infinity } : null;
}

export const zeroG = (laws: Pick<Laws, "gravityScale">) => laws.gravityScale < ZERO_G;

/** The water volumes in this world, in binding-id order (a box per bound entity). */
export function watersOf(b: Pick<WorldBundle, "verbs" | "entities">): Water[] {
  const out: Water[] = [];
  for (const v of [...b.verbs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    if (v.verb !== SWIM) continue;
    const e = b.entities.find((x) => x.id === v.on);
    if (!e || out.some((w) => w.id === e.id)) continue;
    const p = clampParams(swimVerb.params, v.params);
    out.push({ id: e.id, verb: v.id, min: [e.pos[0] - e.size[0] / 2, e.pos[1] - e.size[1] / 2, e.pos[2] - e.size[2] / 2], max: [e.pos[0] + e.size[0] / 2, e.pos[1] + e.size[1] / 2, e.pos[2] + e.size[2] / 2], breath: Number(p.breath) });
  }
  return out;
}

/** The water a character's centre is in (null on land or in the air). */
export function waterAt(ws: readonly Water[], p: readonly number[]): Water | null {
  for (const w of ws) if (p[0]! >= w.min[0] && p[0]! <= w.max[0] && p[2]! >= w.min[2] && p[2]! <= w.max[2] && p[1]! < w.max[1] && p[1]! > w.min[1] - HEAD_UP) return w;
  return null;
}

/**
 * The straight-line flight model: seconds of power a flight `across` metres and `rise` metres up
 * takes (both at once: the stick and the climb), or for a way down, whether the fall after the
 * fuel runs out still carries you across. Returns the powered seconds needed (Infinity: out of
 * reach). The 0.85 is the same margin the jump model keeps.
 */
export function flightNeed(f: Flight, laws: Pick<Laws, "speed" | "gravityScale" | "thrust">, across: number, rise: number): number {
  const speed = laws.speed * 0.85;
  if (f.fuel === Infinity) {
    // the thrust law: speed up, cruise, slow down, along the straight line
    const d = Math.sqrt(across * across + rise * rise);
    const a = Math.max(1, laws.thrust);
    return d / speed + laws.speed / a;
  }
  const t = Math.max(across / speed, Math.max(0, rise) / (f.climb * 0.9));
  if (rise >= 0 || t <= f.fuel) return t;
  // a way down: fly the fuel out, then fall the rest of the way, steering as you go
  const g = 9.81 * Math.max(ZERO_G, laws.gravityScale);
  const drop = -rise - f.fuel * SINK;
  const fall = drop > 0 ? Math.sqrt((2 * drop) / g) : 0;
  return across <= speed * (f.fuel + fall) ? f.fuel : Infinity;
}

/** Seconds under water a dive takes: down to `depth` metres (the head under) and back up, at the swim's speeds. */
export function diveNeed(depth: number): number {
  const d = Math.max(0, depth);
  return d / (SWIM_DOWN * 0.85) + d / (SWIM_UP * 0.85);
}
