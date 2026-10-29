// T3, physics witnesses: AI runners execute the win chain in the real deterministic simulation,
// following navmesh paths with seeded variation against the world's own bots, and a jump witness
// checks each "requires" (alone: geometry, not tactics).
import { stream } from "@ghostrun/detmath";
import { clampLaws, type Expect, type Laws, type Vec3, type WorldBundle } from "@ghostrun/ir";
import { buildNav, lowHazards, type NavWorld } from "@ghostrun/nav";
import { castBrain } from "@ghostrun/bots";
import { verb } from "@ghostrun/kits";
import { BTN, SimWorld, type Rapier } from "@ghostrun/sim";
import { carryables, causeSteps, playerWeapons, producers, type PlanStep, type Want, type WinChain } from "./t0";
import { GhostRecorder, secretsOf, type Ghost } from "./ghost";
import { apex, gap, hopOk, hopRoute, reachAt, surfaceUnder as surfaceAt, surfaces, type Surface } from "./t1";
import type { Chip, Trail } from "./types";

const RUN_TICKS = 120 * 60; // two minutes of play per run (a world's own timer still ends it sooner)
const TOO_EASY_S = 3;

/**
 * The hazards low enough to jump (a laser grid across a doorway) and, built the first time a runner
 * needs it, a navmesh that goes through them; runners jump each one as they reach it. Set for the
 * length of one t3() or tour() call (both synchronous).
 */
interface Leap {
  boxes: { pos: Vec3; size: Vec3 }[];
  nav(): NavWorld;
  free(): void;
}
let leap: Leap | null = null;

/** Navmeshes with the doors shut right now baked in, by which doors (built when first needed). */
let shutNavs: Map<string, NavWorld> | null = null;
function shutNav(b: WorldBundle, closed: string[]): NavWorld {
  const key = closed.join(",");
  let n = shutNavs?.get(key);
  if (!n) {
    n = buildNav(b, { closed });
    (shutNavs ??= new Map()).set(key, n);
  }
  return n;
}
const freeShut = () => {
  for (const n of shutNavs?.values() ?? []) n.destroy();
  shutNavs = null;
};
function leapFor(b: WorldBundle): Leap | null {
  const boxes = lowHazards(b);
  if (!boxes.length) return null;
  let built: NavWorld | null = null;
  return { boxes, nav: () => (built ??= buildNav(b, { leap: true })), free: () => built?.destroy() };
}
const leapPath = (from: Vec3, to: Vec3) => (leap ? leap.nav().path(from, to) : null);

/**
 * Where a path runs through a low hazard, cut that stretch out: a run-up point 1 m before it
 * (jump there) and a landing point 1 m past it, straight across, so the jump is lined up (a
 * diagonal leap through a doorway clips its jamb). `jumps` holds the run-up indices.
 */
function leapify(path: Vec3[]): { pts: Vec3[]; jumps: Set<number> } {
  const jumps = new Set<number>();
  if (!leap || path.length < 2) return { pts: path, jumps };
  // the path, sampled every 10 cm: each sample knows the waypoint it heads for
  const samples: { q: Vec3; seg: number }[] = [{ q: path[0]!, seg: 0 }];
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1]!;
    const c = path[k]!;
    const n = Math.max(1, Math.ceil(Math.sqrt(d2h(a, c)) / 0.1));
    for (let j = 1; j <= n; j++) samples.push({ q: [a[0] + ((c[0] - a[0]) * j) / n, a[1] + ((c[1] - a[1]) * j) / n, a[2] + ((c[2] - a[2]) * j) / n], seg: k });
  }
  const level = (h: { pos: Vec3; size: Vec3 }, q: Vec3) => Math.abs(h.pos[1] - h.size[1] / 2 - q[1]) < 1;
  // one crossing per hazard: from the first sample inside it to the last (a path along its edge
  // flickers in and out), in path order; one that starts under the runner is walked off, not jumped
  const crossings = leap.boxes
    .map((h) => {
      const inside = samples.map((x, n) => (level(h, x.q) && inBox(x.q[0], x.q[2], h, 0.4) ? n : -1)).filter((n) => n >= 0);
      return inside.length && inside[0]! > 0 && inside.at(-1)! < samples.length - 1 ? { h, from: inside[0]!, to: inside.at(-1)! } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((x, y) => x.from - y.from);
  const out: Vec3[] = [path[0]!];
  let next = 1; // the next original waypoint still to copy
  let past = 0; // the last sample already crossed
  for (const { h, from, to } of crossings) {
    if (from <= past) continue;
    const entry = samples[from]!.q;
    const exit = samples[to]!.q;
    for (; next < samples[from]!.seg; next++) out.push(path[next]!);
    // across it along the axis the path crosses it by; a narrow one (a laser grid in front of a
    // doorway) on its centre line, where the doorway is
    const alongX = Math.abs(exit[0] - entry[0]) >= Math.abs(exit[2] - entry[2]);
    const ax = alongX ? 0 : 2;
    const lat = alongX ? 2 : 0;
    const sgn = Math.sign(exit[ax] - entry[ax]) || 1;
    const side = h.size[lat] <= 3 ? h.pos[lat] : (entry[lat] + exit[lat]) / 2;
    const edge = (dir: number, off: number): Vec3 => {
      const v: Vec3 = [0, entry[1], 0];
      v[ax] = h.pos[ax] + dir * (h.size[ax] / 2 + 0.4 + off);
      v[lat] = side;
      return v;
    };
    out.push(edge(-sgn, 1.4), edge(-sgn, 0.6)); // line up, then the run-up spot (jump there)
    jumps.add(out.length - 1);
    out.push(edge(sgn, 1.0)); // the landing
    next = samples[to]!.seg;
    past = to;
  }
  for (; next < path.length; next++) out.push(path[next]!);
  return { pts: out, jumps };
}
const inBox = (x: number, z: number, h: { pos: Vec3; size: Vec3 }, grow: number) => Math.abs(x - h.pos[0]) <= h.size[0] / 2 + grow && Math.abs(z - h.pos[2]) <= h.size[2] / 2 + grow;

/** Boxes that end the run (or send you back) on contact: standing hazards and lose-on-entry sensors. */
const deadlyCache = new WeakMap<WorldBundle, { pos: Vec3; size: Vec3 }[]>();
function deadly(b: WorldBundle): { pos: Vec3; size: Vec3 }[] {
  let out = deadlyCache.get(b);
  if (!out) {
    const losing = new Set(b.rules.filter((r) => (r.when.t === "enter" || r.when.t === "hit") && r.when.a === "player" && r.then.some((x) => x.e === "lose")).map((r) => r.when.b));
    out = b.entities
      .filter((e) => (e.body === "sensor" || e.body === "fixed") && (losing.has(e.id) || b.verbs.some((v) => v.on === e.id && v.verb === "motion_hazards.hazard")))
      .map((e) => ({ pos: e.pos, size: e.size }));
    deadlyCache.set(b, out);
  }
  return out;
}

/** The wind (current, conveyor) pushing whoever stands at p, m/s: what a runner leans into. */
function windAt(b: WorldBundle, p: Vec3): [number, number] {
  let x = 0;
  let z = 0;
  for (const v of b.verbs) {
    if (v.verb !== "motion_hazards.wind") continue;
    const e = b.entities.find((q) => q.id === v.on);
    if (!e || Math.abs(p[0] - e.pos[0]) > e.size[0] / 2 || Math.abs(p[2] - e.pos[2]) > e.size[2] / 2 || Math.abs(p[1] - e.pos[1]) > e.size[1] / 2 + 0.9) continue;
    x += Number(v.params.x ?? 4);
    z += Number(v.params.z ?? 0);
  }
  return [x, z];
}

/** Input that walks at `want` (−127…127 each way) with the wind at p cancelled, clamped. */
function lean(b: WorldBundle, speed: number, p: Vec3, wx: number, wz: number): [number, number] {
  const [x, z] = windAt(b, p);
  if (!x && !z) return [wx, wz];
  const k = 127 / Math.max(0.1, speed);
  return [Math.max(-127, Math.min(127, Math.round(wx - x * k))), Math.max(-127, Math.min(127, Math.round(wz - z * k)))];
}

/** Opt-in trace of the runners' moves (diagnosis only: it never changes what they do). */
let trace: ((line: string) => void) | null = null;
export function traceRunners(fn: ((line: string) => void) | null) {
  trace = fn;
}
const v1 = (p: Vec3) => p.map((x) => x.toFixed(1)).join(",");

interface RunResult {
  won: boolean;
  ticks: number;
  stuck: number;
  /** The rule that fired the loss, when the run was lost (null: it won, or ran out of steps). */
  lostBy: string | null;
  /** Where a stuck run stopped (the player's position), or null. */
  stuckAt: Vec3 | null;
  /** Whose shot or blow last hurt or hit the player in a lost run ("" if none did). */
  lostTo: string;
  /** The step a stuck run was on ("shoot drone_2"), or "". */
  stuckOn: string;
  /** Its feet every 20 ticks (x, y, z triples at 0.1 m). */
  trail: number[];
  /** The run sampled for racing, when it won. */
  ghost: Ghost | null;
}

type Target = Vec3 | (() => Vec3);
const at = (t: Target) => (typeof t === "function" ? t() : t);
const d2h = (a: Vec3, b: Vec3) => (a[0] - b[0]) * (a[0] - b[0]) + (a[2] - b[2]) * (a[2] - b[2]); // never **: not bit-identical across engines

const armedCache = new WeakMap<WorldBundle, ReturnType<typeof playerWeapons>>();
/** The player's weapons in this world (none in most worlds: then runners never fire). */
const armedOf = (b: WorldBundle) => {
  let w = armedCache.get(b);
  if (!w) armedCache.set(b, (w = playerWeapons(b)));
  return w;
};

/** Armed rivals standing (anyone not on the player's team with a weapon of its own). */
const threats = (sim: SimWorld) => [...sim.npcs.keys()].filter((id) => !sim.entity(id)!.destroyed && sim.entity(id)!.team !== sim.entity("player")!.team && sim.weaponOf(id) !== null);

/**
 * Fighting back on the way anywhere: when the weapon in hand is ready and an armed rival is in
 * range with a clear line, the stick turns to it for one tick and USE fires (whatever the step was
 * about: a runner crossing a robot's room shoots the robot). The stick toward it, or null.
 */
function fightBack(sim: SimWorld, b: WorldBundle): [number, number] | null {
  const ws = armedOf(b);
  if (!ws.length || sim.usable()?.label !== "shoot") return null;
  const wp = ws.find((x) => x.on === "player" || sim.entity(x.on)?.carrier === "player");
  if (!wp || Number(sim.verbs.find((x) => x.bound.id === wp.id)?.bound.mem.next ?? 0) > sim.tick + 1) return null;
  const p = sim.pos("player");
  const reach = wp.range * 0.8;
  let best = "";
  let bestD = reach * reach;
  for (const id of threats(sim)) {
    const q = sim.pos(id);
    const d = d2h(p, q);
    if (d < bestD && Math.abs(q[1] - p[1]) < reach && sim.clearShot([p[0], p[1] + 0.35, p[2]], q, id)) ((best = id), (bestD = d));
  }
  if (!best) return null;
  const q = sim.pos(best);
  const l = Math.sqrt(bestD) || 1;
  return [Math.round(((q[0] - p[0]) / l) * 24), Math.round(((q[2] - p[2]) / l) * 24)];
}

/**
 * Walk the player to `goal` along the navmesh; a function goal is a moving target (an item in
 * someone's hands) and is re-planned as it moves. Returns false if it can't get there in time.
 */
function walkTo(sim: SimWorld, nav: NavWorld, goal: Target, rng: () => number, speed: number, budget: { ticks: number }, stop: () => boolean, b?: WorldBundle): boolean {
  const moving = typeof goal === "function";
  const plan = (aim: Vec3): Vec3[] | null => {
    const from = sim.pos("player");
    const feet: Vec3 = [from[0], from[1] - 0.9, from[2]];
    let path = nav.path(feet, aim) ?? leapPath(feet, aim); // walking, else jumping the low hazards on the way
    if (!path && !moving && b) {
      // ground too narrow for the navmesh (a 0.7 m beam erodes away): on the same surface, go straight
      const ss = surfaces(b);
      const here = surfaceAt(ss, [from[0], from[1] - 0.8, from[2]]);
      const there = surfaceAt(ss, [aim[0], aim[1] + 0.1, aim[2]]);
      if (here && there && here.id === there.id) path = [feet, aim];
    }
    if (!path && moving) {
      // the walkable ground beside it, at its own level (not the deck above a ball that rolled under it)
      const near = nav.nearest(aim, 1) ?? nav.nearest(aim);
      path = (near && nav.path(feet, near)) || [aim];
    }
    if (!path) return null;
    // seeded variety in the line each runner takes, a third as much beside a wall: a 0.9 m doorway
    // leaves a 0.7 m runner 0.1 m a side, and a waypoint nudged 0.15 m walks it into the jamb
    const nearWall = (q: Vec3) => Boolean(b?.statics.some((st) => st.surf === "wall" && Math.abs(q[0] - st.pos[0]) < st.size[0] / 2 + 0.8 && Math.abs(q[2] - st.pos[2]) < st.size[2] / 2 + 0.8 && q[1] < st.pos[1] + st.size[1] / 2));
    const jittered = path.map((p, i) => {
      if (i === path.length - 1) return p;
      const k = nearWall(p) ? 0.1 : 0.3;
      return [p[0] + (rng() - 0.5) * k, p[1], p[2] + (rng() - 0.5) * k] as Vec3;
    });
    const l = leapify(jittered);
    jumps = l.jumps;
    return l.pts;
  };
  let jumps = new Set<number>();
  let aim = at(goal);
  let pts = plan(aim);
  if (!pts) return false;
  let i = 0;
  let replanAt = sim.tick + 20;
  let lastProgressTick = sim.tick;
  let best = Infinity;
  let leapNow = false;
  let hopAt = 0;
  while (budget.ticks > 0 && !sim.result) {
    if (stop()) return true;
    if (moving && sim.tick >= replanAt) {
      const now = at(goal);
      if (d2h(now, aim) > 2.25 || i >= pts.length) {
        aim = now;
        pts = plan(aim)!;
        i = 0;
        best = Infinity;
      }
      replanAt = sim.tick + 20;
    }
    const p = sim.pos("player");
    // a corner beside something deadly is turned on the spot, not cut (cutting it is half a metre in)
    const route = pts;
    const turn = (k: number) => (jumps.has(k) ? 0.12 : b && deadly(b).some((h) => inBox(route[k]![0], route[k]![2], h, 1.0)) ? 0.15 : 0.45);
    while (i < pts.length && d2h(p, pts[i]!) < turn(i) * turn(i)) {
      if (jumps.has(i)) leapNow = true; // on the run-up spot: jump, straight for the landing point
      i++;
      best = Infinity;
    }
    if (i >= pts.length && !moving) return true;
    // past the last waypoint of a moving target: head straight for it until the next re-plan
    const wp = i < pts.length ? pts[i]! : at(goal);
    const d2 = d2h(p, wp);
    if (d2 < best - 0.01) {
      best = d2;
      lastProgressTick = sim.tick;
    }
    const ux = wp[0] - p[0];
    const uz = wp[2] - p[2];
    const k = (127 * speed) / (Math.sqrt(ux * ux + uz * uz) || 1);
    let wx = Math.round(ux * k);
    let wz = Math.round(uz * k);
    let btn = 0;
    if (sim.tick - lastProgressTick > 45) {
      trace?.(`  stuck at ${v1(p)} heading for ${v1(wp)} (waypoint ${i} of ${pts.length}${moving ? ", moving target" : ""})`);
      // stuck against something: sidestep and hop, deterministically
      wx = Math.round((rng() - 0.5) * 254);
      wz = Math.round((rng() - 0.5) * 254);
      btn = BTN.JUMP;
      lastProgressTick = sim.tick;
    }
    if (leapNow) {
      trace?.(`  jumping a low hazard at ${v1(p)}`);
      btn = BTN.JUMP;
      leapNow = false;
    }
    // a closed door or gate well under jump height just ahead (a waist-high vault door): hop it,
    // as anyone would
    if (b && !btn && sim.player.grounded && sim.tick >= hopAt) {
      const len = Math.sqrt(ux * ux + uz * uz) || 1;
      const ahead: Vec3 = [p[0] + (ux / len) * 1.6, p[1], p[2] + (uz / len) * 1.6];
      const top = Math.min(1.2, apex(sim.laws, sim.laws.jumpsMax) - 0.4); // a waist-high barrier, never a door under a lintel
      // (never from on top of it: a hop from there lands back on it)
      const low = b.entities.find((d) => d.kind === "door" && d.size[1] <= top && sim.entity(d.id)?.col?.isEnabled() && Math.abs(d.pos[1] - d.size[1] / 2 - (p[1] - 0.9)) < 0.5 && !inBox(p[0], p[2], d, 0.45) && crosses(p, ahead, d.pos, d.size));
      if (low) {
        trace?.(`  hopping ${low.id} (${low.size[1]} m) at ${v1(p)}`);
        btn = BTN.JUMP;
        hopAt = sim.tick + 40;
      }
    }
    const back = b && !btn ? fightBack(sim, b) : null;
    if (back) {
      [wx, wz] = back;
      btn = BTN.USE;
    }
    if (b) [wx, wz] = lean(b, sim.laws.speed, p, wx, wz);
    sim.step({ tick: sim.tick + 1, wx, wz, btn });
    budget.ticks--;
  }
  return stop();
}

/** The static surface a point stands on (highest top at or below it). */
function surfaceUnder(b: WorldBundle, p: Vec3) {
  let best: WorldBundle["statics"][number] | undefined;
  for (const s of b.statics) {
    const top = s.pos[1] + s.size[1] / 2;
    if (Math.abs(p[0] - s.pos[0]) > s.size[0] / 2 || Math.abs(p[2] - s.pos[2]) > s.size[2] / 2 || top > p[1] + 0.2) continue;
    if (!best || top > best.pos[1] + best.size[1] / 2) best = s;
  }
  return best;
}

/**
 * Ticks a jump sequence stays airborne before landing `rise` metres up, from the T1 model's own
 * time of flight, plus slack: high jumps (a 4 m jump flies for almost 2 s) must not time out mid-air.
 */
function airTicks(laws: Laws, jumps: number, rise: number): number {
  const r = reachAt(laws, jumps, rise);
  return Math.max(150, Math.ceil((r > 0 ? r / (laws.speed * 0.85) : 2.5) * 60) + 45);
}

/**
 * Jump link: when the target is on a raised surface the navmesh can't reach on foot, walk to the
 * closest face of that surface, jump (and air-jump at the apex), then land on top.
 */
function climbOnto(sim: SimWorld, nav: NavWorld, b: WorldBundle, target: Vec3, rng: () => number, budget: { ticks: number }, onto?: Surface): boolean {
  const s = onto ? null : surfaceUnder(b, [target[0], target[1] + 0.1, target[2]]);
  if (!onto && !s) return false;
  const top = onto ? onto.top : s!.pos[1] + s!.size[1] / 2;
  const p = sim.pos("player");
  const [minX, maxX, minZ, maxZ] = onto ? [onto.min[0], onto.max[0], onto.min[1], onto.max[1]] : [s!.pos[0] - s!.size[0] / 2, s!.pos[0] + s!.size[0] / 2, s!.pos[2] - s!.size[2] / 2, s!.pos[2] + s!.size[2] / 2];
  const clampX = Math.min(maxX - 0.8, Math.max(minX + 0.8, target[0]));
  const clampZ = Math.min(maxZ - 0.8, Math.max(minZ + 0.8, target[2]));
  // candidate approach points 0.7 m outside each face, nearest walkable one first
  const feet = p[1] - 0.9;
  const faces: { at: Vec3; dir: [number, number] }[] = [
    { at: [clampX, feet, minZ - 0.7], dir: [0, 1] }, { at: [clampX, feet, maxZ + 0.7], dir: [0, -1] },
    { at: [minX - 0.7, feet, clampZ], dir: [1, 0] }, { at: [maxX + 0.7, feet, clampZ], dir: [-1, 0] },
  ];
  const d2 = (a: Vec3) => (a[0] - p[0]) * (a[0] - p[0]) + (a[2] - p[2]) * (a[2] - p[2]);
  faces.sort((u, v) => d2(u.at) - d2(v.at));
  for (const f of faces) {
    if (!nav.path([p[0], feet, p[2]], f.at)) continue; // from where the feet are (a fall floor is 3 m down)
    if (!walkTo(sim, nav, f.at, rng, 1, budget, () => false)) continue;
    // as many jumps as the ledge needs, no more: extra air jumps only fly over it (and take longer)
    const rise = top - (sim.pos("player")[1] - 0.9);
    let need = 1;
    while (need < sim.laws.jumpsMax && apex(sim.laws, need) < rise + 0.05) need++;
    let on = false;
    for (let t = 0, end = airTicks(sim.laws, need, rise); t < end && budget.ticks > 0 && !on; t++) {
      const q = sim.pos("player");
      const above = q[1] - 0.9 > top + 0.05;
      const inX = f.dir[0] === 0 ? 0 : Math.max(-127, Math.min(127, Math.round((clampX - q[0]) * 60)));
      const inZ = f.dir[1] === 0 ? 0 : Math.max(-127, Math.min(127, Math.round((clampZ - q[2]) * 60)));
      const wx = above ? inX : f.dir[0] * 127;
      const wz = above ? inZ : f.dir[1] * 127;
      const again = t > 6 && sim.player.vy <= 0.5 && sim.player.jumpsUsed > 0 && sim.player.jumpsUsed < need;
      sim.step({ tick: sim.tick + 1, wx, wz, btn: t === 0 || again ? BTN.JUMP : 0 });
      if (again) sim.step({ tick: sim.tick + 1, wx, wz, btn: 0 });
      budget.ticks -= again ? 2 : 1;
      on = t > 0 && sim.player.grounded && q[1] - 0.9 > top - 0.1;
    }
    if (on) return true;
  }
  return false;
}

/**
 * Drop link, the way down: standing on a raised surface the navmesh can't leave, walk off its
 * edge on the side facing the target (the navmesh has no off-mesh links for drops).
 */
function dropDown(sim: SimWorld, b: WorldBundle, target: Vec3, budget: { ticks: number }): boolean {
  const p = sim.pos("player");
  const s = surfaceUnder(b, [p[0], p[1] - 0.8, p[2]]);
  if (!s) return false;
  const top = s.pos[1] + s.size[1] / 2;
  if (top < 0.5) return false; // already on the ground level
  const [hx, hz] = [s.size[0] / 2, s.size[2] / 2];
  // leave across the edge nearest the target: push the clamped target 1 m past that edge
  const cx = Math.min(s.pos[0] + hx, Math.max(s.pos[0] - hx, target[0]));
  const cz = Math.min(s.pos[2] + hz, Math.max(s.pos[2] - hz, target[2]));
  const ex = Math.abs(cx - s.pos[0]) / hx >= Math.abs(cz - s.pos[2]) / hz;
  const out: Vec3 = ex ? [s.pos[0] + Math.sign(cx - s.pos[0] || 1) * (hx + 1), 0, cz] : [cx, 0, s.pos[2] + Math.sign(cz - s.pos[2] || 1) * (hz + 1)];
  for (let t = 0; t < 240 && budget.ticks > 0 && !sim.result; t++) {
    const q = sim.pos("player");
    if (q[1] - 0.9 < top - 0.5 && sim.player.grounded) return true;
    const ux = out[0] - q[0];
    const uz = out[2] - q[2];
    const k = 127 / (Math.sqrt(ux * ux + uz * uz) || 1);
    sim.step({ tick: sim.tick + 1, wx: Math.round(ux * k), wz: Math.round(uz * k), btn: 0 });
    budget.ticks--;
  }
  return false;
}

const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * One hop between surfaces: walk across when they touch at step height, walk off when the next
 * one is below, otherwise jump with the fewest jumps the T1 model needs and air-jump at each apex.
 */
function hop(sim: SimWorld, nav: NavWorld, b: WorldBundle, a: Surface, n: Surface, budget: { ticks: number }): boolean {
  const laws = sim.laws;
  const rise = n.top - a.top;
  const on = () => {
    const q = sim.pos("player");
    const inside = q[0] >= n.min[0] && q[0] <= n.max[0] && q[2] >= n.min[1] && q[2] <= n.max[1];
    // a pad is reached the moment it throws you up
    if (n.launch) return inside && (sim.player.grounded || sim.player.vy > 0.5);
    return sim.player.grounded && inside && q[1] - 0.9 > n.top - 0.15;
  };
  // take-off: the point of a nearest n, 0.3 m inside a; aim: the point of n nearest that, pushed in
  const ncx = (n.min[0] + n.max[0]) / 2;
  const ncz = (n.min[1] + n.max[1]) / 2;
  const tx = clampTo(clampTo(ncx, a.min[0], a.max[0]), a.min[0] + 0.3, a.max[0] - 0.3);
  const tz = clampTo(clampTo(ncz, a.min[1], a.max[1]), a.min[1] + 0.3, a.max[1] - 0.3);
  let ax = clampTo(clampTo(tx, n.min[0], n.max[0]), n.min[0] + Math.min(1.2, (n.max[0] - n.min[0]) / 2), n.max[0] - Math.min(1.2, (n.max[0] - n.min[0]) / 2));
  let az = clampTo(clampTo(tz, n.min[1], n.max[1]), n.min[1] + Math.min(1.2, (n.max[1] - n.min[1]) / 2), n.max[1] - Math.min(1.2, (n.max[1] - n.min[1]) / 2));
  // a jump pad that isn't this hop's (one a fill put on the lane) throws you off the route, and a
  // portal sends you back: land beside them, and walk around them where the ground is wide enough
  const all = surfaces(b);
  const portals = b.entities
    .filter((e) => b.verbs.some((v) => v.on === e.id && v.verb === "puzzle.portal"))
    .map((e): Surface => ({ id: e.id, zone: e.zone, top: e.pos[1] - e.size[1] / 2, min: [e.pos[0] - e.size[0] / 2, e.pos[2] - e.size[2] / 2], max: [e.pos[0] + e.size[0] / 2, e.pos[2] + e.size[2] / 2] }));
  // and a hazard standing on the lane (a boulder, spikes) is no place to land or walk through
  const losing = new Set(b.rules.filter((r) => (r.when.t === "enter" || r.when.t === "hit") && r.when.a === "player" && r.then.some((x) => x.e === "lose")).map((r) => r.when.b));
  const standing = b.entities
    .filter((e) => (e.body === "sensor" || e.body === "fixed") && (losing.has(e.id) || b.verbs.some((v) => v.on === e.id && v.verb === "motion_hazards.hazard")) && !b.verbs.some((v) => v.on === e.id && v.verb.endsWith(".oscillate")))
    .map((e): Surface & { hurts?: boolean } => ({ id: e.id, zone: e.zone, top: e.pos[1] - e.size[1] / 2, min: [e.pos[0] - e.size[0] / 2, e.pos[2] - e.size[2] / 2], max: [e.pos[0] + e.size[0] / 2, e.pos[2] + e.size[2] / 2], hurts: true }));
  const pads: (Surface & { hurts?: boolean })[] = [...all.filter((x) => x.launch && x.id !== a.id && x.id !== n.id), ...portals, ...standing];
  // what kills gets more room than what only moves you (a landing can carry on half a metre)
  const onPad = (x: number, z: number, top: number, m: number) => pads.find((d) => {
    const g = m + (d.hurts ? 0.6 : 0);
    return Math.abs(d.top - top) < 0.6 && x >= d.min[0] - g && x <= d.max[0] + g && z >= d.min[1] - g && z <= d.max[1] + g;
  });
  // they fire on the runner's centre: a quarter metre clear is enough
  const clear = (x: number, z: number, top: number) => !onPad(x, z, top, 0.25);
  const sideOf = (s: Surface, x: number, z: number, d: Surface & { hurts?: boolean }): [number, number] | null => {
    // the nearest spot on s beside d (left, right, before or after it), 0.35 m in from s's edges
    const o = d.hurts ? 1.0 : 0.6;
    const opts: [number, number][] = [[d.min[0] - o, z], [d.max[0] + o, z], [x, d.min[1] - o], [x, d.max[1] + o]];
    const ok = opts
      .map(([u, v]) => [clampTo(u, s.min[0] + 0.35, s.max[0] - 0.35), clampTo(v, s.min[1] + 0.35, s.max[1] - 0.35)] as [number, number])
      .filter(([u, v]) => clear(u, v, s.top));
    const dd = (q: [number, number]) => (q[0] - x) * (q[0] - x) + (q[1] - z) * (q[1] - z);
    ok.sort((p, q) => dd(p) - dd(q));
    return ok[0] ?? null;
  };
  const landPad = onPad(ax, az, n.top, 0.35);
  if (landPad) [ax, az] = sideOf(n, ax, az, landPad) ?? [ax, az];
  // nor on a loose thing lying there (landing at speed knocks a trophy off the deck): 1.2 m clear
  const carry = carryables(b);
  for (const e of b.entities) {
    if (!carry.has(e.id) || e.body !== "dynamic" || sim.entity(e.id)?.carrier || sim.entity(e.id)?.destroyed) continue;
    const q = sim.pos(e.id);
    if (q[0] < n.min[0] || q[0] > n.max[0] || q[2] < n.min[1] || q[2] > n.max[1] || Math.abs(q[1] - n.top) > 1) continue;
    const dx = ax - q[0];
    const dz = az - q[2];
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= 1.2) continue;
    // back along the way we come in, staying on n
    const ux = tx - q[0];
    const uz = tz - q[2];
    const ul = Math.sqrt(ux * ux + uz * uz) || 1;
    ax = clampTo(q[0] + (ux / ul) * 1.2, n.min[0] + 0.3, n.max[0] - 0.3);
    az = clampTo(q[2] + (uz / ul) * 1.2, n.min[1] + 0.3, n.max[1] - 0.3);
  }
  const steer = (x: number, z: number, k: number, btn: number) => {
    const p = sim.pos("player");
    const ux = x - p[0];
    const uz = z - p[2];
    const s = Math.min(127, (Math.sqrt(ux * ux + uz * uz) * k) || 0) / (Math.sqrt(ux * ux + uz * uz) || 1);
    const [wx, wz] = lean(b, laws.speed, p, Math.round(ux * s), Math.round(uz * s));
    sim.step({ tick: sim.tick + 1, wx, wz, btn });
    budget.ticks--;
  };
  const walkStraight = (x: number, z: number, tol: number) => {
    for (let t = 0; t < 900 && budget.ticks > 0 && !sim.result; t++) {
      const p = sim.pos("player");
      if ((p[0] - x) * (p[0] - x) + (p[2] - z) * (p[2] - z) < tol * tol) return true;
      steer(x, z, 120, 0);
    }
    return false;
  };
  const walkTo = (x: number, z: number, tol: number) => {
    // a pad on the way across this surface: round it by its corners (one or two), on the surface
    const p = sim.pos("player");
    const top = p[1] - 0.9;
    const legClear = (u0: number, v0: number, u1: number, v1: number) => {
      for (let k = 0; k <= 12; k++) if (onPad(u0 + ((u1 - u0) * k) / 12, v0 + ((v1 - v0) * k) / 12, top, 0.2)) return false;
      return true;
    };
    if (!legClear(p[0], p[2], x, z)) {
      const here = surfaceAt(all, [p[0], top + 0.1, p[2]]);
      const d = pads.find((q) => !legClear(p[0], p[2], x, z) && Math.abs(q.top - top) < 0.6);
      if (here && d) {
        const o = d.hurts ? 0.9 : 0.45;
        const corners = ([[d.min[0] - o, d.min[1] - o], [d.max[0] + o, d.min[1] - o], [d.max[0] + o, d.max[1] + o], [d.min[0] - o, d.max[1] + o]] as [number, number][])
          .map(([u, v]) => [clampTo(u, here.min[0] + 0.3, here.max[0] - 0.3), clampTo(v, here.min[1] + 0.3, here.max[1] - 0.3)] as [number, number])
          .filter(([u, v]) => clear(u, v, top));
        const len = (pts: [number, number][]) => pts.reduce((acc, q, i) => { const r0 = i ? pts[i - 1]! : [p[0], p[2]]; return acc + Math.sqrt((q[0] - r0[0]!) * (q[0] - r0[0]!) + (q[1] - r0[1]!) * (q[1] - r0[1]!)); }, 0);
        let best: [number, number][] | null = null;
        for (const c of corners) {
          const via: [number, number][] = [c, [x, z]];
          if (legClear(p[0], p[2], c[0], c[1]) && legClear(c[0], c[1], x, z) && (!best || len(via) < len(best))) best = via;
          for (const c2 of corners) {
            const via2: [number, number][] = [c, c2, [x, z]];
            if (c2 !== c && legClear(p[0], p[2], c[0], c[1]) && legClear(c[0], c[1], c2[0], c2[1]) && legClear(c2[0], c2[1], x, z) && (!best || len(via2) < len(best))) best = via2;
          }
        }
        for (const q of best?.slice(0, -1) ?? []) walkStraight(q[0], q[1], 0.3);
      }
    }
    return walkStraight(x, z, tol);
  };
  if (a.launch) {
    // on the pad: let it throw you up (step onto its middle if it hasn't yet), then drift to the aim
    const [pcx, pcz] = [(a.min[0] + a.max[0]) / 2, (a.min[1] + a.max[1]) / 2];
    for (let t = 0; t < 120 && budget.ticks > 0 && !sim.result && sim.player.grounded; t++) steer(pcx, pcz, 120, 0);
    for (let t = 0; t < 600 && budget.ticks > 0 && !sim.result; t++) {
      steer(ax, az, 1e9, 0);
      if (t > 10 && on()) return true;
      if (sim.pos("player")[1] - 0.9 < Math.min(a.top, n.top) - 1.5) return false; // fell
    }
    return on();
  }
  if (gap(a, n) <= 0.01 && Math.abs(rise) < 0.41) {
    // a big surface (the fall floor among the course's pillars) is crossed on the navmesh
    const p0 = sim.pos("player");
    const path = nav.path([p0[0], p0[1] - 0.9, p0[2]], [ax, n.top, az]);
    if (path) for (const w of path.slice(1, -1)) walkTo(w[0], w[2], 0.45);
    walkTo(ax, az, 0.3); // round anything standing in the way first
    for (let t = 0; t < 900 && budget.ticks > 0 && !sim.result && !on(); t++) steer(ax, az, 120, 0);
    return on();
  }
  // a block standing on (or against) the ground you're on: walk up to one of its faces and climb
  // it (a take-off "nearest its middle" would be inside the block itself)
  if (gap(a, n) <= 0.01 && rise >= 0.41) return climbOnto(sim, nav, b, [ax, n.top, az], stream(sim.tick, "t3:climb"), budget, n) && on();
  let jumps = rise <= 0 && gap(a, n) <= reachAt(laws, 0, rise) ? 0 : 1;
  while (jumps > 0 && jumps < laws.jumpsMax && !(rise <= apex(laws, jumps) + 1e-9 && gap(a, n) <= reachAt(laws, jumps, rise))) jumps++;
  // a big surface (the ground) is crossed on the navmesh; pads are crossed straight
  const p0 = sim.pos("player");
  const path = nav.path([p0[0], p0[1] - 0.9, p0[2]], [tx, a.top, tz]);
  if (path) for (const w of path.slice(1, -1)) walkTo(w[0], w[2], 0.45);
  if (!walkTo(tx, tz, 0.08)) return false;
  for (let t = 0; t < 300 && budget.ticks > 0 && !sim.result; t++) {
    const again = jumps > 1 && t > 6 && sim.player.vy <= 0.5 && sim.player.jumpsUsed > 0 && sim.player.jumpsUsed < jumps;
    steer(ax, az, 1e9, (jumps > 0 && t === 0) || again ? BTN.JUMP : 0);
    if (again) steer(ax, az, 1e9, 0); // release, so the next press is a fresh one
    if (t > 2 && on()) return true;
    if (sim.pos("player")[1] - 0.9 < Math.min(a.top, n.top) - 1.5) return false; // fell
  }
  return on();
}

/** Follow a T1 hop route to the target's surface (gaps, pads, beams the navmesh can't link). */
function hopTo(sim: SimWorld, nav: NavWorld, b: WorldBundle, target: Vec3, budget: { ticks: number }): boolean {
  const ss = surfaces(b).filter((s) => !b.statics.some((x) => x.id === s.id && x.surf === "wall"));
  const p = sim.pos("player");
  const from = surfaceAt(ss, [p[0], p[1] - 0.8, p[2]]);
  const to = surfaceAt(ss, [target[0], target[1] + 0.1, target[2]]);
  if (!from || !to) return false;
  let route = hopRoute(ss, from, to, sim.laws);
  trace?.(`  hop route ${route ? route.map((x) => x.id).join(">") : "none"}`);
  // a hop that lands on something else solid (a step a fill put in the way) carries on from there
  for (let replans = 0; route; ) {
    let i = 1;
    for (; i < route.length; i++) if (!hop(sim, nav, b, route[i - 1]!, route[i]!, budget)) break;
    if (i === route.length) return true;
    const q = sim.pos("player");
    const here = sim.player.grounded ? surfaceAt(ss, [q[0], q[1] - 0.8, q[2]]) : undefined;
    trace?.(`  hop ${route[i - 1]!.id}>${route[i]!.id} failed at ${v1(q)}${here ? ` on ${here.id}` : ""}`);
    if (!here || replans++ >= 3 || here.top < Math.min(route[i - 1]!.top, route[i]!.top) - 0.5 || sim.result) return false;
    route = hopRoute(ss, here, to, sim.laws);
  }
  return false;
}

/**
 * Walk there; when the navmesh can't, get onto the target's surface first: drop down when it is
 * below, otherwise hop across or climb (walking off a platform toward a target on another one
 * only lands on the floor below, which on a course is where the lava is).
 */
function goTo(sim: SimWorld, nav: NavWorld, b: WorldBundle, target: Target, rng: () => number, speed: number, budget: { ticks: number }, stop: () => boolean): boolean {
  const p = sim.pos("player");
  const t = at(target);
  const walkable = () => {
    const q = sim.pos("player");
    const feet: Vec3 = [q[0], q[1] - 0.9, q[2]];
    return Boolean(nav.path(feet, t) ?? leapPath(feet, t));
  };
  if (typeof target !== "function" && !walkable() && !stop()) {
    const below = t[1] < p[1] - 0.9 - 1;
    trace?.(`goTo ${v1(t)} from ${v1(p)}${below ? " (below)" : ""}`);
    const down = () => dropDown(sim, b, t, budget) && walkable();
    const across = () => climbOnto(sim, nav, b, t, rng, budget) || hopTo(sim, nav, b, t, budget);
    if (!(below ? down() || across() : across() || down()) && !walkable()) return stop();
  }
  return walkTo(sim, nav, target, rng, speed, budget, stop, b);
}

interface Run {
  sim: SimWorld;
  nav: NavWorld;
  b: WorldBundle;
  rng: () => number;
  speed: number;
  budget: { ticks: number };
  openers: ReadonlyMap<string, PlanStep[]>;
  opened: Set<string>;
  /** Trying one of several ways to open a door: give up on a target behind a shut door at once. */
  failFast?: boolean;
}

const live = (r: Run) => r.budget.ticks > 0 && !r.sim.result;

/** Counts a rule's firings from now on. */
function counter(sim: SimWorld, rule: string): () => number {
  const base = sim.fires.get(rule) ?? 0;
  return () => (rule ? (sim.fires.get(rule) ?? 0) - base : 0);
}

/** Does the segment a→b cross the box (grown by the capsule radius) on the ground plane? */
function crosses(a: Vec3, b: Vec3, c: Vec3, size: Vec3): boolean {
  let lo = 0;
  let hi = 1;
  for (const k of [0, 2] as const) {
    const d = b[k] - a[k];
    const min = c[k] - size[k] / 2 - 0.35;
    const max = c[k] + size[k] / 2 + 0.35;
    if (Math.abs(d) < 1e-9) {
      if (a[k] < min || a[k] > max) return false;
      continue;
    }
    let u = (min - a[k]) / d;
    let v = (max - a[k]) / d;
    if (u > v) [u, v] = [v, u];
    lo = Math.max(lo, u);
    hi = Math.min(hi, v);
    if (lo > hi) return false;
  }
  return true;
}

/** Every way the world opens a door: a rule that opens it, set off by something a runner can do. */
function otherOpeners(b: WorldBundle, door: string): PlanStep[][] {
  const made = producers(b);
  const out: PlanStep[][] = [];
  for (const r of [...b.rules].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    if (!r.then.some((e) => e.target === door && (e.e === "open" || (e.e === "set_state" && String(e.v) === "open")))) continue;
    const w = r.when;
    const p = w.t === "state_is" ? made.find((x) => x.k === "state" && x.a === w.a && x.s === w.s && x.cause) : undefined;
    if (p?.cause) out.push(causeSteps(p.cause, r.id));
  }
  return out;
}

/** If a closed door stands on the way to `target`, open it first (once per door per run). */
function clearDoors(r: Run, target: Vec3) {
  const p = r.sim.pos("player");
  const path = r.nav.path([p[0], p[1] - 0.9, p[2]], target) ?? leapPath([p[0], p[1] - 0.9, p[2]], target);
  if (!path) return;
  for (let i = 1; i < path.length; i++) {
    for (const d of r.b.entities) {
      if (d.kind !== "door" || r.opened.has(d.id)) continue;
      const e = r.sim.entity(d.id);
      // open is a door you can walk through, whatever its state is called ("occupied")
      const passable = e?.state === "open" || (e?.col ? !e.col.isEnabled() : false);
      if (!e || e.destroyed || passable || !crosses(path[i - 1]!, path[i]!, d.pos, d.size)) continue;
      r.opened.add(d.id);
      trace?.(`door ${d.id} blocks the way: opening it`);
      // its planned opener first, then any other way the world opens it (a lever on this side when
      // the planned one is behind the door)
      const ways = [r.openers.get(d.id) ?? [], ...otherOpeners(r.b, d.id)].filter((w, i, all) => w.length && all.findIndex((x) => JSON.stringify(x) === JSON.stringify(w)) === i);
      for (const [wi, way] of ways.entries()) {
        let ok = true;
        r.failFast = wi < ways.length - 1;
        for (const st of way) {
          const res = perform(r, st);
          trace?.(`  opener ${st.do} ${"item" in st ? st.item : "at" in st ? st.at : "sensor" in st ? st.sensor : ""} → ${res} at ${v1(r.sim.pos("player"))}${"want" in st && st.want ? ` (${st.want.id} ${r.sim.entity(st.want.id)?.state})` : ""}`);
          if (res !== "ok") {
            ok = false;
            break;
          }
        }
        r.failFast = false;
        const e2 = r.sim.entity(d.id);
        if (ok || e2?.state === "open" || (e2?.col && !e2.col.isEnabled())) break;
        if (!live(r)) return;
      }
    }
  }
}

/** Eight directions round a point (no trigonometry in the simulation path). */
const RING8: readonly (readonly [number, number])[] = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]];

/**
 * Where to stand to reach a thing. A sensor or decor: the walkable point nearest it. A solid
 * thing: beside it, on the side with a path from here (never on top: a sculpture's top is
 * walkable navmesh, and a visitor up there is too high to use it).
 */
const spotBy = (r: Run, id: string): Vec3 => {
  const e = r.b.entities.find((x) => x.id === id)!;
  const solid = e.body === "fixed" || e.body === "kinematic" || e.body === "dynamic";
  const floor = e.pos[1] - e.size[1] / 2;
  if (!solid) {
    const near = r.nav.nearest([e.pos[0], floor, e.pos[2]]);
    // something you use (a pad you mustn't step on) only needs you within its reach
    const use = Math.max(0, ...r.b.verbs.filter((v) => v.on === id).map((v) => verb(v.verb)?.use?.radius ?? 0));
    const reach = use ? use + Math.max(e.size[0], e.size[2]) / 2 - 0.3 : 1;
    // ground too narrow for the navmesh (a beam), or the walkable ground found is the floor below a
    // deck it lies on: stand on the thing's own spot and get there by climbing or hops
    return near && d2h(near, e.pos) <= Math.max(1, reach * reach) && near[1] > floor - 1.2 ? near : [e.pos[0], floor, e.pos[2]];
  }
  const p = r.sim.pos("player");
  const feet: Vec3 = [p[0], p[1] - 0.9, p[2]];
  const [hx, hz] = [e.size[0] / 2 + 0.6, e.size[2] / 2 + 0.6];
  const sides: Vec3[] = [[e.pos[0], floor, e.pos[2] - hz], [e.pos[0], floor, e.pos[2] + hz], [e.pos[0] - hx, floor, e.pos[2]], [e.pos[0] + hx, floor, e.pos[2]]];
  // a side that only reaches the navmesh by snapping far away (into the wall beside a door) is no spot
  // (walkable ground at the thing's own level first: a pane in the wall has a ledge above it)
  const spots = sides.map((q) => [q, r.nav.nearest(q, 1) ?? r.nav.nearest(q)] as const).filter(([q, n]) => n !== null && Math.abs(n[1] - floor) < 0.6 && d2h(q, n) < 0.25).map(([, n]) => n!);
  spots.sort((u, v) => d2h(u, p) - d2h(v, p));
  const side = spots.find((q) => r.nav.path(feet, q)) ?? spots[0];
  if (side) return side;
  // nothing walkable right beside it (a pane above a shelf): anywhere on the floor within its reach
  const use = Math.max(0, ...r.b.verbs.filter((v) => v.on === id).map((v) => verb(v.verb)?.use?.radius ?? 0));
  const reach = use + Math.max(e.size[0], e.size[2]) / 2 - 0.3;
  const ring: Vec3[] = [];
  for (const rad of [1.2, 1.8, 2.4, 3.0]) {
    if (rad > reach) break;
    for (const [cx, cz] of RING8) {
      const n = r.nav.nearest([e.pos[0] + cx * rad, floor, e.pos[2] + cz * rad], 1.6);
      if (n && d2h(n, e.pos) <= reach * reach && r.nav.path(feet, n)) ring.push(n);
    }
    if (ring.length) break;
  }
  ring.sort((u, v) => d2h(u, p) - d2h(v, p));
  return ring[0] ?? r.nav.nearest([e.pos[0], floor, e.pos[2]]) ?? e.pos;
};

/** Turn toward a thing (one short nudge of the stick): USE takes what you face. */
function faceTo(r: Run, id: string) {
  const p = r.sim.pos("player");
  const q = r.sim.pos(id);
  const dx = q[0] - p[0];
  const dz = q[2] - p[2];
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 0.05 || r.budget.ticks <= 0 || r.sim.result) return;
  r.sim.step({ tick: r.sim.tick + 1, wx: Math.round((dx / d) * 30), wz: Math.round((dz / d) * 30), btn: 0 });
  r.budget.ticks--;
}

/**
 * Two things in reach and USE takes the nearer: a sculpture with its guide beside it. Step toward
 * the one wanted until it is the one USE would pick (or it's right there).
 */
function closeIn(r: Run, id: string): boolean {
  const { sim } = r;
  for (let k = 0; k < 45 && r.budget.ticks > 0 && !sim.result; k++, r.budget.ticks--) {
    if (sim.usable()?.on === id) return true;
    const p = sim.pos("player");
    const q = sim.pos(id);
    const dx = q[0] - p[0];
    const dz = q[2] - p[2];
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    sim.step({ tick: sim.tick + 1, wx: Math.round((dx / d) * 60), wz: Math.round((dz / d) * 60), btn: 0 });
  }
  return sim.usable()?.on === id;
}

/** Execute one plan step in physics; "lost" means a carried item was taken (start over). */
function perform(r: Run, st: PlanStep): "ok" | "lost" | "stuck" {
  const { sim, nav, b, rng, speed, budget } = r;
  const go = (t: Vec3 | (() => Vec3), stop: () => boolean) => {
    if (typeof t !== "function") clearDoors(r, t);
    // doors still shut after that (a gate that opens later): walk round them when there's a way
    const closed = b.entities.filter((d) => d.kind === "door" && sim.entity(d.id)?.col?.isEnabled()).map((d) => d.id).sort();
    if (closed.length) {
      const n = shutNav(b, closed);
      const p = sim.pos("player");
      const feet: Vec3 = [p[0], p[1] - 0.9, p[2]];
      const q = typeof t === "function" ? t() : t;
      if (n.path(feet, q)) return goTo(sim, n, b, t, rng, speed, budget, stop);
      // the only way there is through a door still shut, while another way to open the door is
      // left to try: out of reach for now (don't walk into it for the rest of the run)
      if (r.failFast && nav.path(feet, q)) {
        trace?.(`  ${v1(q)} is behind a shut door for now`);
        return false;
      }
    }
    return goTo(sim, nav, b, t, rng, speed, budget, stop);
  };
  const gone = (id: string) => sim.entity(id)?.destroyed === true;
  const met = (w: Want) => sim.entity(w.id)?.state === w.s;
  switch (st.do) {
    case "pickup": {
      if (!sim.entity(st.item)) return "stuck"; // nothing by that name in the world
      // already used up (a part that went into its slot, a key a lock kept): the step it was for
      // has happened; the next step checks its own goal
      if (sim.entity(st.item)!.destroyed) return "ok";
      const has = () => sim.entity(st.item)?.carrier === "player";
      // it may be in someone else's hands: chase the carrier (a tag knocks it loose)
      const where = () => {
        const c = sim.entity(st.item)!.carrier;
        return c ? sim.pos(c) : sim.pos(st.item);
      };
      // holding something else (a kept key the doors on the way needed, something picked up on the
      // way): put it down beside the target, clear of anything usable, then pick the right thing up
      const wrong = () => {
        const h = sim.entity("player")?.carrying;
        return Boolean(h && h !== st.item);
      };
      const near = () => d2h(sim.pos("player"), where()) < 2.25;
      const putDown = () => {
        // something usable in reach would take the USE: step away from it, slowly, never off the edge
        const ss = surfaces(b);
        for (let k = 0; k < 30 && live(r); k++, budget.ticks--) {
          const u = sim.usable();
          if (!u) break;
          const p = sim.pos("player");
          const q = sim.pos(u.on);
          const len = Math.sqrt((p[0] - q[0]) * (p[0] - q[0]) + (p[2] - q[2]) * (p[2] - q[2])) || 1;
          const [dx, dz] = [(p[0] - q[0]) / len, (p[2] - q[2]) / len];
          const under = surfaceAt(ss, [p[0], p[1] - 0.8, p[2]]);
          const ahead = surfaceAt(ss, [p[0] + dx * 0.6, p[1] - 0.8, p[2] + dz * 0.6]);
          if (under && (!ahead || ahead.top < under.top - 0.3)) break; // the edge
          sim.step({ tick: sim.tick + 1, wx: Math.round(dx * 64), wz: Math.round(dz * 64), btn: 0 });
        }
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.USE });
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: 0 });
        budget.ticks -= 2;
      };
      if (!sim.entity(st.item)!.carrier) {
        clearDoors(r, sim.pos(st.item));
        // lying somewhere the navmesh can't reach (on a platform): climb or hop to it first, unless
        // someone takes it; reachable on foot, chase it as it moves (a bumped or carried orb)
        const p = sim.pos("player");
        const it = sim.pos(st.item);
        if (!nav.path([p[0], p[1] - 0.9, p[2]], it)) {
          go(it, () => has() || Boolean(sim.entity(st.item)!.carrier) || (wrong() && near()));
          if (has()) return "ok";
        }
      }
      for (let tries = 0; tries < 3 && live(r); tries++) {
        const ok = go(where, () => has() || (wrong() && near()));
        if (has()) return "ok";
        if (!wrong()) return ok ? "ok" : "stuck";
        trace?.(`  holding ${sim.entity("player")!.carrying} at ${st.item}: putting it down`);
        putDown();
      }
      return has() ? "ok" : "stuck";
    }
    case "deliver": {
      const fired = counter(sim, st.rule);
      const done = () => (st.want ? met(st.want) : fired() > 0);
      // only the thing being delivered can be lost (a key the lock used up is not)
      const lost = () => st.item !== "player" && sim.entity(st.item)?.carrier !== "player";
      const sensor = b.entities.find((e) => e.id === st.sensor)!;
      // into someone (catch the thief): chase them where they are now
      const into = sensor.kind === "npc" ? () => sim.pos(sensor.id) : sensor.pos;
      go(into, () => done() || lost());
      // already inside from a previous delivery: step out and come back in (a fresh enter)
      for (let k = 0; k < 2 && !done() && !lost() && live(r); k++) {
        const p = sim.pos("player");
        const out: Vec3 = [sensor.pos[0] + (p[0] >= sensor.pos[0] ? 1 : -1) * (sensor.size[0] / 2 + 2), p[1] - 0.9, sensor.pos[2]];
        go(nav.nearest(out) ?? out, () => false);
        go(sensor.pos, () => done() || lost());
      }
      if (done()) return "ok";
      return lost() && live(r) ? "lost" : "stuck";
    }
    case "use": {
      const fired = counter(sim, st.rule);
      // a step the plan repeats (two conditions both needed the head in its slot) is done when what
      // its rule does already holds, or its once-only rule already fired
      const rule = st.rule ? b.rules.find((x) => x.id === st.rule) : undefined;
      const sets = rule?.then.filter((e) => e.e === "set_state") ?? [];
      const already = () => Boolean(rule && ((rule.once && (sim.fires.get(rule.id) ?? 0) > 0) || (sets.length && sets.every((e) => sim.entity(e.target)?.state === String(e.v)))));
      const done = () => (st.want ? met(st.want) : st.rule ? fired() > 0 || already() : sim.entity(st.at)?.state === "open");
      const someone = b.entities.find((e) => e.id === st.at)?.kind === "npc";
      for (let attempt = 0; attempt < (someone ? 8 : 3) && live(r) && !done(); attempt++) {
        // someone to catch moves: chase them where they are, not to where they started
        const spot = someone ? () => sim.pos(st.at) : spotBy(r, st.at);
        go(spot, () => sim.usable()?.on === st.at || done());
        // arrived mid-hop (an unsticking jump): come down first, it's out of reach from the air
        for (let k = 0; k < 60 && !sim.player.grounded && sim.usable()?.on !== st.at && live(r); k++, budget.ticks--) sim.step(null);
        if (sim.usable()?.on !== st.at && !done()) faceTo(r, st.at);
        if (sim.usable() && sim.usable()?.on !== st.at && !done()) closeIn(r, st.at);
        trace?.(`  use ${st.at} ${attempt}: spot ${v1(typeof spot === "function" ? spot() : spot)}, at ${v1(sim.pos("player"))}, usable ${sim.usable()?.on ?? "-"}`);
        if (sim.usable()?.on !== st.at || !live(r)) continue;
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.USE });
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: 0 });
        budget.ticks -= 2;
      }
      return done() ? "ok" : "stuck";
    }
    case "throw": {
      // holding the ball, close in on the nearest rival and throw; pick it up again after a miss
      const fired = counter(sim, st.rule);
      const done = () => (st.want ? met(st.want) : fired() >= (st.times ?? 1));
      const mine = sim.entity("player")?.team ?? "";
      // what it can be thrown at: rivals, and the things the throw verb names (pins, cans)
      const at = new Set(String(b.verbs.find((v) => v.verb === "combat_sport.throw" && v.on === st.item)?.params.at ?? "").split(",").filter(Boolean));
      // a rule about one pin: that pin, and close enough that it's the nearest when the ball goes
      const one = b.rules.find((x) => x.id === st.rule)?.when.a;
      const only = one && at.has(one) ? one : "";
      const rival = () => {
        const p = sim.pos("player");
        let best: Vec3 = p;
        let bestD = Infinity;
        for (const e of b.entities) {
          if (only ? e.id !== only : !(e.kind === "npc" && !(mine && e.team === mine)) && !at.has(e.id)) continue;
          if (sim.entity(e.id)?.destroyed) continue;
          const q = sim.pos(e.id);
          const d = d2h(p, q);
          if (d < bestD) ((bestD = d), (best = q));
        }
        return best;
      };
      for (let attempt = 0; attempt < 8 * (st.times ?? 1) && live(r) && !done(); attempt++) {
        if (sim.entity(st.item)?.carrier !== "player") go(() => sim.pos(st.item), () => sim.entity(st.item)?.carrier === "player" || done());
        if (sim.entity(st.item)?.carrier !== "player") continue;
        go(rival, () => d2h(sim.pos("player"), rival()) < (only ? 2.25 : 25) || done()); // within 5 m: well inside any throw's range
        trace?.(`throw ${attempt}: at ${v1(sim.pos("player"))}, rival ${v1(rival())}, holding ${sim.entity(st.item)?.carrier === "player"}, usable ${sim.usable()?.on ?? "-"}, fired ${fired()}`);
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.USE });
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: 0 });
        budget.ticks -= 2;
      }
      return done() ? "ok" : "stuck";
    }
    case "shove": {
      // stand on the inner side of the target (between it and the ring's middle) and shove outward
      const fired = counter(sim, st.rule);
      const done = () => (st.want ? met(st.want) : fired() >= (st.times ?? 1));
      const ring = st.from ? b.entities.find((e) => e.id === st.from) : undefined;
      const pit = st.into ? b.entities.find((e) => e.id === st.into) : undefined;
      const inner = (): Vec3 => {
        const t = sim.pos(st.at);
        // out of a ring: stand between it and the ring's middle; into a pit: on its far side
        const c = ring ?? pit;
        if (!c) return t;
        const [dx, dz] = [t[0] - c.pos[0], t[2] - c.pos[2]];
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        const k = ring ? -1.1 : 1.1;
        const q: Vec3 = [t[0] + (dx / len) * k, t[1], t[2] + (dz / len) * k];
        // never off the ring yourself (leaving it is how you lose)
        if (ring) for (const ax of [0, 2] as const) q[ax] = Math.max(ring.pos[ax] - ring.size[ax] / 2 + 0.5, Math.min(ring.pos[ax] + ring.size[ax] / 2 - 0.5, q[ax]));
        return q;
      };
      // only from that spot: a shove from wherever reach begins pushes them any which way
      const placed = () => (ring || pit ? d2h(sim.pos("player"), inner()) < 0.6 * 0.6 : true) && sim.usable()?.on === st.at;
      for (let attempt = 0; attempt < 10 * (st.times ?? 1) && live(r) && !done(); attempt++) {
        go(inner, () => placed() || done());
        if (sim.usable()?.on !== st.at && !done()) faceTo(r, st.at);
        trace?.(`shove ${attempt}: at ${v1(sim.pos("player"))}, ${st.at} at ${v1(sim.pos(st.at))}, usable ${sim.usable()?.on ?? "-"}, fired ${fired()}`);
        if (sim.usable()?.on !== st.at || done()) continue;
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.USE });
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: 0 });
        budget.ticks -= 2;
        for (let k = 0; k < 40 && live(r) && !done(); k++, budget.ticks--) sim.step(null); // let the knock-back carry them
      }
      return done() ? "ok" : "stuck";
    }
    case "shoot": {
      // in range with a clear line: face it and fire (the sim's aim assist leads a moving one);
      // out of range or behind cover: close in. The weapon in hand first, if it is one to hold
      const fired = counter(sim, st.rule);
      // (a precondition worn down to its hit points: done once they are that low, or it is gone)
      const low = (id: string) => sim.entity(id)?.destroyed === true || (sim.hp(id) ?? Infinity) <= (st.hp ?? -1);
      const done = () => (st.hp !== undefined ? low(st.at) : st.want ? met(st.want) : fired() >= (st.times ?? 1));
      const all = playerWeapons(b);
      // the weapon the plan names; else your own; else the one in your hands; else the nearest lying about
      const p0 = sim.pos("player");
      const loose = all.filter((x) => x.held && !sim.entity(x.on)?.carrier && !sim.entity(x.on)?.destroyed).sort((x, y) => d2h(sim.pos(x.on), p0) - d2h(sim.pos(y.on), p0) || (x.on < y.on ? -1 : 1));
      const wp = (st.weapon ? all.find((x) => x.on === st.weapon) : undefined) ?? all.find((x) => x.on === "player") ?? all.find((x) => x.held && sim.entity(x.on)?.carrier === "player") ?? loose[0] ?? all[0];
      if (!wp) return "stuck";
      const mine = sim.entity("player")?.team ?? "";
      const team = st.at.startsWith("team:") ? st.at.slice(5) : null;
      // the one the rule names; else anyone on that team; else any rival (or thing to shoot at)
      const named = st.at && !team ? st.at : "";
      const pool = named ? [named] : b.entities.filter((e) => (e.kind === "npc" && sim.npcs.has(e.id) && e.team !== mine && (!team || e.team === team)) || (!team && wp.at.includes(e.id))).map((e) => e.id);
      const standing = () => pool.filter((id) => sim.entity(id) && !sim.entity(id)!.destroyed);
      const reach = wp.range * 0.8;
      const inShot = (id: string) => {
        const p = sim.pos("player");
        const q = sim.pos(id);
        return d2h(p, q) < reach * reach && Math.abs(q[1] - p[1]) < reach && sim.clearShot([p[0], p[1] + 0.35, p[2]], q, id);
      };
      const nearest = (ids: string[]) => {
        const p = sim.pos("player");
        return ids.sort((x, y) => d2h(sim.pos(x), p) - d2h(sim.pos(y), p) || (x < y ? -1 : 1))[0];
      };
      let waits = 0;
      let misses = 0;
      while (live(r) && !done()) {
        if (wp.held && sim.entity(wp.on)?.carrier !== "player") {
          go(() => sim.pos(wp.on), () => sim.entity(wp.on)?.carrier === "player" || done());
          if (sim.entity(wp.on)?.carrier !== "player") return done() ? "ok" : "stuck";
        }
        const up = standing();
        // the target when it is in the open; else an armed rival in range (it is shooting you)
        const ready = nearest(up.filter(inShot)) ?? nearest(threats(sim).filter(inShot));
        if (!ready) {
          const t = nearest(up);
          if (!t) {
            // nobody standing (knocked out, on their way back): wait for them, a while
            if (++waits > 600) return "stuck";
            sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: 0 });
            budget.ticks--;
            continue;
          }
          const before = sim.tick;
          // chased on foot while the navmesh reaches it or the ground beside it; else, when heading
          // straight for it would walk into a pit below you both (a drone on a platform across a
          // course's gap), to where it stands now, by the hops and climbs a fixed spot gets
          const p1 = sim.pos("player");
          const feet: Vec3 = [p1[0], p1[1] - 0.9, p1[2]];
          const q = sim.pos(t);
          const near = nav.nearest(q, 1) ?? nav.nearest(q);
          const onFoot = Boolean(nav.path(feet, q) ?? leapPath(feet, q) ?? (near && nav.path(feet, near)));
          const foot: Vec3 = [q[0], q[1] - (b.entities.find((e) => e.id === t)?.size[1] ?? 1.8) / 2, q[2]];
          const ss = onFoot ? [] : surfaces(b);
          const pit = ss.length > 0 && [0.2, 0.4, 0.6, 0.8].some((k) => (surfaceAt(ss, [feet[0] + (foot[0] - feet[0]) * k, feet[1] + 0.1, feet[2] + (foot[2] - feet[2]) * k])?.top ?? -Infinity) < Math.min(feet[1], foot[1]) - 1);
          go(pit ? foot : () => sim.pos(t), () => done() || standing().some(inShot));
          trace?.(`  shoot: closing in on ${t} from ${v1(sim.pos("player"))}`);
          if (!standing().some(inShot) && (sim.tick === before || ++misses > 6)) return done() ? "ok" : "stuck";
          continue;
        }
        // between shots, back away from claws close by (as anyone would), along the ground: straight
        // away from them, else to either side
        const p = sim.pos("player");
        const cooling = Number(sim.verbs.find((x) => x.bound.id === wp.id)?.bound.mem.next ?? 0) > sim.tick + 1;
        const claws = cooling ? [...sim.npcs.keys()].filter((id) => !sim.entity(id)!.destroyed && sim.entity(id)!.team !== mine && (sim.weaponOf(id)?.range ?? 99) < 4 && d2h(sim.pos(id), p) < 3.5 * 3.5) : [];
        if (claws.length) {
          let ax = 0;
          let az = 0;
          for (const id of claws) {
            const c = sim.pos(id);
            const l = Math.sqrt(d2h(p, c)) || 1;
            ax += (p[0] - c[0]) / l;
            az += (p[2] - c[2]) / l;
          }
          const al = Math.sqrt(ax * ax + az * az) || 1;
          const ways: [number, number][] = [[ax / al, az / al], [-az / al, ax / al], [az / al, -ax / al]];
          const open = ([ux, uz]: [number, number]) => {
            const t: Vec3 = [p[0] + ux * 1.5, p[1] - 0.9, p[2] + uz * 1.5];
            const n = nav.nearest(t, 0.6);
            return n !== null && d2h(n, t) < 0.3;
          };
          const [ux, uz] = ways.find(open) ?? ways[1]!;
          sim.step({ tick: sim.tick + 1, wx: Math.round(ux * 127), wz: Math.round(uz * 127), btn: 0 });
          budget.ticks--;
          continue;
        }
        // face it (a short push on the stick, toward it) and press USE afresh every other tick
        const q = sim.pos(ready);
        const dx = q[0] - p[0];
        const dz = q[2] - p[2];
        const d = Math.sqrt(dx * dx + dz * dz) || 1;
        sim.step({ tick: sim.tick + 1, wx: Math.round((dx / d) * 24), wz: Math.round((dz / d) * 24), btn: sim.tick % 2 === 0 ? BTN.USE : 0 });
        budget.ticks--;
      }
      return done() ? "ok" : "stuck";
    }
    case "touch": {
      const fired = counter(sim, st.rule);
      const done = () => (st.want ? met(st.want) : fired() > 0 || gone(st.at));
      go(spotBy(r, st.at), done);
      return done() ? "ok" : "stuck";
    }
    case "collect": {
      // a coin hung in the air over the ground (nothing under it) is jumped for from below
      const overhead = (id: string): Vec3 | null => {
        const q = sim.pos(id);
        // the ground below it (searching down: the nearest walkable point may be a wall top above)
        let g: Vec3 | null = null;
        for (const down of [1.5, 3, 4.5]) if (!g) g = ((x) => (x && x[1] < q[1] - 1.2 ? x : null))(nav.nearest([q[0], q[1] - down, q[2]], 1));
        if (!g || d2h(g, q) > 0.5 || q[1] - g[1] < 1.6 || surfaces(b).some((s) => q[0] >= s.min[0] && q[0] <= s.max[0] && q[2] >= s.min[1] && q[2] <= s.max[1] && s.top <= q[1] + 0.05 && s.top > g[1] + 0.3)) return null;
        return q[1] - g[1] <= apex(sim.laws, sim.laws.jumpsMax) + 2.2 ? g : null;
      };
      const jumpFor = (id: string) => {
        for (let t = 0; t < 120 && live(r) && !gone(id); t++, budget.ticks--) {
          const again = t > 6 && sim.player.vy <= 0.5 && sim.player.jumpsUsed > 0 && sim.player.jumpsUsed < sim.laws.jumpsMax;
          sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: t === 0 || again ? BTN.JUMP : 0 });
          if (again) sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: 0 });
          if (t > 10 && sim.player.grounded) break;
        }
        return gone(id);
      };
      const counts = (st.rules ?? [st.rule]).map((id) => counter(sim, id));
      const fired = () => counts.reduce((n, f) => n + f(), 0);
      // nearest first; an item it can't reach this time (a missed jump) waits for a later pass
      const skipped = new Set<string>();
      while (live(r) && fired() < st.times) {
        const p = sim.pos("player");
        let left = st.items.filter((id) => !gone(id) && !skipped.has(id));
        if (!left.length) {
          if (!skipped.size) break;
          skipped.clear();
          left = st.items.filter((id) => !gone(id));
          if (!left.length) break;
        }
        left.sort((x, y) => d2h(sim.pos(x), p) - d2h(sim.pos(y), p) || (x < y ? -1 : 1));
        const it = left[0]!;
        const t0 = sim.tick;
        const before = fired();
        const g = overhead(it);
        const ok = g ? go(g, () => gone(it)) && jumpFor(it) : go(spotBy(r, it), () => gone(it));
        // got there and it's still there (out of reach overhead), or never got there: try the others first
        if (!gone(it) && (!ok || sim.tick === t0 || fired() === before)) {
          if (skipped.has(it) || (sim.tick === t0 && fired() === before && skipped.size >= left.length - 1)) return "stuck"; // a pass with no progress: never spin in place
          skipped.add(it);
        }
      }
      return fired() >= st.times ? "ok" : "stuck";
    }
    case "wait": {
      const fired = counter(sim, st.rule);
      const done = () => (st.want ? met(st.want) : fired() > 0);
      while (live(r) && !done()) {
        // (standing by for the clock, a runner still fires back at an armed rival in range)
        const back = fightBack(sim, b);
        sim.step({ tick: sim.tick + 1, wx: back?.[0] ?? 0, wz: back?.[1] ?? 0, btn: back ? BTN.USE : 0 });
        budget.ticks--;
      }
      return done() ? "ok" : "stuck";
    }
  }
}

function witnessRun(R: Rapier, b: WorldBundle, nav: NavWorld, chain: WinChain, openers: ReadonlyMap<string, PlanStep[]>, seed: number, playerTeam: "red" | "blue", schedule: readonly (readonly [string, string])[] = []): RunResult {
  // The cast plays too: runners must beat the same bots the judge will face (and, for the
  // envelope, the bots locked to whatever a schedule says their minds chose).
  trace?.(`run ${seed}${schedule.length ? ` (${schedule.map(([n, o]) => `${n}: ${o}`).join(", ")})` : ""}`);
  const brain = castBrain(nav, b);
  for (const [npc, option] of schedule) brain.choose(npc, option);
  const sim = new SimWorld(R, b, { playerTeam, brain });
  // the route it takes, for play analytics (reading positions only: the run is unchanged)
  const trail: number[] = [];
  const ghost = new GhostRecorder(sim, secretsOf(b));
  const step = sim.step.bind(sim);
  sim.step = (input) => {
    const evs = step(input);
    ghost.step(sim, input);
    if (sim.tick % 20 === 0) {
      const p = sim.pos("player");
      trail.push(Math.round(p[0] * 10) / 10, Math.round((p[1] - 0.9) * 10) / 10, Math.round(p[2] * 10) / 10);
    }
    return evs;
  };
  const rng = stream(seed, `t3:run`);
  // a world with a countdown gets its length plus a minute to play out (capped at ten minutes)
  const timer = Math.max(0, ...b.verbs.filter((v) => v.verb === "puzzle.timer").map((v) => Number(v.params.seconds) || 0));
  const ticks = Math.min(600 * 60, Math.max(RUN_TICKS, Math.round((timer + 60) * 60)));
  const r: Run = { sim, nav, b, rng, speed: 0.85 + rng() * 0.15, budget: { ticks }, openers, opened: new Set() };
  let stuck = 0;
  let stuckAt: Vec3 | null = null;
  let stuckOn = "";
  let lastTop = -1;
  outer: while (live(r)) {
    if (sim.tick === lastTop) break; // a whole pass without a tick: never spin
    lastTop = sim.tick;
    for (const st of chain.steps) {
      const res = perform(r, st);
      trace?.(`step ${st.do} ${"item" in st ? st.item : "at" in st ? st.at : "sensor" in st ? st.sensor : ""} → ${res} at ${v1(r.sim.pos("player"))} t=${r.sim.tick}${"item" in st && st.item !== "player" ? ` (${st.item} at ${v1(r.sim.pos(st.item))})` : ""}`);
      if (res === "lost") continue outer; // tagged on the way: go and win it back
      if (res === "stuck") {
        if (live(r)) stuck++;
        stuckAt = sim.pos("player");
        stuckOn = `${st.do} ${st.do === "collect" ? st.items.join(",") : "at" in st ? st.at : "sensor" in st ? st.sensor : "item" in st ? st.item : st.rule}`;
        break outer;
      }
      if (sim.result) break outer;
    }
    if (chain.steps.length === 0) break;
  }
  // how a lost run ended: the rule that fired the loss
  const lostBy = sim.result === "lose" ? (sim.log.findLast((e) => e.k === "lose")?.rule ?? "") : null;
  // (and whose shot it was: the weapon a hit names is its shooter's own, or one held)
  const blow = lostBy !== null ? (sim.log.findLast((e) => (e.k === "hp" || e.k === "hit") && e.a === "player" && e.b !== "")?.b ?? "") : "";
  const lostTo = sim.entity(blow)?.carrier || blow;
  trace?.(`end ${sim.result ?? "none"}${lostBy ? ` (${lostBy})` : ""} at ${v1(sim.pos("player"))} t=${sim.tick}`);
  const won = sim.result === "win";
  const out = { won, ticks: sim.tick, stuck, lostBy, stuckAt: sim.result ? null : stuckAt, lostTo, stuckOn: sim.result ? "" : stuckOn, trail, ghost: won ? ghost.finish(sim) : null };
  sim.free();
  return out;
}

/** Why runs didn't win, counted: "8 lost (hit the lava ×6, the timer ran out ×2), 4 got stuck". */
function endings(b: WorldBundle, results: readonly RunResult[]): string {
  const lost = new Map<string, number>();
  // (a fight lost is told by who: "knocked out by archer_west ×8")
  const fight = (r: RunResult) => {
    const w = b.rules.find((x) => x.id === r.lostBy)?.when;
    return r.lostTo && w && (w.t === "health_lte" || (w.t === "hit" && b.entities.some((e) => e.id === w.b && e.kind === "npc"))) ? ` by ${r.lostTo}` : "";
  };
  for (const r of results) if (r.lostBy !== null) lost.set(`${r.lostBy}${fight(r)}`, (lost.get(`${r.lostBy}${fight(r)}`) ?? 0) + 1);
  const words = (key: string) => {
    const [id, by = ""] = key.split(" by ");
    const w = b.rules.find((x) => x.id === id)?.when;
    const name = (x: string) => b.entities.find((e) => e.id === x)?.noun || x.replace(/_/g, " ");
    if (!w) return id || "a loss rule";
    if (by) return `${w.t === "hit" ? "shot" : "knocked out"} by ${by}`;
    if (w.t === "health_lte") return w.a === "player" || w.a.startsWith("team:") ? "knocked out" : `${name(w.a)} down`;
    return w.t === "hit" ? `hit the ${name(w.b)}` : w.t === "timer_end" ? "the timer ran out" : w.t === "score_gte" ? `${w.a.replace("team:", "")} reached ${w.n}` : w.t === "enter" ? `${name(w.a)} reached the ${name(w.b)}` : `${id}`;
  };
  const nLost = [...lost.values()].reduce((a, x) => a + x, 0);
  // how soon the fights were lost (a fight lost in seconds is the rivals' numbers, not tactics)
  const fast = results.filter((r) => r.lostBy !== null && fight(r)).map((r) => Math.round(r.ticks / 6) / 10).sort((x, y) => x - y);
  const stuckRuns = results.filter((r) => !r.won && r.lostBy === null);
  const ss = surfaces(b);
  const where = new Map<string, number>();
  for (const r of stuckRuns) {
    const z = r.stuckAt && surfaceAt(ss, [r.stuckAt[0], r.stuckAt[1] - 0.8, r.stuckAt[2]])?.zone;
    const name = z ? b.zones.find((x) => x.id === z)?.name || z.replace(/^z_/, "").replace(/_/g, " ") : "";
    if (name) where.set(name, (where.get(name) ?? 0) + 1);
  }
  // (and on what: the step most stuck runs were on)
  const on = new Map<string, number>();
  for (const r of stuckRuns) if (r.stuckOn) on.set(r.stuckOn, (on.get(r.stuckOn) ?? 0) + 1);
  const most = [...on].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1))[0]?.[0];
  const soon = fast.length ? `, after ${fast[0]}${fast.at(-1) !== fast[0] ? `–${fast.at(-1)}` : ""} s` : "";
  const stuckWhere = [...(where.size ? [`in ${[...where].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).map(([n, k]) => `the ${n} ×${k}`).join(", ")}`] : []), ...(most ? [`at '${most}'`] : [])];
  const parts = [];
  if (nLost) parts.push(`${nLost} lost (${[...lost].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1)).map(([id, n]) => `${words(id)} ×${n}`).join(", ")}${soon})`);
  if (stuckRuns.length) parts.push(`${stuckRuns.length} got stuck${stuckWhere.length ? ` (${stuckWhere.join(", ")})` : ""}`);
  return parts.join(", ") || "no run finished";
}

/** Physics check of a "requires jumps>=k" expectation: approach the target's ledge and jump. */
function jumpWitness(R: Rapier, b: WorldBundle, nav: NavWorld, x: Expect, jumps: number, attempt: number, playerTeam: "red" | "blue"): boolean {
  const targets = b.statics.filter((s) => s.zone === x.b);
  if (!targets.length) return false;
  const seg = targets[attempt % targets.length]!;
  const top = seg.pos[1] + seg.size[1] / 2;
  const faceZ = seg.pos[2] - seg.size[2] / 2;
  const xs = seg.pos[0] + ((attempt % 3) - 1) * seg.size[0] * 0.25;
  const sim = new SimWorld(R, b, { playerTeam, laws: { jumpsMax: jumps } });
  const budget = { ticks: RUN_TICKS };
  walkTo(sim, nav, [xs, 0, faceZ - 0.7], stream(attempt, "t3:jump"), 1, budget, () => false);
  // One attempt: jump, air-jump at each apex, keep pushing toward the face; stop on landing.
  let onTop = false;
  for (let t = 0, end = airTicks(sim.laws, jumps, top); t < end && !onTop; t++) {
    const first = t === 0;
    const again = t > 6 && sim.player.vy <= 0.5 && sim.player.jumpsUsed < jumps && sim.player.jumpsUsed > 0;
    // push toward the face until the feet clear the ledge, then steer to the middle of the top
    const q = sim.pos("player");
    const above = q[1] - 0.9 > top + 0.05;
    const mid = faceZ + seg.size[2] / 2;
    const wz = above ? Math.max(-127, Math.min(127, Math.round((mid - q[2]) * 60))) : 127;
    sim.step({ tick: sim.tick + 1, wx: 0, wz, btn: first || again ? BTN.JUMP : 0 });
    if (again) sim.step({ tick: sim.tick + 1, wx: 0, wz, btn: 0 });
    const p = sim.pos("player");
    const inside = p[0] >= seg.pos[0] - seg.size[0] / 2 && p[0] <= seg.pos[0] + seg.size[0] / 2 && p[2] > faceZ && p[2] <= faceZ + seg.size[2];
    onTop = t > 0 && sim.player.grounded && inside && p[1] - 0.9 > top - 0.05;
    if (t > 0 && sim.player.grounded && !inside && p[1] < 1.5) break; // landed back on the street
  }
  sim.free();
  return onTop;
}

/**
 * Why nobody won, when the jump model can say it for certain: from the spawn, the surfaces the
 * world's jumps can hop between never include the one something the win needs stands on (and
 * nothing could lift the player instead: no jump pad or portal, no navmesh path such as a ramp).
 * The reason names the lowest step up out of reach. Null when the model can't explain it.
 */
function outOfReach(b: WorldBundle, chain: WinChain, playerTeam: "red" | "blue", navw?: NavWorld): string | null {
  if (b.verbs.some((v) => /portal/.test(v.verb))) return null;
  const laws = clampLaws(b.laws);
  const ss = surfaces(b).filter((x) => !b.statics.some((st) => st.id === x.id && st.surf === "wall"));
  const spawn = b.entities.find((e) => e.kind === "spawn" && e.team === playerTeam) ?? b.entities.find((e) => e.kind === "spawn");
  const from = spawn && surfaceAt(ss, [spawn.pos[0], spawn.pos[1] + 0.2, spawn.pos[2]]);
  if (!from) return null;
  const reached = new Set([from.id]);
  for (const queue = [from]; queue.length; ) {
    const s0 = queue.shift()!;
    for (const n of ss) if (!reached.has(n.id) && hopOk(s0, n, laws, laws.jumpsMax)) (reached.add(n.id), queue.push(n));
  }
  const mid = (x: Surface): Vec3 => [(x.min[0] + x.max[0]) / 2, x.top, (x.min[1] + x.max[1]) / 2];
  const ids = chain.steps.flatMap((st) => (st.do === "pickup" ? [st.item] : st.do === "deliver" ? [st.sensor] : st.do === "use" || st.do === "touch" ? [st.at] : st.do === "collect" ? st.items : []));
  for (const id of ids) {
    const e = b.entities.find((x) => x.id === id);
    const t = e && surfaceAt(ss, [e.pos[0], e.pos[1] + 0.1, e.pos[2]]);
    if (!e || !t || reached.has(t.id) || navw?.path(mid(from), mid(t))) continue;
    // the lowest step up from anywhere reachable onto a neighbouring surface that isn't
    let step = Infinity;
    for (const a of ss) if (reached.has(a.id)) for (const n of ss) if (!reached.has(n.id) && n.top > a.top && gap(a, n) < 1) step = Math.min(step, n.top - a.top);
    const jumps = `${laws.jumpsMax} jump${laws.jumpsMax === 1 ? "" : "s"}`;
    const name = `the ${e.noun || e.id.replace(/_/g, " ")}`;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    return Number.isFinite(step) ? `no route reaches ${name}: a ${r1(step)} m step on the way, and ${jumps} reach${laws.jumpsMax === 1 ? "es" : ""} ${r1(apex(laws, laws.jumpsMax))} m` : `no route with ${jumps} reaches ${name} (jump model)`;
  }
  return null;
}

export interface T3Out {
  chips: Chip[];
  par: { goldS: number; runs: number; won: number } | null;
  trails: Trail[];
  /** The par runner's run, for racing it (null when no runner won). */
  ghost: Ghost | null;
}

export function t3(R: Rapier, b: WorldBundle, nav: NavWorld, chain: WinChain | null, runs: number, playerTeam: "red" | "blue" = "red", openers: ReadonlyMap<string, PlanStep[]> = new Map()): T3Out {
  leap = leapFor(b);
  try {
    return t3Runs(R, b, nav, chain, runs, playerTeam, openers);
  } finally {
    leap?.free();
    leap = null;
    freeShut();
  }
}

function t3Runs(R: Rapier, b: WorldBundle, nav: NavWorld, chain: WinChain | null, runs: number, playerTeam: "red" | "blue", openers: ReadonlyMap<string, PlanStep[]>): T3Out {
  const chips: Chip[] = [];
  let par: { goldS: number; runs: number; won: number } | null = null;
  let trails: Trail[] = [];
  let ghost: Ghost | null = null;
  if (chain && b.mode === "play") {
    const t0 = globalThis.performance?.now?.() ?? 0;
    const results = Array.from({ length: runs }, (_, i) => witnessRun(R, b, nav, chain, openers, b.seed * 1000 + i, playerTeam));
    const bots = b.entities.filter((e) => e.kind === "npc" && e.body !== "none" && e.body !== "sensor").length;
    const vs = bots ? ` vs ${bots} bot${bots > 1 ? "s" : ""}` : "";
    const won = results.filter((r) => r.won);
    trails = results.map((r) => ({ won: r.won, xyz: r.trail }));
    const gold = won.length ? Math.min(...won.map((r) => r.ticks)) / 60 : 0;
    par = won.length ? { goldS: Math.round(gold * 10) / 10, runs, won: won.length } : null;
    // the par runner itself (the first of equals) is the one a player races
    ghost = won.find((r) => r.ticks / 60 === gold)?.ghost ?? null;
    chips.push({
      id: "T3:win",
      tier: "T3",
      subject: { kind: "property", id: "win_reachable" },
      status: won.length ? "played" : "counterexample",
      method: `physics, ${runs} AI runners${vs}`,
      n: runs,
      k: won.length,
      text: won.length ? `AI runners won by playing it${vs} (AI par ${par!.goldS} s)` : `no AI runner could win${vs}`,
      cx: won.length ? null : { where: null, have: 0, need: 1, unit: "wins", text: [endings(b, results), outOfReach(b, chain, playerTeam, nav)].filter(Boolean).join(": ") },
      src: "",
      ms: Math.round((globalThis.performance?.now?.() ?? 0) - t0),
    });
    // the envelope: minds may switch an NPC to any option on its typed menu at any time; lock the
    // whole cast to each option index in turn and check runners still win
    const minded = b.cast.filter((c) => c.menu.length > 1 && b.entities.some((e) => e.id === c.npc));
    if (minded.length) {
      const t1 = globalThis.performance?.now?.() ?? 0;
      const width = Math.max(...minded.map((c) => c.menu.length));
      const schedules = Array.from({ length: width }, (_, j) => minded.map((c) => [c.npc, c.menu[j] ?? c.dflt] as const));
      const per = 3;
      const outcomes = schedules.map((sch, j) => Array.from({ length: per }, (_, i) => witnessRun(R, b, nav, chain, openers, b.seed * 1000 + 500 + j * per + i, playerTeam, sch)).filter((x) => x.won).length);
      const k = outcomes.reduce((a, x) => a + x, 0);
      const worst = outcomes.indexOf(0);
      chips.push({
        id: "T3:envelope", tier: "T3", subject: { kind: "property", id: "win_reachable" }, status: worst < 0 ? "played" : "counterexample",
        method: `physics, ${schedules.length} menu schedules × ${per} runners`, n: schedules.length * per, k,
        text: worst < 0 ? `runners still win whatever the cast's minds choose (${schedules.length} schedules)` : "a choice the cast's minds can make stops every runner",
        cx: worst < 0 ? null : { where: null, have: 0, need: 1, unit: "wins", text: `if ${schedules[worst]!.map(([n, o]) => `${n} plays ${o}`).join(", ")}, no runner wins` },
        src: "", ms: Math.round((globalThis.performance?.now?.() ?? 0) - t1),
      });
    }
    // a win in under 3 s is over before it starts: honest, but barely a game
    if (par && par.goldS < TOO_EASY_S) {
      chips.push({
        id: "T3:too_easy", tier: "T3", subject: { kind: "property", id: "win_reachable" }, status: "counterexample", method: `physics, ${runs} AI runners`,
        n: runs, k: won.length, text: `won in ${par.goldS} s: over almost before it starts`,
        cx: { where: null, have: par.goldS, need: TOO_EASY_S, unit: "s", text: `AI par ${par.goldS} s < ${TOO_EASY_S} s` }, src: "", ms: 0,
      });
    }
  }
  for (const x of b.expects.filter((e) => e.prop === "requires")) {
    const m = x.need.map((n) => /^jumps>=(\d+)$/.exec(n.replace(/\s/g, ""))).find(Boolean);
    if (!m) continue;
    const k = Number(m[1]);
    const t0 = globalThis.performance?.now?.() ?? 0;
    const n = 4;
    const withK = Array.from({ length: n }, (_, i) => jumpWitness(R, b, nav, x, k, i, playerTeam)).filter(Boolean).length;
    const withFewer = Array.from({ length: n }, (_, i) => jumpWitness(R, b, nav, x, k - 1, i, playerTeam)).filter(Boolean).length;
    const good = withK > 0 && withFewer === 0;
    chips.push({
      id: `T3:${x.id}`,
      tier: "T3",
      subject: { kind: "property", id: x.id },
      status: good ? "played" : "counterexample",
      method: `physics jump witness, ${n} attempts per jump count`,
      n,
      k: withK,
      text: `${x.text || x.id}: reached with ${k} jumps ${withK} of ${n}, with ${k - 1} ${withFewer} of ${n}`,
      cx: good ? null : { where: null, have: withFewer, need: 0, unit: "attempts", text: withK === 0 ? `never reached with ${k} jumps` : `reached with only ${k - 1} jump(s)` },
      src: x.src === "user" ? "user" : x.src,
      ms: Math.round((globalThis.performance?.now?.() ?? 0) - t0),
    });
  }
  return { chips, par, trails, ghost };
}

/**
 * The tour, for places to explore: an AI visitor walks to everything that can be used or
 * inspected, nearest first, and uses it. Played, k of n reached; anything it can't reach is the
 * counterexample (a sealed room, an exhibit inside a wall).
 */
export function tour(R: Rapier, b: WorldBundle, nav: NavWorld, openers: ReadonlyMap<string, PlanStep[]> = new Map()): Chip | null {
  leap = leapFor(b);
  try {
    return tourRun(R, b, nav, openers);
  } finally {
    leap?.free();
    leap = null;
    freeShut();
  }
}

function tourRun(R: Rapier, b: WorldBundle, nav: NavWorld, openers: ReadonlyMap<string, PlanStep[]>): Chip | null {
  // what a visitor can always use: exhibits and switches (a lock needs its key, so it isn't a sight)
  const sights = [...new Set(b.verbs.filter((v) => (v.verb === "social.inspect" || v.verb === "puzzle.switch") && b.entities.some((e) => e.id === v.on)).map((v) => v.on))].sort();
  if (!sights.length) return null;
  const t0 = globalThis.performance?.now?.() ?? 0;
  const sim = new SimWorld(R, b, { brain: castBrain(nav, b) });
  // a visitor opens the doors on the way, as runners do
  const r: Run = { sim, nav, b, rng: stream(b.seed, "t3:tour"), speed: 0.9, budget: { ticks: RUN_TICKS * 2 }, openers, opened: new Set() };
  const seen = new Set<string>();
  const used = () => {
    for (const e of sim.log) if (e.k === "touch" && e.a === "player") seen.add(e.b);
  };
  // nearest first; a second pass for anything missed (a door opened on the way, a better angle)
  for (let pass = 0; pass < 2; pass++) {
    const left = new Set(sights.filter((x) => !seen.has(x)));
    while (left.size && live(r)) {
      const p = sim.pos("player");
      const next = [...left].sort((x, y) => d2h(sim.pos(x), p) - d2h(sim.pos(y), p) || (x < y ? -1 : 1))[0]!;
      left.delete(next);
      if (seen.has(next)) continue;
      dropDown(sim, b, sim.pos(next), r.budget); // perched on something: come down first
      const spot = spotBy(r, next);
      clearDoors(r, spot);
      goTo(sim, nav, b, spot, r.rng, r.speed, r.budget, () => sim.usable()?.on === next);
      if (sim.usable()?.on !== next) faceTo(r, next);
      if (sim.usable()?.on !== next) closeIn(r, next);
      trace?.(`tour ${next}: at ${v1(sim.pos("player"))}, usable ${sim.usable()?.on ?? "-"}`);
      if (sim.usable()?.on === next) {
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.USE });
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: 0 });
      }
      used();
    }
  }
  sim.free();
  const k = sights.filter((s) => seen.has(s)).length;
  const missed = sights.filter((s) => !seen.has(s));
  return {
    id: "T3:tour", tier: "T3", subject: { kind: "property", id: "tour" }, status: k === sights.length ? "played" : "counterexample",
    method: "physics, an AI visitor walks to and uses each", n: sights.length, k,
    text: `walked to and inspected ${k} of ${sights.length} things`,
    cx: missed.length ? { where: null, have: k, need: sights.length, unit: "things", text: `couldn't reach ${missed.slice(0, 4).join(", ")}${missed.length > 4 ? "…" : ""}` } : null,
    src: "", ms: Math.round((globalThis.performance?.now?.() ?? 0) - t0),
  };
}
