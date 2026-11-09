// volume: worlds you cross through the air or the water rather than on foot, in three media (the
// sub-zone picks one): sky (floating islands rising in an arc, with cloud steps and a high peak,
// crossed with a jetpack: none of the gaps can be jumped), water (a beach and a lagoon seven metres
// deep with a sunken ship, swum: the treasure lies by the wreck), and space (a station's modules and
// an asteroid field in zero-g: the thrust law). The placer gives each medium what it needs to
// move in (a jetpack, the lagoon's water, zero gravity) when the fill didn't.
import { stream } from "@ghostrun/detmath";
import type { Vec3 } from "@ghostrun/ir";
import type { LayoutPack, LayoutParamSpec, PackLayout, PackStatic, ZoneSpec } from "@ghostrun/plugin-api";

export interface VolumeParams {
  [k: string]: number;
  /** How far apart things stand: 1 is the default spread. */
  spread: number;
}

export const MEDIA = ["sky", "water", "space"] as const;
export type Medium = (typeof MEDIA)[number];

/** The medium a layout is in: its sub-zone (sky when it names none). */
export const mediumOf = (sub: readonly string[]): Medium => (MEDIA.find((m) => sub.includes(m)) ?? "sky");

/** The lagoon's water in the water medium: the zone tag the placer fills with a swimmable volume. */
export const WATER_TAG = "lagoon";

export const VOLUME_SCHEMA: Readonly<Record<string, LayoutParamSpec>> = {
  spread: { min: 0.8, max: 1.3, step: 0.1, label: "spread", unit: "×", line: "how far apart the islands, the reef or the modules stand" },
};

const box = (zoneSlot: string, pos: Vec3, size: Vec3, surf: PackStatic["surf"]): PackStatic => ({ zoneSlot, shape: "box", pos, rotY: 0, size, surf });
const r2 = (x: number) => Math.round(x * 100) / 100;

/** An island: a slab whose top is `top`, its anchors on it. */
function island(slot: string, tag: string, c: Vec3, w: number, d: number, anchors: Record<string, [number, number]>): { st: PackStatic; zone: ZoneSpec } {
  const top = c[1];
  const st = box(slot, [c[0], top - 1.5, c[2]], [w, 3, d], "floor");
  const a: Record<string, Vec3> = {};
  for (const [k, [dx, dz]] of Object.entries(anchors)) a[k] = [r2(c[0] + dx), top, r2(c[2] + dz)];
  return { st, zone: { slot, tag, bounds: { min: [c[0] - w / 2, top, c[2] - d / 2], max: [c[0] + w / 2, top + 4, c[2] + d / 2] }, floorY: top, anchors: a } };
}

function sky(seed: number, k: number): PackLayout {
  const rng = stream(seed, "pack:volume:sky");
  const j = (m: number) => (rng() - 0.5) * 2 * m; // jitter ±m
  const statics: PackStatic[] = [];
  const zones: ZoneSpec[] = [];
  const add = (x: { st: PackStatic; zone: ZoneSpec }) => (statics.push(x.st), zones.push(x.zone));
  // the arc: start, three islands, the finish, each 4–5 m higher and 9–12 m of open air apart (no jump spans it)
  const pts: Vec3[] = [[0, 0, 0]];
  for (let i = 0; i < 4; i++) {
    const p = pts[i]!;
    pts.push([r2(p[0] + (15 + j(1.5)) * k), r2(p[1] + 5.5 + j(0.5)), r2((i % 2 ? -1 : 1) * (5 + j(1.5)) * k)]);
  }
  const [s0, a, b, c, fin] = pts as [Vec3, Vec3, Vec3, Vec3, Vec3];
  add(island("start", "island", s0, 10, 10, { spawn_pad: [-2.5, 0], sign: [2.5, 3], center: [0, 0], edge: [3.5, 0] }));
  add(island("isle_1", "island", a, 7, 7, { center: [0, 0], cp: [1.5, 0], pickup: [-1.5, 1.5] }));
  add(island("isle_2", "island", b, 7, 7, { center: [0, 0], cp: [1.5, 0], pickup: [-1.5, -1.5] }));
  add(island("isle_3", "island", c, 7, 7, { center: [0, 0], cp: [1.5, 0], pickup: [-1.5, 1.5] }));
  add(island("finish", "island", fin, 10, 10, { goal: [1.5, 0], center: [0, 0], pickup: [-2.5, 2.5] }));
  // the peak: off the arc and high above it, reached from the second island (a 12–14 m climb)
  const peak: Vec3 = [r2(b[0] + j(2)), r2(b[1] + 12 + j(1)), r2(b[2] + (b[2] < 0 ? -14 : 14) * k)];
  add(island("peak", "peak", peak, 6, 6, { treasure: [0, 0], center: [0, 0] }));
  // cloud steps under the arc's gaps: thin, a place to land and refuel halfway
  const clouds: Vec3[] = [[(s0[0] + a[0]) / 2, (s0[1] + a[1]) / 2 - 3, (s0[2] + a[2]) / 2], [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2 - 3, (b[2] + c[2]) / 2]];
  clouds.forEach((p, i) => statics.push(box(`cloud_${i + 1}`, [r2(p[0]), r2(p[1] - 0.2), r2(p[2])], [3, 0.4, 3], "floor")));
  zones.push(...clouds.map((p, i): ZoneSpec => ({ slot: `cloud_${i + 1}`, tag: "cloud", bounds: { min: [p[0] - 1.5, p[1], p[2] - 1.5], max: [p[0] + 1.5, p[1] + 3, p[2] + 1.5] }, floorY: r2(p[1]), anchors: { cloud: [r2(p[0]), r2(p[1]), r2(p[2])] } })));
  // the sky itself: rings to fly through hang in the open air between the islands
  zones.push({ slot: "open_sky", tag: "air", bounds: { min: [s0[0], 2, -12], max: [fin[0], fin[1] + 10, 12] }, floorY: 6,
    anchors: { ring_1: [r2((a[0] + b[0]) / 2), r2((a[1] + b[1]) / 2 + 3), r2((a[2] + b[2]) / 2)], ring_2: [r2((c[0] + fin[0]) / 2), r2((c[1] + fin[1]) / 2 + 3), r2((c[2] + fin[2]) / 2)] } });
  return {
    packId: "volume", version: VERSION, zones, statics,
    cameraBounds: { min: [-8, -10, -24], max: [fin[0] + 8, peak[1] + 12, 24] },
    notes: [`volume (sky): 5 islands rising ${r2(fin[1])} m over ${r2(fin[0])} m, a peak at ${r2(peak[1])} m, 2 cloud steps (a jetpack crosses it: no gap can be jumped)`],
  };
}

function water(seed: number, k: number): PackLayout {
  const rng = stream(seed, "pack:volume:water");
  const j = (m: number) => (rng() - 0.5) * 2 * m;
  const statics: PackStatic[] = [];
  // the lagoon: 28 × 24 m of water, 7 m deep, its surface level with the beach
  const W = r2(14 * k);
  const D = r2(24 * k);
  const depth = 7;
  statics.push(box("beach", [0, -4, -10], [2 * W + 16, 8, 20], "floor")); // the beach south of the water, its face the lagoon's south wall
  statics.push(box("lagoon", [0, -depth - 0.5, D / 2], [2 * W, 1, D], "floor")); // the seabed
  statics.push(box("rim_w", [-W - 4, -4, D / 2], [8, 8, D], "floor"));
  statics.push(box("rim_e", [W + 4, -4, D / 2], [8, 8, D], "floor"));
  statics.push(box("rim_n", [0, -4, D + 4], [2 * W + 16, 8, 8], "floor"));
  // the sunken ship on the seabed: a hull, its deck 3 m up, a mast standing out of the water
  const sx = r2(j(W * 0.35));
  const sz = r2(D * 0.6 + j(2));
  statics.push(box("wreck", [sx, -depth + 1.5, sz], [8, 3, 3], "ledge"));
  statics.push(box("wreck", [r2(sx + 1), -depth + 4.5, sz], [0.4, 3, 0.4], "wall"));
  // an islet with a palm in the shallows west of the wreck
  const ix = r2(-W * 0.55 + j(1));
  const iz = r2(D * 0.35 + j(1.5));
  statics.push(box("islet", [ix, -depth / 2 + 0.25, iz], [4, depth + 0.5, 4], "floor"));
  const zones: ZoneSpec[] = [
    { slot: "beach", tag: "shore", bounds: { min: [-W - 8, 0, -18], max: [W + 8, 4, -1] }, floorY: 0,
      anchors: { spawn_pad: [-4, 0, -12], goal: [4, 0, -6], hut: [-W + 2, 0, -14], sign: [0, 0, -3], center: [0, 0, -9] } },
    { slot: "lagoon", tag: WATER_TAG, bounds: { min: [-W, -depth, 0], max: [W, 0, D] }, floorY: -depth,
      anchors: { shallows: [r2(-W * 0.3), -depth, 3], reef: [r2(W * 0.6), -depth, r2(D * 0.3)], deep: [r2(-W * 0.2), -depth, r2(D * 0.8)], surface: [0, 0, r2(D * 0.5)] } },
    { slot: "wreck", tag: "ship", bounds: { min: [sx - 4, -depth, sz - 3], max: [sx + 4, -depth + 6, sz + 3] }, floorY: -depth + 3,
      anchors: { deck: [r2(sx - 2), -depth + 3, sz], hold: [r2(sx + 1.5), -depth, r2(sz + 2.6)], bow: [r2(sx - 5.2), -depth, sz] } },
    { slot: "islet", tag: "island", bounds: { min: [ix - 2, 0.5, iz - 2], max: [ix + 2, 4, iz + 2] }, floorY: 0.5, anchors: { palm: [ix, 0.5, iz] } },
  ];
  return {
    packId: "volume", version: VERSION, zones, statics,
    cameraBounds: { min: [-W - 8, -depth - 1, -18], max: [W + 8, 12, D + 8] },
    notes: [`volume (water): a lagoon ${2 * W}×${D} m and ${depth} m deep off a beach, a sunken ship on the seabed, an islet`],
  };
}

function space(seed: number, k: number): PackLayout {
  const rng = stream(seed, "pack:volume:space");
  const j = (m: number) => (rng() - 0.5) * 2 * m;
  const statics: PackStatic[] = [];
  // the station: an airlock module you start on, a hub, a truss out to the far module, solar wings
  statics.push(box("airlock", [0, -1.5, 0], [8, 3, 8], "roof"));
  statics.push(box("hub", [r2(14 * k), 1, 0], [10, 6, 10], "roof"));
  statics.push(box("truss", [r2(28 * k), 2.5, 0], [r2(18 * k), 1, 1], "ledge"));
  statics.push(box("far_module", [r2(42 * k), 1, 0], [8, 6, 8], "roof"));
  statics.push(box("hub", [r2(14 * k), 1.5, 9], [3, 0.2, 8], "ledge")); // a solar wing
  statics.push(box("hub", [r2(14 * k), 1.5, -9], [3, 0.2, 8], "ledge"));
  // the asteroid field beyond: rocks hanging off the line to the escape pod
  const rocks: Vec3[] = [];
  for (let i = 0, tries = 0; i < 6 && tries < 60; tries++) {
    const p: Vec3 = [r2((20 + rng() * 28) * k), r2(6 + j(4)), r2(j(14))];
    // clear of the truss, the modules and their wings, and each other
    if (Math.abs(p[2]) < 3.5 || (Math.abs(p[0] - 42 * k) < 8 && Math.abs(p[2]) < 7) || (Math.abs(p[0] - 14 * k) < 8 && Math.abs(p[2]) < 15) || rocks.some((q) => Math.abs(q[0] - p[0]) < 5 && Math.abs(q[2] - p[2]) < 5)) continue;
    const s = r2(2 + rng() * 2.5);
    rocks.push([p[0], r2(p[1] + s / 2), p[2]]);
    statics.push(box("field", p, [s, s, s], "roof"));
  }
  const far = r2(42 * k);
  const zones: ZoneSpec[] = [
    { slot: "airlock", tag: "module", bounds: { min: [-4, 0, -4], max: [4, 4, 4] }, floorY: 0, anchors: { spawn_pad: [-1.5, 0, 0], hatch: [2.5, 0, 2.5], sign: [2.5, 0, -2.5], center: [0, 0, 0] } },
    { slot: "hub", tag: "module", bounds: { min: [r2(14 * k) - 5, 4, -5], max: [r2(14 * k) + 5, 8, 5] }, floorY: 4, anchors: { center: [r2(14 * k), 4, 0], console: [r2(14 * k + 3), 4, 3], cp: [r2(14 * k - 2), 4, -2] } },
    { slot: "far_module", tag: "module", bounds: { min: [far - 4, 4, -4], max: [far + 4, 8, 4] }, floorY: 4, anchors: { center: [far, 4, 0], keycard: [r2(far - 2), 4, 2], console: [r2(far + 2), 4, -2] } },
    { slot: "field", tag: "asteroids", bounds: { min: [20 * k, 2, -14], max: [48 * k, 10, 14] }, floorY: 6, anchors: Object.fromEntries(rocks.map((p, i) => [`rock_${i + 1}`, p])) },
    // the escape pod waits out in the open, past the field
    { slot: "pod", tag: "air", bounds: { min: [far + 6, 6, -4], max: [far + 14, 14, 4] }, floorY: 10, anchors: { pod: [r2(far + 10), 10, r2(j(3))] } },
  ];
  return {
    packId: "volume", version: VERSION, zones, statics,
    cameraBounds: { min: [-8, -6, -16], max: [far + 16, 18, 16] },
    notes: [`volume (space): a station of 3 modules on a ${r2(18 * k)} m truss, ${rocks.length} asteroids, an escape pod in the open (zero-g)`],
  };
}

const VERSION = "0.1.0";

export const volume: LayoutPack<VolumeParams> = {
  id: "volume",
  version: VERSION,
  modes: ["play", "wander"],
  defaults: { spread: 1 },
  schema: VOLUME_SCHEMA,
  ci: { seeds: Array.from({ length: 50 }, (_, i) => i + 1) },
  generate({ seed, params, sub }): PackLayout {
    const k = Math.min(1.3, Math.max(0.8, Number(params.spread) || 1));
    const m = mediumOf(sub);
    return m === "water" ? water(seed, k) : m === "space" ? space(seed, k) : sky(seed, k);
  },
};
