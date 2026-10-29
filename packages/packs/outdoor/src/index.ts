// outdoor: open terrain for forests, parks, gardens, islands, beaches, campsites and outdoor
// markets. Clear paths join a start clearing (entrance) to a central clearing, two side clearings
// (team bases), a pond with a dock, a grove on a terraced knoll and a camp. Seeded trees, rocks and
// bushes stand off every path and anchor; terraces rise 0.2 m at a time, so all ground is walkable.
// A raised lookout is reachable only by jumping: its first ledge needs every jump the laws allow
// (approached over open ground from the south, where a jump witness can try it) and each gap after
// it is ≤ 0.8 × the T1 ballistic reach (0.95 × when `harder`). The map flips east–west by seed.
import { stream } from "@ghostrun/detmath";
import { clampLaws, type Laws, type Vec3 } from "@ghostrun/ir";
import type { LayoutPack, PackLayout, PackStatic, ZoneSpec } from "@ghostrun/plugin-api";

export interface OutdoorParams {
  [k: string]: number;
  trees: number;
  rocks: number;
  bushes: number;
}

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

/** T1 walks any rise under 0.41 m (touching footprints only), so every jumped hop rises at least this much. */
export const MIN_HOP = 0.5;
/** A walkable riser for laws that can't jump: under the 0.4 m autostep and navmesh climb. */
export const STEP = 0.3;
/** Rise per terrace of the knolls. */
export const TERRACE = 0.2;
export const GAP_FRACTION = 0.8;
export const GAP_FRACTION_HARDER = 0.95;
const MAX_GAP = 3.5; // the lookout sits in a corner; capping only ever makes a hop easier
const ROCK_MAX = 1.2;
const BUSH_MAX = 1;
const H = 26; // half extent: the map is 52 × 52 m

/** Do these laws jump clearly higher than a walkable step? (If not, the lookout becomes stairs.) */
export function canJump(laws: Laws): boolean {
  return laws.jumpsMax >= 1 && apex(laws, 1) >= MIN_HOP + 0.2;
}

/** A rise that needs exactly `n` jumps: 55 % of the way from what n − 1 jumps reach to what n do. */
export function needRise(laws: Laws, n: number): number {
  if (n <= 0) return STEP;
  const lo = n === 1 ? MIN_HOP : apex(laws, n - 1);
  return Math.round((lo + 0.55 * (apex(laws, n) - lo)) * 10) / 10;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const box = (zoneSlot: string, pos: Vec3, size: Vec3, surf: PackStatic["surf"]): PackStatic => ({ zoneSlot, shape: "box", pos, rotY: 0, size, surf });

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
const rect = (ax: number, az: number, bx: number, bz: number): Rect => ({ x0: Math.min(ax, bx), x1: Math.max(ax, bx), z0: Math.min(az, bz), z1: Math.max(az, bz) });
const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, x1: r.x1 + d, z0: r.z0 - d, z1: r.z1 + d });
const hitsRect = (r: Rect, x: number, z: number, rad: number) => x + rad > r.x0 && x - rad < r.x1 && z + rad > r.z0 && z - rad < r.z1;
/** Distance from (x, z) to the segment a–b. */
function segDist(x: number, z: number, a: [number, number], b: [number, number]): number {
  const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / len2)) : 0;
  const [px, pz] = [a[0] + t * dx - x, a[1] + t * dz - z];
  return Math.sqrt(px * px + pz * pz);
}

export const outdoor: LayoutPack<OutdoorParams> = {
  id: "outdoor",
  version: "0.1.0",
  modes: ["play", "wander"],
  defaults: { trees: 44, rocks: 12, bushes: 16 },
  ci: { seeds: Array.from({ length: 50 }, (_, i) => i + 1) },

  generate({ seed, params, laws, harder }): PackLayout {
    const L = clampLaws(laws);
    const k = L.jumpsMax;
    const jumping = canJump(L);
    const frac = harder ? GAP_FRACTION_HARDER : GAP_FRACTION;
    const rng = stream(seed, "pack:outdoor");
    const j = (a: number) => (rng() - 0.5) * 2 * a;
    const s = rng() < 0.5 ? 1 : -1; // grove and lookout on the +s side, pond and knolls on −s
    const statics: PackStatic[] = [];

    // ---- points of interest -----------------------------------------------------------------
    // pond: water sheet, a dock from its south shore
    const [wx, wz] = [r2(-16 * s + j(1)), r2(18 + j(1))];
    const [hx, hz] = [r2(4 + j(0.8)), r2(3 + j(0.4))];
    statics.push(box("pond", [wx, 0.025, wz], [2 * hx, 0.05, 2 * hz], "water"));
    const dockX = r2(wx + 2 * s);
    const [dz0, dz1] = [wz - hz - 0.8, wz - hz + 2.6];
    statics.push(box("pond", [dockX, 0.15, (dz0 + dz1) / 2], [1.6, 0.3, dz1 - dz0], "floor"));

    // grove: a knoll of 2–3 terraces, the grove on its plateau
    const [gx, gz] = [r2(16 * s + j(1)), r2(16 + j(1))];
    const levels = 2 + Math.floor(rng() * 2);
    for (let i = 1; i <= levels; i++) {
      const half = 7 - 1.5 * (i - 1);
      statics.push(box("grove", [gx, (TERRACE * i) / 2, gz], [2 * half, TERRACE * i, 2 * half], "floor"));
    }
    const plateau = 7 - 1.5 * (levels - 1);
    const gTop = r2(TERRACE * levels);

    // lookout: base ledge (every jump), then a middle step and the deck, each a hop east (× s)
    const bx0 = 7.5 + j(0.5);
    const bz0 = r2(-17 + j(0.5));
    const bzc = bz0 + 2;
    const u = [rng(), rng(), rng(), rng()];
    const h1 = jumping ? needRise(L, k) : STEP;
    const stepMax = Math.min(1, Math.max(MIN_HOP, r2(0.6 * apex(L, 1))));
    const d1 = jumping ? r2(MIN_HOP + (stepMax - MIN_HOP) * u[0]!) : STEP;
    const d2 = jumping ? r2(MIN_HOP + (stepMax - MIN_HOP) * u[1]!) : STEP;
    const gapFor = (rise: number, f: number) => (jumping ? Math.min(MAX_GAP, r2((0.2 + 0.25 * f) * frac * reachAt(L, k, rise))) : 0);
    const g1 = gapFor(d1, u[2]!);
    const g2 = gapFor(d2, u[3]!);
    const xs = (a: number, b: number): [number, number] => (s > 0 ? [a, b] : [-b, -a]); // flip an x span
    const pillars: { x: [number, number]; z: [number, number]; top: number }[] = [
      { x: xs(bx0, bx0 + 4), z: [bz0, bz0 + 4], top: h1 },
      { x: xs(bx0 + 4 + g1, bx0 + 6.5 + g1), z: [bzc - 1.25, bzc + 1.25], top: r2(h1 + d1) },
      { x: xs(bx0 + 6.5 + g1 + g2, bx0 + 10 + g1 + g2), z: [bzc - 2, bzc + 2], top: r2(h1 + d1 + d2) },
    ];
    for (const p of pillars) statics.push(box("lookout", [(p.x[0] + p.x[1]) / 2, p.top / 2, (p.z[0] + p.z[1]) / 2], [p.x[1] - p.x[0], p.top, p.z[1] - p.z[0]], "ledge"));
    const mid = (p: (typeof pillars)[number]): Vec3 => [r2((p.x[0] + p.x[1]) / 2), p.top, r2((p.z[0] + p.z[1]) / 2)];
    const deckTop = pillars[2]!.top;
    const lookoutRect: Rect = { x0: Math.min(...pillars.map((p) => p.x[0])), x1: Math.max(...pillars.map((p) => p.x[1])), z0: bzc - 2, z1: bzc + 2 };
    const baseCx = (pillars[0]!.x[0] + pillars[0]!.x[1]) / 2;

    // ---- zones and anchors --------------------------------------------------------------------
    const zones: ZoneSpec[] = [
      { slot: "entrance", tag: "start", bounds: { min: [-6, 0, -25], max: [6, 3, -15] }, floorY: 0,
        anchors: { spawn_pad: [0, 0, -21], gate: [0, 0, -16.5], sign: [-3.5 * s, 0, -17], guide: [-3.5 * s, 0, -22.5] } },
      { slot: "clearing", tag: "hub", bounds: { min: [-7, 0, -6], max: [7, 3, 6] }, floorY: 0,
        anchors: { center: [0, 0, 0], center_n: [0, 0, 3.5], center_s: [0, 0, -3.5], center_e: [3.5, 0, 0], center_w: [-3.5, 0, 0] } },
      { slot: "clearing_w", tag: "base", bounds: { min: [-25, 0, -6], max: [-13, 3, 6] }, floorY: 0,
        anchors: { spawn_pad: [-22.5, 0, 0], goal: [-17.5, 0, 0], flank_n: [-19, 0, 4], flank_s: [-19, 0, -4] } },
      { slot: "clearing_e", tag: "base", bounds: { min: [13, 0, -6], max: [25, 3, 6] }, floorY: 0,
        anchors: { spawn_pad: [22.5, 0, 0], goal: [17.5, 0, 0], flank_n: [19, 0, 4], flank_s: [19, 0, -4] } },
      { slot: "pond", tag: "water", bounds: { min: [Math.min(wx - hx, wx + hx) - 2, 0, wz - hz - 2], max: [Math.max(wx - hx, wx + hx) + 2, 3, wz + hz + 2] }, floorY: 0,
        anchors: { shore: [r2(wx - 1.5 * s), 0, r2(wz - hz - 2)], bank: [r2(wx + (hx + 2) * s), 0, wz], water: [r2(wx - s), 0.05, r2(wz + 0.5)], dock: [dockX, 0.3, r2(wz - hz + 2)] } },
      { slot: "grove", tag: "trees", bounds: { min: [gx - plateau, gTop, gz - plateau], max: [gx + plateau, gTop + 3, gz + plateau] }, floorY: gTop,
        anchors: { heart: [gx, gTop, gz], stump: [r2(gx + 2 * s), gTop, r2(gz + 2)], hollow: [r2(gx - 2 * s), gTop, r2(gz + 1.5)], roots: [r2(gx + 1.5 * s), gTop, r2(gz - 2.2)] } },
      { slot: "camp", tag: "camp", bounds: { min: [-6, 0, 13], max: [6, 3, 25] }, floorY: 0,
        anchors: { fire: [0, 0, 19.5], goal: [0, 0, 15.5], tent: [-3.5, 0, 22.5], stall_1: [3.5, 0, 22.5], stall_2: [3.5, 0, 16.5], stall_3: [-3.5, 0, 16.5] } },
      { slot: "lookout", tag: "high_ground", bounds: { min: [pillars[2]!.x[0], deckTop, pillars[2]!.z[0]], max: [pillars[2]!.x[1], deckTop + 3, pillars[2]!.z[1]] }, floorY: deckTop,
        anchors: { ledge: mid(pillars[0]!), mid: mid(pillars[1]!), top: mid(pillars[2]!) } },
    ];

    // ---- path network (thin floor strips; corridors around them stay clear) -------------------
    const northW = -12 * s;
    const northE = 9 * s;
    // Each zone owns a walkable static, so T1 can answer "is <zone> reachable?" for any of them.
    const strips: [string, Rect][] = [
      ["clearing", rect(-1.5, -19, 1.5, 14)], // entrance → clearing → camp
      ["clearing_w", rect(-22.5, -1.5, -7, 1.5)], // west base ↔ clearing ↔ east base
      ["clearing", rect(-7, -1.5, 7, 1.5)],
      ["clearing_e", rect(7, -1.5, 22.5, 1.5)],
      ["camp", rect(northW, 8.5, northE, 11.5)], // pond ↔ trunk ↔ grove knoll
      ["entrance", rect(1.5 * s, -22.5, 10 * s, -19.5)], // entrance → lookout foot
    ];
    for (const [slot, r] of strips) statics.push(box(slot, [(r.x0 + r.x1) / 2, 0.005, (r.z0 + r.z1) / 2], [r.x1 - r.x0, 0.03, r.z1 - r.z0], "floor"));
    const pondBank = zones[4]!.anchors.bank!;
    const corridors: [[number, number], [number, number]][] = [
      [[0, -21], [0, 19.5]],
      [[-22.5, 0], [22.5, 0]],
      [[northW, 10], [northE, 10]],
      [[northW, 10], [pondBank[0], pondBank[2]]],
      [[northE, 10], [gx, gz]],
      [[0, -21], [10 * s, -21]],
      [[10 * s, -21], [baseCx, bz0 - 1]],
    ];

    // ---- keep-outs --------------------------------------------------------------------------
    const anchorPts = zones.flatMap((z) => Object.values(z.anchors));
    const zoneRects = zones.filter((z) => z.slot !== "pond" && z.slot !== "lookout").map((z) => grow({ x0: z.bounds.min[0], x1: z.bounds.max[0], z0: z.bounds.min[2], z1: z.bounds.max[2] }, 1));
    const waterRect = grow(rect(wx - hx, wz - hz, wx + hx, wz + hz), 2);
    const dockRect = grow(rect(dockX - 0.8, dz0, dockX + 0.8, dz1), 1);
    // no rock, bush or knoll a (k−1)-jump route could use to reach the lookout
    const clear = k >= 2 ? Math.max(3, reachAt(L, k - 1, h1 - ROCK_MAX) + 1) : 3;
    const openGround = (x: number, z: number, rad: number, lookoutClear: number) =>
      Math.abs(x) + rad < H - 0.5 && Math.abs(z) + rad < H - 0.5 &&
      !anchorPts.some((a) => (a[0] - x) * (a[0] - x) + (a[2] - z) * (a[2] - z) < (2.5 + rad) * (2.5 + rad)) &&
      !corridors.some(([a, b]) => segDist(x, z, a, b) < 3 + rad) && // 3 m paths keep 1.5 m clear each side

      !zoneRects.some((r) => hitsRect(r, x, z, rad)) &&
      !hitsRect(waterRect, x, z, rad) && !hitsRect(dockRect, x, z, rad) &&
      !hitsRect(grow(lookoutRect, lookoutClear), x, z, rad);

    // knolls on the −s side, away from the lookout
    const knolls: Rect[] = [grow(rect(gx, gz, gx, gz), 7)];
    for (const [cx, cz, half0, maxLv] of [[-17 * s, -17, 4, 3], [-8.5 * s, -10.5, 2.5, 2]] as const) {
      const [x, z, half] = [r2(cx + j(1.5)), r2(cz + j(1)), r2(half0 + j(0.5))];
      const lv = 1 + Math.floor(rng() * maxLv);
      if (!openGround(x, z, half, 3)) continue;
      for (let i = 1; i <= lv && half - 1.5 * (i - 1) > 0.5; i++) {
        const hh = half - 1.5 * (i - 1);
        statics.push(box("clearing", [x, (TERRACE * i) / 2, z], [2 * hh, TERRACE * i, 2 * hh], "floor"));
      }
      knolls.push(grow(rect(x, z, x, z), half));
    }

    // ---- scatter: trees (too tall for any jump), rocks, bushes --------------------------------
    const treeMin = r2(Math.max(4, deckTop + apex(L, Math.max(1, k)) + 0.5));
    const placed: [number, number, number][] = [];
    const counts = { tree: 0, rock: 0, bush: 0 };
    const scatter = (kind: "tree" | "rock" | "bush", n: number) => {
      for (let tries = 0; counts[kind] < n && tries < n * 30; tries++) {
        const x = (rng() - 0.5) * 2 * (H - 1.5);
        const z = (rng() - 0.5) * 2 * (H - 1.5);
        const [a, b, c] = [rng(), rng(), rng()];
        const size: Vec3 =
          kind === "tree" ? [r2(0.5 + 0.3 * a), r2(treeMin + 2.5 * b), 0] : kind === "rock" ? [r2(0.8 + 1.4 * a), r2(0.5 + (ROCK_MAX - 0.5) * b), r2(0.8 + 1.4 * c)] : [r2(0.9 + 0.9 * a), r2(0.6 + (BUSH_MAX - 0.6) * b), r2(0.9 + 0.9 * c)];
        if (kind === "tree") size[2] = size[0];
        const rad = Math.max(size[0], size[2]) * 0.71;
        if (!openGround(x, z, rad, kind === "tree" ? 2.5 : clear)) continue;
        if (kind !== "tree" && knolls.some((r) => hitsRect(r, x, z, rad))) continue; // rocks and bushes stay off terraces
        if (placed.some(([px, pz, pr]) => (px - x) * (px - x) + (pz - z) * (pz - z) < (pr + rad + 1.2) * (pr + rad + 1.2))) continue;
        placed.push([x, z, rad]);
        counts[kind]++;
        statics.push(box("clearing", [r2(x), size[1] / 2, r2(z)], size, "wall"));
      }
    };
    const count = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(120, Math.round(v))) : 0);
    scatter("rock", count(params.rocks));
    scatter("bush", count(params.bushes));
    scatter("tree", count(params.trees));

    // ---- perimeter (taller than anything reachable plus a full jump) and the ground ----------
    const wallTop = treeMin + 1;
    statics.push(box("entrance", [0, wallTop / 2, -H - 0.5], [2 * H + 2, wallTop, 1], "wall"));
    statics.push(box("camp", [0, wallTop / 2, H + 0.5], [2 * H + 2, wallTop, 1], "wall"));
    statics.push(box("clearing_w", [-H - 0.5, wallTop / 2, 0], [1, wallTop, 2 * H], "wall"));
    statics.push(box("clearing_e", [H + 0.5, wallTop / 2, 0], [1, wallTop, 2 * H], "wall"));
    statics.push(box("clearing", [0, -0.5, 0], [2 * H, 1, 2 * H], "floor"));

    return {
      packId: this.id,
      version: this.version,
      zones,
      statics,
      cameraBounds: { min: [-H, -1, -H], max: [H, wallTop + 4, H] },
      // a race loop round the central clearing: north of the lookout, south of the pond and the
      // grove knoll, through the side clearings (a race clears the trees and rocks standing on it)
      track: { points: [[0, 0, -7], [12, 0, -7], [12, 0, 7], [0, 0, 7], [-12, 0, 7], [-12, 0, -7]], width: 6 },
      notes: [
        `outdoor ${2 * H}×${2 * H} m: ${counts.tree} trees, ${counts.rock} rocks, ${counts.bush} bushes; grove knoll ${gTop} m; pond ${r2(2 * hx)}×${r2(2 * hz)} m`,
        `lookout deck ${deckTop} m: first ledge ${h1} m (${jumping ? `needs ${k} jump${k === 1 ? "" : "s"}` : "a step: these laws barely jump"}), gaps ${g1} m and ${g2} m${harder ? " (harder: up to 0.95 × reach)" : ""}`,
      ],
    };
  },
};
