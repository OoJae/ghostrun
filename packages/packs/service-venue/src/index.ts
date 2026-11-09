// service_venue: a shop, café, restaurant or bank floor at real scale (3 m walls, 0.9 × 2.1 m
// doorways, no ceilings: the cutaway camera looks down into every room). From the street you come
// through an entrance vestibule onto the customer floor (tables, a queue in front of the counter),
// the counter runs across it with a flap at one end to the staff side, and behind that a back room
// (a kitchen, an office) leads on to a storeroom (a stockroom, a vault) you reach only through it:
// a lock-and-key chain by construction. For "a café where you take orders", "a bank heist", "a
// sushi bar".
import { stream } from "@ghostrun/detmath";
import type { Vec3 } from "@ghostrun/ir";
import { DOOR_H, DOOR_W, driveRound, r2, Shell, T, WALL_H, YARD } from "@ghostrun/pack-common";
import type { LayoutPack, LayoutParamSpec, PackLayout, ZoneSpec } from "@ghostrun/plugin-api";

export interface ServiceVenueParams {
  [k: string]: number;
  width: number; // x extent of the building (m)
  depth: number; // z extent (m)
}

/** The counter: how high its top is, how deep, and the flap left open at one end. */
export const COUNTER_H = 1.05;
const COUNTER_D = 0.7;
const FLAP = 1.2;
/** The staff side behind the counter, from the counter's middle line to the back wall. */
const STAFF_D = 3.2;
/** The entrance vestibule. */
const VEST_W = 3.6;
const VEST_D = 2.6;

/** What a structural edit may change: the floor's size. */
export const SERVICE_VENUE_SCHEMA: Readonly<Record<string, LayoutParamSpec>> = {
  width: { min: 20, max: 32, step: 2, label: "venue", unit: "m wide", line: "the building's width (the counter runs across it)" },
  depth: { min: 16, max: 24, step: 2, label: "venue", unit: "m deep", line: "the building's depth (more room for tables)" },
};

export const serviceVenue: LayoutPack<ServiceVenueParams> = {
  id: "service_venue",
  version: "0.1.0",
  modes: ["play", "wander"],
  defaults: { width: 24, depth: 18 },
  schema: SERVICE_VENUE_SCHEMA,
  ci: { seeds: Array.from({ length: 50 }, (_, i) => i + 1) },

  generate({ seed, params }): PackLayout {
    const rng = stream(seed, "pack:service_venue");
    const W = params.width;
    const D = params.depth;
    const x0 = -W / 2;
    const x3 = W / 2;
    const zFront = -D / 2;
    const zBack = D / 2;
    const back = r2(5 + rng()); // back row depth
    const zR = r2(zBack - back); // the back row's front wall
    const zK = r2(zR - STAFF_D); // the counter's middle line
    const zSeat = r2(zK - COUNTER_D / 2); // the customer side ends at the counter's face
    const xB = r2(x0 + W * (0.5 + rng() * 0.12)); // back room | storeroom
    const flapEast = rng() < 0.5;
    const xe = r2(x0 + 4 + VEST_W / 2 + rng() * (W - 8 - VEST_W)); // the vestibule's middle
    const [v0, v1] = [r2(xe - VEST_W / 2), r2(xe + VEST_W / 2)];
    const zV = r2(zFront + VEST_D);
    /** A door along a wall from a to b, kept `keep` m from each end. */
    const doorAt = (a: number, b: number, keep = b - a >= 5.5 ? 2 : 1.6) => r2(a + keep + rng() * (b - a - 2 * keep));
    const inner = r2(xe + (rng() - 0.5) * 1.2); // the vestibule's inner door
    const kitchenDoor = doorAt(x0, xB);
    const storeDoor = doorAt(zR, zBack);

    const s = new Shell();
    const yard = s.yard("yard", x0, x3, zFront, xe);
    // floors, one per zone and never overlapping (the customer floor in three pieces round the vestibule)
    s.slab("entrance", v0, v1, zFront, zV, 0);
    s.slab("seating", x0, v0, zFront, zK, 0);
    s.slab("seating", v1, x3, zFront, zK, 0);
    s.slab("seating", v0, v1, zV, zK, 0);
    s.slab("counter", x0, x3, zK, zR, 0);
    s.slab("back_room", x0, xB, zR, zBack, 0);
    s.slab("storeroom", xB, x3, zR, zBack, 0);
    // outer walls, each owned by the zone it bounds; the front door opens into the vestibule
    s.wall("entrance", "x", zFront, x0, x3, xe);
    s.wall("back_room", "x", zBack, x0, xB, null);
    s.wall("storeroom", "x", zBack, xB, x3, null);
    for (const [x, slot] of [[x0, "back_room"], [x3, "storeroom"]] as const) {
      s.wall("seating", "z", x, zFront, zK, null);
      s.wall("counter", "z", x, zK, zR, null);
      s.wall(slot, "z", x, zR, zBack, null);
    }
    // the vestibule
    s.wall("entrance", "z", v0, zFront, zV, null);
    s.wall("entrance", "z", v1, zFront, zV, null);
    s.wall("entrance", "x", zV, v0, v1, inner);
    // the back row: the kitchen door off the staff side, the storeroom only through the back room
    s.wall("back_room", "x", zR, x0, xB, kitchenDoor);
    s.wall("storeroom", "x", zR, xB, x3, null);
    s.wall("storeroom", "z", xB, zR, zBack, storeDoor);
    // the counter, wall to wall but for the flap
    const [c0, c1] = flapEast ? [x0 + T / 2, x3 - T / 2 - FLAP] : [x0 + T / 2 + FLAP, x3 - T / 2];
    s.box("counter", [r2((c0 + c1) / 2), COUNTER_H / 2, zK], [r2(c1 - c0), COUNTER_H, COUNTER_D], "wall");
    const cMid = r2((c0 + c1) / 2);
    // the till stands on the counter top near its customer edge (in reach of both sides), a little to
    // the flap side of its middle
    const till = r2(cMid + (flapEast ? 1 : -1) * Math.min(2, (c1 - c0) / 4));

    // the customer floor: tables beside the vestibule and nearer the counter, a queue before the counter
    const seatD = zSeat - zFront;
    const zt1 = r2(zFront + 2);
    const zt2 = r2(Math.max(zFront + 4.4, zSeat - 2.6));
    const [tw, te] = [r2(x0 + 2.4), r2(x3 - 2.4)];
    const far = xe > (x0 + x3) / 2 ? r2((x0 + v0) / 2) : r2((v1 + x3) / 2); // the front wall away from the vestibule
    const m = 0.8;
    const seating: ZoneSpec = {
      slot: "seating", tag: "hall",
      bounds: { min: [x0, 0, zFront], max: [x3, WALL_H, zSeat] },
      floorY: 0,
      anchors: {
        center: [r2((x0 + x3) / 2), 0, r2((zV + zSeat) / 2)],
        // the corner by the flap stands further in, so nothing put there blocks the way behind the counter
        corner_nw: [r2(x0 + (flapEast ? m : 2.4)), 0, r2(zSeat - m - 0.35)], corner_ne: [r2(x3 - (flapEast ? 2.4 : m)), 0, r2(zSeat - m - 0.35)],
        corner_sw: [r2(x0 + m), 0, r2(zFront + m)], corner_se: [r2(x3 - m), 0, r2(zFront + m)],
        table_1: [tw, 0, zt1], table_2: [tw, 0, zt2], table_3: [te, 0, zt1], table_4: [te, 0, zt2],
        counter_front: [cMid, 0, r2(zSeat - 0.9)],
        queue: [r2(flapEast ? cMid + 2 : cMid - 2), 0, r2(zSeat - 1.8)],
        wall_w: [r2(x0 + T / 2 + 0.12), 1.4, r2(zFront + seatD / 2)], wall_e: [r2(x3 - T / 2 - 0.12), 1.4, r2(zFront + seatD / 2)],
        wall_s: [far, 1.4, r2(zFront + T / 2 + 0.12)],
        doorway_s: [inner, 0, zV],
      } as Record<string, Vec3>,
    };
    const staffMid = r2((zK + COUNTER_D / 2 + zR) / 2);
    // the back bar stands against the back wall, away from the kitchen door
    const backBar = r2(kitchenDoor - x0 > xB - kitchenDoor ? (x0 + kitchenDoor) / 2 : Math.min((kitchenDoor + x3) / 2, x3 - 3));
    const counter: ZoneSpec = {
      slot: "counter", tag: "counter",
      bounds: { min: [x0, 0, r2(zK + COUNTER_D / 2)], max: [x3, WALL_H, zR] },
      floorY: 0,
      anchors: {
        center: [r2((x0 + x3) / 2 + (flapEast ? -3 : 3)), 0, staffMid],
        till: [till, COUNTER_H, r2(zK - COUNTER_D / 2 + 0.15)],
        behind_counter: [cMid, 0, r2(zK + COUNTER_D / 2 + 0.8)],
        // the kitchen pass beside the kitchen door (never in front of it), on the side away from the back bar
        pass: [r2(kitchenDoor + (kitchenDoor - x0 > xB - kitchenDoor ? 1.6 : -1.6)), 0, r2(zR - 0.5)],
        doorway_n: [kitchenDoor, 0, zR],
        back_bar: [backBar, 0, r2(zR - 0.5)],
        corner_w: [r2(x0 + (flapEast ? m : 2.6)), 0, staffMid],
        corner_e: [r2(x3 - (flapEast ? 2.6 : m)), 0, staffMid],
      } as Record<string, Vec3>,
    };
    const xs = r2((xB + x3) / 2);
    const zones: ZoneSpec[] = [
      yard,
      s.room("entrance", "entrance", v0, v1, zFront, zV),
      seating,
      counter,
      s.room("back_room", "room", x0, xB, zR, zBack, 0, { stove: [r2((x0 + xB) / 2), 0, r2(zBack - 0.7)], fridge: [r2(x0 + 0.7), 0, r2((zR + zBack) / 2)] }),
      s.room("storeroom", "room", xB, x3, zR, zBack, 0, { shelves: [xs, 0, r2(zBack - 0.7)], safe: [r2(x3 - 0.9), 0, r2((zR + zBack) / 2)] }),
    ];
    return {
      packId: this.id,
      version: this.version,
      zones,
      statics: s.statics,
      maxProp: 2.4,
      cameraBounds: { min: [x0 - 4, -1, zFront - YARD], max: [x3 + 4, 12, zBack] },
      track: driveRound(x0, x3, zFront, zBack, { west: "seating", east: "seating", back: "back_room" }),
      notes: [`venue ${W}×${D} m, ${WALL_H} m walls, ${DOOR_W}×${DOOR_H} m doorways, a ${COUNTER_H} m counter with a flap, cutaway (no ceilings)`],
    };
  },
};
