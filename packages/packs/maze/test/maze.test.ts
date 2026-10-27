import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LAWS, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { maze } from "../src";

beforeAll(async () => {
  await loadNavNode();
});

const shell = (seed: number, slots: string[]): WorldBundle => ({
  v: 1, engine: "e", seed, mode: "play", lang: "en", pack: { id: "maze", version: "0", seed, params: {}, sub: [] }, laws: DEFAULT_LAWS,
  zones: slots.map((s) => ({ id: `z_${s}`, src: "ai", layer: "gameplay", pack: "maze", slot: s, tag: "", name: s, parent: "" })),
  statics: [], entities: [], verbs: [], rules: [], states: [], cast: [], expects: [],
  cosmetic: { look: "default", mood: [0, 0, 0], timeOfDay: 12, weather: "clear", dress: [], posters: [] },
});

describe("maze pack", () => {
  it("exit, centre and every dead end are reachable from the start pad (50 seeds)", () => {
    for (const seed of maze.ci.seeds) {
      const layout = maze.generate({ seed, params: maze.defaults, sub: [], laws: DEFAULT_LAWS, harder: false });
      const { bundle } = placeWorld(shell(seed, layout.zones.map((z) => z.slot)), layout);
      const nav = buildNav(bundle);
      const sp = layout.zones.find((z) => z.slot === "start")!.anchors.spawn_pad!;
      const anchors = layout.zones.find((z) => z.slot === "maze")!.anchors;
      expect(Object.keys(anchors).filter((k) => k.startsWith("dead_end")).length).toBeGreaterThanOrEqual(2);
      for (const [name, a] of Object.entries(anchors)) expect(nav.path(sp, a), `seed ${seed}: ${name}`).not.toBeNull();
      nav.destroy();
    }
  });
});
