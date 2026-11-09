// course: a linear obstacle course for parkour time trials, platformers and obbies.
// Start pad → an opening wall that needs every jump the laws allow → seeded segments (staggered
// gaps, rising steps, narrow beams, a pit over a hazard floor, plus extras) → finish pad, with a
// checkpoint pad between segments. Every hop is sized from the laws with the T1 ballistic model
// (≤ 0.8 × reach, 0.95 × when `harder`), so the course is beatable by construction. Under it lies
// a fall floor inside canyon walls, with stairs back up to the start: a missed jump costs time,
// never a softlock.
import { stream } from "@ghostrun/detmath";
import { clampLaws, type Laws, type Vec3 } from "@ghostrun/ir";
import type { LayoutPack, LayoutParamSpec, PackLayout, PackStatic, ZoneSpec } from "@ghostrun/plugin-api";

export interface CourseParams {
  [k: string]: number;
  segments: number; // 6–8 including the opening wall (a fill binds at most 8 zones)
}

export type SegmentKind = "ledge" | "gaps" | "steps" | "beam" | "pit";

// ---- the T1 ballistic model (mirrors packages/proof/src/t1.ts; the tests pin the two together) --
const EULER_LOSS = 0.06;

/** Feet height `jumps` chained jumps reach (each taken at the previous apex). */
export function apex(laws: Laws, jumps: number): number {
  return jumps * laws.jumpH * (1 - EULER_LOSS);
}

/** Horizontal distance covered while ending `rise` metres higher (−1 if out of reach). */
export function reachAt(laws: Laws, jumps: number, rise: number): number {
  if (jumps <= 0) return rise <= 0 ? laws.speed * 0.25 : -1;
  const g = 9.81 * Math.max(0.05, laws.gravityScale);
  const H = laws.jumpH * (1 - EULER_LOSS);
  const v = Math.sqrt(2 * g * H);
  const disc = v * v + 2 * g * ((jumps - 1) * H - rise);
  if (disc < 0) return -1;
  const t = ((jumps - 1) * v) / g + (v + Math.sqrt(disc)) / g;
  return laws.speed * t * 0.85;
}

/** T1 walks any rise under 0.41 m (touching footprints only), so every jumped hop rises or drops this much. */
export const MIN_HOP = 0.5;
/** A walkable riser: under the controller's 0.4 m autostep and the navmesh's 0.4 m climb. */
export const STEP = 0.3;
/** Share of the ballistic reach a gap may use; `harder` relaxes it. */
export const GAP_FRACTION = 0.8;
export const GAP_FRACTION_HARDER = 0.95;
const MAX_GAP = 10; // absolute cap: low-gravity laws give absurd ballistic reach

/** Do these laws jump clearly higher than a walkable step? (If not, the course becomes a walk.) */
export function canJump(laws: Laws): boolean {
  return laws.jumpsMax >= 1 && apex(laws, 1) >= MIN_HOP + 0.2;
}

/** A rise that needs exactly `n` jumps: 55 % of the way from what n − 1 jumps reach to what n do. */
export function needRise(laws: Laws, n: number): number {
  if (n <= 0) return STEP;
  const lo = n === 1 ? MIN_HOP : apex(laws, n - 1);
  return Math.round((lo + 0.55 * (apex(laws, n) - lo)) * 10) / 10;
}

/**
 * The law-independent plan. Segment kinds and piece counts depend on the seed alone, so the slots,
 * tags and anchors an LLM fills against stay the same when the fill changes the laws (the edge
 * shows the LLM a layout made with default laws; the client regenerates it with the fill's).
 * The opening wall comes first, so a "needs double jump" claim on it can be witnessed from the
 * start pad; every other kind appears at least once.
 */
export function planCourse(seed: number, segments: number): { kinds: SegmentKind[]; pieces: number[] } {
  const rng = stream(seed, "pack:course:plan");
  const pool: SegmentKind[] = ["gaps", "steps", "beam", "pit"];
  const bag = [...pool];
  while (bag.length < segments - 1) bag.push(pool[Math.floor(rng() * pool.length)]!);
  const kinds: SegmentKind[] = ["ledge"];
  while (bag.length) {
    // no kind twice in a row: a kind holding half of what's left must go now, else pick at random
    const prev = kinds[kinds.length - 1];
    const fresh = bag.filter((x) => x !== prev);
    const from = fresh.length ? fresh : bag;
    const count = (x: SegmentKind) => bag.filter((y) => y === x).length;
    const crowded = from.find((x) => count(x) > 1 && count(x) * 2 >= bag.length);
    const pick = crowded ?? from[Math.floor(rng() * from.length)]!;
    bag.splice(bag.indexOf(pick), 1);
    kinds.push(pick);
  }
  const pieces = kinds.map((kd) => (kd === "gaps" ? 2 + Math.floor(rng() * 2) : kd === "steps" ? 3 + Math.floor(rng() * 2) : kd === "beam" ? 1 + Math.floor(rng() * 2) : 1));
  return { kinds, pieces };
}

const W = 8; // start pad, opening wall and finish pad width
const PAD = 4; // checkpoint pad size
const HALF = 9; // canyon half-width: the fall floor spans x ∈ [−9, 9]
const START_D = 10; // start pad depth (z ∈ [−10, 0])

interface Plat {
  slot: string;
  x: number;
  w: number;
  z0: number;
  z1: number;
  top: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const box = (zoneSlot: string, pos: Vec3, size: Vec3, surf: PackStatic["surf"]): PackStatic => ({ zoneSlot, shape: "box", pos, rotY: 0, size, surf });

/** What a structural edit may change: how many segments (a longer course, a shorter one). */
export const COURSE_SCHEMA: Readonly<Record<string, LayoutParamSpec>> = {
  segments: { min: 6, max: 8, step: 1, label: "course", unit: "segments", line: "segments from start to finish, the opening wall included (each new one is a fresh obstacle)" },
};

export const course: LayoutPack<CourseParams> = {
  id: "course",
  version: "0.1.0",
  modes: ["play", "wander"],
  defaults: { segments: 6 },
  schema: COURSE_SCHEMA,
  ci: { seeds: Array.from({ length: 50 }, (_, i) => i + 1) },

  generate({ seed, params, laws, harder }): PackLayout {
    const L = clampLaws(laws);
    const k = L.jumpsMax;
    const jumping = canJump(L);
    const frac = harder ? GAP_FRACTION_HARDER : GAP_FRACTION;
    const n = Number.isFinite(params.segments) ? Math.max(6, Math.min(8, Math.round(params.segments))) : 6;
    const { kinds, pieces } = planCourse(seed, n);
    const geo = stream(seed, "pack:course:geo");
    const stepMax = Math.min(1.2, Math.max(MIN_HOP, r2(0.7 * apex(L, 1))));
    const fallDepth = Math.max(3, Math.round((apex(L, Math.max(1, k)) + 1.5) * 10) / 10);
    const fallY = -fallDepth;
    const gapFor = (rise: number, f: number) => (jumping ? Math.min(MAX_GAP, r2(f * frac * reachAt(L, k, rise))) : 0);

    const statics: PackStatic[] = [];
    const zones: ZoneSpec[] = [];
    // Every platform is a pillar down to the fall floor: no underpasses, and every rise is a face.
    const pillar = (p: Plat) =>
      statics.push(box(p.slot, [p.x, (p.top + fallY) / 2, (p.z0 + p.z1) / 2], [p.w, p.top - fallY, p.z1 - p.z0], "ledge"));
    const start: Plat = { slot: "start", x: 0, w: W, z0: -START_D, z1: 0, top: 0 };
    pillar(start);
    let cur = start;
    const hop = (slot: string, rise: number, gap: number, w: number, d: number, x: number): Plat => {
      const p: Plat = { slot, x: r2(x), w: r2(w), z0: cur.z1 + r2(gap), z1: cur.z1 + r2(gap) + r2(d), top: cur.top + r2(rise) };
      pillar(p);
      cur = p;
      return p;
    };
    /** Seeded sideways shift, pulled toward the centre line, that keeps a platform of width w inside the canyon. */
    const lateral = (u: number, w: number, maxShift: number) => {
      const lim = W / 2 - w / 2;
      return Math.max(-lim, Math.min(lim, cur.x * 0.6 + (u - 0.5) * 2 * maxShift));
    };
    const centre = (p: Plat): Vec3 => [r2(p.x), r2(p.top), r2((p.z0 + p.z1) / 2)];

    let gateRise = 0;
    kinds.forEach((kind, idx) => {
      const i = idx + 1;
      const slot = `seg_${i}`;
      const last = i === n;
      const landSlot = last ? "finish" : slot;
      const landW = last ? W : PAD;
      const landD = last ? 6 : PAD;
      const landX = (u: number) => (last ? 0 : lateral(u, PAD, 1.2));
      const anchors: Record<string, Vec3> = {};
      let mid: Plat | null = null;
      const m = pieces[idx]!;
      switch (kind) {
        case "ledge": {
          // the opening wall: flush with the start pad, one face that needs every jump the laws allow
          gateRise = jumping ? needRise(L, k) : STEP;
          hop(slot, gateRise, 0, W, PAD, 0);
          break;
        }
        case "gaps": {
          // stepping platforms staggered ±0.5 m (T1 never jumps a level gap), then the pad
          for (let p = 0; p <= m; p++) {
            const [ug, uw, ud, ux] = [geo(), geo(), geo(), geo()];
            const rise = jumping ? (p % 2 === 0 ? MIN_HOP : -MIN_HOP) : 0;
            const gap = gapFor(rise, 0.45 + 0.4 * ug);
            if (p < m) {
              const w = 2.6 + 0.8 * uw;
              const pl = hop(slot, rise, gap, w, 2 + 0.6 * ud, lateral(ux, w, 1));
              if (p === Math.floor((m - 1) / 2)) mid = pl;
            } else hop(landSlot, rise, gap, landW, landD, landX(ux));
          }
          break;
        }
        case "steps": {
          // rising blocks, each a single jump up with a short gap, the pad on top
          for (let p = 0; p <= m; p++) {
            const [ur, ug, uw, ud, ux] = [geo(), geo(), geo(), geo(), geo()];
            const rise = jumping ? MIN_HOP + (stepMax - MIN_HOP) * ur : STEP;
            const gap = gapFor(rise, 0.1 + 0.35 * ug);
            if (p < m) {
              const w = 2.4 + 0.8 * uw;
              const pl = hop(slot, rise, gap, w, 1.8 + 0.5 * ud, lateral(ux, w, 0.8));
              if (p === Math.floor((m - 1) / 2)) mid = pl;
            } else hop(landSlot, rise, gap, landW, landD, landX(ux));
          }
          break;
        }
        case "beam": {
          // narrow beams flush with the pads, an island between two of them
          for (let p = 0; p < m; p++) {
            const [uw, ul, ux] = [geo(), geo(), geo()];
            const bw = 0.5 + 0.3 * uw;
            const room = cur.w / 2 - Math.max(0.6, bw / 2 + 0.3);
            const beam = hop(slot, 0, 0, bw, 5 + 3 * ul, Math.max(-(W / 2 - bw / 2), Math.min(W / 2 - bw / 2, cur.x + (ux - 0.5) * 2 * room)));
            if (p < m - 1) mid = hop(slot, 0, 0, 2.2, 2.2, beam.x);
            else if (!mid) mid = beam;
          }
          const ux = geo();
          hop(landSlot, 0, 0, landW, landD, last ? 0 : Math.max(-2, Math.min(2, cur.x + (ux - 0.5) * 2.4)));
          break;
        }
        case "pit": {
          // a diving board flush with the pad, then one long hop over a hazard floor (anchor pit_i
          // for a lose sensor); the board also gives the segment a surface of its own
          const [ug, ux, uw] = [geo(), geo(), geo()];
          const bw = 1.6 + 0.6 * uw;
          mid = hop(slot, 0, 0, bw, 2.5, Math.max(-(W / 2 - bw / 2), Math.min(W / 2 - bw / 2, cur.x)));
          const from = cur;
          const z0 = cur.z1;
          if (jumping) hop(landSlot, MIN_HOP, gapFor(MIN_HOP, 0.7 + 0.25 * ug), landW, landD, landX(ux));
          else {
            hop(slot, 0, 0, 1, 3, cur.x); // no jump in these laws: a plank across
            hop(landSlot, 0, 0, landW, landD, landX(ux));
          }
          const z1 = cur.z0;
          const x0 = Math.min(from.x - from.w / 2, cur.x - cur.w / 2);
          const x1 = Math.max(from.x + from.w / 2, cur.x + cur.w / 2);
          const zm = jumping ? (z0 + z1) / 2 : z0 + 1.5;
          statics.push(box(slot, [(x0 + x1) / 2, fallY + 0.1, (z0 + z1) / 2], [x1 - x0, 0.2, z1 - z0], "hazard"));
          anchors[`pit_${i}`] = [r2(jumping ? (x0 + x1) / 2 : from.x + 2.2 * (from.x > 0 ? -1 : 1)), r2(fallY + 0.2), r2(zm)];
          break;
        }
      }
      const land = cur;
      if (!last) anchors[`cp_${i}`] = centre(land);
      // a collectible mid-segment (the opening wall has none: it sits beside that checkpoint)
      const c = centre(mid ?? land);
      anchors[`pickup_${i}`] = mid ? c : [r2(c[0] - 2.5), c[1], c[2]];
      // bounds = the segment's landing pad, so anything placed without an anchor stands on it
      zones.push({
        slot,
        tag: kind,
        bounds: { min: [land.x - land.w / 2, land.top, land.z0], max: [land.x + land.w / 2, land.top + 3, land.z1] },
        floorY: land.top,
        anchors,
      });
      if (last) {
        const c = centre(land);
        zones.push({
          slot: "finish",
          tag: "finish",
          bounds: { min: [land.x - land.w / 2, land.top, land.z0], max: [land.x + land.w / 2, land.top + 3, land.z1] },
          floorY: land.top,
          anchors: { goal: c, host: [r2(c[0] - 2.6), c[1], r2(c[2] + 1.6)], trophy: [r2(c[0] + 2.6), c[1], r2(c[2] + 1.6)] },
        });
      }
    });

    const zEnd = cur.z1;
    const maxTop = Math.max(...statics.filter((s) => s.surf === "ledge").map((s) => s.pos[1] + s.size[1] / 2));

    // stairs from the fall floor back up to the start pad, behind it
    const nS = Math.floor((fallDepth - 0.01) / STEP);
    for (let s = 1; s <= nS; s++) {
      const top = -STEP * s;
      statics.push(box("start", [0, (top + fallY) / 2, -START_D - 0.6 * s + 0.3], [3, top - fallY, 0.6], "ledge"));
    }
    const zBack = -START_D - 0.6 * nS - 3;
    statics.push(box("start", [0, fallY - 0.5, (zBack + zEnd + 3) / 2], [2 * HALF, 1, zEnd + 3 - zBack], "floor"));
    // canyon walls whose tops no jump reaches: nothing leaves the course but the stairs
    const wallTop = maxTop + apex(L, Math.max(1, k)) + 1;
    const wallH = wallTop - fallY;
    const len = zEnd + 3 - zBack;
    for (const sx of [-1, 1]) statics.push(box("start", [sx * (HALF + 0.5), (wallTop + fallY) / 2, (zBack + zEnd + 3) / 2], [1, wallH, len + 2], "wall"));
    statics.push(box("start", [0, (wallTop + fallY) / 2, zBack - 0.5], [2 * HALF, wallH, 1], "wall"));
    statics.push(box("start", [0, (wallTop + fallY) / 2, zEnd + 3.5], [2 * HALF, wallH, 1], "wall"));

    zones.unshift({
      slot: "start",
      tag: "start",
      bounds: { min: [-W / 2, 0, -START_D], max: [W / 2, 3, 0] },
      floorY: 0,
      anchors: {
        spawn_pad: [0, 0, -4.5],
        spawn_alt: [2.5, 0, -4.5],
        host: [-2.5, 0, -7.5],
        sign: [2.5, 0, -8],
        fall: [-HALF + 2.5, fallY, r2((zEnd - START_D) / 2)],
      },
    });

    return {
      packId: this.id,
      version: this.version,
      zones,
      statics,
      maxProp: 1.2,
      cameraBounds: { min: [-HALF, fallY, zBack], max: [HALF, maxTop + 6, zEnd + 3] },
      // a race loop on the canyon floor: up the east side of the platforms (every pillar stands
      // within 4 m of the centre line, the canyon walls 9 m out), round behind the finish, back
      // down the west side and round behind the stairs
      track: {
        points: [[6.5, fallY, r2((zEnd - START_D) / 2)], [6.5, fallY, r2(zEnd + 1.5)], [-6.5, fallY, r2(zEnd + 1.5)], [-6.5, fallY, r2((zEnd - START_D) / 2)], [-6.5, fallY, r2(zBack + 1.5)], [6.5, fallY, r2(zBack + 1.5)]],
        width: 4,
      },
      notes: [
        `course: ${kinds.join(" → ")}, ${Math.round(zEnd)} m to the finish; opening wall ${gateRise} m (${jumping ? `needs ${k} jump${k === 1 ? "" : "s"}` : "a step: these laws barely jump"})`,
        `fall floor ${fallDepth} m down with stairs back to the start${harder ? "; harder: gaps up to 0.95 × reach" : ""}`,
      ],
    };
  },
};
