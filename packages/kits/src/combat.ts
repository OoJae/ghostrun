// Hitting and knocking out other players: dodgeball, snowball fights, bumper cars, sumo rings,
// duels and shooters. As with every kit, the verbs only produce events (a hit, someone leaving a
// ring, someone's hit points running out); the world's rules turn them into points, wins and losses.
import type { Vec3 } from "@ghostrun/ir";
import type { VerbCtx, VerbPlugin } from "@ghostrun/plugin-api";

/** The nearest character within `range` of `from` on another team (any other one, without teams). */
function nearestRival(c: Parameters<NonNullable<VerbPlugin["tick"]>>[0], from: string, range: number): string {
  const me = c.ent(from);
  const p = c.pos(from);
  let best = "";
  let bestD = range * range;
  for (const a of c.agents()) {
    const e = c.ent(a);
    if (a === from || !e || e.destroyed || (me?.team && e.team === me.team)) continue;
    const q = c.pos(a);
    const d = (q[0] - p[0]) * (q[0] - p[0]) + (q[2] - p[2]) * (q[2] - p[2]);
    if (d < bestD) ((bestD = d), (best = a));
  }
  return best;
}

/** The nearest of `ids` (things to throw at: pins, cans) still standing within `range` of `from`. */
function nearestTarget(c: Parameters<NonNullable<VerbPlugin["tick"]>>[0], from: string, ids: string[], range: number): { id: string; d: number } {
  const p = c.pos(from);
  let best = { id: "", d: range * range };
  for (const id of ids) {
    const e = c.ent(id);
    if (!e || e.destroyed) continue;
    const q = c.pos(id);
    const d = (q[0] - p[0]) * (q[0] - p[0]) + (q[2] - p[2]) * (q[2] - p[2]);
    if (d < best.d) best = { id, d };
  }
  return best;
}

export const throwVerb: VerbPlugin = {
  id: "combat_sport.throw",
  line: 'on a ball/snowball: carry it, USE hits the nearest rival (or thing in "at") in range (hit a=the one hit b=it), then it goes back to its spot; params {"range":3-20,"at":"pin_1,pin_2"}',
  on: ["pickup"],
  params: { range: { def: 10, min: 3, max: 20 }, at: { def: "" } },
  carries: (b) => [b.on],
  use: {
    radius: 1.5,
    label: "throw",
    run(c, b, actor) {
      if (c.ent(actor)?.carrying !== b.on) return false;
      const range = Number(b.params.range);
      const rival = nearestRival(c, actor, range);
      const thing = nearestTarget(c, actor, String(b.params.at ?? "").split(",").filter(Boolean), range);
      const p = c.pos(actor);
      const q = rival ? c.pos(rival) : null;
      const rd = q ? (q[0] - p[0]) * (q[0] - p[0]) + (q[2] - p[2]) * (q[2] - p[2]) : Infinity;
      const target = thing.id && thing.d < rd ? thing.id : rival;
      if (!target) return false;
      // the hit first, the release next tick: rules see who threw it ("IF ball.carrier.team eq red")
      c.emit("hit", target, b.on);
      b.mem.release = c.tick + 1; // verbs tick before rules: let go on the next tick, after the rules have seen the hit
    },
  },
  tick(c, b) {
    if (!b.mem.release || c.tick < Number(b.mem.release)) return;
    b.mem.release = 0;
    c.release(b.on, c.ent(b.on)!.home); // back in play where it started (not at their feet, or they'd simply keep it)
  },
  produces: (b) => [{ k: "hit", a: "", b: b.on, cause: { do: "throw", item: b.on } }],
};

const KNOCK_TICKS = 24;

export const shoveVerb: VerbPlugin = {
  id: "combat_sport.shove",
  line: 'on a rival/bumper car (npc): USE next to it knocks it back ~4 m, e.g. out of a ring (exit a=it b=ring); params {"force":4-12}',
  on: ["npc"],
  params: { force: { def: 10, min: 4, max: 12 } },
  use: {
    radius: 1.6,
    label: "shove",
    run(c, b, actor) {
      if (actor === b.on) return false;
      const p = c.pos(actor);
      const q = c.pos(b.on);
      const [dx, dz] = [q[0] - p[0], q[2] - p[2]];
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const f = Number(b.params.force);
      b.mem.kb = KNOCK_TICKS;
      b.mem.kx = (dx / len) * f;
      b.mem.kz = (dz / len) * f;
    },
  },
  tick(c, b) {
    const left = Number(b.mem.kb ?? 0);
    if (left <= 0) return;
    c.shove(b.on, Number(b.mem.kx), Number(b.mem.kz));
    b.mem.kb = left - 1;
  },
  produces: (b) => [{ k: "exit", a: b.on, b: "", cause: { do: "shove", at: b.on } }],
};

export const catchVerb: VerbPlugin = {
  id: "combat_sport.catch",
  line: "on someone to catch (a thief, a pickpocket, an npc): USE next to them catches them (touch a=player b=them)",
  on: ["npc"],
  params: {},
  use: {
    radius: 1.6,
    label: "catch",
    run(_c, b, actor) {
      return actor !== b.on; // the sim logs touch a=actor b=them
    },
  },
  produces: (b) => [{ k: "touch", a: "player", b: b.on, cause: { do: "use", at: b.on } }],
};

// ---- shooting and hit points ---------------------------------------------------------------------
// A wizard's fireball, a blaster, a bow, a zombie's claws: a projectile marched at a fixed step by
// the sim (no physics bodies, no trig), which hits the first character or target on its line.

export const SHOOT = "combat_sport.shoot";
export const HEALTH = "combat_sport.health";

/** A projectile's radius: what it hits is within this of its centre line. */
export const SHOT_RADIUS = 0.2;
/** A standing character, as a projectile sees it: a cylinder round the capsule's axis, feet to head. */
export const BODY_RADIUS = 0.35;
export const BODY_HALF = 0.9;
/** Shots leave from the chest, this far above a character's centre. */
export const MUZZLE_UP = 0.35;
/** Aim assist: a target within this cosine of where you face (about 35°) is the one you meant. */
const ASSIST_COS = 0.82;

/** Where the segment a→b first enters the box (centre c, size s, grown by r): 0…1, or −1 if it misses. */
export function segBox(a: Vec3, b: Vec3, c: Vec3, s: Vec3, r = 0): number {
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 3; k++) {
    const d = b[k]! - a[k]!;
    const min = c[k]! - s[k]! / 2 - r;
    const max = c[k]! + s[k]! / 2 + r;
    if (Math.abs(d) < 1e-12) {
      if (a[k]! < min || a[k]! > max) return -1;
      continue;
    }
    let u = (min - a[k]!) / d;
    let v = (max - a[k]!) / d;
    if (u > v) [u, v] = [v, u];
    if (u > lo) lo = u;
    if (v < hi) hi = v;
    if (lo > hi) return -1;
  }
  return lo;
}

/** Where the segment a→b first comes within `r` of a standing character centred at c: 0…1, or −1. */
export function segBody(a: Vec3, b: Vec3, c: Vec3, r = BODY_RADIUS + SHOT_RADIUS): number {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const fx = a[0] - c[0];
  const fz = a[2] - c[2];
  const A = dx * dx + dz * dz;
  const B = 2 * (fx * dx + fz * dz);
  const C = fx * fx + fz * fz - r * r;
  let t = 0; // already within reach (point blank: a claw swipe)
  if (C > 0) {
    if (A < 1e-12) return -1;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return -1;
    t = (-B - Math.sqrt(disc)) / (2 * A);
    if (t < 0 || t > 1) return -1;
  }
  const y = a[1] + (b[1] - a[1]) * t;
  return Math.abs(y - c[1]) <= BODY_HALF + SHOT_RADIUS ? t : -1;
}

/** Characters and `at` targets a shot from `actor` may be aimed at: anyone not on its team. */
function aimAt(c: VerbCtx, actor: string, at: readonly string[]): string[] {
  const me = c.ent(actor);
  const out = c.agents().filter((a) => {
    const e = c.ent(a);
    return a !== actor && e && !e.destroyed && !(me?.team && e.team === me.team);
  });
  for (const id of at) if (c.ent(id) && !c.ent(id)!.destroyed) out.push(id);
  return out;
}

/**
 * Where the shot goes: along the way the shooter faces, or, when a target stands within the
 * assist cone, in range and in clear view, at it (led by its velocity, so one walking across
 * is still hit). The best-aligned one wins; ties go to the nearer, then the first in id order.
 */
export function aim(c: VerbCtx, actor: string, at: readonly string[], range: number, speed: number): { from: Vec3; dir: Vec3; target: string } {
  const p = c.pos(actor);
  const [fx, fz] = c.facing(actor);
  const from: Vec3 = [p[0] + fx * 0.3, p[1] + MUZZLE_UP, p[2] + fz * 0.3];
  let best = "";
  let bestCos = ASSIST_COS;
  let bestD = Infinity;
  for (const id of aimAt(c, actor, at)) {
    const q = c.pos(id);
    const dx = q[0] - p[0];
    const dz = q[2] - p[2];
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > range + BODY_RADIUS) continue;
    const cos = d < 0.05 ? 1 : (dx * fx + dz * fz) / d;
    if (cos < bestCos - 1e-9 || (cos < bestCos + 1e-9 && d >= bestD)) continue;
    if (!c.los(from, q, id)) continue;
    best = id;
    bestCos = cos;
    bestD = d;
  }
  if (!best) return { from, dir: [fx, 0, fz], target: "" };
  const q = c.pos(best);
  const [vx, vz] = c.vel(best);
  const t = bestD / Math.max(1, speed);
  const to: Vec3 = [q[0] + vx * t, q[1], q[2] + vz * t];
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) || 1;
  return { from, dir: [d[0] / len, d[1] / len, d[2] / len], target: best };
}

export const shootVerb: VerbPlugin = {
  id: SHOOT,
  line: 'a weapon, on "player"/an npc (its own: spell, claws) or a pickup to hold (wand, blaster, bow); USE fires where you face, hitting the first one or "at" thing (hit a=it b=the weapon) for damage HP; params {"range":1.5-30,"speed":8-60,"damage":0-100,"cooldown":0.15-5,"at":"id,id"}',
  on: ["player", "npc", "pickup"],
  params: { range: { def: 12, min: 1.5, max: 30 }, speed: { def: 24, min: 8, max: 60 }, damage: { def: 25, min: 0, max: 100 }, cooldown: { def: 0.5, min: 0.15, max: 5 }, at: { def: "" } },
  // a held weapon is carried (the sim never lets anyone carry a character, so a spell stays innate)
  carries: (b) => (b.on === "player" ? [] : [b.on]),
  use: {
    radius: 1.5,
    label: "shoot",
    quiet: true,
    run(c, b, actor) {
      // a weapon lying about, or someone else's spell, isn't yours to fire
      if (b.on !== actor && c.ent(b.on)?.carrier !== actor) return false;
      if (c.tick < Number(b.mem.next ?? 0)) return false; // still cooling down
      const range = Number(b.params.range);
      const speed = Number(b.params.speed);
      const at = String(b.params.at ?? "").split(",").filter(Boolean);
      const { from, dir } = aim(c, actor, at, range, speed);
      c.fire({ by: actor, weapon: b.on, from, dir, speed, range, damage: Number(b.params.damage), at });
      b.mem.next = c.tick + Math.max(1, Math.round(Number(b.params.cooldown) * 60));
    },
  },
  // (an npc's own weapon is its doing, not the player's: the proof drops the cause for those)
  produces: (b) => [{ k: "hit", a: "", b: b.on, cause: b.on === "player" ? { do: "shoot", at: "" } : { do: "shoot", at: "", weapon: b.on } }],
};

export const healthVerb: VerbPlugin = {
  id: HEALTH,
  line: 'hit points, on "player" or an npc (or a prop to break): at 0 it is knocked out (health_lte a=it n=0), back at its start if "respawn", else gone; params {"hp":1-1000,"respawn":bool}',
  on: ["player", "npc", "prop", "vehicle"],
  params: { hp: { def: 100, min: 1, max: 1000 }, respawn: { def: true } },
};

export const COMBAT: VerbPlugin[] = [throwVerb, shoveVerb, catchVerb, shootVerb, healthVerb];
