// orrery: the solar system as walkways in space (a planetarium's model you walk through). The Sun
// stands on a hub in the middle; four spokes run out from it along the compass, and each planet
// sits on a plinth (one 0.3 m step up) astride a spoke at its distance from the Sun SCALED: the
// square root of its distance in AU, times `scale` metres (true proportions would put Neptune 78
// times as far out as Mercury). Planet sizes are not to scale either. The layout says so in its
// notes, and a sign anchor by the entrance is where a fill puts that note. Consecutive planets take
// consecutive spokes, so neighbours never crowd. A square ring walkway crosses the spokes between
// Mars and Jupiter, where the asteroid belt is: the race loop. The entrance platform is at the end
// of the south spoke. Every planet is reached on foot; a step off a walkway is a fall into space
// (the simulation brings anyone who falls 20 m back to the start). Planets are exhibits for a tour
// (wander) and platforms to fetch something from (play).
import { stream } from "@ghostrun/detmath";
import type { Vec3 } from "@ghostrun/ir";
import { r2, Shell } from "@ghostrun/pack-common";
import type { LayoutPack, LayoutParamSpec, PackLayout, PackStatic, ZoneSpec } from "@ghostrun/plugin-api";

export interface OrreryParams {
  [k: string]: number;
  scale: number; // metres per √AU
  planets: number; // how many planets out from the Sun (5: to Jupiter, 8: to Neptune)
}

/** Name, mean distance from the Sun (AU), √AU (written out: no roots in the layout), plinth width (m, not to scale). */
export const PLANETS: readonly (readonly [string, number, number, number])[] = [
  ["mercury", 0.387, 0.6221, 1.6],
  ["venus", 0.723, 0.8503, 2],
  ["earth", 1, 1, 2],
  ["mars", 1.524, 1.2345, 1.8],
  ["jupiter", 5.203, 2.281, 4],
  ["saturn", 9.537, 3.0882, 3.6],
  ["uranus", 19.19, 4.3806, 2.8],
  ["neptune", 30.07, 5.4836, 2.8],
];
/** How high a plinth stands (one step up, no jump needed). */
export const PLINTH_H = 0.3;
/** The spokes' and the ring's widths. */
export const SPOKE_W = 3;
const RING_W = 4;
const HUB = 5;
const SUN = 2.4;
const ENTRANCE_W = 8;
const ENTRANCE_D = 6;

/** What a structural edit may change: how far apart things are, and how many planets. */
export const ORRERY_SCHEMA: Readonly<Record<string, LayoutParamSpec>> = {
  scale: { min: 5.5, max: 8, step: 0.5, label: "scale", unit: "m per √AU", line: "how spread out the solar system is (Earth this far from the Sun)" },
  planets: { min: 5, max: 8, step: 1, label: "planets", line: "how many planets out from the Sun: 5 ends at Jupiter, 8 at Neptune" },
};

/** The four spokes, as unit directions (east, north, west, south). */
const SPOKES: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export const orrery: LayoutPack<OrreryParams> = {
  id: "orrery",
  version: "0.1.0",
  modes: ["play", "wander"],
  defaults: { scale: 6, planets: 8 },
  schema: ORRERY_SCHEMA,
  ci: { seeds: Array.from({ length: 50 }, (_, i) => i + 1) },

  generate({ seed, params }): PackLayout {
    const rng = stream(seed, "pack:orrery");
    const k = params.scale;
    const planets = PLANETS.slice(0, params.planets);
    const rot = Math.floor(rng() * 4); // which spoke Mercury takes; the rest follow round
    const s = new Shell();
    const at = new Map<string, Vec3>();
    const beside = new Map<string, Vec3>();
    const reach = [0, 0, 0, 0]; // how far out each spoke must run
    const plinths: PackStatic[] = [];
    planets.forEach(([name, , root, w], i) => {
      const spoke = (i + rot) % 4;
      const [dx, dz] = SPOKES[spoke]!;
      const r = r2(k * root);
      // a little to one side of the spoke's middle line (its distance along the spoke stays exact)
      const side = r2((rng() < 0.5 ? -1 : 1) * Math.min(0.5, Math.max(0, (SPOKE_W - w) / 2 + 0.5)));
      const [x, z] = [r2(dx * r + dz * side), r2(dz * r + dx * side)];
      plinths.push({ zoneSlot: i < 4 ? "inner" : name, shape: "box", pos: [x, PLINTH_H / 2, z], rotY: 0, size: [w, PLINTH_H, w], surf: "ledge" });
      at.set(name, [x, PLINTH_H, z]);
      // beside the plinth, on the spoke, on its side away from the Sun (a sign, a guide)
      const out = w / 2 + 1.2;
      beside.set(name, [r2(dx * (r + out)), 0, r2(dz * (r + out))]);
      reach[spoke] = Math.max(reach[spoke]!, r + out + 1.2);
    });
    const outer = planets[planets.length - 1]!;
    const rOut = r2(k * outer[2]);
    // the belt ring, halfway between Mars's plinth and Jupiter's
    const a = r2((k * PLANETS[3]![2] + PLANETS[3]![3] / 2 + k * PLANETS[4]![2] - PLANETS[4]![3] / 2) / 2);
    const h = HUB / 2;
    const half = SPOKE_W / 2;
    // the south spoke runs on past everything to the entrance
    reach[3] = Math.max(reach[3]!, rOut + 4);
    for (const sp of [0, 1, 2]) reach[sp] = Math.max(reach[sp]!, a + RING_W / 2 + 1);
    const zEnt = r2(-reach[3]!);
    // the hub, the Sun's plinth on it, the spokes (each ending where the ring crosses it, then on)
    s.slab("sun", -h, h, -h, h, 0);
    s.box("sun", [0, PLINTH_H / 2, 0], [SUN, PLINTH_H, SUN], "ledge");
    const ring0 = r2(a - RING_W / 2);
    const ring1 = r2(a + RING_W / 2);
    SPOKES.forEach(([dx, dz], i) => {
      const end = r2(reach[i]!);
      for (const [p, q, slot] of [[h, ring0, "sun"], [ring0, ring1, "belt"], [ring1, end, "sun"]] as const) {
        if (q - p < 0.05) continue;
        const [ax, bx] = dx ? (dx > 0 ? [p, q] : [-q, -p]) : [-half, half];
        const [az, bz] = dz ? (dz > 0 ? [p, q] : [-q, -p]) : [-half, half];
        s.slab(slot, ax, bx, az, bz, 0);
      }
    });
    // the ring's four sides between the spokes (the crossings are the spokes'); the north and south
    // sides take the corners
    for (const sgn of [-1, 1]) {
      const [p, q] = [r2(sgn * a - RING_W / 2), r2(sgn * a + RING_W / 2)];
      for (const [u, v] of [[-ring1, -half], [half, ring1]] as const) s.slab("belt", u, v, p, q, 0);
      for (const [u, v] of [[-ring0, -half], [half, ring0]] as const) s.slab("belt", p, q, u, v, 0);
    }
    s.statics.push(...plinths);
    // the entrance platform at the end of the south spoke
    s.slab("entrance", -ENTRANCE_W / 2, ENTRANCE_W / 2, r2(zEnt - ENTRANCE_D), zEnt, 0);

    const zones: ZoneSpec[] = [
      { slot: "entrance", tag: "entrance", bounds: { min: [-ENTRANCE_W / 2, 0, r2(zEnt - ENTRANCE_D)], max: [ENTRANCE_W / 2, 3, zEnt] }, floorY: 0,
        anchors: { spawn_pad: [0, 0, r2(zEnt - ENTRANCE_D + 2)], desk: [r2(-ENTRANCE_W / 2 + 1.2), 0, r2(zEnt - 1.2)], scale_note: [r2(ENTRANCE_W / 2 - 1.2), 0, r2(zEnt - 1.2)], corner_e: [r2(ENTRANCE_W / 2 - 0.8), 0, r2(zEnt - ENTRANCE_D + 0.8)], corner_w: [r2(-ENTRANCE_W / 2 + 0.8), 0, r2(zEnt - ENTRANCE_D + 0.8)] } },
      { slot: "sun", tag: "center", bounds: { min: [-h, 0, -h], max: [h, 3, h] }, floorY: 0, anchors: { sun: [0, PLINTH_H, 0], console: [0, 0, r2(-h + 0.6)], hub_e: [r2(h - 0.6), 0, 0], hub_w: [r2(-h + 0.6), 0, 0] } },
      { slot: "inner", tag: "planet", bounds: { min: [r2(-a), 0, r2(-a)], max: [a, 3, a] }, floorY: 0,
        anchors: { mercury: at.get("mercury")!, venus: at.get("venus")!, earth: at.get("earth")!, mars: at.get("mars")!, moon: beside.get("earth")! } },
      { slot: "belt", tag: "ring", bounds: { min: [-ring1, 0, -ring1], max: [ring1, 3, ring1] }, floorY: 0,
        anchors: { belt_ne: [a, 0, a], belt_nw: [r2(-a), 0, a], belt_se: [a, 0, r2(-a)], belt_sw: [r2(-a), 0, r2(-a)] } },
      ...planets.slice(4).map(([name, , , w]): ZoneSpec => {
        const p = at.get(name)!;
        // (its bounds are the stretch of spoke it stands on: anything scattered in the zone lands on the walkway)
        const [hx, hz] = Math.abs(p[0]) > Math.abs(p[2]) ? [w, half] : [half, w];
        const [sx, sz] = Math.abs(p[0]) > Math.abs(p[2]) ? [p[0], 0] : [0, p[2]];
        return { slot: name, tag: "planet", bounds: { min: [r2(sx - hx), 0, r2(sz - hz)], max: [r2(sx + hx), 3, r2(sz + hz)] }, floorY: 0, anchors: { [name]: p, beside: beside.get(name)! } };
      }),
    ];
    const ext = r2(Math.max(...reach.slice(0, 3), ring1) + 2);
    // the race loop: round the belt ring, starting at its south-west corner
    const points: Vec3[] = [[r2(-a), 0, r2(-a)], [0, 0, r2(-a)], [a, 0, r2(-a)], [a, 0, 0], [a, 0, a], [0, 0, a], [r2(-a), 0, a], [r2(-a), 0, 0]];
    return {
      packId: this.id,
      version: this.version,
      zones,
      statics: s.statics,
      cameraBounds: { min: [-ext, -1, r2(zEnt - ENTRANCE_D)], max: [ext, 20, ext] },
      track: { points, width: RING_W - 0.5 },
      notes: [
        `orrery: distances scaled (√AU × ${k} m: Earth ${r2(k)} m from the Sun, ${outer[0][0]!.toUpperCase()}${outer[0].slice(1)} ${rOut} m; true to scale it would be ${r2(k * outer[1])} m), planet sizes not to scale`,
      ],
    };
  },
};
