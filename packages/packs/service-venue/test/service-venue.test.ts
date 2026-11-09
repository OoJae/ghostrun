import { beforeAll, describe, expect, it } from "vitest";
import { BUDGETS, DEFAULT_LAWS } from "@ghostrun/ir";
import { loadNavNode } from "@ghostrun/nav/node";
import { conformance } from "@ghostrun/pack-common/conformance";
import type { PackLayout } from "@ghostrun/plugin-api";
import { COUNTER_H, serviceVenue, SERVICE_VENUE_SCHEMA } from "../src";

beforeAll(async () => {
  await loadNavNode();
});

const gen = (seed: number, params = serviceVenue.defaults) => serviceVenue.generate({ seed, params, sub: [], laws: DEFAULT_LAWS, harder: false });
const zone = (l: PackLayout, slot: string) => l.zones.find((z) => z.slot === slot)!;
const SPAWN = { spawn: { slot: "yard", anchor: "spawn_pad" } };

describe("service_venue pack", () => {
  it("conforms on 50 of 50 seeds: anchors on foot from the spawn, none in geometry, real doorways, every zone reachable", () => {
    const bad = serviceVenue.ci.seeds.flatMap((seed) => conformance("service_venue", gen(seed), seed, SPAWN).map((p) => `seed ${seed}: ${p}`));
    expect(bad).toEqual([]);
  });

  it("conforms at the ends of its schema (10 seeds each)", () => {
    const bad: string[] = [];
    for (const end of ["min", "max"] as const) {
      const params = { width: SERVICE_VENUE_SCHEMA.width![end], depth: SERVICE_VENUE_SCHEMA.depth![end] };
      for (const seed of serviceVenue.ci.seeds.slice(0, 10)) bad.push(...conformance("service_venue", gen(seed, params), seed, SPAWN).map((p) => `${end} seed ${seed}: ${p}`));
    }
    expect(bad).toEqual([]);
  });

  it("has an entrance, seating, a counter with a till on top and a flap, a back room and a storeroom reached only through it", () => {
    for (const seed of [1, 2, 3, 17, 42]) {
      const l = gen(seed);
      expect(l.zones.map((z) => z.slot)).toEqual(["yard", "entrance", "seating", "counter", "back_room", "storeroom"]);
      expect(zone(l, "counter").anchors.till![1]).toBe(COUNTER_H);
      // the storeroom's one doorway is in the back room's wall; the back room's is off the staff side
      expect(Object.keys(zone(l, "storeroom").anchors).filter((k) => k.startsWith("doorway_"))).toEqual(["doorway_w"]);
      expect(Object.keys(zone(l, "back_room").anchors).filter((k) => k.startsWith("doorway_")).sort()).toEqual(["doorway_e", "doorway_s"]);
      // the flap is a gap at one end of the counter, wider than a doorway (no anchor: nothing is put in the way)
      const counterTop = l.statics.find((s) => s.zoneSlot === "counter" && s.surf === "wall" && s.size[1] < 1.5)!;
      const W = serviceVenue.defaults.width;
      const ends = [counterTop.pos[0] - counterTop.size[0] / 2 + W / 2, W / 2 - (counterTop.pos[0] + counterTop.size[0] / 2)];
      expect(Math.max(...ends)).toBeGreaterThanOrEqual(1.2 + 0.1 - 1e-9);
      expect(Object.keys(zone(l, "counter").anchors)).not.toContain("flap");
    }
  });

  it("is deterministic, differs across seeds, keeps its anchor names and fits the zone budget", () => {
    const names = (l: PackLayout) => JSON.stringify(l.zones.map((z) => [z.slot, z.tag, Object.keys(z.anchors).sort()]));
    expect(JSON.stringify(gen(7))).toBe(JSON.stringify(gen(7)));
    expect(new Set(serviceVenue.ci.seeds.map((s) => JSON.stringify(gen(s).statics))).size).toBe(serviceVenue.ci.seeds.length);
    for (const seed of serviceVenue.ci.seeds) expect(names(gen(seed))).toBe(names(gen(1)));
    expect(gen(1).zones.length).toBeLessThanOrEqual(BUDGETS.zone);
  });
});
