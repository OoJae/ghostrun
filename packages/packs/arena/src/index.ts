// arena: a walled, mirror-symmetric field for team games, duels and sports. Cover blocks, two
// bases with goal anchors, hoop anchors above each end, and raised side platforms on a ledge one
// jump can't reach (two can) for "requires double jump" style mechanics.
import { stream } from "@ghostrun/detmath";
import type { Vec3 } from "@ghostrun/ir";
import type { LayoutPack, PackLayout, PackStatic, ZoneSpec } from "@ghostrun/plugin-api";

export interface ArenaParams {
  [k: string]: number;
  length: number;
  width: number;
}

const box = (zoneSlot: string, pos: Vec3, size: Vec3, surf: PackStatic["surf"]): PackStatic => ({ zoneSlot, shape: "box", pos, rotY: 0, size, surf });

export const arena: LayoutPack<ArenaParams> = {
  id: "arena",
  version: "0.1.0",
  modes: ["play", "wander"],
  defaults: { length: 44, width: 28 },
  ci: { seeds: Array.from({ length: 50 }, (_, i) => i + 1) },

  generate({ seed, params, laws }): PackLayout {
    const rng = stream(seed, "pack:arena");
    const L = params.length / 2;
    const Wd = params.width / 2;
    const statics: PackStatic[] = [];
    statics.push(box("midfield", [0, -0.5, 0], [params.length, 1, params.width], "floor"));
    for (const [pos, size] of [
      [[0, 2, Wd + 0.5], [params.length + 2, 4, 1]],
      [[0, 2, -Wd - 0.5], [params.length + 2, 4, 1]],
      [[L + 0.5, 2, 0], [1, 4, params.width]],
      [[-L - 0.5, 2, 0], [1, 4, params.width]],
    ] as [Vec3, Vec3][]) statics.push(box("midfield", pos, size, "wall"));

    // mirrored cover: generate one half, reflect it to the other (fairness by construction).
    // Cover keeps 2.5 m clear of every ground anchor (and its mirror image).
    const keepClear: [number, number][] = [[L - 3, 0], [L - 6, 0], [L - 8, Wd - 7], [L - 8, -Wd + 7], [0, 0], [0, 4], [0, -4]];
    const blocked = (x: number, z: number, sx: number, sz: number) =>
      keepClear.some(([ax, az]) => [[ax, az], [-ax, -az]].some(([bx, bz]) => Math.abs(x - bx!) < sx / 2 + 2.5 && Math.abs(z - bz!) < sz / 2 + 2.5));
    const half: [number, number, number, number][] = [];
    for (let i = 0, tries = 0; i < 4 && tries < 80; tries++) {
      const x = 5 + rng() * (L - 12);
      const z = (rng() - 0.5) * (params.width - 8);
      const sx = 1 + rng() * 2;
      const sz = 1 + rng() * 2.5;
      if (blocked(x, z, sx, sz) || blocked(-x, -z, sx, sz)) continue;
      half.push([x, z, sx, sz]);
      i++;
    }
    for (const [x, z, sx, sz] of half) {
      statics.push(box("west_half", [-x, 0.6, z], [sx, 1.2, sz], "wall"));
      statics.push(box("east_half", [x, 0.6, -z], [sx, 1.2, sz], "wall")); // point symmetry
    }

    // raised side platforms (one per side, mirrored), ledge between one and two jump apexes
    const ledge = Math.round(laws.jumpH * 1.6 * 10) / 10;
    statics.push(box("north_deck", [0, ledge / 2, Wd - 2.5], [12, ledge, 4], "ledge"));
    statics.push(box("south_deck", [0, ledge / 2, -Wd + 2.5], [12, ledge, 4], "ledge"));

    const zones: ZoneSpec[] = [
      { slot: "midfield", tag: "center", bounds: { min: [-8, 0, -Wd + 5], max: [8, 4, Wd - 5] }, floorY: 0,
        anchors: { center: [0, 0, 0], center_n: [0, 0, 4], center_s: [0, 0, -4], scoreboard: [0, 3, Wd - 0.15] } },
      { slot: "west_half", tag: "base", bounds: { min: [-L, 0, -Wd], max: [-8, 4, Wd] }, floorY: 0,
        anchors: { spawn_pad: [-L + 3, 0, 0], goal_ring: [-L + 6, 0, 0], hoop: [-L + 1.2, 3.05, 0], flank_n: [-L + 8, 0, Wd - 7], flank_s: [-L + 8, 0, -Wd + 7] } },
      { slot: "east_half", tag: "base", bounds: { min: [8, 0, -Wd], max: [L, 4, Wd] }, floorY: 0,
        anchors: { spawn_pad: [L - 3, 0, 0], goal_ring: [L - 6, 0, 0], hoop: [L - 1.2, 3.05, 0], flank_n: [L - 8, 0, Wd - 7], flank_s: [L - 8, 0, -Wd + 7] } },
      { slot: "north_deck", tag: "platform", bounds: { min: [-6, ledge, Wd - 4.5], max: [6, ledge + 4, Wd - 0.5] }, floorY: ledge,
        anchors: { deck_center: [0, ledge, Wd - 2.5], deck_w: [-4.5, ledge, Wd - 2.5], deck_e: [4.5, ledge, Wd - 2.5] } },
      { slot: "south_deck", tag: "platform", bounds: { min: [-6, ledge, -Wd + 0.5], max: [6, ledge + 4, -Wd + 4.5] }, floorY: ledge,
        anchors: { deck_center: [0, ledge, -Wd + 2.5], deck_w: [-4.5, ledge, -Wd + 2.5], deck_e: [4.5, ledge, -Wd + 2.5] } },
    ];
    return {
      packId: this.id,
      version: this.version,
      zones,
      statics,
      cameraBounds: { min: [-L, -1, -Wd], max: [L, 16, Wd] },
      notes: [`arena ${params.length}×${params.width} m, point-symmetric cover, decks on ${ledge} m ledges`],
      // a race loop: the line in the middle of the south side, round the far corners clear of the cover
      // and inside the decks, the north side, and back
      track: { points: [[0, 0, -(Wd - 8.5)], [L - 4, 0, -(Wd - 5)], [L - 4, 0, Wd - 5], [0, 0, Wd - 8.5], [-(L - 4), 0, Wd - 5], [-(L - 4), 0, -(Wd - 5)]], width: 6 },
    };
  },
};
