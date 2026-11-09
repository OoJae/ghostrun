// The conformance check catches what it says it does, on a floor it is shown broken copies of.
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LAWS } from "@ghostrun/ir";
import { loadNavNode } from "@ghostrun/nav/node";
import type { PackLayout, ZoneSpec } from "@ghostrun/plugin-api";
import { DOOR_H, DOOR_W, Shell } from "../src";
import { conformance } from "./conformance";

beforeAll(async () => {
  await loadNavNode();
});

/** Two 8 × 8 m rooms behind a yard, a doorway between them; `door` null walls the second off. */
function twoRooms(door: number | null = 0, ledge = 0): PackLayout {
  const s = new Shell();
  const yard = s.yard("yard", -8, 8, -4, 0);
  s.slab("a", -8, 8, -4, 4, 0);
  s.slab("b", -8, 8, 4, 12, ledge);
  s.wall("a", "x", -4, -8, 8, 0);
  s.wall("a", "x", 4, -8, 8, door);
  s.wall("b", "x", 12, -8, 8, null);
  s.wall("a", "z", -8, -4, 12, null);
  s.wall("a", "z", 8, -4, 12, null);
  const zones: ZoneSpec[] = [yard, s.room("a", "room", -8, 8, -4, 4), s.room("b", "room", -8, 8, 4, 12, ledge)];
  return { packId: "test", version: "0", zones, statics: s.statics, cameraBounds: { min: [-12, 0, -12], max: [12, 4, 12] }, notes: [] };
}
const check = (l: PackLayout) => conformance("test", l, 1, { spawn: { slot: "yard", anchor: "spawn_pad" } });

describe("conformance", () => {
  it("passes two rooms joined by a doorway", () => expect(check(twoRooms())).toEqual([]));

  it("catches a room walled off, an anchor in a wall, a spawn in geometry, a wrong-sized doorway and a ledge too far up", () => {
    expect(check(twoRooms(null)).some((p) => /^b\.center unreachable on foot/.test(p))).toBe(true);
    const inWall = twoRooms();
    inWall.zones[1]!.anchors.center = [-8, 0, 0];
    expect(check(inWall).some((p) => p.startsWith("a.center inside"))).toBe(true);
    const boxed = twoRooms();
    boxed.statics.push({ zoneSlot: "yard", shape: "box", pos: boxed.zones[0]!.anchors.spawn_pad!, rotY: 0, size: [1, 2, 1], surf: "wall" });
    expect(check(boxed).some((p) => p.startsWith("spawn inside"))).toBe(true);
    const wide = twoRooms();
    const lintel = wide.statics.find((s) => s.pos[1] - s.size[1] / 2 > 2 && s.pos[2] === 4)!;
    lintel.size = [1.4, lintel.size[1], lintel.size[2]];
    expect(check(wide).some((p) => /a\.doorway_n is 1\.40 × 2\.10 m/.test(p))).toBe(true);
    expect(check(twoRooms(0, 3)).some((p) => p.startsWith("zone b owns no ground"))).toBe(true);
    expect([DOOR_W, DOOR_H]).toEqual([0.9, 2.1]);
    expect(DEFAULT_LAWS.jumpsMax).toBe(1);
  });
});
