// stage: a theatre or concert hall at real scale (3 m walls, 0.9 × 2.1 m doorways, no ceilings:
// the cutaway camera looks down into it). From the street through the foyer (a box office, a bar)
// into the house: rows of seats with a centre aisle and two side aisles, a sound booth at the back.
// At the front a pit (an orchestra's, or the crowd's at a gig) sunk one 0.3 m step. The stage
// stands a metre up behind it, reached on foot by stairs at both sides that climb to doorways in
// the proscenium wall into the wings; the wings open onto the stage past the masking flats and lead
// through doorways upstage into the backstage corridor. Over the stage hangs the lighting rig:
// anchors for lights, a mirror ball, a banner. For "a rock concert", "a magic show", "a play".
import { stream } from "@ghostrun/detmath";
import type { Vec3 } from "@ghostrun/ir";
import { DOOR_H, DOOR_W, driveRound, MARGIN, r2, Shell, WALL_H, YARD } from "@ghostrun/pack-common";
import type { LayoutPack, LayoutParamSpec, PackLayout, ZoneSpec } from "@ghostrun/plugin-api";

export interface StageParams {
  [k: string]: number;
  width: number; // x extent of the hall (m)
  depth: number; // z extent (m)
}

/** How high the stage (and the wings and backstage) stand, how deep the pit is sunk. */
export const STAGE_H = 1;
export const PIT_DROP = 0.3;
/** The lighting rig hangs this high over the stage floor. */
export const RIG_H = 3.2; // (low enough that a light hung there is looked at from the stage floor)
const FOYER_D = 4;
const PIT_D = 3;
const BACK_D = 4.5;
const STAIR_W = 1.6;
const STEP_RUN = 0.4;
const STEP_RISE = 0.25;
/** The proscenium wall stands this far upstage of the stage's front edge (the stairs arrive in front of it). */
const APRON = 0.6;
/** The gaps left at both ends of a masking flat between a wing and the stage. */
const LEG_GAP = 1.6;

/** What a structural edit may change: the hall's size. */
export const STAGE_SCHEMA: Readonly<Record<string, LayoutParamSpec>> = {
  width: { min: 24, max: 36, step: 2, label: "hall", unit: "m wide", line: "the hall's width (the stage and both wings across it)" },
  depth: { min: 26, max: 36, step: 2, label: "hall", unit: "m deep", line: "the hall's depth (more rows of seats)" },
};

export const stage: LayoutPack<StageParams> = {
  id: "stage",
  version: "0.1.0",
  modes: ["play", "wander"],
  defaults: { width: 28, depth: 30 },
  schema: STAGE_SCHEMA,
  ci: { seeds: Array.from({ length: 50 }, (_, i) => i + 1) },

  generate({ seed, params }): PackLayout {
    const rng = stream(seed, "pack:stage");
    const W = params.width;
    const D = params.depth;
    const x0 = -W / 2;
    const x3 = W / 2;
    const zFront = -D / 2;
    const zBack = D / 2;
    const stageD = r2(6.5 + rng() * 1.5);
    const xs = r2((W * (0.5 + rng() * 0.08)) / 2); // half the stage's width
    const zFoy = r2(zFront + FOYER_D);
    const zBs = r2(zBack - BACK_D); // the upstage wall, backstage behind it
    const zSF = r2(zBs - stageD); // the stage's front edge
    const zP = r2(zSF + APRON); // the proscenium wall
    const zPit = r2(zSF - PIT_D); // the pit's house edge
    const xp = r2(xs - 1); // half the pit's width
    const xw = r2((x0 - xs) / 2); // the middle of the west wing (the east one mirrors it)
    const front = r2((rng() - 0.5) * 4);
    const houseDoors = [r2(-W / 4 + (rng() - 0.5) * 2), r2(W / 4 + (rng() - 0.5) * 2)] as const;
    const backDoor = (a: number, b: number) => r2(a + 1.6 + rng() * (b - a - 3.2));
    const backDoors = [backDoor(x0, -xs), backDoor(xs, x3)] as const;

    const s = new Shell();
    const yard = s.yard("yard", x0, x3, zFront, front);
    // floors: the foyer, the house (with a strip each side of the pit), the pit one step down
    s.slab("foyer", x0, x3, zFront, zFoy, 0);
    s.slab("seating", x0, x3, zFoy, zPit, 0);
    s.slab("seating", x0, -xp, zPit, zSF, 0);
    s.slab("seating", xp, x3, zPit, zSF, 0);
    s.slab("pit", -xp, xp, zPit, zSF, -PIT_DROP);
    // the stage block, a metre up: the stage, the wings, backstage
    s.slab("stage", -xs, xs, zSF, zBs, STAGE_H, STAGE_H, "ledge");
    s.slab("wing_w", x0, -xs, zSF, zBs, STAGE_H, STAGE_H, "ledge");
    s.slab("wing_e", xs, x3, zSF, zBs, STAGE_H, STAGE_H, "ledge");
    s.slab("backstage", x0, x3, zBs, zBack, STAGE_H, STAGE_H, "ledge");
    // stairs up from each side of the house to the wings' doorways (0.25 m steps, then the stage block)
    const steps = Math.round(STAGE_H / STEP_RISE) - 1;
    for (const [x, slot] of [[xw, "wing_w"], [-xw, "wing_e"]] as const) {
      for (let k = 1; k <= steps; k++) {
        const z1 = r2(zSF - (steps - k) * STEP_RUN);
        s.slab(slot, r2(x - STAIR_W / 2), r2(x + STAIR_W / 2), r2(z1 - STEP_RUN), z1, r2(k * STEP_RISE), r2(k * STEP_RISE), "ledge");
      }
    }
    // outer walls (a metre taller beside and behind the stage block, so they stand 3 m over it)
    const tall = WALL_H + STAGE_H;
    s.wall("foyer", "x", zFront, x0, x3, front);
    s.wall("backstage", "x", zBack, x0, x3, null, 0, tall);
    for (const [x, wing] of [[x0, "wing_w"], [x3, "wing_e"]] as const) {
      s.wall("foyer", "z", x, zFront, zFoy, null);
      s.wall("seating", "z", x, zFoy, zSF, null);
      s.wall(wing, "z", x, zSF, zBs, null, 0, tall);
      s.wall("backstage", "z", x, zBs, zBack, null, 0, tall);
    }
    // the foyer's two doors into the back of the house
    s.wall("foyer", "x", zFoy, x0, 0, houseDoors[0]);
    s.wall("foyer", "x", zFoy, 0, x3, houseDoors[1]);
    // the proscenium wall over each wing, its doorway at the top of the stairs
    s.wall("wing_w", "x", zP, x0, -xs, xw, STAGE_H);
    s.wall("wing_e", "x", zP, xs, x3, -xw, STAGE_H);
    // masking flats between the wings and the stage, open at both ends
    for (const [x, wing] of [[-xs, "wing_w"], [xs, "wing_e"]] as const) s.wall(wing, "z", x, r2(zP + LEG_GAP), r2(zBs - LEG_GAP), null, STAGE_H);
    // the upstage wall, a doorway from each wing into backstage
    s.wall("backstage", "x", zBs, x0, -xs, backDoors[0], STAGE_H);
    s.wall("backstage", "x", zBs, -xs, xs, null, STAGE_H);
    s.wall("backstage", "x", zBs, xs, x3, backDoors[1], STAGE_H);
    // rows of seats: a centre aisle 2 m wide and side aisles 1.5 m, 1.4 m from row to row
    const rows: number[] = [];
    for (let z = r2(zPit - 2); z - 0.3 >= zFoy + 2.5; z = r2(z - 1.4)) rows.push(z);
    for (const z of rows) {
      s.slab("seating", r2(x0 + 1.6), -1, r2(z - 0.3), r2(z + 0.3), 0.45, 0.45, "wall");
      s.slab("seating", 1, r2(x3 - 1.6), r2(z - 0.3), r2(z + 0.3), 0.45, 0.45, "wall");
    }
    const midRows = rows.length ? r2((rows[0]! + rows[rows.length - 1]!) / 2) : r2((zFoy + zPit) / 2);

    const m = MARGIN;
    const foyer = s.room("foyer", "entrance", x0, x3, zFront, zFoy, 0, { box_office: [r2(x0 + 2.5), 0, r2(zFoy - 0.9)], bar: [r2(x3 - 2.5), 0, r2(zFoy - 0.9)] });
    const seating: ZoneSpec = s.room("seating", "hall", x0, x3, zFoy, zSF, 0, {
      center: [0, 0, midRows],
      aisle_l: [r2(x0 + 0.8), 0, midRows],
      aisle_r: [r2(x3 - 0.8), 0, midRows],
      front_row: [0, 0, r2(zPit - 1)],
      booth: [0, 0, r2(zFoy + 1.2)],
      corner_nw: [r2(x0 + m), 0, r2(zSF - m)], corner_ne: [r2(x3 - m), 0, r2(zSF - m)],
    });
    for (const k of ["wall_n", "wall_e", "wall_w"]) delete seating.anchors[k]; // north is the stage; the side walls stay bare (the fill prompt's size budget)
    const pit: ZoneSpec = {
      slot: "pit", tag: "pit",
      bounds: { min: [-xp, -PIT_DROP, zPit], max: [xp, WALL_H, zSF] },
      floorY: -PIT_DROP,
      anchors: { center: [0, -PIT_DROP, r2((zPit + zSF) / 2)], pit_l: [r2(-xp / 2), -PIT_DROP, r2((zPit + zSF) / 2)], pit_r: [r2(xp / 2), -PIT_DROP, r2((zPit + zSF) / 2)], podium: [0, -PIT_DROP, r2(zPit + 0.7)] },
    };
    const mid = r2((zSF + zBs) / 2);
    const y = STAGE_H;
    const stageZone: ZoneSpec = {
      slot: "stage", tag: "stage",
      bounds: { min: [-xs, y, zSF], max: [xs, y + WALL_H, zBs] },
      floorY: y,
      anchors: {
        center: [0, y, mid],
        downstage: [0, y, r2(zSF + 1.2)],
        upstage: [0, y, r2(zBs - 1.2)],
        stage_l: [r2(-xs + 2), y, mid],
        stage_r: [r2(xs - 2), y, mid],
        backdrop: [0, y, r2(zBs - 0.5)], // (on the floor against the upstage wall: a backdrop stands up from there)
        rig_l: [r2(-xs / 2), y + RIG_H, r2(zSF + 2)], rig_c: [0, y + RIG_H, r2(zSF + 2)], rig_r: [r2(xs / 2), y + RIG_H, r2(zSF + 2)],
      },
    };
    const wing = (slot: string, ax: number, bx: number, outer: "w" | "e"): ZoneSpec => {
      const z = s.room(slot, "wing", ax, bx, zP, zBs, y, { rack: [outer === "w" ? r2(ax + 0.8) : r2(bx - 0.8), y, mid] }, { walls: false });
      // the inner corners stand in the ways onto the stage
      for (const k of outer === "w" ? ["corner_ne", "corner_se"] : ["corner_nw", "corner_sw"]) delete z.anchors[k];
      return z;
    };
    const backstage = s.room("backstage", "room", x0, x3, zBs, zBack, y, { rack: [r2(-3), y, r2(zBack - 0.8)], crates: [3, y, r2(zBack - 0.8)] }, { walls: false });
    const zones: ZoneSpec[] = [yard, foyer, seating, pit, stageZone, wing("wing_w", x0, -xs, "w"), wing("wing_e", xs, x3, "e"), backstage];
    return {
      packId: this.id,
      version: this.version,
      zones,
      statics: s.statics,
      maxProp: 2.4,
      cameraBounds: { min: [x0 - 4, -1, zFront - YARD], max: [x3 + 4, 13, zBack] },
      track: driveRound(x0, x3, zFront, zBack, { west: "seating", east: "seating", back: "backstage" }),
      notes: [`hall ${W}×${D} m, a stage ${r2(2 * xs)}×${stageD} m ${STAGE_H} m up with wings, backstage and a lighting rig, a pit, ${rows.length * 2} blocks of seats, ${WALL_H} m walls, ${DOOR_W}×${DOOR_H} m doorways, cutaway (no ceilings)`],
    };
  },
};
