// T1, kinematic: reachability over the surfaces of the level using the movement law's jump
// abstraction (k jumps lift the feet k × jumpH), with analytic counterexamples
// ("apex 1.6 m < ledge 2.6 m").
import type { Expect, Laws, Vec3, WorldBundle } from "@ghostrun/ir";
import type { Chip } from "./types";

export interface Surface {
  id: string;
  zone: string;
  top: number;
  min: [number, number];
  max: [number, number];
  /** A jump pad: stepping on it throws you this many metres straight up. */
  launch?: number;
}

const EULER_LOSS = 0.06; // fixed-step integration reaches slightly less than the analytic apex

export function surfaces(b: WorldBundle): Surface[] {
  const box = (id: string, zone: string, pos: readonly number[], size: readonly number[]): Surface => ({
    id,
    zone,
    top: pos[1]! + size[1]! / 2,
    min: [pos[0]! - size[0]! / 2, pos[2]! - size[2]! / 2] as [number, number],
    max: [pos[0]! + size[0]! / 2, pos[2]! + size[2]! / 2] as [number, number],
  });
  // a platform or prop that never moves is somewhere to stand too (a crate to climb, a step a fill
  // put on a course); moving and crumbling ones are not ground anyone can plan on
  const moving = new Set(b.verbs.filter((v) => /oscillate|crumble|carry/.test(v.verb)).map((v) => v.on));
  const pads = new Map(b.verbs.filter((v) => v.verb === "locomotion.jump_pad").map((v) => [v.on, Math.min(12, Math.max(1, Number(v.params.height ?? 4) || 4))]));
  return [
    // a pad is a launch surface lying on the floor it stands on
    ...b.entities.filter((e) => pads.has(e.id)).map((e) => ({ ...box(e.id, e.zone, [e.pos[0], e.pos[1] - e.size[1] / 2, e.pos[2]], [e.size[0], 0, e.size[2]]), launch: pads.get(e.id)! })),
    ...b.statics.filter((s) => s.surf === "floor" || s.surf === "ledge" || s.surf === "roof" || s.surf === "wall").map((s) => box(s.id, s.zone, s.pos, s.size)),
    ...b.entities.filter((e) => (e.kind === "platform" || e.kind === "prop") && (e.body === "fixed" || e.body === "kinematic") && e.shape === "box" && !moving.has(e.id)).map((e) => box(e.id, e.zone, e.pos, e.size)),
  ].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Horizontal gap between two footprints (0 if they touch or overlap). */
export function gap(a: Surface, b: Surface): number {
  const dx = Math.max(0, a.min[0] - b.max[0], b.min[0] - a.max[0]);
  const dz = Math.max(0, a.min[1] - b.max[1], b.min[1] - a.max[1]);
  return Math.sqrt(dx * dx + dz * dz);
}

export function surfaceUnder(ss: Surface[], p: Vec3): Surface | undefined {
  let best: Surface | undefined;
  for (const s of ss) {
    if (p[0] < s.min[0] || p[0] > s.max[0] || p[2] < s.min[1] || p[2] > s.max[1]) continue;
    if (s.top > p[1] + 0.2) continue;
    if (!best || s.top > best.top) best = s;
  }
  return best;
}

export function apex(laws: Laws, jumps: number): number {
  return jumps * laws.jumpH * (1 - EULER_LOSS);
}

/**
 * Horizontal distance a runner can cover while ending `rise` metres higher (negative = lower):
 * (jumps − 1) jumps taken at each apex, then the descending branch of the last jump.
 * Infinity-free: returns −1 when the rise is out of reach. The 0.85 factor is a safety margin
 * (players don't hit frame-perfect apexes).
 */
export function reachAt(laws: Laws, jumps: number, rise: number): number {
  if (jumps <= 0) return rise <= 0 ? laws.speed * 0.25 : -1; // walking off an edge
  const g = 9.81 * Math.max(0.05, laws.gravityScale);
  const H = laws.jumpH * (1 - EULER_LOSS);
  const v = Math.sqrt(2 * g * H);
  const disc = v * v + 2 * g * ((jumps - 1) * H - rise);
  if (disc < 0) return -1;
  const t = ((jumps - 1) * v) / g + (v + Math.sqrt(disc)) / g;
  return laws.speed * t * 0.85;
}

/** Can a runner get from s onto t with up to `jumps` jumps (walking when they touch at step height)? */
/** From a pad: anything within its launch height, and as far as the fall from it drifts. */
function launchReach(s: Surface, t: Surface, laws: Laws): boolean {
  const g = 9.81 * Math.max(0.05, laws.gravityScale);
  const H = s.launch! * (1 - EULER_LOSS);
  const rise = t.top - s.top;
  if (rise > H + 1e-9) return false;
  const v = Math.sqrt(2 * g * H);
  const time = (v + Math.sqrt(v * v - 2 * g * rise)) / g;
  return gap(s, t) <= laws.speed * time * 0.85;
}

export function hopOk(s: Surface, t: Surface, laws: Laws, jumps: number, margin = 0): boolean {
  if (s.launch) return launchReach(s, t, laws);
  const rise = t.top - s.top;
  if (rise > apex(laws, jumps) - margin + 1e-9) return false;
  const limit = Math.abs(rise) < 0.41 ? 0.01 : reachAt(laws, jumps, rise);
  return limit >= 0 && gap(s, t) <= limit;
}

/**
 * Fewest-hop route between two surfaces over floors, ledges and roofs (T3 runners follow it).
 * Hops that need the very top of a jump are avoided when a route with room to spare exists (a
 * 2.9 m ledge under a 3.0 m apex works on paper and fails in physics); the exact model is the
 * fallback, so a route is found whenever one exists.
 */
export function hopRoute(ss: Surface[], start: Surface, goal: Surface, laws: Laws): Surface[] | null {
  return route(ss, start, goal, laws, 0.3) ?? route(ss, start, goal, laws, 0);
}

function route(ss: Surface[], start: Surface, goal: Surface, laws: Laws, margin: number): Surface[] | null {
  const parent = new Map<string, Surface | null>([[start.id, null]]);
  const queue = [start];
  while (queue.length && !parent.has(goal.id)) {
    const s = queue.shift()!;
    for (const t of ss) {
      if (parent.has(t.id) || !hopOk(s, t, laws, laws.jumpsMax, margin)) continue;
      parent.set(t.id, s);
      queue.push(t);
    }
  }
  if (!parent.has(goal.id)) return null;
  const route: Surface[] = [];
  for (let s: Surface | null | undefined = goal; s; s = parent.get(s.id)) route.unshift(s);
  return route;
}

/** BFS over surfaces; returns the set reachable from `start` with `jumps` jumps per hop. */
function reachable(ss: Surface[], start: Surface, laws: Laws, jumps: number): Set<string> {
  const up = apex(laws, jumps);
  const seen = new Set([start.id]);
  const queue = [start];
  while (queue.length) {
    const s = queue.shift()!;
    for (const t of ss) {
      if (seen.has(t.id)) continue;
      if (s.launch) {
        if (launchReach(s, t, laws)) (seen.add(t.id), queue.push(t));
        continue;
      }
      const rise = t.top - s.top;
      if (rise > up + 1e-9) continue;
      // walking: touching footprints within step height; jumping/dropping: ballistic reach
      const limit = Math.abs(rise) < 0.41 ? 0.01 : reachAt(laws, jumps, rise);
      if (limit < 0 || gap(s, t) > limit) continue;
      seen.add(t.id);
      queue.push(t);
    }
  }
  return seen;
}

export function t1(b: WorldBundle, laws: Laws): Chip[] {
  const chips: Chip[] = [];
  const ss = surfaces(b);
  const where = (id: string): Vec3 | null => b.entities.find((e) => e.id === id)?.pos ?? null;
  for (const x of b.expects.filter((e) => e.prop === "requires" || e.prop === "reachable" || e.prop === "unreachable")) {
    const t0 = globalThis.performance?.now?.() ?? 0;
    const from = where(x.a);
    const start = from ? surfaceUnder(ss, from) : undefined;
    const targets = ss.filter((s) => s.zone === x.b);
    const base: Omit<Chip, "status" | "text" | "cx"> = { id: `T1:${x.id}`, tier: "T1", subject: { kind: "property", id: x.id }, method: "kinematic reachability (jump apex model)", n: 0, k: 0, src: x.src === "user" ? "user" : x.src, ms: 0 };
    if (!start || targets.length === 0) {
      chips.push({ ...base, status: "not_checkable", text: label(x), cx: null });
      continue;
    }
    const lowestStep = Math.min(...targets.map((t) => t.top - start.top));
    if (x.prop === "requires") {
      const k = parseNeed(x.need);
      if (k === null) {
        chips.push({ ...base, status: "not_checkable", text: `${label(x)}: needs ${x.need.join(", ") || "nothing stated"}, no checker for that yet`, cx: null });
        continue;
      }
      const withK = reachable(ss, start, { ...laws, jumpsMax: k }, k);
      const withFewer = reachable(ss, start, { ...laws, jumpsMax: k - 1 }, k - 1);
      const hit = (set: Set<string>) => targets.some((t) => set.has(t.id));
      if (hit(withK) && !hit(withFewer)) {
        chips.push({ ...base, status: "verified", text: label(x), cx: null });
      } else if (!hit(withK)) {
        chips.push({ ...base, status: "counterexample", text: label(x), cx: { where: null, have: round(apex(laws, k)), need: round(lowestStep), unit: "m", text: `apex ${round(apex(laws, k))} m < ledge ${round(lowestStep)} m` } });
      } else {
        chips.push({ ...base, status: "counterexample", text: label(x), cx: { where: null, have: round(apex(laws, k - 1)), need: round(lowestStep), unit: "m", text: `reachable with ${k - 1} jump${k - 1 === 1 ? "" : "s"}: step ${round(lowestStep)} m ≤ apex ${round(apex(laws, k - 1))} m` } });
      }
    } else {
      const set = reachable(ss, start, laws, laws.jumpsMax);
      const hit = targets.some((t) => set.has(t.id));
      const good = x.prop === "reachable" ? hit : !hit;
      chips.push({ ...base, status: good ? "verified" : "counterexample", text: label(x), cx: good ? null : { where: null, have: hit ? 1 : 0, need: hit ? 0 : 1, unit: "route", text: hit ? "reachable after all" : "no route found" } });
    }
    chips[chips.length - 1]!.ms = Math.round((globalThis.performance?.now?.() ?? 0) - t0);
  }
  return chips;
}

const round = (x: number) => Math.round(x * 100) / 100;
const label = (x: Expect) => x.text || `${x.prop} ${x.a} → ${x.b}`;
function parseNeed(need: string[]): number | null {
  for (const n of need) {
    const m = /^jumps>=(\d+)$/.exec(n.replace(/\s/g, ""));
    if (m) return Number(m[1]);
  }
  return null;
}

/** Zones the player can reach from `from` with exactly k jumps (not with k − 1): repair hints. */
export function zonesNeeding(b: WorldBundle, laws: Laws, from: string, k: number): string[] {
  const ss = surfaces(b);
  const at = b.entities.find((e) => e.id === from)?.pos;
  const start = at ? surfaceUnder(ss, at) : undefined;
  if (!start || k < 1) return [];
  const withK = reachable(ss, start, { ...laws, jumpsMax: k }, k);
  const fewer = reachable(ss, start, { ...laws, jumpsMax: k - 1 }, k - 1);
  const zones = new Set<string>();
  for (const s of ss) if (withK.has(s.id) && !fewer.has(s.id)) zones.add(s.zone);
  return [...zones].sort();
}
