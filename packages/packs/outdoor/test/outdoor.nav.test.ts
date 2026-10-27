// Walkability on the real navmesh (what T3's runners and NPCs path on). Its own file because a
// 52 × 52 m navmesh costs ~0.3 s to build and this sweeps 50 seeds.
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LAWS, parseFill } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { outdoor } from "../src";
import { allAnchors, fillFor } from "./reach";

beforeAll(async () => {
  await loadNavNode();
});

describe("outdoor pack on the navmesh", () => {
  it("every ground anchor is reachable on foot from the entrance and both team spawns; the lookout is not (50 seeds)", () => {
    const laws = { ...DEFAULT_LAWS, jumpsMax: 2 };
    for (const seed of outdoor.ci.seeds) {
      const layout = outdoor.generate({ seed, params: outdoor.defaults, sub: [], laws, harder: false });
      const fill = parseFill(fillFor("outdoor", layout, seed, laws, { slot: "entrance", anchor: "spawn_pad" }), { seed });
      const nav = buildNav(placeWorld(fill.draft, layout).bundle);
      const spawns = ["entrance", "clearing_w", "clearing_e"].map((slot) => layout.zones.find((z) => z.slot === slot)!.anchors.spawn_pad!);
      for (const { slot, name, a } of allAnchors(layout)) {
        for (const sp of spawns) {
          if (slot === "lookout") expect(nav.path(sp, a), `seed ${seed}: ${slot}.${name} is walkable`).toBeNull();
          else expect(nav.path(sp, a), `seed ${seed}: ${slot}.${name} from ${sp.join(",")}`).not.toBeNull();
        }
      }
      nav.destroy();
    }
  }, 180_000); // 50 navmeshes: ~14 s alone, slower when the whole suite runs in parallel
});
