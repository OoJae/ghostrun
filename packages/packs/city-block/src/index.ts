// city-block: a neon street grid between two bases, with an optional rooftop sub-zone.
// The rooftop lane sits on a ledge the player can only reach with a double jump, which is the
// property the organizer's CTF brief ("Add double jump") turns into a verified headline.
import { stream } from "@ghostrun/detmath";
import type { Vec3 } from "@ghostrun/ir";
import type { LayoutPack, PackLayout, PackStatic, ZoneSpec } from "@ghostrun/plugin-api";

export interface CityBlockParams {
  [k: string]: number;
  length: number; // x extent of the playable street (m)
  depth: number; // z extent (m)
}

/** Ledge height of the rooftop lane: above one jump's apex, well below two jumps' apex. */
export function roofLedgeHeight(jumpH: number): number {
  return Math.round((jumpH * 1.6) * 10) / 10; // 1.6 m jump → 2.6 m ledge (apex 1.6 < 2.6 ≤ 3.2)
}

const box = (zoneSlot: string, pos: Vec3, size: Vec3, surf: PackStatic["surf"]): PackStatic => ({
  zoneSlot, shape: "box", pos, rotY: 0, size, surf,
});

export const cityBlock: LayoutPack<CityBlockParams> = {
  id: "city_block",
  version: "0.1.0",
  modes: ["play", "wander"],
  defaults: { length: 80, depth: 40 },
  ci: { seeds: Array.from({ length: 50 }, (_, i) => i + 1) },

  generate({ seed, params, sub, laws }): PackLayout {
    const L = params.length / 2; // half extents
    const D = params.depth / 2;
    const rng = stream(seed, "pack:city_block");
    const statics: PackStatic[] = [];
    const notes: string[] = [];

    // Ground and perimeter walls.
    statics.push(box("center", [0, -0.5, 0], [params.length, 1, params.depth], "floor"));
    statics.push(box("center", [0, 4, D + 0.5], [params.length, 8, 1], "wall"));
    statics.push(box("center", [0, 4, -D - 0.5], [params.length, 8, 1], "wall"));
    statics.push(box("west_block", [-L - 0.5, 4, 0], [1, 8, params.depth], "wall"));
    statics.push(box("east_block", [L + 0.5, 4, 0], [1, 8, params.depth], "wall"));

    // Building rows along the north and south edges (z = ±(D-4)), leaving the street open.
    const rowDepth = 8;
    for (const side of [1, -1]) {
      let x = -L + 2;
      while (x < L - 2) {
        const w = 6 + Math.floor(rng() * 5); // 6–10 m wide
        const h = 5 + Math.floor(rng() * 6); // 5–10 m tall
        const cx = Math.min(x + w / 2, L - 2 - w / 2);
        statics.push(box(side > 0 ? "north_row" : "south_row", [cx, h / 2, side * (D - rowDepth / 2)], [w - 0.4, h, rowDepth], "wall"));
        x += w;
      }
    }

    // Base kiosks: low cover near each goal.
    for (const [slot, sx] of [["west_block", -1], ["east_block", 1]] as const) {
      statics.push(box(slot, [sx * (L - 10), 0.6, -4], [2, 1.2, 4], "wall"));
      statics.push(box(slot, [sx * (L - 10), 0.6, 4], [2, 1.2, 4], "wall"));
    }

    const zones: ZoneSpec[] = [
      { slot: "center", tag: "plaza", bounds: { min: [-12, 0, -8], max: [12, 6, 8] }, floorY: 0,
        // wall_n is on the north row's front face, above head height even from the rooftop lane
        anchors: { plinth: [0, 0, 0], wall_n: [0, 5.5, D - rowDepth - 0.15], floor_ne: [8, 0, 6], floor_sw: [-8, 0, -6] } },
      { slot: "west_block", tag: "base", bounds: { min: [-L, 0, -8], max: [-24, 6, 8] }, floorY: 0,
        anchors: { spawn_pad: [-(L - 4), 0, 0], goal_ring: [-(L - 14), 0, 0] } },
      { slot: "east_block", tag: "base", bounds: { min: [24, 0, -8], max: [L, 6, 8] }, floorY: 0,
        anchors: { spawn_pad: [L - 4, 0, 0], goal_ring: [L - 14, 0, 0] } },
      { slot: "street_w", tag: "street", bounds: { min: [-24, 0, -8], max: [-12, 6, 8] }, floorY: 0, anchors: {} },
      { slot: "street_e", tag: "street", bounds: { min: [12, 0, -8], max: [24, 6, 8] }, floorY: 0, anchors: {} },
    ];

    if (sub.includes("rooftop")) {
      // A raised lane in front of the north row, from the red side street to the blue side street.
      // Its front face is a ledge of roofLedgeHeight(): one jump can't reach it, two can.
      const top = roofLedgeHeight(laws.jumpH);
      // 4 m deep and flush against the north row, so a player who overshoots a double jump
      // bumps the wall and lands on the lane instead of dropping into a gap behind it.
      const depth = 4;
      const z0 = D - rowDepth - depth / 2; // lane centre line
      const segments: [number, number][] = [[-22, -9], [-6.5, 6.5], [9, 22]]; // gaps of 2.5 m (single-jump reach ≈ 6.8 m)
      for (const [a, b] of segments) {
        statics.push(box("roof_lane_a", [(a + b) / 2, top / 2, z0], [b - a, top, depth], "ledge"));
      }
      zones.push({
        slot: "roof_lane_a", tag: "rooftop", bounds: { min: [-22, top, z0 - depth / 2], max: [22, top + 4, z0 + depth / 2] }, floorY: top,
        anchors: { lane_start: [-20, top, z0], gap_mid: [-7.75, top, z0], lane_end: [20, top, z0], edge: [-12, top, z0 + 1] },
      });
      notes.push(`rooftop lane: ${top} m ledge (one jump reaches ${laws.jumpH} m, two reach ${2 * laws.jumpH} m)`);
    }

    return {
      packId: this.id,
      version: this.version,
      zones,
      statics,
      cameraBounds: { min: [-L, -1, -D], max: [L, 20, D] },
      notes,
    };
  },
};
