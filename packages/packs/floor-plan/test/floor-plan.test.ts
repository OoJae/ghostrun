import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LAWS, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { DOOR_H, DOOR_W, floorPlan } from "../src";

beforeAll(async () => {
  await loadNavNode();
});

function emptyWorld(seed: number, zones: { id: string; slot: string }[]): WorldBundle {
  return {
    v: 1, engine: "e", seed, mode: "wander", lang: "en",
    pack: { id: "floor_plan", version: "0", seed, params: {}, sub: [] },
    laws: DEFAULT_LAWS,
    zones: zones.map((z) => ({ id: z.id, src: "ai", layer: "gameplay", pack: "floor_plan", slot: z.slot, tag: "", name: z.id, parent: "" })),
    statics: [], entities: [], verbs: [], rules: [], states: [], cast: [], expects: [],
    cosmetic: { look: "showroom", mood: [0, 0, 0], timeOfDay: 12, weather: "clear", dress: [], posters: [] },
  };
}

describe("floor_plan pack", () => {
  it("every room is reachable on foot from the yard, for 50 seeds", () => {
    for (const seed of floorPlan.ci.seeds) {
      const layout = floorPlan.generate({ seed, params: floorPlan.defaults, sub: [], laws: DEFAULT_LAWS, harder: false });
      const slots = layout.zones.map((z) => z.slot);
      const { bundle } = placeWorld(emptyWorld(seed, slots.map((s) => ({ id: `z_${s}`, slot: s }))), layout);
      const nav = buildNav(bundle);
      const yard = layout.zones.find((z) => z.slot === "yard")!.anchors.spawn_pad!;
      for (const z of layout.zones) {
        const c = z.anchors.center ?? z.anchors.spawn_pad!;
        expect(nav.path(yard, c), `seed ${seed}: ${z.slot} unreachable`).not.toBeNull();
      }
      nav.destroy();
    }
  });

  it("uses real-scale doorways", () => {
    const layout = floorPlan.generate({ seed: 3, params: floorPlan.defaults, sub: [], laws: DEFAULT_LAWS, harder: false });
    const lintels = layout.statics.filter((s) => s.surf === "wall" && s.pos[1] - s.size[1] / 2 > 2);
    expect(lintels.length).toBeGreaterThanOrEqual(7);
    for (const l of lintels) {
      expect(l.pos[1] - l.size[1] / 2).toBeCloseTo(DOOR_H);
      expect(Math.min(l.size[0], l.size[2])).toBeCloseTo(0.2);
      expect(Math.max(l.size[0], l.size[2])).toBeCloseTo(DOOR_W);
    }
  });
});

describe("floor_plan doorway anchors", () => {
  it("every doorway anchor stands in a real gap of a wall line (20 seeds)", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const layout = floorPlan.generate({ seed, params: floorPlan.defaults, sub: [], laws: DEFAULT_LAWS, harder: false });
      const walls = layout.statics.filter((s) => s.surf === "wall");
      let n = 0;
      for (const z of layout.zones) {
        for (const [name, p] of Object.entries(z.anchors)) {
          if (!name.startsWith("doorway_")) continue;
          n++;
          const inside = (s: (typeof walls)[number], y: number) =>
            Math.abs(p[0] - s.pos[0]) < s.size[0] / 2 - 0.01 && Math.abs(p[2] - s.pos[2]) < s.size[2] / 2 - 0.01 && Math.abs(y - s.pos[1]) < s.size[1] / 2;
          expect(walls.some((s) => inside(s, 1.0)), `${z.slot}.${name} seed ${seed} is blocked`).toBe(false);
          expect(walls.some((s) => inside(s, 2.6)), `${z.slot}.${name} seed ${seed} has no lintel`).toBe(true);
        }
      }
      expect(n).toBeGreaterThanOrEqual(8); // each interior doorway is offered from both rooms
    }
  });
});
