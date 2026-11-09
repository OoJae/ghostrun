// puzzle_rooms: a chain of 3 to 6 small rooms, one after another, each joined to the next by a
// 0.9 × 2.1 m doorway a gate or a locked door can stand in, from the front yard to an exit yard
// behind the last room. The chain folds back on itself (east along the front row, west along the
// back) so it stays compact under the cutaway camera. Every room offers the same puzzle anchors on
// walls no doorway uses: a switch on a wall, a lever and a chest by another, a plate on the floor
// and a key in a corner, so "flip the switch to open the gate", "carry the key to the lock" and
// "stand on the plate" puzzles lay out cleanly in any room. The way in and the way on are
// doorway_in and doorway_out whatever side they are on.
import { stream } from "@ghostrun/detmath";
import type { Vec3 } from "@ghostrun/ir";
import { DOOR_H, DOOR_W, driveRound, r2, Shell, T, WALL_H, YARD } from "@ghostrun/pack-common";
import type { LayoutPack, LayoutParamSpec, PackLayout, ZoneSpec } from "@ghostrun/plugin-api";

export interface PuzzleRoomsParams {
  [k: string]: number;
  rooms: number; // how many rooms in the chain (3-6)
  size: number; // each room's side (m)
}

/** Depth of the exit yard behind the last room. */
export const EXIT_D = 5;
/** Doorways keep this far from a wall's ends, clear of what stands in the corners. */
const KEEP = 2.2;
/** A switch is on a wall at hip height (low enough that whoever flips it stands on the floor below it). */
export const SWITCH_Y = 0.5;

/** What a structural edit may change: how many rooms, and how big each is. */
export const PUZZLE_ROOMS_SCHEMA: Readonly<Record<string, LayoutParamSpec>> = {
  rooms: { min: 3, max: 6, step: 1, label: "rooms", line: "how many rooms in the chain: slots room_1 to room_N, then the exit" },
  size: { min: 6, max: 10, step: 1, label: "room size", unit: "m", line: "each room's width and depth" },
};

type Side = "n" | "s" | "e" | "w";
const DIR: Record<Side, [number, number]> = { n: [0, 1], s: [0, -1], e: [1, 0], w: [-1, 0] };
const ORDER: readonly Side[] = ["n", "e", "s", "w"];

export const puzzleRooms: LayoutPack<PuzzleRoomsParams> = {
  id: "puzzle_rooms",
  version: "0.1.0",
  modes: ["play", "wander"],
  defaults: { rooms: 4, size: 7 },
  schema: PUZZLE_ROOMS_SCHEMA,
  ci: { seeds: Array.from({ length: 50 }, (_, i) => i + 1) },

  generate({ seed, params }): PackLayout {
    const rng = stream(seed, "pack:puzzle_rooms");
    const N = params.rooms;
    const S = params.size;
    const c = Math.ceil(N / 2); // rooms along the front row
    const x0 = r2((-c * S) / 2);
    const x3 = r2((c * S) / 2);
    const zF = -S;
    // room k (1-based): east along the front row, then west along the back
    const cell = (k: number): [number, number] => (k <= c ? [k - 1, 0] : [2 * c - k, 1]);
    const at = new Map<string, number>();
    for (let k = 1; k <= N; k++) at.set(cell(k).join(","), k);
    const bounds = (k: number) => {
      const [col, row] = cell(k);
      const ax = r2(x0 + col * S);
      const az = row ? 0 : zF;
      return { ax, bx: r2(ax + S), az, bz: r2(az + S) };
    };
    const doorAt = (a: number, b: number) => r2(a + KEEP + rng() * (b - a - 2 * KEEP));
    const s = new Shell();
    // where each room's way in and way on are, and on which of its walls
    const ways = new Map<number, { in?: [Side, Vec3]; out?: [Side, Vec3] }>();
    const way = (k: number, key: "in" | "out", side: Side, p: Vec3) => ways.set(k, { ...ways.get(k), [key]: [side, p] });
    const flip: Record<Side, Side> = { n: "s", s: "n", e: "w", w: "e" };
    let frontDoor = 0;
    for (let k = 1; k <= N; k++) {
      const { ax, bx, az, bz } = bounds(k);
      const [col, row] = cell(k);
      s.slab(`room_${k}`, ax, bx, az, bz, 0);
      for (const side of ORDER) {
        const [dx, dz] = DIR[side];
        const other = at.get(`${col + dx},${row + dz}`);
        if (other !== undefined && other < k) continue; // the other room laid this wall
        const axis = side === "n" || side === "s" ? "x" : "z";
        const fixed = side === "n" ? bz : side === "s" ? az : side === "e" ? bx : ax;
        const [a, b] = axis === "x" ? [ax, bx] : [az, bz];
        const next = other !== undefined && Math.abs(other - k) === 1;
        const front = other === undefined && k === 1 && side === "s";
        const exit = other === undefined && k === N && side === "n";
        const door = next || front || exit ? doorAt(a, b) : null;
        s.wall(`room_${k}`, axis, fixed, a, b, door);
        if (door === null) continue;
        const p: Vec3 = axis === "x" ? [door, 0, fixed] : [fixed, 0, door];
        if (front) ((frontDoor = door), way(k, "in", side, p));
        else if (exit) way(k, "out", side, p);
        else (way(k, "out", side, p), way(other!, "in", flip[side], p));
      }
    }
    const yard = s.yard("yard", x0, x3, zF, frontDoor);
    // the exit yard behind the last room, fenced
    const last = bounds(N);
    const exitDoor = ways.get(N)!.out![1][0];
    s.slab("exit", last.ax, last.bx, S, S + EXIT_D, 0);
    s.box("exit", [r2(last.ax - T / 2), 1, r2(S + EXIT_D / 2)], [T, 2, EXIT_D], "wall");
    s.box("exit", [r2(last.bx + T / 2), 1, r2(S + EXIT_D / 2)], [T, 2, EXIT_D], "wall");
    s.box("exit", [r2((last.ax + last.bx) / 2), 1, r2(S + EXIT_D + T / 2)], [r2(S + 2 * T), 2, T], "wall");
    const exit: ZoneSpec = {
      slot: "exit", tag: "outside",
      bounds: { min: [last.ax, 0, S], max: [last.bx, 3, S + EXIT_D] },
      floorY: 0,
      anchors: {
        center: [r2((last.ax + last.bx) / 2), 0, r2(S + EXIT_D / 2 + 0.5)],
        gate: [exitDoor, 0, r2(S + 1.2)],
        corner_e: [r2(last.bx - 0.8), 0, r2(S + EXIT_D - 0.8)],
        corner_w: [r2(last.ax + 0.8), 0, r2(S + EXIT_D - 0.8)],
      },
    };

    // each room's puzzle anchors, on the walls no doorway uses (every room has two such walls)
    const rooms: ZoneSpec[] = [];
    for (let k = 1; k <= N; k++) {
      const { ax, bx, az, bz } = bounds(k);
      const w = ways.get(k)!;
      const used = new Set([w.in![0], w.out![0]]);
      // an outside wall first: a switch on a wall another room shares is a switch on both its faces
      // (whoever is next door stands as near to it, and the wall is between them)
      const [col, row] = cell(k);
      const inside = (d: Side) => (at.has(`${col + DIR[d][0]},${row + DIR[d][1]}`) ? 1 : 0);
      const [A, B] = ORDER.filter((x) => !used.has(x)).sort((p, q) => inside(p) - inside(q)) as [Side, Side];
      const cx = r2((ax + bx) / 2);
      const cz = r2((az + bz) / 2);
      const h = S / 2;
      const along = (d: Side): [number, number] => [-DIR[d][1], DIR[d][0]]; // along that wall
      const pt = (d: Side, off: number, side: number, y = 0): Vec3 => {
        const [nx, nz] = DIR[d];
        const [px, pz] = along(d);
        return [r2(cx + nx * off + px * side), y, r2(cz + nz * off + pz * side)];
      };
      rooms.push(
        s.room(`room_${k}`, "room", ax, bx, az, bz, 0, {
          doorway_in: w.in![1],
          doorway_out: w.out![1],
          switch: pt(A, h - T / 2 - 0.12, 0, SWITCH_Y),
          plate: pt(A, h - 2, 0),
          key: pt(A, h - 0.9, h - 0.9),
          lever: pt(B, h - 0.7, -1.2),
          chest: pt(B, h - 0.9, h - 0.9),
        }, { walls: false, doors: false }),
      );
    }
    const zRear = S + EXIT_D;
    return {
      packId: this.id,
      version: this.version,
      zones: [yard, ...rooms, exit],
      statics: s.statics,
      maxProp: 2.4,
      cameraBounds: { min: [x0 - 4, -1, zF - YARD], max: [x3 + 4, 12, zRear] },
      track: driveRound(x0, x3, zF, zRear, { west: "room_1", east: `room_${c}`, back: "exit" }),
      notes: [`puzzle rooms: a chain of ${N} rooms ${S}×${S} m, ${WALL_H} m walls, ${DOOR_W}×${DOOR_H} m doorways, cutaway (no ceilings)`],
    };
  },
};
