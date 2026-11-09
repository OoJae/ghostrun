// Flight, zero-g and water on the proof ladder, T1: the straight-line flight model (a jetpack's
// climb and fuel, the thrust law's acceleration) over the level's surfaces and to every place the
// win needs, and the dive model (a breath against the depth there and back). No physics here (the
// static rungs run at the edge); T2's forced tests are in t2moves.ts.
import { clampLaws, type Laws, type Vec3, type WorldBundle } from "@ghostrun/ir";
import { diveNeed, flightNeed, flightOf, HEAD_UP, waterAt, watersOf, zeroG, type Flight, type Water } from "@ghostrun/kits";
import { gap, hopOk, surfaces, surfaceUnder, type Surface } from "./t1";
import type { WinChain } from "./t0";
import type { Chip } from "./types";

const round = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;
const now = () => globalThis.performance?.now?.() ?? 0;

/** What the player flies with in this world (the laws clamped first), or null on foot. */
export function playerFlight(b: WorldBundle, laws: Laws): Flight | null {
  return flightOf({ verbs: b.verbs, laws });
}

/** A hop the flight model makes from surface s onto t: the powered seconds it takes (Infinity: none). */
export function flyNeed(s: Surface, t: Surface, f: Flight, laws: Laws): number {
  return flightNeed(f, laws, gap(s, t), t.top - s.top);
}

/** Walking, dropping or jumping as on foot, or flying within the fuel. */
export function flyOk(s: Surface, t: Surface, f: Flight, laws: Laws, margin = 0): boolean {
  if (hopOk(s, t, { ...laws, jumpsMax: 0 }, 0, margin)) return true;
  if (t.launch) return false; // a jump pad is nowhere to land a flight (it throws you up again)
  return flyNeed(s, t, f, laws) <= f.fuel - margin;
}

/** Every surface the flight model reaches from `start`, and from which surface each was first reached. */
export function flyReach(ss: Surface[], start: Surface, f: Flight, laws: Laws): Map<string, Surface | null> {
  const parent = new Map<string, Surface | null>([[start.id, null]]);
  const queue = [start];
  while (queue.length) {
    const s = queue.shift()!;
    for (const t of ss) {
      if (parent.has(t.id) || !flyOk(s, t, f, laws)) continue;
      parent.set(t.id, s);
      queue.push(t);
    }
  }
  return parent;
}

/**
 * Can a swimmer get from s to t through water W: both touch it (a footprint over or beside it, a top
 * no higher than a jump out of it), and t's top lies within a breath's dive (down and back up)?
 */
export function swimOk(s: Surface, t: Surface, ws: readonly Water[], laws: Laws): boolean {
  const out = Math.min(1.4, laws.jumpsMax > 0 ? laws.jumpH * 0.94 : 0.3);
  const touches = (x: Surface, w: Water) => x.max[0] >= w.min[0] - 1.5 && x.min[0] <= w.max[0] + 1.5 && x.max[1] >= w.min[2] - 1.5 && x.min[1] <= w.max[2] + 1.5 && x.top >= w.min[1] - 0.1 && x.top <= w.max[1] + out;
  return ws.some((w) => touches(s, w) && touches(t, w) && (w.breath <= 0 || diveNeed(Math.max(0, w.max[1] - 0.05 - (t.top + 2 * HEAD_UP))) <= w.breath));
}

/** Every surface reached from `start` on foot (or by the flight model) and by swimming the world's water. */
export function swimReach(ss: Surface[], start: Surface, laws: Laws, ws: readonly Water[], f: Flight | null): Set<string> {
  const seen = new Set([start.id]);
  const queue = [start];
  while (queue.length) {
    const s = queue.shift()!;
    for (const t of ss) {
      if (seen.has(t.id)) continue;
      if (!(f ? flyOk(s, t, f, laws) : hopOk(s, t, laws, laws.jumpsMax)) && !swimOk(s, t, ws, laws)) continue;
      seen.add(t.id);
      queue.push(t);
    }
  }
  return seen;
}

/** Fewest-hop flight route between two surfaces (with fuel to spare first, then exactly). */
export function flyRoute(ss: Surface[], start: Surface, goal: Surface, f: Flight, laws: Laws): Surface[] | null {
  for (const margin of [Math.min(1, f.fuel * 0.2), 0]) {
    const parent = new Map<string, Surface | null>([[start.id, null]]);
    const queue = [start];
    while (queue.length && !parent.has(goal.id)) {
      const s = queue.shift()!;
      for (const t of ss) {
        if (parent.has(t.id) || !flyOk(s, t, f, laws, margin)) continue;
        parent.set(t.id, s);
        queue.push(t);
      }
    }
    if (!parent.has(goal.id)) continue;
    const route: Surface[] = [];
    for (let s: Surface | null | undefined = goal; s; s = parent.get(s.id)) route.unshift(s);
    return route;
  }
  return null;
}

/** The things the win chain needs the player at: what it picks up, the places it brings things into, what it uses or touches. */
function chainTargets(b: WorldBundle, chain: WinChain): string[] {
  const ids = chain.steps.flatMap((st) => (st.do === "pickup" ? [st.item] : st.do === "deliver" ? [st.sensor] : st.do === "use" || st.do === "touch" ? [st.at] : st.do === "collect" ? st.items : []));
  return [...new Set(ids)].filter((id) => b.entities.some((e) => e.id === id && e.kind !== "npc"));
}

/**
 * Where the player's feet must get to for a target to count: a sensor is entered with the centre
 * inside it (the centre is 0.9 m over the feet), a thing is touched within 1.4 m of its centre.
 * The feet's lowest height there, and the target's footprint.
 */
function feetFor(b: WorldBundle, id: string): { lo: number; min: [number, number]; max: [number, number] } {
  const e = b.entities.find((x) => x.id === id)!;
  const sensor = e.body === "sensor";
  const lo = sensor ? e.pos[1] - e.size[1] / 2 - 1.8 + 0.2 : e.pos[1] - 2.3 + 0.2;
  const grow = sensor ? 0 : 0.6;
  return { lo, min: [e.pos[0] - e.size[0] / 2 - grow, e.pos[2] - e.size[2] / 2 - grow], max: [e.pos[0] + e.size[0] / 2 + grow, e.pos[2] + e.size[2] / 2 + grow] };
}

const nounOf = (b: WorldBundle, id: string) => `the ${b.entities.find((e) => e.id === id)?.noun || id.replace(/_/g, " ")}`;

/**
 * T1 for a world that flies: from the ground the flight model reaches from the spawn, can the
 * player get to every place the win needs within the fuel (a straight line up and across, both at
 * once)? The farthest one is named either way: "the goal, 14.2 m up and 9 m across: 4.8 s of 6 s".
 */
export function t1Fly(b: WorldBundle, laws: Laws, chain: WinChain | null, playerTeam: "red" | "blue" = "red"): Chip[] {
  const f = playerFlight(b, laws);
  if (!f || !chain || b.mode !== "play") return [];
  const t0 = now();
  const ss = surfaces(b).filter((s) => !b.statics.some((x) => x.id === s.id && x.surf === "wall"));
  const spawn = b.entities.find((e) => e.kind === "spawn" && e.team === playerTeam) ?? b.entities.find((e) => e.kind === "spawn");
  const start = spawn ? surfaceUnder(ss, [spawn.pos[0], spawn.pos[1] + 0.2, spawn.pos[2]]) : undefined;
  const targets = chainTargets(b, chain);
  if (!start || !targets.length) return [];
  const reached = flyReach(ss, start, f, laws);
  const ground = ss.filter((s) => reached.has(s.id));
  const unlimited = f.fuel === Infinity;
  const what = unlimited ? "the zero-g thrust law" : `the ${f.kind}`;
  const base: Omit<Chip, "status" | "text" | "cx"> = {
    id: "T1:fly", tier: "T1", subject: { kind: "world", id: f.id || "laws" }, n: 0, k: 0, src: "", ms: 0,
    method: unlimited ? `flight model (zero-g thrust law: straight lines at ${r1(laws.speed)} m/s, ${r1(Math.max(1, laws.thrust))} m/s²)` : `flight model (thrust-limited straight lines: climb ${r1(f.climb)} m/s, ${r1(f.fuel)} s of fuel from each landing)`,
  };
  let worst: { id: string; rise: number; across: number; need: number } | null = null;
  for (const id of targets) {
    const want = feetFor(b, id);
    // the cheapest flight to it from any ground in reach
    let best: { rise: number; across: number; need: number } | null = null;
    for (const s of ground) {
      const dx = Math.max(0, want.min[0] - s.max[0], s.min[0] - want.max[0]);
      const dz = Math.max(0, want.min[1] - s.max[1], s.min[1] - want.max[1]);
      const across = Math.sqrt(dx * dx + dz * dz);
      const rise = Math.max(0, want.lo - s.top);
      // (standing on ground under it: no flight needed)
      const need = across === 0 && rise <= 0.4 ? 0 : flightNeed(f, laws, across, want.lo - s.top);
      if (!best || need < best.need) best = { rise, across, need };
    }
    if (!best) continue;
    if (!worst || best.need > worst.need) worst = { id, ...best };
  }
  if (!worst) return [];
  const ok = worst.need <= f.fuel;
  const name = nounOf(b, worst.id);
  const fuel = unlimited ? "" : ` of ${r1(f.fuel)} s`;
  if (ok) {
    // the longest single flight on the way there (from ground to ground, a landing refuelling between)
    let longest: { need: number; to: string } = { need: worst.need, to: worst.id };
    for (const id of targets) {
      const e = b.entities.find((x) => x.id === id)!;
      const t = surfaceUnder(ss, [e.pos[0], e.pos[1] + 0.1, e.pos[2]]);
      const route = t && reached.has(t.id) && !unlimited ? flyRoute(ss, start, t, f, laws) : null;
      for (let i = 1; route && i < route.length; i++) {
        const need = hopOk(route[i - 1]!, route[i]!, { ...laws, jumpsMax: 0 }, 0) ? 0 : flyNeed(route[i - 1]!, route[i]!, f, laws);
        if (need > longest.need) longest = { need, to: id };
      }
    }
    const far = longest.need > 0 ? ` (the longest flight, on the way to ${nounOf(b, longest.to)}: ${r1(longest.need)} s${fuel})` : "";
    return [{ ...base, status: "verified", text: `${what} reaches every place the win needs${far}`, cx: null, ms: Math.round(now() - t0) }];
  }
  const climbs = round(f.climb * 0.9 * f.fuel);
  const text = worst.rise > climbs ? `${name} is ${r1(worst.rise)} m above any ground you can reach: ${r1(f.fuel)} s of fuel climbs ${climbs} m` : `${name} is ${r1(worst.across)} m across from any ground you can reach: ${r1(f.fuel)} s of fuel flies ${round(laws.speed * 0.85 * f.fuel)} m`;
  const e = b.entities.find((x) => x.id === worst.id)!;
  return [{ ...base, status: "counterexample", text: `${what} reaches every place the win needs`, cx: { where: e.pos, have: worst.rise > climbs ? climbs : round(laws.speed * 0.85 * f.fuel), need: worst.rise > climbs ? round(worst.rise) : round(worst.across), unit: "m", text }, ms: Math.round(now() - t0) }];
}

/** How deep the head must go to get to a target in water (0: it's reached from the surface). */
export function depthFor(b: WorldBundle, w: Water, id: string): number {
  const e = b.entities.find((x) => x.id === id)!;
  const sensor = e.body === "sensor";
  // the centre as high as still counts (inside a sensor; within 1.4 m of a thing), the floor permitting
  const centre = Math.max(w.min[1] + HEAD_UP, sensor ? e.pos[1] + e.size[1] / 2 + 0.9 - 0.2 : e.pos[1] + 1.4 - 0.2);
  return Math.max(0, w.max[1] - 0.05 - (centre + HEAD_UP));
}

/**
 * T1 for a world with water: each place the win needs under water, against a breath (down there
 * and back up, at the swim's speeds): "the chest is 5.1 m down: 4.8 s there and back, a breath
 * lasts 20 s".
 */
export function t1Swim(b: WorldBundle, chain: WinChain | null): Chip[] {
  const ws = watersOf(b);
  if (!ws.length || !chain || b.mode !== "play") return [];
  const t0 = now();
  const chips: Chip[] = [];
  for (const id of chainTargets(b, chain)) {
    const e = b.entities.find((x) => x.id === id)!;
    const w = waterAt(ws, e.pos);
    if (!w) continue;
    const depth = depthFor(b, w, id);
    const need = diveNeed(depth);
    const base: Omit<Chip, "status" | "text" | "cx"> = { id: `T1:swim:${id}`, tier: "T1", subject: { kind: "world", id: w.verb }, n: 0, k: 0, src: "", ms: 0, method: `dive model (down and back up at ${r1(2.5 * 0.85)} m/s, against one breath)` };
    const name = nounOf(b, id);
    const text = `${name} can be reached on one breath`;
    if (w.breath <= 0) chips.push({ ...base, status: "verified", text: `${name} can be reached under water (no breath limit)`, cx: null });
    else if (need <= w.breath) chips.push({ ...base, status: "verified", text: `${text} (${r1(depth)} m down: ${r1(need)} s there and back of ${r1(w.breath)} s)`, cx: null });
    else chips.push({ ...base, status: "counterexample", text, cx: { where: e.pos, have: w.breath, need: round(need), unit: "s", text: `${name} is ${r1(depth)} m down: ${r1(need)} s there and back, and a breath lasts ${r1(w.breath)} s` } });
  }
  for (const c of chips) c.ms = Math.round(now() - t0);
  return chips;
}
