// T1, kinematic: reachability over the surfaces of the level using the movement law's jump
// abstraction (k jumps lift the feet k × jumpH), with analytic counterexamples
// ("apex 1.6 m < ledge 2.6 m").
import type { Expect, Laws, Vec3, WorldBundle } from "@ghostrun/ir";
import type { Chip } from "./types";

interface Surface {
  id: string;
  zone: string;
  top: number;
  min: [number, number];
  max: [number, number];
}

const EULER_LOSS = 0.06; // fixed-step integration reaches slightly less than the analytic apex

function surfaces(b: WorldBundle): Surface[] {
  return b.statics
    .filter((s) => s.surf === "floor" || s.surf === "ledge" || s.surf === "roof" || s.surf === "wall")
    .map((s) => ({
      id: s.id,
      zone: s.zone,
      top: s.pos[1] + s.size[1] / 2,
      min: [s.pos[0] - s.size[0] / 2, s.pos[2] - s.size[2] / 2] as [number, number],
      max: [s.pos[0] + s.size[0] / 2, s.pos[2] + s.size[2] / 2] as [number, number],
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Horizontal gap between two footprints (0 if they touch or overlap). */
function gap(a: Surface, b: Surface): number {
  const dx = Math.max(0, a.min[0] - b.max[0], b.min[0] - a.max[0]);
  const dz = Math.max(0, a.min[1] - b.max[1], b.min[1] - a.max[1]);
  return Math.sqrt(dx * dx + dz * dz);
}

function surfaceUnder(ss: Surface[], p: Vec3): Surface | undefined {
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

/** BFS over surfaces; returns the set reachable from `start` with `jumps` jumps per hop. */
function reachable(ss: Surface[], start: Surface, laws: Laws, jumps: number): Set<string> {
  const up = apex(laws, jumps);
  const seen = new Set([start.id]);
  const queue = [start];
  while (queue.length) {
    const s = queue.shift()!;
    for (const t of ss) {
      if (seen.has(t.id)) continue;
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
