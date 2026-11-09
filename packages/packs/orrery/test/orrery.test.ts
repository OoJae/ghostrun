import { beforeAll, describe, expect, it } from "vitest";
import { BUDGETS, DEFAULT_LAWS } from "@ghostrun/ir";
import { loadNavNode } from "@ghostrun/nav/node";
import { conformance } from "@ghostrun/pack-common/conformance";
import type { PackLayout } from "@ghostrun/plugin-api";
import { orrery, ORRERY_SCHEMA, PLANETS, PLINTH_H } from "../src";

beforeAll(async () => {
  await loadNavNode();
});

const gen = (seed: number, params = orrery.defaults) => orrery.generate({ seed, params, sub: [], laws: DEFAULT_LAWS, harder: false });
const SPAWN = { spawn: { slot: "entrance", anchor: "spawn_pad" } };
const planetsOf = (l: PackLayout) => new Map(l.zones.flatMap((z) => Object.entries(z.anchors)).filter(([k]) => PLANETS.some((p) => p[0] === k)));
const dist = (p: readonly number[]) => Math.max(Math.abs(p[0]!), Math.abs(p[2]!)); // along its spoke

describe("orrery pack", () => {
  it("conforms on 50 of 50 seeds: every planet and the belt on foot from the entrance, nothing standing in geometry", () => {
    const bad = orrery.ci.seeds.flatMap((seed) => conformance("orrery", gen(seed), seed, SPAWN).map((p) => `seed ${seed}: ${p}`));
    expect(bad).toEqual([]);
  }, 120_000);

  it("conforms at the ends of its schema (5 seeds each)", () => {
    const bad: string[] = [];
    for (const end of ["min", "max"] as const) {
      const params = { scale: ORRERY_SCHEMA.scale![end], planets: ORRERY_SCHEMA.planets![end] };
      for (const seed of orrery.ci.seeds.slice(0, 5)) bad.push(...conformance("orrery", gen(seed, params), seed, SPAWN).map((p) => `${end} seed ${seed}: ${p}`));
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it("puts each planet at √AU × scale from the Sun along its spoke, in order, and says the distances are scaled", () => {
    for (const scale of [5.5, 6, 8]) {
      for (const seed of [1, 2, 3, 20]) {
        const l = gen(seed, { scale, planets: 8 });
        const at = planetsOf(l);
        expect([...at.keys()].sort()).toEqual(PLANETS.map((p) => p[0]).sort());
        let last = 0;
        for (const [name, au, root] of PLANETS) {
          expect(Math.abs(root * root - au) / au).toBeLessThan(0.002); // the written-out roots are right
          const p = at.get(name)!;
          expect(p[1]).toBe(PLINTH_H);
          expect(Math.abs(dist(p) - scale * root)).toBeLessThan(0.02);
          expect(dist(p)).toBeGreaterThan(last);
          last = dist(p);
        }
        expect(l.notes[0]).toMatch(/^orrery: distances scaled \(√AU × [\d.]+ m: Earth [\d.]+ m from the Sun, Neptune [\d.]+ m; true to scale it would be [\d.]+ m\), planet sizes not to scale$/);
        expect(l.zones.length).toBeLessThanOrEqual(BUDGETS.zone);
      }
    }
  });

  it("fewer planets: the outer zones go, the inner system stays where it was", () => {
    const all = gen(5);
    const five = gen(5, { ...orrery.defaults, planets: 5 });
    expect(five.zones.map((z) => z.slot)).toEqual(["entrance", "sun", "inner", "belt", "jupiter"]);
    expect(all.zones.map((z) => z.slot)).toEqual(["entrance", "sun", "inner", "belt", "jupiter", "saturn", "uranus", "neptune"]);
    for (const name of ["mercury", "venus", "earth", "mars"]) expect(planetsOf(five).get(name)).toEqual(planetsOf(all).get(name));
  });

  it("is deterministic, differs across seeds, and keeps its anchor names", () => {
    const names = (l: PackLayout) => JSON.stringify(l.zones.map((z) => [z.slot, z.tag, Object.keys(z.anchors).sort()]));
    expect(JSON.stringify(gen(7))).toBe(JSON.stringify(gen(7)));
    // (only the spokes the planets take and the side of it each stands on vary: a few seeds coincide)
    expect(new Set(orrery.ci.seeds.map((s) => JSON.stringify(gen(s).statics))).size).toBeGreaterThanOrEqual(40);
    for (const seed of orrery.ci.seeds) expect(names(gen(seed))).toBe(names(gen(1)));
  });
});
