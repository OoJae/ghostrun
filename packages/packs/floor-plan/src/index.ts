// floor_plan: a single-storey interior at real scale (3 m walls, 0.9 × 2.1 m doorways) on a
// 3 × 2 room grid behind a front yard. Every room is reachable through doors; the yard holds the
// spawn. For tours, galleries, shops, heists and homes. No ceilings (cutaway camera).
// A second floor (floors 2) is two rooms one storey up, behind the back rooms rather than over
// them (the cutaway camera looks down into every room), reached by a staircase in the main hall.
import { stream } from "@ghostrun/detmath";
import type { Vec3 } from "@ghostrun/ir";
import type { LayoutPack, LayoutParamSpec, PackLayout, PackStatic, ZoneSpec } from "@ghostrun/plugin-api";

export interface FloorPlanParams {
  [k: string]: number;
  width: number; // x extent of the building (m)
  depth: number; // z extent of the building (m)
  floors: number; // 1, or 2 with the upper floor
}

export const WALL_H = 3;
export const DOOR_W = 0.9;
export const DOOR_H = 2.1;
const T = 0.2; // wall thickness
const YARD = 8; // depth of the front yard
/** The upper floor: how deep it is, and its staircase (9 steps of 0.3 m, then a landing at the top). */
const UPPER_D = 8;
const STEP_RISE = 0.3;
const STEP_RUN = 0.5;
const STAIR_W = 1.4;
const LANDING = 1.4;

/** What a structural edit may change: the building's size, and a second floor. */
export const FLOOR_PLAN_SCHEMA: Readonly<Record<string, LayoutParamSpec>> = {
  width: { min: 24, max: 40, step: 2, label: "building", unit: "m wide", line: "the building's width" },
  depth: { min: 16, max: 28, step: 2, label: "building", unit: "m deep", line: "the building's depth" },
  floors: { min: 1, max: 2, step: 1, label: "floors", line: "2 adds an upper floor up a staircase in the main hall: slots upper_hall and upper_room" },
};

const box = (zoneSlot: string, pos: Vec3, size: Vec3, surf: PackStatic["surf"]): PackStatic => ({ zoneSlot, shape: "box", pos, rotY: 0, size, surf });

/** A wall from a to b along one axis, with an optional doorway centred at `door`, standing on `base`. */
function wall(out: PackStatic[], slot: string, axis: "x" | "z", fixed: number, a: number, b: number, door: number | null, base = 0) {
  const seg = (s: number, e: number, y0: number, y1: number) => {
    if (e - s < 0.05) return;
    const mid = (s + e) / 2;
    const len = e - s;
    const pos: Vec3 = axis === "x" ? [mid, base + (y0 + y1) / 2, fixed] : [fixed, base + (y0 + y1) / 2, mid];
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
  defaults: { width: 28, depth: 20, floors: 1 },
  schema: FLOOR_PLAN_SCHEMA,
  ci: { seeds: Array.from({ length: 50 }, (_, i) => i + 1) },

  generate({ seed, params }): PackLayout {
    const rng = stream(seed, "pack:floor_plan");
    const W = params.width;
    const D = params.depth;
    const upper = params.floors === 2;
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

    // the upper floor: a block one storey high behind the back rooms (its top flush with the back
    // wall's), two rooms on it, and a staircase up the main hall's back wall to a gap in the upper
    // front wall. Its own seed stream, so the floor below is the same house with or without it.
    const zUp = zBack + UPPER_D;
    const upDoors: typeof doorways = [];
    if (upper) {
      const up = stream(seed, "pack:floor_plan:upper");
      const east = x2 - T / 2; // the landing stands against the main hall's east wall
      const [sz0, sz1] = [zBack - T / 2 - STAIR_W, zBack - T / 2];
      const stair = (xa: number, xb: number, top: number) => statics.push(box("main_room", [(xa + xb) / 2, top / 2, (sz0 + sz1) / 2], [xb - xa, top, sz1 - sz0], "ledge"));
      const steps = Math.round(WALL_H / STEP_RISE) - 1;
      for (let k = 1; k <= steps; k++) stair(east - LANDING - (steps + 1 - k) * STEP_RUN, east - LANDING - (steps - k) * STEP_RUN, Math.round(k * STEP_RISE * 100) / 100);
      stair(east - LANDING, east, WALL_H);
      statics.push(box("upper_hall", [0, WALL_H / 2, (sz1 + zUp) / 2], [W, WALL_H, zUp - sz1], "floor"));
      const uw = (slot: string, axis: "x" | "z", fixed: number, a: number, b: number, door: number | null) => {
        wall(statics, slot, axis, fixed, a, b, door, WALL_H);
        if (door !== null) upDoors.push({ axis, fixed, at: door });
      };
      uw("upper_hall", "x", zBack, x0, x3, Math.round((east - LANDING / 2) * 100) / 100); // over the landing
      uw("upper_hall", "x", zUp, x0, x3, null);
      uw("upper_room", "z", x0, zBack, zUp, null);
      uw("upper_hall", "z", x3, zBack, zUp, null);
      const room = (UPPER_D / 2 - DOOR_W / 2 - 0.6) * 2;
      uw("upper_room", "z", x1, zBack, zUp, Math.round((zBack + UPPER_D / 2 + (up() - 0.5) * Math.min(2, room)) * 100) / 100);
    }

    const near = (p: number, q: number) => Math.abs(p - q) < 0.01;
    const doorAnchors = (ax: number, bx: number, az: number, bz: number, list = doorways, y = 0): Record<string, Vec3> => {
      const out: Record<string, Vec3> = {};
      for (const d of list) {
        const along = d.axis === "x" ? d.at >= ax && d.at <= bx : d.at >= az && d.at <= bz;
        if (!along) continue;
        const side = d.axis === "x" ? (near(d.fixed, bz) ? "n" : near(d.fixed, az) ? "s" : "") : near(d.fixed, bx) ? "e" : near(d.fixed, ax) ? "w" : "";
        if (side && !out[`doorway_${side}`]) out[`doorway_${side}`] = d.axis === "x" ? [d.at, y, d.fixed] : [d.fixed, y, d.at];
      }
      return out;
    };
    const room = (slot: string, tag: string, ax: number, bx: number, az: number, bz: number, y = 0): ZoneSpec => {
      const cx = (ax + bx) / 2;
      const cz = (az + bz) / 2;
      const m = 0.8; // keep anchors off the walls
      return {
        slot, tag,
        bounds: { min: [ax, y, az], max: [bx, y + WALL_H, bz] },
        floorY: y,
        anchors: {
          center: [cx, y, cz],
          corner_ne: [bx - m, y, bz - m], corner_nw: [ax + m, y, bz - m], corner_se: [bx - m, y, az + m], corner_sw: [ax + m, y, az + m],
          wall_n: [cx, y + 1.4, bz - T / 2 - 0.12], wall_s: [cx, y + 1.4, az + T / 2 + 0.12],
          wall_e: [bx - T / 2 - 0.12, y + 1.4, cz], wall_w: [ax + T / 2 + 0.12, y + 1.4, cz],
          ...(y ? doorAnchors(ax, bx, az, bz, upDoors, y) : doorAnchors(ax, bx, az, bz)),
        },
      };
    };
    const hall = room("main_room", "hall", x1, x2, zMid, zBack);
    // the staircase takes the hall's back wall and its north-east corner
    if (upper) for (const k of ["wall_n", "corner_ne"]) delete hall.anchors[k];
    const zones: ZoneSpec[] = [
      { slot: "yard", tag: "outside", bounds: { min: [x0 - 4, 0, zFront - YARD], max: [x3 + 4, 3, zFront] }, floorY: 0,
        anchors: { spawn_pad: [0, 0, zFront - YARD + 2], gate: [0, 0, zFront - 1.2], corner_e: [x3 + 2, 0, zFront - YARD / 2], corner_w: [x0 - 2, 0, zFront - YARD / 2] } },
      room("entrance", "entrance", x1, x2, zFront, zMid),
      room("room_sw", "room", x0, x1, zFront, zMid),
      room("room_se", "room", x2, x3, zFront, zMid),
      room("room_nw", "room", x0, x1, zMid, zBack),
      hall,
      room("room_ne", "room", x2, x3, zMid, zBack),
      ...(upper ? [room("upper_hall", "hall", x1, x3, zBack, zUp, WALL_H), room("upper_room", "room", x0, x1, zBack, zUp, WALL_H)] : []),
    ];
    // the back of the house: behind the upper floor when there is one
    const zRear = upper ? zUp : zBack;

    return {
      packId: this.id,
      version: this.version,
      zones,
      statics,
      maxProp: 2.4,
      cameraBounds: { min: [x0 - 4, -1, zFront - YARD], max: [x3 + 4, 12, zRear] },
      // a race loop round the house: across the front yard, then a drive (laid only for a race)
      // down each side and behind, as wide as the yard reaches past the walls
      track: {
        points: [[0, 0, zFront - YARD / 2], [x3 + 2, 0, zFront - YARD / 2], [x3 + 2, 0, zRear + 2], [x0 - 2, 0, zRear + 2], [x0 - 2, 0, zFront - YARD / 2]],
        width: 3.4,
        ground: [
          box("room_sw", [x0 - 2, -0.1, (zFront + zRear + 4) / 2], [4, 0.2, zRear + 4 - zFront], "floor"),
          box("room_se", [x3 + 2, -0.1, (zFront + zRear + 4) / 2], [4, 0.2, zRear + 4 - zFront], "floor"),
          box("main_room", [0, -0.1, zRear + 2], [W, 0.2, 4], "floor"),
          box("room_sw", [x0 - 4 - T / 2, 1, (zFront + zRear + 4) / 2], [T, 2, zRear + 4 - zFront], "wall"),
          box("room_se", [x3 + 4 + T / 2, 1, (zFront + zRear + 4) / 2], [T, 2, zRear + 4 - zFront], "wall"),
          box("main_room", [0, 1, zRear + 4 + T / 2], [W + 8 + 2 * T, 2, T], "wall"),
        ],
      },
      notes: [
        `interior ${W}×${D} m, ${WALL_H} m walls, ${DOOR_W}×${DOOR_H} m doorways, cutaway (no ceilings)`,
        ...(upper ? [`upper floor ${W}×${UPPER_D} m, ${WALL_H} m up a staircase in the main hall`] : []),
      ],
    };
  },
};
