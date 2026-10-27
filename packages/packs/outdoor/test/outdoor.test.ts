import { describe, expect, it } from "vitest";
import { BUDGETS, clampLaws, DEFAULT_LAWS, parseFill, type Laws, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import type { PackLayout, PackStatic } from "@ghostrun/plugin-api";
import { apex as proofApex, reachAt as proofReach, t1 } from "@ghostrun/proof";
import { apex, outdoor, reachAt, TERRACE } from "../src";
import { allAnchors, fillFor, gap, reachable, solidsNear, surfaces, surfaceUnder } from "./reach";

const lawsK = (jumpsMax: number): Laws => ({ ...DEFAULT_LAWS, jumpsMax });
const gen = (seed: number, laws: Laws = lawsK(2), harder = false) => outdoor.generate({ seed, params: outdoor.defaults, sub: [], laws, harder });
const zone = (l: PackLayout, slot: string) => l.zones.find((z) => z.slot === slot)!;
const top = (s: PackStatic) => s.pos[1] + s.size[1] / 2;
const foot = (s: PackStatic) => ({ min: [s.pos[0] - s.size[0] / 2, s.pos[2] - s.size[2] / 2] as [number, number], max: [s.pos[0] + s.size[0] / 2, s.pos[2] + s.size[2] / 2] as [number, number] });
const lookout = (l: PackLayout) => l.statics.filter((s) => s.zoneSlot === "lookout"); // [first ledge, middle, deck]

function place(seed: number, laws: Laws, layout: PackLayout, extra: string[] = []): WorldBundle {
  const fill = parseFill(fillFor("outdoor", layout, seed, laws, { slot: "entrance", anchor: "spawn_pad" }, extra), { seed });
  return placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout).bundle;
}

describe("outdoor pack", () => {
  it("the lookout needs every jump the laws allow: T1 reaches all of it, never with one jump fewer (50 seeds × 1–3 jumps)", () => {
    for (const k of [1, 2, 3]) {
      for (const seed of outdoor.ci.seeds) {
        const layout = gen(seed, lawsK(k));
        const need = JSON.stringify({ op: "expect", id: "x_look", prop: "requires", a: "sp_red", b: "z_lookout", need: [`jumps>=${k}`] });
        const b = place(seed, lawsK(k), layout, [need]);
        const L = clampLaws(b.laws);
        const ss = surfaces(b);
        const start = surfaceUnder(ss, b.entities.find((e) => e.id === "sp_red")!.pos)!;
        const all = reachable(ss, start, L, k);
        for (const { slot, name, a } of allAnchors(layout)) {
          const under = surfaceUnder(ss, a);
          expect(under && all.has(under.id), `${k} jumps, seed ${seed}: ${slot}.${name}`).toBe(true);
        }
        // T1 answers "is <zone> reachable?" by its statics: every zone owns a reachable one
        for (const z of b.zones) expect(ss.some((s) => s.zone === z.id && all.has(s.id)), `${k} jumps, seed ${seed}: ${z.slot}`).toBe(true);
        const fewer = reachable(ss, start, { ...L, jumpsMax: k - 1 }, k - 1);
        expect(ss.filter((s) => s.zone === "z_lookout" && fewer.has(s.id)).length, `${k} jumps, seed ${seed}`).toBe(0);
        expect(t1(b, L).find((c) => c.id === "T1:x_look")?.status, `${k} jumps, seed ${seed}`).toBe("verified");
      }
    }
  });

  it("lookout hops: the first ledge sits between k − 1 and k jump apexes; gaps ≤ 0.8 × T1 reach (0.95 × harder), rises ≥ 0.41 m", () => {
    let normal = 0;
    let harder = 0;
    for (const k of [1, 2, 3]) {
      for (const seed of outdoor.ci.seeds) {
        const L = clampLaws(lawsK(k));
        for (const hard of [false, true]) {
          const [base, mid, deck] = lookout(gen(seed, L, hard));
          expect(top(base!)).toBeGreaterThan(k === 1 ? 0.41 : apex(L, k - 1));
          expect(top(base!)).toBeLessThanOrEqual(apex(L, k));
          for (const [a, n] of [[base!, mid!], [mid!, deck!]] as const) {
            const rise = top(n) - top(a);
            const g = gap(foot(a), foot(n));
            expect(rise, `seed ${seed}`).toBeGreaterThanOrEqual(0.41);
            expect(g / reachAt(L, k, rise), `${k} jumps, seed ${seed}, ${hard ? "harder" : "normal"}`).toBeLessThanOrEqual((hard ? 0.95 : 0.8) + 1e-9);
            if (hard) harder += g;
            else normal += g;
          }
        }
      }
    }
    expect(harder).toBeGreaterThan(normal * 1.1); // harder really does widen the gaps
  });

  it("terrain is walkable: terraces rise 0.2 m at a time, each ≥ 1.5 m inside the one below", () => {
    for (const seed of outdoor.ci.seeds) {
      const layout = gen(seed);
      const terraces = layout.statics.filter((s) => s.surf === "floor" && top(s) > 0.05 && s.zoneSlot !== "pond"); // the dock is one 0.3 m step
      expect(terraces.length).toBeGreaterThanOrEqual(2);
      for (const t of terraces) {
        const lvl = Math.round(top(t) / TERRACE);
        expect(top(t)).toBeCloseTo(lvl * TERRACE);
        if (lvl === 1) continue;
        const below = terraces.find((u) => Math.round(top(u) / TERRACE) === lvl - 1 && u.pos[0] === t.pos[0] && u.pos[2] === t.pos[2]);
        expect(below, `seed ${seed}: terrace at ${top(t)} m has nothing 0.2 m below it`).toBeDefined();
        expect(below!.size[0] - t.size[0]).toBeGreaterThanOrEqual(3 - 1e-9);
      }
      // scatter is never low enough to be stepped onto by accident
      for (const s of layout.statics.filter((x) => x.surf === "wall")) expect(s.size[1]).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("trees, rocks and bushes keep 1.2 m off every path, and nothing solid stands within 1 m of an anchor", () => {
    for (const k of [1, 2]) {
      for (const seed of outdoor.ci.seeds) {
        const layout = gen(seed, lawsK(k));
        const paths = layout.statics.filter((s) => s.surf === "floor" && s.size[1] < 0.05);
        expect(paths.length).toBeGreaterThanOrEqual(4);
        const scatter = layout.statics.filter((s) => s.surf === "wall" && Math.max(s.size[0], s.size[2]) < 5);
        expect(scatter.length).toBeGreaterThan(30);
        for (const p of paths) for (const s of scatter) expect(gap(foot(p), foot(s)), `seed ${seed}`).toBeGreaterThan(1.2);
        for (const { slot, name, a } of allAnchors(layout)) expect(solidsNear(layout, a), `${k} jumps, seed ${seed}: ${slot}.${name}`).toEqual([]);
      }
    }
  });

  it("is deterministic per seed, differs across seeds, flips east–west, and keeps its names whatever the laws", () => {
    const sig = (l: PackLayout) => JSON.stringify(l.zones.map((z) => [z.slot, z.tag, Object.keys(z.anchors)]));
    expect(JSON.stringify(gen(7))).toBe(JSON.stringify(gen(7)));
    expect(gen(7).zones.length).toBeLessThanOrEqual(BUDGETS.zone); // a fill can bind every slot
    const seen = new Set(outdoor.ci.seeds.map((s) => JSON.stringify(gen(s).statics)));
    expect(seen.size).toBe(outdoor.ci.seeds.length);
    const sides = new Set(outdoor.ci.seeds.map((s) => Math.sign(zone(gen(s), "grove").anchors.heart![0])));
    expect([...sides].sort()).toEqual([-1, 1]);
    for (const seed of outdoor.ci.seeds.slice(0, 10)) {
      for (const laws of [lawsK(0), lawsK(1), lawsK(3), { ...DEFAULT_LAWS, jumpH: 3, speed: 10, gravityScale: 0.5 }]) expect(sig(gen(seed, laws))).toBe(sig(gen(seed)));
    }
  });

  it("uses exactly the proof's ballistic model", () => {
    for (const jumpH of [0.5, 1, 1.6, 2.5, 4]) {
      for (const gravityScale of [0, 0.5, 1, 2]) {
        const L = clampLaws({ ...DEFAULT_LAWS, jumpH, gravityScale, speed: 7 });
        for (const jumps of [0, 1, 2, 3]) {
          expect(apex(L, jumps)).toBe(proofApex(L, jumps));
          for (const rise of [-3, -0.5, 0, 0.5, 1.2, 2.5, 4]) expect(reachAt(L, jumps, rise)).toBe(proofReach(L, jumps, rise));
        }
      }
    }
  });
});
