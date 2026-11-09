// Building blocks the newer packs share (service venue, puzzle rooms, stage, orrery): real-scale
// walls with 0.9 × 2.1 m doorways (a lintel over each), rooms whose anchors stand off the walls
// with every doorway offered from both sides, a front yard the spawn stands in, and a race drive
// round the outside of a building (laid only in a race). The same rules as the floor plan's, so a
// fill that knows one interior knows them all. Pure and deterministic: no trig, no clocks.
import type { Vec3 } from "@ghostrun/ir";
import type { PackLayout, PackStatic, ZoneSpec } from "@ghostrun/plugin-api";

export const WALL_H = 3;
export const DOOR_W = 0.9;
export const DOOR_H = 2.1;
/** Wall thickness. */
export const T = 0.2;
/** Depth of a front yard. */
export const YARD = 8;
/** Anchors keep this far in from a room's wall lines (the wall's face is T / 2 nearer). */
export const MARGIN = 0.8;

export const r2 = (x: number) => Math.round(x * 100) / 100;

export const box = (zoneSlot: string, pos: Vec3, size: Vec3, surf: PackStatic["surf"]): PackStatic => ({ zoneSlot, shape: "box", pos, rotY: 0, size, surf });

/** A doorway cut in a wall line: which axis the wall runs along, where the line is, where along it, on what floor. */
export interface Doorway {
  axis: "x" | "z";
  fixed: number;
  at: number;
  base: number;
}

/** The statics of a building as they are laid, and every doorway cut on the way. */
export class Shell {
  readonly statics: PackStatic[] = [];
  readonly doorways: Doorway[] = [];

  box(zoneSlot: string, pos: Vec3, size: Vec3, surf: PackStatic["surf"]): void {
    this.statics.push(box(zoneSlot, pos, size, surf));
  }

  /** A slab from (ax, az) to (bx, bz) whose top is at `top`, `h` thick. */
  slab(zoneSlot: string, ax: number, bx: number, az: number, bz: number, top: number, h = 0.2, surf: PackStatic["surf"] = "floor"): void {
    this.box(zoneSlot, [r2((ax + bx) / 2), r2(top - h / 2), r2((az + bz) / 2)], [r2(bx - ax), h, r2(bz - az)], surf);
  }

  /** A wall from a to b along one axis at `fixed`, standing on `base`, with a doorway centred at `door` (none: null). */
  wall(slot: string, axis: "x" | "z", fixed: number, a: number, b: number, door: number | null, base = 0, h = WALL_H): void {
    const seg = (s: number, e: number, y0: number, y1: number) => {
      if (e - s < 0.05) return;
      const mid = r2((s + e) / 2);
      const len = r2(e - s);
      const pos: Vec3 = axis === "x" ? [mid, r2(base + (y0 + y1) / 2), fixed] : [fixed, r2(base + (y0 + y1) / 2), mid];
      const size: Vec3 = axis === "x" ? [len, r2(y1 - y0), T] : [T, r2(y1 - y0), len];
      this.box(slot, pos, size, "wall");
    };
    if (door === null) {
      seg(a, b, 0, h);
      return;
    }
    seg(a, door - DOOR_W / 2, 0, h);
    seg(door + DOOR_W / 2, b, 0, h);
    seg(door - DOOR_W / 2, door + DOOR_W / 2, DOOR_H, h); // lintel
    this.doorways.push({ axis, fixed, at: door, base });
  }

  /** The doorways in the walls round a room, named by side (a second on one side gets a 2). */
  doorAnchors(ax: number, bx: number, az: number, bz: number, y = 0): Record<string, Vec3> {
    const near = (p: number, q: number) => Math.abs(p - q) < 0.01;
    const out: Record<string, Vec3> = {};
    for (const d of this.doorways) {
      if (!near(d.base, y)) continue;
      const along = d.axis === "x" ? d.at > ax && d.at < bx : d.at > az && d.at < bz;
      if (!along) continue;
      const side = d.axis === "x" ? (near(d.fixed, bz) ? "n" : near(d.fixed, az) ? "s" : "") : near(d.fixed, bx) ? "e" : near(d.fixed, ax) ? "w" : "";
      if (!side) continue;
      const name = out[`doorway_${side}`] ? `doorway_${side}2` : `doorway_${side}`;
      if (!out[name]) out[name] = d.axis === "x" ? [d.at, y, d.fixed] : [d.fixed, y, d.at];
    }
    return out;
  }

  /**
   * A room between wall lines ax..bx and az..bz on floor y: its centre and corners (MARGIN in),
   * its walls at eye height (pictures, switches, screens), its doorways, and the pack's own anchors.
   */
  room(slot: string, tag: string, ax: number, bx: number, az: number, bz: number, y = 0, extra: Record<string, Vec3> = {}, opts: { walls?: boolean; doors?: boolean } = {}): ZoneSpec {
    const cx = r2((ax + bx) / 2);
    const cz = r2((az + bz) / 2);
    const m = MARGIN;
    /**
     * Where along a wall a picture or a screen hangs: its middle, or, when a doorway is near it,
     * the middle of the longest stretch of wall the doorways leave (never over a door).
     */
    const along = (axis: "x" | "z", fixed: number, a: number, b: number): number => {
      const doors = this.doorways.filter((d) => d.axis === axis && Math.abs(d.fixed - fixed) < 0.01 && Math.abs(d.base - y) < 0.01 && d.at > a && d.at < b).map((d) => d.at).sort((p, q) => p - q);
      const mid = (a + b) / 2;
      if (!doors.some((d) => Math.abs(d - mid) < DOOR_W / 2 + 0.9)) return r2(mid);
      const cuts = [a, ...doors.flatMap((d) => [d - DOOR_W / 2, d + DOOR_W / 2]), b];
      let best: [number, number] = [a, a];
      for (let i = 0; i < cuts.length; i += 2) if (cuts[i + 1]! - cuts[i]! > best[1] - best[0]) best = [cuts[i]!, cuts[i + 1]!];
      return r2((best[0] + best[1]) / 2);
    };
    return {
      slot, tag,
      bounds: { min: [ax, y, az], max: [bx, y + WALL_H, bz] },
      floorY: y,
      anchors: {
        center: [cx, y, cz],
        corner_ne: [r2(bx - m), y, r2(bz - m)], corner_nw: [r2(ax + m), y, r2(bz - m)], corner_se: [r2(bx - m), y, r2(az + m)], corner_sw: [r2(ax + m), y, r2(az + m)],
        ...(opts.walls !== false
          ? {
              wall_n: [along("x", bz, ax, bx), r2(y + 1.4), r2(bz - T / 2 - 0.12)], wall_s: [along("x", az, ax, bx), r2(y + 1.4), r2(az + T / 2 + 0.12)],
              wall_e: [r2(bx - T / 2 - 0.12), r2(y + 1.4), along("z", bx, az, bz)], wall_w: [r2(ax + T / 2 + 0.12), r2(y + 1.4), along("z", ax, az, bz)],
            }
          : {}),
        ...(opts.doors !== false ? this.doorAnchors(ax, bx, az, bz, y) : {}),
        ...extra,
      } as Record<string, Vec3>,
    };
  }

  /**
   * The front yard: ground W + 8 m wide and YARD deep in front of the wall line zFront, fenced on
   * its three open sides, the spawn pad near its far edge and the gate just outside the front door.
   */
  yard(slot: string, x0: number, x3: number, zFront: number, door: number): ZoneSpec {
    const W = x3 - x0;
    const cx = r2((x0 + x3) / 2);
    this.box(slot, [cx, -0.1, r2(zFront - YARD / 2)], [r2(W + 8), 0.2, YARD], "floor");
    this.box(slot, [r2(x0 - 4 - T / 2), 1, r2(zFront - YARD / 2)], [T, 2, YARD], "wall");
    this.box(slot, [r2(x3 + 4 + T / 2), 1, r2(zFront - YARD / 2)], [T, 2, YARD], "wall");
    this.box(slot, [cx, 1, r2(zFront - YARD - T / 2)], [r2(W + 8), 2, T], "wall");
    return {
      slot, tag: "outside",
      bounds: { min: [r2(x0 - 4), 0, r2(zFront - YARD)], max: [r2(x3 + 4), 3, zFront] },
      floorY: 0,
      anchors: { spawn_pad: [door, 0, r2(zFront - YARD + 2)], gate: [door, 0, r2(zFront - 1.2)], corner_e: [r2(x3 + 2), 0, r2(zFront - YARD / 2)], corner_w: [r2(x0 - 2), 0, r2(zFront - YARD / 2)] },
    };
  }
}

/**
 * A race loop round a building: across the front yard, then a drive (laid only for a race) down
 * each side and behind it, as wide as the yard reaches past the walls. The slots own the strips.
 */
export function driveRound(x0: number, x3: number, zFront: number, zRear: number, slots: { west: string; east: string; back: string }): NonNullable<PackLayout["track"]> {
  const W = x3 - x0;
  const cx = r2((x0 + x3) / 2);
  const zMid = r2((zFront + zRear + 4) / 2);
  const len = r2(zRear + 4 - zFront);
  return {
    points: [[cx, 0, r2(zFront - YARD / 2)], [r2(x3 + 2), 0, r2(zFront - YARD / 2)], [r2(x3 + 2), 0, r2(zRear + 2)], [r2(x0 - 2), 0, r2(zRear + 2)], [r2(x0 - 2), 0, r2(zFront - YARD / 2)]],
    width: 3.4,
    ground: [
      box(slots.west, [r2(x0 - 2), -0.1, zMid], [4, 0.2, len], "floor"),
      box(slots.east, [r2(x3 + 2), -0.1, zMid], [4, 0.2, len], "floor"),
      box(slots.back, [cx, -0.1, r2(zRear + 2)], [r2(W), 0.2, 4], "floor"),
      box(slots.west, [r2(x0 - 4 - T / 2), 1, zMid], [T, 2, len], "wall"),
      box(slots.east, [r2(x3 + 4 + T / 2), 1, zMid], [T, 2, len], "wall"),
      box(slots.back, [cx, 1, r2(zRear + 4 + T / 2)], [r2(W + 8 + 2 * T), 2, T], "wall"),
    ],
  };
}
