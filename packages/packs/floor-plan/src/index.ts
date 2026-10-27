// floor_plan: a single-storey interior at real scale (3 m walls, 0.9 × 2.1 m doorways) on a
// 3 × 2 room grid behind a front yard. Every room is reachable through doors; the yard holds the
// spawn. For tours, galleries, shops, heists and homes. No ceilings (cutaway camera).
import { stream } from "@ghostrun/detmath";
import type { Vec3 } from "@ghostrun/ir";
import type { LayoutPack, PackLayout, PackStatic, ZoneSpec } from "@ghostrun/plugin-api";

export interface FloorPlanParams {
  [k: string]: number;
  width: number; // x extent of the building (m)
  depth: number; // z extent of the building (m)
}

export const WALL_H = 3;
export const DOOR_W = 0.9;
export const DOOR_H = 2.1;
const T = 0.2; // wall thickness
const YARD = 8; // depth of the front yard

const box = (zoneSlot: string, pos: Vec3, size: Vec3, surf: PackStatic["surf"]): PackStatic => ({ zoneSlot, shape: "box", pos, rotY: 0, size, surf });

/** A wall from a to b along one axis, with an optional doorway centred at `door`. */
function wall(out: PackStatic[], slot: string, axis: "x" | "z", fixed: number, a: number, b: number, door: number | null) {
  const seg = (s: number, e: number, y0: number, y1: number) => {
    if (e - s < 0.05) return;
    const mid = (s + e) / 2;
    const len = e - s;
    const pos: Vec3 = axis === "x" ? [mid, (y0 + y1) / 2, fixed] : [fixed, (y0 + y1) / 2, mid];
    const size: Vec3 = axis === "x" ? [len, y1 - y0, T] : [T, y1 - y0, len];
    out.push(box(slot, pos, size, "wall"));
  };
  if (door === null) {
    seg(a, b, 0, WALL_H);
    return;
  }
  seg(a, door - DOOR_W / 2, 0, WALL_H);
  seg(door + DOOR_W / 2, b, 0, WALL_H);
  seg(door - DOOR_W / 2, door + DOOR_W / 2, DOOR_H, WALL_H); // lintel
}

export const floorPlan: LayoutPack<FloorPlanParams> = {
  id: "floor_plan",
  version: "0.1.0",
  modes: ["play", "wander"],
  defaults: { width: 28, depth: 20 },
  ci: { seeds: Array.from({ length: 50 }, (_, i) => i + 1) },

  generate({ seed, params }): PackLayout {
    const rng = stream(seed, "pack:floor_plan");
    const W = params.width;
    const D = params.depth;
    const x0 = -W / 2;
    const x3 = W / 2;
    const zFront = -D / 2;
    const zBack = D / 2;
    // column cuts and the row cut, seeded but always leaving generous rooms
    const w1 = W * (0.28 + rng() * 0.06);
    const w3 = W * (0.28 + rng() * 0.06);
    const x1 = x0 + w1;
    const x2 = x3 - w3;
    const zMid = D * (-0.1 + rng() * 0.2);
    const doorAt = (a: number, b: number) => {
      const m = (a + b) / 2;
      const room = (b - a) / 2 - DOOR_W / 2 - 0.6;
      return Math.round((m + (rng() - 0.5) * Math.min(2, room * 2)) * 100) / 100;
    };

    const statics: PackStatic[] = [];
    // every doorway cut, so rooms can offer door anchors in the gap (a door entity there guards it)
    const doorways: { axis: "x" | "z"; fixed: number; at: number }[] = [];
    const w = (slot: string, axis: "x" | "z", fixed: number, a: number, b: number, door: number | null) => {
      wall(statics, slot, axis, fixed, a, b, door);
      if (door !== null) doorways.push({ axis, fixed, at: door });
    };
    statics.push(box("yard", [0, -0.1, zFront - YARD / 2], [W + 8, 0.2, YARD], "floor"));
    statics.push(box("main_room", [0, -0.1, 0], [W, 0.2, D], "floor"));

    // exterior walls; the front door opens from the yard into the entrance
    w("entrance", "x", zFront, x0, x3, doorAt(x1, x2));
    w("main_room", "x", zBack, x0, x3, null);
    w("room_sw", "z", x0, zFront, zBack, null);
    w("room_se", "z", x3, zFront, zBack, null);
    // yard boundary (so nobody walks off the world)
    statics.push(box("yard", [x0 - 4 - T / 2, 1, zFront - YARD / 2], [T, 2, YARD], "wall"));
    statics.push(box("yard", [x3 + 4 + T / 2, 1, zFront - YARD / 2], [T, 2, YARD], "wall"));
    statics.push(box("yard", [0, 1, zFront - YARD - T / 2], [W + 8, 2, T], "wall"));

    // interior: front row | back row split by the row wall; columns split by two column walls
    w("room_sw", "x", zMid, x0, x1, doorAt(x0, x1)); // room_sw ↔ room_nw
    w("entrance", "x", zMid, x1, x2, doorAt(x1, x2)); // entrance ↔ main_room
    w("room_se", "x", zMid, x2, x3, null); // room_se reaches the back via the entrance
    w("entrance", "z", x1, zFront, zMid, doorAt(zFront, zMid)); // room_sw ↔ entrance
    w("entrance", "z", x2, zFront, zMid, doorAt(zFront, zMid)); // entrance ↔ room_se
    w("main_room", "z", x1, zMid, zBack, doorAt(zMid, zBack)); // room_nw ↔ main_room
    w("main_room", "z", x2, zMid, zBack, doorAt(zMid, zBack)); // main_room ↔ room_ne

    const near = (p: number, q: number) => Math.abs(p - q) < 0.01;
    const doorAnchors = (ax: number, bx: number, az: number, bz: number): Record<string, Vec3> => {
      const out: Record<string, Vec3> = {};
      for (const d of doorways) {
        const along = d.axis === "x" ? d.at >= ax && d.at <= bx : d.at >= az && d.at <= bz;
        if (!along) continue;
        const side = d.axis === "x" ? (near(d.fixed, bz) ? "n" : near(d.fixed, az) ? "s" : "") : near(d.fixed, bx) ? "e" : near(d.fixed, ax) ? "w" : "";
        if (side && !out[`doorway_${side}`]) out[`doorway_${side}`] = d.axis === "x" ? [d.at, 0, d.fixed] : [d.fixed, 0, d.at];
      }
      return out;
    };
    const room = (slot: string, tag: string, ax: number, bx: number, az: number, bz: number): ZoneSpec => {
      const cx = (ax + bx) / 2;
      const cz = (az + bz) / 2;
      const m = 0.8; // keep anchors off the walls
      return {
        slot, tag,
        bounds: { min: [ax, 0, az], max: [bx, WALL_H, bz] },
        floorY: 0,
        anchors: {
          center: [cx, 0, cz],
          corner_ne: [bx - m, 0, bz - m], corner_nw: [ax + m, 0, bz - m], corner_se: [bx - m, 0, az + m], corner_sw: [ax + m, 0, az + m],
          wall_n: [cx, 1.4, bz - T / 2 - 0.12], wall_s: [cx, 1.4, az + T / 2 + 0.12],
          wall_e: [bx - T / 2 - 0.12, 1.4, cz], wall_w: [ax + T / 2 + 0.12, 1.4, cz],
          ...doorAnchors(ax, bx, az, bz),
        },
      };
    };
    const zones: ZoneSpec[] = [
      { slot: "yard", tag: "outside", bounds: { min: [x0 - 4, 0, zFront - YARD], max: [x3 + 4, 3, zFront] }, floorY: 0,
        anchors: { spawn_pad: [0, 0, zFront - YARD + 2], gate: [0, 0, zFront - 1.2], corner_e: [x3 + 2, 0, zFront - YARD / 2], corner_w: [x0 - 2, 0, zFront - YARD / 2] } },
      room("entrance", "entrance", x1, x2, zFront, zMid),
      room("room_sw", "room", x0, x1, zFront, zMid),
      room("room_se", "room", x2, x3, zFront, zMid),
      room("room_nw", "room", x0, x1, zMid, zBack),
      room("main_room", "hall", x1, x2, zMid, zBack),
      room("room_ne", "room", x2, x3, zMid, zBack),
    ];

    return {
      packId: this.id,
      version: this.version,
      zones,
      statics,
      cameraBounds: { min: [x0 - 4, -1, zFront - YARD], max: [x3 + 4, 12, zBack] },
      notes: [`interior ${W}×${D} m, ${WALL_H} m walls, ${DOOR_W}×${DOOR_H} m doorways, cutaway (no ceilings)`],
    };
  },
};
