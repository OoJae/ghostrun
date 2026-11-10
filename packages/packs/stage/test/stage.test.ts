import { beforeAll, describe, expect, it } from "vitest";
import { BUDGETS, DEFAULT_LAWS } from "@ghostrun/ir";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { conformance, placeShell } from "@ghostrun/pack-common/conformance";
import type { PackLayout } from "@ghostrun/plugin-api";
import { PIT_DROP, RIG_H, stage, STAGE_H, STAGE_SCHEMA } from "../src";

beforeAll(async () => {
  await loadNavNode();
});

const gen = (seed: number, params = stage.defaults) => stage.generate({ seed, params, sub: [], laws: DEFAULT_LAWS, harder: false });
const zone = (l: PackLayout, slot: string) => l.zones.find((z) => z.slot === slot)!;
const OPTS = { spawn: { slot: "yard", anchor: "spawn_pad" }, hanging: (_slot: string, name: string) => name.startsWith("rig_") };

describe("stage pack", () => {
  it("conforms on 50 of 50 seeds: the stage, wings and backstage on foot up the stairs, the pit one step down, real doorways", () => {
    const bad = stage.ci.seeds.flatMap((seed) => conformance("stage", gen(seed), seed, OPTS).map((p) => `seed ${seed}: ${p}`));
    expect(bad).toEqual([]);
  });

  it("conforms at the ends of its schema (10 seeds each)", () => {
    const bad: string[] = [];
    for (const end of ["min", "max"] as const) {
      const params = { width: STAGE_SCHEMA.width![end], depth: STAGE_SCHEMA.depth![end] };
      for (const seed of stage.ci.seeds.slice(0, 10)) bad.push(...conformance("stage", gen(seed, params), seed, OPTS).map((p) => `${end} seed ${seed}: ${p}`));
    }
    expect(bad).toEqual([]);
  });

  it("raises the stage a metre, sinks the pit a step, hangs the rig over the stage and seats the house in rows with aisles", () => {
    for (const seed of [1, 4, 30]) {
      const l = gen(seed);
      expect(l.zones.map((z) => z.slot)).toEqual(["yard", "foyer", "seating", "pit", "stage", "wing_w", "wing_e", "backstage"]);
      expect(l.zones.length).toBeLessThanOrEqual(BUDGETS.zone);
      for (const slot of ["stage", "wing_w", "wing_e", "backstage"]) expect(zone(l, slot).floorY).toBe(STAGE_H);
      expect(zone(l, "pit").floorY).toBe(-PIT_DROP);
      for (const k of ["rig_l", "rig_c", "rig_r"]) expect(zone(l, "stage").anchors[k]![1]).toBe(STAGE_H + RIG_H);
      const seats = l.statics.filter((s) => s.zoneSlot === "seating" && s.surf === "wall" && s.size[1] < 0.5);
      expect(seats.length).toBeGreaterThanOrEqual(6);
      // the wings' doorways: one in the proscenium wall at the top of the stairs, one upstage
      for (const w of ["wing_w", "wing_e"]) expect(Object.keys(zone(l, w).anchors).filter((k) => k.startsWith("doorway_")).sort()).toEqual(["doorway_n", "doorway_s"]);
    }
  });

  it("the stage can only be walked onto up the stairs: with the stairs gone, the stage is off the navmesh from the house", () => {
    for (const seed of [2, 11]) {
      const l = gen(seed);
      const b = placeShell("stage", l, seed, DEFAULT_LAWS, OPTS.spawn);
      const from = zone(l, "yard").anchors.spawn_pad!;
      const to = zone(l, "stage").anchors.center!;
      const with_ = buildNav(b);
      expect(with_.path(from, to)).not.toBeNull();
      with_.destroy();
      const stairs = new Set(b.statics.filter((s) => s.surf === "ledge" && s.size[1] < STAGE_H).map((s) => s.id));
      const without = buildNav({ ...b, statics: b.statics.filter((s) => !stairs.has(s.id)) });
      expect(without.path(from, to)).toBeNull();
      without.destroy();
    }
  });

  it("is deterministic, differs across seeds, and keeps its anchor names", () => {
    const names = (l: PackLayout) => JSON.stringify(l.zones.map((z) => [z.slot, z.tag, Object.keys(z.anchors).sort()]));
    expect(JSON.stringify(gen(7))).toBe(JSON.stringify(gen(7)));
    expect(new Set(stage.ci.seeds.map((s) => JSON.stringify(gen(s).statics))).size).toBe(stage.ci.seeds.length);
    for (const seed of stage.ci.seeds) expect(names(gen(seed))).toBe(names(gen(1)));
  });
});
