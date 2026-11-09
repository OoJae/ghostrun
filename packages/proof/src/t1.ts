// T1, kinematic: reachability over the surfaces of the level using the movement law's jump
// abstraction (k jumps lift the feet k × jumpH), with analytic counterexamples
// ("apex 1.6 m < ledge 2.6 m").
import type { Expect, Laws, Rule, Vec3, WorldBundle } from "@ghostrun/ir";
import { DRIVE, feelOf, flightOf, MUZZLE_UP, segBox, TRACK, verb, watersOf } from "@ghostrun/kits";
import { flyReach, swimReach } from "./moves";
import { clampParams } from "@ghostrun/plugin-api";
import { hitPoints, playerWeapons } from "./t0";
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
/**
 * From a pad: anything within its launch height, and as far as you can drift while you fall. A
 * pad throws you straight up, so the drift is steered in the air (air control), not carried over
 * from a run-up like a jump's.
 */
function launchReach(s: Surface, t: Surface, laws: Laws, margin = 0): boolean {
  const g = 9.81 * Math.max(0.05, laws.gravityScale);
  const H = s.launch! * (1 - EULER_LOSS);
  const rise = t.top - s.top;
  if (rise > H - margin + 1e-9) return false;
  const v = Math.sqrt(2 * g * H);
  const time = (v + Math.sqrt(v * v - 2 * g * rise)) / g;
  return gap(s, t) <= laws.speed * Math.max(0.2, laws.airControl) * time * 0.85;
}

export function hopOk(s: Surface, t: Surface, laws: Laws, jumps: number, margin = 0): boolean {
  if (s.launch) return launchReach(s, t, laws, margin);
  const rise = t.top - s.top;
  // a step the character controller walks up (autostep 0.4 m) needs no jump, touching edge to edge
  if (rise <= 0.4 && rise > -0.41 && gap(s, t) <= 0.01) return true;
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

/** What a surface is, in the receipt's words: the thing it is the top of, else a ledge. */
function nounOf(b: WorldBundle, id: string): string {
  const e = b.entities.find((x) => x.id === id);
  if (e) return `the ${e.noun ?? e.id}`;
  const st = b.statics.find((x) => x.id === id);
  return st?.surf === "roof" ? "a roof" : "a ledge";
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
        // the way up with fewer jumps: often not one step but a climb over things on the way (a
        // crate, a kiosk roof), so say what it climbs and its highest single step, never the
        // straight rise from the ground (which can be higher than the jump)
        const fewer = { ...laws, jumpsMax: k - 1 };
        const goal = targets.find((t) => withFewer.has(t.id))!;
        const way = route(ss, start, goal, fewer, 0);
        const steps = way ? way.slice(1).map((t, i) => t.top - way[i]!.top) : [];
        const highest = steps.length ? Math.max(...steps) : lowestStep;
        const over = (way ?? []).slice(1, -1).filter((t) => t.top > start.top + 0.41);
        const named = [...new Set(over.map((t) => nounOf(b, t.id)))].slice(0, 2);
        const via = named.length ? ` by way of ${named.join(" and ")}` : "";
        const n = `${k - 1} jump${k - 1 === 1 ? "" : "s"}`;
        chips.push({ ...base, status: "counterexample", text: label(x), cx: { where: null, have: round(apex(laws, k - 1)), need: round(highest), unit: "m", text: `reachable with ${n}${via}: highest step ${round(highest)} m, apex ${round(apex(laws, k - 1))} m` } });
      }
    } else {
      // a world that flies is reached by the flight model (walking, dropping and flying within the fuel)
      // (and one with water by the dive model too: down within a breath)
      const fl = flightOf({ verbs: b.verbs, laws });
      const ws = watersOf(b);
      const set = ws.length ? swimReach(ss, start, laws, ws, fl) : fl ? new Set(flyReach(ss, start, fl, laws).keys()) : reachable(ss, start, laws, laws.jumpsMax);
      if (fl) base.method = "kinematic reachability (flight model: thrust-limited straight lines)";
      if (ws.length) base.method = `kinematic reachability (${fl ? "flight" : "jump"} model, and swimming within a breath)`;
      const hit = targets.some((t) => set.has(t.id));
      const good = x.prop === "reachable" ? hit : !hit;
      chips.push({ ...base, status: good ? "verified" : "counterexample", text: label(x), cx: good ? null : { where: null, have: hit ? 1 : 0, need: hit ? 0 : 1, unit: "route", text: hit ? "reachable after all" : "no route found" } });
    }
    chips[chips.length - 1]!.ms = Math.round((globalThis.performance?.now?.() ?? 0) - t0);
  }
  return chips;
}

const STEP = 0.25; // fine enough that a 0.9 m doorway (0.4 m of room for a body's centre) always has a cell in it

/**
 * The ground the player can stand on, as a 0.5 m grid flooded from the spawn: across each surface
 * wherever there is room to stand (a wall or solid prop in the way stops it; doors don't, they
 * open), and onto another surface wherever the jump model's hop reaches it from that spot. Feet.
 */
function groundReached(b: WorldBundle, laws: Laws, playerTeam: string, solid: readonly { pos: Vec3; size: Vec3 }[]): Vec3[] {
  const ss = surfaces(b);
  const spawn = b.entities.find((e) => e.kind === "spawn" && e.team === playerTeam) ?? b.entities.find((e) => e.kind === "spawn");
  const start = spawn ? surfaceUnder(ss, [spawn.pos[0], spawn.pos[1] + 0.2, spawn.pos[2]]) : undefined;
  if (!spawn || !start) return [];
  const roomy = (x: number, top: number, z: number) => !solid.some((o) => Math.abs(x - o.pos[0]) < o.size[0] / 2 + 0.25 && Math.abs(z - o.pos[2]) < o.size[2] / 2 + 0.25 && o.pos[1] - o.size[1] / 2 < top + 1.7 && o.pos[1] + o.size[1] / 2 > top + 0.3);
  const grid = ss.map((s) => {
    const nx = Math.max(1, Math.floor((s.max[0] - s.min[0]) / STEP));
    const nz = Math.max(1, Math.floor((s.max[1] - s.min[1]) / STEP));
    return { nx, nz, x0: (s.min[0] + s.max[0]) / 2 - ((nx - 1) * STEP) / 2, z0: (s.min[1] + s.max[1]) / 2 - ((nz - 1) * STEP) / 2, seen: new Uint8Array(nx * nz) };
  });
  const queue: [number, number, number][] = [];
  const visit = (si: number, i: number, j: number) => {
    const g = grid[si]!;
    if (i < 0 || j < 0 || i >= g.nx || j >= g.nz || g.seen[i * g.nz + j]) return;
    g.seen[i * g.nz + j] = 1;
    if (roomy(g.x0 + i * STEP, ss[si]!.top, g.z0 + j * STEP)) queue.push([si, i, j]);
  };
  const cell = (si: number, x: number, z: number): [number, number] => {
    const g = grid[si]!;
    return [Math.min(g.nx - 1, Math.max(0, Math.round((x - g.x0) / STEP))), Math.min(g.nz - 1, Math.max(0, Math.round((z - g.z0) / STEP)))];
  };
  const hops = new Map<number, boolean>();
  const hop = (si: number, ti: number) => {
    const k = si * ss.length + ti;
    let h = hops.get(k);
    if (h === undefined) hops.set(k, (h = hopOk(ss[si]!, ss[ti]!, laws, laws.jumpsMax)));
    return h;
  };
  const s0 = ss.indexOf(start);
  visit(s0, ...cell(s0, spawn.pos[0], spawn.pos[2]));
  const out: Vec3[] = [];
  for (let q = 0; q < queue.length; q++) {
    const [si, i, j] = queue[q]!;
    const s = ss[si]!;
    const g = grid[si]!;
    const [x, z] = [g.x0 + i * STEP, g.z0 + j * STEP];
    out.push([x, s.top, z]);
    visit(si, i + 1, j);
    visit(si, i - 1, j);
    visit(si, i, j + 1);
    visit(si, i, j - 1);
    for (let ti = 0; ti < ss.length; ti++) {
      if (ti === si) continue;
      const t = ss[ti]!;
      const dx = Math.max(0, t.min[0] - x, x - t.max[0]);
      const dz = Math.max(0, t.min[1] - z, z - t.max[1]);
      if (!s.launch && Math.sqrt(dx * dx + dz * dz) > Math.max(STEP + 0.05, reachAt(laws, laws.jumpsMax, t.top - s.top))) continue;
      if (hop(si, ti)) visit(ti, ...cell(ti, x, z));
    }
  }
  return out;
}

/**
 * The range model, for rules won by shooting someone (worn down, or hit): from the ground the jump
 * model reaches from the spawn, sampled every metre, is there a spot with the target's centre
 * within the weapon's range and nothing solid on the line? (Statics and solid props block; doors
 * don't, since they open.) Targets are where they start: one a rule names, or the rivals it means.
 */
export function t1Range(b: WorldBundle, laws: Laws, playerTeam: "red" | "blue" = "red"): Chip[] {
  const weapons = playerWeapons(b);
  if (!weapons.length || b.mode !== "play") return [];
  const hp = hitPoints(b);
  const ents = new Map(b.entities.map((e) => [e.id, e]));
  const shotAt = (r: Rule) => (r.when.t === "health_lte" || r.when.t === "hit") && r.when.a !== "player" && r.when.a !== `team:${playerTeam}`;
  const rules = [...b.rules].filter(shotAt).sort((x, y) => (x.id < y.id ? -1 : 1));
  if (!rules.length) return [];
  const t0 = globalThis.performance?.now?.() ?? 0;
  // where the player can stand: every metre of each surface the jump model reaches, with room overhead
  const solid = [...b.statics, ...b.entities.filter((e) => (e.body === "fixed" || e.body === "kinematic") && e.kind !== "npc" && e.kind !== "door")];
  const muzzles = groundReached(b, laws, playerTeam, solid).map(([x, y, z]): Vec3 => [x, y + 0.95 + MUZZLE_UP, z]);
  if (!muzzles.length) return [];
  const blockers = solid.filter((o) => !("kind" in o) || !b.verbs.some((v) => v.on === o.id && /carry|oscillate|crumble/.test(v.verb)));
  const centre = (id: string): Vec3 => {
    const e = ents.get(id)!;
    return e.kind === "npc" ? [e.pos[0], e.pos[1] - e.size[1] / 2 + 0.95, e.pos[2]] : e.pos;
  };
  const name = (id: string) => `the ${ents.get(id)?.noun || id.replace(/_/g, " ")}`;
  const chips: Chip[] = [];
  for (const r of rules) {
    const w = r.when;
    const ws = weapons.filter((x) => !w.b || x.on === w.b);
    if (!ws.length) continue;
    const range = Math.max(...ws.map((x) => x.range));
    const team = w.a.startsWith("team:") ? w.a.slice(5) : null;
    const targets = (w.a && !team ? [w.a] : b.entities.filter((e) => (e.kind === "npc" && e.body !== "sensor" && e.body !== "none" && e.team !== playerTeam && (!team || e.team === team)) || (!team && ws.some((x) => x.at.includes(e.id)))).map((e) => e.id))
      .filter((id) => ents.has(id) && (w.t !== "health_lte" || hp.has(id)));
    if (!targets.length) continue;
    // per target: the farthest spot in range with a clear line (how much room there is), else why not
    const res = targets.map((id) => {
      const q = centre(id);
      const e = ents.get(id)!;
      // (never from on top of the target itself: a crate-sized core is no place to shoot it from)
      const onIt = (m: Vec3) => e.kind !== "npc" && Math.abs(m[0] - e.pos[0]) <= e.size[0] / 2 && Math.abs(m[2] - e.pos[2]) <= e.size[2] / 2 && m[1] > e.pos[1];
      let near = Infinity;
      let clearAt = -1;
      for (const m of muzzles) {
        if (onIt(m)) continue;
        const d = Math.sqrt((m[0] - q[0]) * (m[0] - q[0]) + (m[1] - q[1]) * (m[1] - q[1]) + (m[2] - q[2]) * (m[2] - q[2]));
        if (d < near) near = d;
        if (d > range || d <= clearAt) continue;
        if (!blockers.some((o) => o !== ents.get(id) && segBox(m, q, o.pos, o.size) >= 0)) clearAt = d;
      }
      return { id, near, clearAt };
    });
    const ok = res.filter((x) => x.clearAt >= 0);
    const base: Omit<Chip, "status" | "text" | "cx"> = { id: `T1:range:${r.id}`, tier: "T1", subject: { kind: "rule", id: r.id }, method: "line-of-sight range model (from ground the jump model reaches)", n: 0, k: 0, src: r.src, ms: 0 };
    const who = targets.length === 1 ? name(targets[0]!) : `${ok.length} of ${targets.length} ${team ? `${team} ` : ""}rivals`;
    if (ok.length) {
      const best = Math.max(...ok.map((x) => x.clearAt));
      chips.push({ ...base, status: "verified", text: `a shot reaches ${who}: clear lines from as far as ${round(best)} m (range ${round(range)} m)`, cx: null });
    } else {
      const far = res.find((x) => x.near > range);
      const id = (far ?? res[0]!).id;
      const text = far ? `the nearest ground you can reach is ${round(far.near)} m from ${name(far.id)}; the shot reaches ${round(range)} m` : `every spot within ${round(range)} m of ${name(id)} is behind cover (no clear line)`;
      chips.push({ ...base, status: "counterexample", text: `a shot reaches ${who}`, cx: { where: centre(id), have: far ? round(far.near) : 0, need: round(range), unit: "m", text } });
    }
    chips[chips.length - 1]!.ms = Math.round((globalThis.performance?.now?.() ?? 0) - t0);
  }
  return chips;
}

/**
 * The drivability model, for a race at the wheel: a vehicle can't jump (jump boosts), so the line
 * and every gate must stand on ground it drives to from the start (steps of 0.4 m at most, drops
 * allowed); each gate's corner must fit the vehicle's turning circle at corner speed (30 % of top
 * speed: the model slows itself for a bend); and when a clock ends the race, the laps the win
 * needs must fit in it even at top speed with every boost (a lap is at least its straight legs).
 */
export function t1Drive(b: WorldBundle, laws: Laws, playerTeam: "red" | "blue" = "red"): Chip[] {
  const track = b.verbs.find((v) => v.verb === TRACK);
  const ents = new Map(b.entities.map((e) => [e.id, e]));
  const line = track && ents.get(track.on);
  const ride = b.verbs.find((v) => v.verb === DRIVE && v.params.driver === "player") ?? b.verbs.find((v) => v.verb === DRIVE);
  if (!track || !line || !ride || b.mode !== "play") return [];
  const t0 = globalThis.performance?.now?.() ?? 0;
  const feel = feelOf(ride.params, clampParams(verb(DRIVE)!.params, ride.params));
  const route = [...String(track.params.gates ?? "").split(",").map((id) => ents.get(id.trim())).filter((e): e is NonNullable<typeof e> => Boolean(e)), line];
  const solid = [...b.statics, ...b.entities.filter((e) => (e.body === "fixed" || e.body === "kinematic") && e.kind !== "npc" && e.kind !== "door" && e.kind !== "vehicle")];
  const ground = groundReached(b, { ...laws, jumpsMax: 0 }, playerTeam, solid);
  const ss = surfaces(b);
  const name = (e: (typeof route)[number]) => `the ${e.noun || e.id.replace(/_/g, " ")}`;
  const base: Omit<Chip, "status" | "text" | "cx"> = { id: `T1:drive:${track.on}`, tier: "T1", subject: { kind: "world", id: track.on }, method: "drivability model (ground a vehicle drives to, turning circle, top speed)", n: 0, k: 0, src: track.src === "user" ? "user" : track.src, ms: 0 };
  const chips: Chip[] = [];
  // 1. on drivable ground
  let why = "";
  for (const g of route) {
    const [lo, hi] = [g.pos[1] - g.size[1] / 2 - 0.5, g.pos[1] + g.size[1] / 2];
    if (ground.some((c) => Math.abs(c[0] - g.pos[0]) <= g.size[0] / 2 && Math.abs(c[2] - g.pos[2]) <= g.size[2] / 2 && c[1] >= lo && c[1] <= hi)) continue;
    const under = surfaceUnder(ss, [g.pos[0], g.pos[1] - g.size[1] / 2 + 0.1, g.pos[2]]);
    const low = Math.min(...ground.filter((c) => Math.abs(c[0] - g.pos[0]) < 6 && Math.abs(c[2] - g.pos[2]) < 6).map((c) => c[1]), Infinity);
    why = under && Number.isFinite(low) && under.top - low > 0.4 ? `${name(g)} stands on a ${round(under.top - low)} m rise: a ${feel.kind} climbs 0.4 m and can't jump` : `no ground a ${feel.kind} can drive reaches ${name(g)}`;
    chips.push({ ...base, status: "counterexample", text: `a ${feel.kind} can drive every gate`, cx: { where: g.pos, have: 0, need: 1, unit: "route", text: why } });
    break;
  }
  // 2. corners, and the length of a lap
  const pts = route.map((e) => e.pos);
  let lap = 0;
  const radius = (0.3 * feel.speed) / feel.turn;
  for (let i = 0; i < pts.length; i++) {
    const [a, g, c] = [pts[(i + pts.length - 1) % pts.length]!, pts[i]!, pts[(i + 1) % pts.length]!];
    const [ix, iz, ox, oz] = [g[0] - a[0], g[2] - a[2], c[0] - g[0], c[2] - g[2]];
    const [li, lo] = [Math.sqrt(ix * ix + iz * iz), Math.sqrt(ox * ox + oz * oz)];
    lap += lo;
    if (why || li < 1e-6 || lo < 1e-6 || pts.length < 3) continue;
    const cos = (ix * ox + iz * oz) / (li * lo);
    const need = cos <= -0.999 ? Infinity : radius * Math.sqrt((1 - cos) / (1 + cos));
    if (need <= Math.min(li, lo) / 2) continue;
    why = `a ${cos < -0.7 ? "hairpin" : "sharp turn"} at ${name(route[i]!)} needs ${Number.isFinite(need) ? round(need) : "a"} m of road at ${round(0.3 * feel.speed)} m/s; the gates each side are ${round(Math.min(li, lo))} m away`;
    chips.push({ ...base, status: "counterexample", text: `a ${feel.kind} can make every corner`, cx: { where: g, have: round(Math.min(li, lo) / 2), need: Number.isFinite(need) ? round(need) : 999, unit: "m", text: why } });
  }
  if (!why) chips.push({ ...base, status: "verified", text: `a ${feel.kind} can drive the line and ${route.length - 1} gate${route.length === 2 ? "" : "s"} on the ground (a lap ≥ ${round(lap)} m, turning circle ${round(radius)} m at corner speed)`, cx: null });
  // 3. the laps the win needs against the clock that ends the race
  // (the shortest clock that ends the race in a loss)
  const clocks = b.rules.filter((r) => r.when.t === "timer_end" && r.then.some((e) => e.e === "lose")).flatMap((r) => b.verbs.filter((v) => v.verb === "puzzle.timer" && v.on === r.when.a)).map((v) => Math.min(600, Math.max(5, Number(v.params.seconds ?? 60) || 60)));
  const seconds = clocks.length ? Math.min(...clocks) : 0;
  for (const r of seconds && lap > 0 ? b.rules : []) {
    if (r.when.t !== "lap_done" || !(r.when.a === "player" || r.when.a === `team:${playerTeam}` || !r.when.a) || !r.then.some((e) => e.e === "win")) continue;
    const laps = Math.max(1, r.when.n);
    const fastest = (laps * lap) / (feel.speed * feel.boost);
    const ok = fastest <= seconds;
    chips.push({
      id: `T1:laps:${r.id}`, tier: "T1", subject: { kind: "rule", id: r.id }, method: "race-time model (laps × the shortest lap ÷ top speed with boost)", n: 0, k: 0, src: r.src === "user" ? "user" : r.src, ms: 0,
      status: ok ? "verified" : "counterexample",
      text: `${laps} lap${laps === 1 ? "" : "s"} fit the ${seconds} s clock`,
      cx: ok ? null : { where: null, have: seconds, need: round(fastest), unit: "s", text: `${laps} laps of ≥ ${round(lap)} m take ≥ ${round(fastest)} s at ${round(feel.speed * feel.boost)} m/s; the clock gives ${seconds} s` },
    });
  }
  for (const c of chips) c.ms = Math.round((globalThis.performance?.now?.() ?? 0) - t0);
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
