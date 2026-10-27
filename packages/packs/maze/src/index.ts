// maze: a seeded perfect maze (recursive backtracker) of 3 m cells and 2.6 m walls, entered from
// an outside start pad. Every cell is reachable; the exit is the cell farthest from the start.
// Anchors: start, exit, center, and up to four dead ends (good spots for keys and ghosts).
import { stream } from "@ghostrun/detmath";
import type { Vec3 } from "@ghostrun/ir";
import type { LayoutPack, PackLayout, PackStatic, ZoneSpec } from "@ghostrun/plugin-api";

export interface MazeParams {
  [k: string]: number;
  cols: number;
  rows: number;
}

const CELL = 3;
const H = 2.6;
const T = 0.3;
const box = (zoneSlot: string, pos: Vec3, size: Vec3, surf: PackStatic["surf"]): PackStatic => ({ zoneSlot, shape: "box", pos, rotY: 0, size, surf });

export const maze: LayoutPack<MazeParams> = {
  id: "maze",
  version: "0.1.0",
  modes: ["play", "wander"],
  defaults: { cols: 9, rows: 9 },
  ci: { seeds: Array.from({ length: 50 }, (_, i) => i + 1) },

  generate({ seed, params }): PackLayout {
    const rng = stream(seed, "pack:maze");
    const C = params.cols;
    const R = params.rows;
    const W = C * CELL;
    const D = R * CELL;
    const ox = -W / 2;
    const oz = -D / 2;
    // walls[r][c] = [east, north] present
    const east = Array.from({ length: R }, () => Array<boolean>(C).fill(true));
    const north = Array.from({ length: R }, () => Array<boolean>(C).fill(true));
    const seen = Array.from({ length: R }, () => Array<boolean>(C).fill(false));
    const dist = Array.from({ length: R }, () => Array<number>(C).fill(0));
    // iterative recursive backtracker from the south-middle cell (the entrance)
    const sc = Math.floor(C / 2);
    const stack: [number, number][] = [[0, sc]];
    seen[0]![sc] = true;
    while (stack.length) {
      const [r, c] = stack[stack.length - 1]!;
      const nbrs: [number, number][] = [];
      if (r > 0 && !seen[r - 1]![c]) nbrs.push([r - 1, c]);
      if (r < R - 1 && !seen[r + 1]![c]) nbrs.push([r + 1, c]);
      if (c > 0 && !seen[r]![c - 1]) nbrs.push([r, c - 1]);
      if (c < C - 1 && !seen[r]![c + 1]) nbrs.push([r, c + 1]);
      if (!nbrs.length) {
        stack.pop();
        continue;
      }
      const [nr, nc] = nbrs[Math.floor(rng() * nbrs.length)]!;
      if (nr === r + 1) north[r]![c] = false;
      else if (nr === r - 1) north[nr]![nc] = false;
      else if (nc === c + 1) east[r]![c] = false;
      else east[nr]![nc] = false;
      seen[nr]![nc] = true;
      dist[nr]![nc] = dist[r]![c]! + 1;
      stack.push([nr, nc]);
    }

    const statics: PackStatic[] = [];
    statics.push(box("maze", [0, -0.5, -3], [W + 4, 1, D + 10], "floor"));
    const cx = (c: number) => ox + c * CELL + CELL / 2;
    const cz = (r: number) => oz + r * CELL + CELL / 2;
    // outer walls; the entrance gap is in the south wall at the start cell
    for (let c = 0; c < C; c++) if (c !== sc) statics.push(box("maze", [cx(c), H / 2, oz], [CELL + T, H, T], "wall"));
    statics.push(box("maze", [0, H / 2, oz + D], [W + T, H, T], "wall"));
    statics.push(box("maze", [ox, H / 2, 0], [T, H, D + T], "wall"));
    statics.push(box("maze", [ox + W, H / 2, 0], [T, H, D + T], "wall"));
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (c < C - 1 && east[r]![c]) statics.push(box("maze", [ox + (c + 1) * CELL, H / 2, cz(r)], [T, H, CELL + T], "wall"));
        if (r < R - 1 && north[r]![c]) statics.push(box("maze", [cx(c), H / 2, oz + (r + 1) * CELL], [CELL + T, H, T], "wall"));
      }
    }
    // outside start area with low fence
    statics.push(box("start", [0, 0.5, oz - 6], [W + 4, 1, T], "wall"));

    // exit = farthest cell; dead ends = cells with three walls, farthest first
    let far: [number, number] = [0, sc];
    const ends: [number, number, number][] = [];
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (dist[r]![c]! > dist[far[0]]![far[1]]!) far = [r, c];
        const walls = (east[r]![c] ? 1 : 0) + (c === 0 || east[r]![c - 1] ? 1 : 0) + (north[r]![c] ? 1 : 0) + (r === 0 ? (c === sc ? 0 : 1) : north[r - 1]![c] ? 1 : 0);
        if (walls === 3 && !(r === 0 && c === sc)) ends.push([dist[r]![c]!, r, c]);
      }
    }
    ends.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
    const deadEnds = ends.filter(([, r, c]) => !(r === far[0] && c === far[1])).slice(0, 4);
    const anchors: Record<string, Vec3> = {
      exit: [cx(far[1]), 0, cz(far[0])],
      center: [cx(Math.floor(C / 2)), 0, cz(Math.floor(R / 2))],
      entrance: [cx(sc), 0, cz(0)],
    };
    deadEnds.forEach(([, r, c], i) => (anchors[`dead_end_${i + 1}`] = [cx(c), 0, cz(r)]));

    const zones: ZoneSpec[] = [
      { slot: "start", tag: "outside", bounds: { min: [ox, 0, oz - 6], max: [ox + W, 3, oz] }, floorY: 0, anchors: { spawn_pad: [0, 0, oz - 3], sign: [3, 1.2, oz - 0.3] } },
      { slot: "maze", tag: "maze", bounds: { min: [ox, 0, oz], max: [ox + W, H, oz + D] }, floorY: 0, anchors },
    ];
    return {
      packId: this.id,
      version: this.version,
      zones,
      statics,
      cameraBounds: { min: [ox - 2, -1, oz - 8], max: [ox + W + 2, 24, oz + D + 2] },
      notes: [`maze ${C}×${R} cells of ${CELL} m, exit ${dist[far[0]]![far[1]]} cells from the entrance`],
    };
  },
};
