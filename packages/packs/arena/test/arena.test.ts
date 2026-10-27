import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LAWS, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { arena } from "../src";

beforeAll(async () => {
  await loadNavNode();
});

const shell = (seed: number, slots: string[]): WorldBundle => ({
  v: 1, engine: "e", seed, mode: "play", lang: "en", pack: { id: "arena", version: "0", seed, params: {}, sub: [] }, laws: DEFAULT_LAWS,
  zones: slots.map((s) => ({ id: `z_${s}`, src: "ai", layer: "gameplay", pack: "arena", slot: s, tag: "", name: s, parent: "" })),
  statics: [], entities: [], verbs: [], rules: [], states: [], cast: [], expects: [],
  cosmetic: { look: "default", mood: [0, 0, 0], timeOfDay: 12, weather: "clear", dress: [], posters: [] },
});

describe("arena pack", () => {
  it("ground anchors are reachable on foot from both spawns, decks are not (50 seeds)", () => {
    for (const seed of arena.ci.seeds) {
      const layout = arena.generate({ seed, params: arena.defaults, sub: [], laws: DEFAULT_LAWS, harder: false });
      const { bundle } = placeWorld(shell(seed, layout.zones.map((z) => z.slot)), layout);
      const nav = buildNav(bundle);
      for (const side of ["west_half", "east_half"]) {
        const sp = layout.zones.find((z) => z.slot === side)!.anchors.spawn_pad!;
        for (const z of layout.zones) {
          for (const [name, a] of Object.entries(z.anchors)) {
            if (a[1] > 0.5) continue; // hoops, scoreboard, decks are raised
            expect(nav.path(sp, a), `seed ${seed}: ${side} → ${z.slot}.${name}`).not.toBeNull();
          }
        }
        const deck = layout.zones.find((z) => z.slot === "north_deck")!.anchors.deck_center!;
        expect(nav.path(sp, deck)).toBeNull();
      }
      nav.destroy();
    }
  });

  it("is point-symmetric (fair for both teams)", () => {
    const layout = arena.generate({ seed: 5, params: arena.defaults, sub: [], laws: DEFAULT_LAWS, harder: false });
    const cover = layout.statics.filter((s) => s.surf === "wall" && s.size[1] < 2);
    const key = (x: number, z: number) => `${x.toFixed(3)},${z.toFixed(3)}`;
    const set = new Set(cover.map((s) => key(s.pos[0], s.pos[2])));
    for (const s of cover) expect(set.has(key(-s.pos[0], -s.pos[2]))).toBe(true);
  });
});
