// The volume pack's conformance over 50 seeds in each medium: the sky's islands are reached by the
// jetpack's flight model and never by jumping; the lagoon is water, everything in it within a
// breath, the beach walkable; space is zero-g with nothing anchored inside a rock or a module.
import { beforeAll, describe, expect, it } from "vitest";
import { clampLaws, DEFAULT_LAWS, type WorldBundle } from "@ghostrun/ir";
import { diveNeed, FLY, flightOf, HEAD_UP, SWIM, waterAt, watersOf } from "@ghostrun/kits";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { flyReach, hopOk, surfaces, surfaceUnder } from "@ghostrun/proof";
import { mediumOf, volume } from "../src";

beforeAll(async () => {
  await loadNavNode();
});

const shell = (seed: number, slots: string[], sub: string[]): WorldBundle => ({
  v: 1, engine: "e", seed, mode: "play", lang: "en", pack: { id: "volume", version: "0", seed, params: {}, sub }, laws: DEFAULT_LAWS,
  zones: slots.map((s) => ({ id: `z_${s}`, src: "ai", layer: "gameplay", pack: "volume", slot: s, tag: "", name: s, parent: "" })),
  statics: [], entities: [{ id: "sp_red", src: "ai", layer: "gameplay", kind: "spawn", zone: `z_${slots[0]}`, anchor: "spawn_pad", pos: [0, 0, 0], rotY: 0, size: [1.2, 0.1, 1.2], noun: "", hyper: "", asset: "", body: "none", shape: "none", team: "red", tags: [], states: [], init: "", props: {} }],
  verbs: [], rules: [], states: [], cast: [], expects: [],
  cosmetic: { look: "default", mood: [0, 0, 0], timeOfDay: 12, weather: "clear", dress: [], posters: [] },
});

function placed(seed: number, sub: string[]) {
  const layout = volume.generate({ seed, params: volume.defaults, sub, laws: DEFAULT_LAWS, harder: false });
  const { bundle, notes } = placeWorld(shell(seed, layout.zones.map((z) => z.slot), sub), layout);
  return { layout, bundle, notes };
}

describe("volume pack", () => {
  it("picks its medium from the sub-zone (sky when none)", () => {
    expect(mediumOf([])).toBe("sky");
    expect(mediumOf(["water"])).toBe("water");
    expect(mediumOf(["space"])).toBe("space");
    const a = volume.generate({ seed: 3, params: volume.defaults, sub: ["water"], laws: DEFAULT_LAWS, harder: false });
    const b = volume.generate({ seed: 3, params: volume.defaults, sub: ["water"], laws: DEFAULT_LAWS, harder: false });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // deterministic
  });

  it("sky: every island and cloud is in the jetpack's reach from the start, and none can be jumped to (50 seeds)", () => {
    for (const seed of volume.ci.seeds) {
      const { bundle, notes } = placed(seed, ["sky"]);
      expect(notes.some((n) => n.includes(FLY)), `seed ${seed}`).toBe(true); // the placer gave the player a jetpack
      const laws = clampLaws(bundle.laws);
      const fly = flightOf({ verbs: bundle.verbs, laws })!;
      expect(fly).toMatchObject({ kind: "jetpack", climb: 3, fuel: 6 });
      const ss = surfaces(bundle);
      const start = surfaceUnder(ss, [-2.5, 0.2, 0])!;
      const reached = flyReach(ss, start, fly, laws);
      expect(ss.filter((s) => !reached.has(s.id)).map((s) => s.id), `seed ${seed}`).toEqual([]);
      // with three jumps and no jetpack, no island but the start is reached (the clouds below may be)
      const three = { ...laws, jumpsMax: 3 };
      const jumped = new Set([start.id]);
      for (const queue = [start]; queue.length; ) {
        const s = queue.shift()!;
        for (const t of ss) if (!jumped.has(t.id) && hopOk(s, t, three, 3)) (jumped.add(t.id), queue.push(t));
      }
      const islands = bundle.zones.length ? ss.filter((s) => s.top > start.top + 3) : [];
      expect(islands.length, `seed ${seed}`).toBeGreaterThanOrEqual(5);
      expect(islands.filter((s) => jumped.has(s.id)).map((s) => s.id), `seed ${seed}`).toEqual([]);
    }
  });

  it("water: the lagoon is water, everything in it within one breath, the beach walkable (50 seeds)", () => {
    for (const seed of volume.ci.seeds) {
      const { layout, bundle } = placed(seed, ["water"]);
      const ws = watersOf(bundle);
      expect(ws, `seed ${seed}`).toHaveLength(1);
      expect(bundle.verbs.some((v) => v.verb === SWIM)).toBe(true);
      const w = ws[0]!;
      for (const z of layout.zones.filter((x) => x.slot === "lagoon" || x.slot === "wreck")) {
        for (const [name, a] of Object.entries(z.anchors)) {
          if (!waterAt(ws, [a[0], a[1] + 0.3, a[2]])) continue; // the deck's top is under too; the mast isn't an anchor
          const depth = w.max[1] - (Math.max(w.min[1] + HEAD_UP, a[1] - 1.2) + HEAD_UP);
          expect(diveNeed(depth), `seed ${seed}: ${z.slot}.${name}`).toBeLessThan(w.breath);
        }
      }
      const nav = buildNav(bundle);
      const beach = layout.zones.find((z) => z.slot === "beach")!;
      for (const [name, a] of Object.entries(beach.anchors)) expect(nav.path(beach.anchors.spawn_pad!, a), `seed ${seed}: beach.${name}`).not.toBeNull();
      nav.destroy();
    }
  });

  it("space: zero-g, and no anchor inside a rock or a module (50 seeds)", () => {
    for (const seed of volume.ci.seeds) {
      const { layout, bundle } = placed(seed, ["space"]);
      expect(clampLaws(bundle.laws).gravityScale, `seed ${seed}`).toBe(0);
      expect(flightOf({ verbs: bundle.verbs, laws: clampLaws(bundle.laws) })?.fuel).toBe(Infinity);
      for (const z of layout.zones) {
        for (const [name, a] of Object.entries(z.anchors)) {
          const inside = layout.statics.find((s) => Math.abs(a[0] - s.pos[0]) < s.size[0] / 2 - 0.05 && Math.abs(a[2] - s.pos[2]) < s.size[2] / 2 - 0.05 && a[1] + 0.9 > s.pos[1] - s.size[1] / 2 + 0.05 && a[1] < s.pos[1] + s.size[1] / 2 - 0.05);
          expect(inside, `seed ${seed}: ${z.slot}.${name}`).toBeUndefined();
        }
      }
    }
  });
});
