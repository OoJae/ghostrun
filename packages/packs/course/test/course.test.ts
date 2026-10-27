import { beforeAll, describe, expect, it } from "vitest";
import { BUDGETS, clampLaws, DEFAULT_LAWS, parseFill, type Laws, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import type { PackLayout } from "@ghostrun/plugin-api";
import { apex as proofApex, reachAt as proofReach, t1 } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { apex, course, reachAt } from "../src";
import { allAnchors, fillFor, gap, reachable, solidsNear, surfaces, surfaceUnder } from "./reach";
import { courseRoute, runCourse } from "./runner";

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

const lawsK = (jumpsMax: number): Laws => ({ ...DEFAULT_LAWS, jumpsMax });
const gen = (seed: number, laws: Laws = lawsK(2), harder = false) => course.generate({ seed, params: course.defaults, sub: [], laws, harder });
const goalAt = (layout: PackLayout): [number, number] => {
  const g = layout.zones.find((z) => z.slot === "finish")!.anchors.goal!;
  return [g[0], g[2]];
};

/** Place a minimal fill on the layout: one zone per slot, a red spawn, a finish goal that wins. */
function place(seed: number, laws: Laws, layout: PackLayout, extra: string[] = []): WorldBundle {
  const ops = [
    JSON.stringify({ op: "goal", id: "finish_line", zone: "z_finish", anchor: "goal" }),
    JSON.stringify({ op: "rule", id: "r_win", when: { t: "enter", a: "player", b: "finish_line" }, then: [{ e: "win", target: "player" }], once: true }),
    ...extra,
  ];
  const fill = parseFill(fillFor("course", layout, seed, laws, { slot: "start", anchor: "spawn_pad" }, ops), { seed });
  return placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout).bundle;
}

describe("course pack", () => {
  it("plans ≥6 segments: the opening wall, then every other kind, never one twice running; names don't depend on the laws", () => {
    const sig = (l: PackLayout) => JSON.stringify(l.zones.map((z) => [z.slot, z.tag, Object.keys(z.anchors)]));
    for (const seed of course.ci.seeds) {
      const layout = gen(seed);
      for (const k of [0, 1, 3]) expect(sig(gen(seed, lawsK(k))), `seed ${seed}, ${k} jumps`).toBe(sig(layout));
      expect(sig(gen(seed, { ...DEFAULT_LAWS, jumpH: 3, speed: 9, gravityScale: 0.5 }))).toBe(sig(layout));
      const segs = layout.zones.filter((z) => z.slot.startsWith("seg_"));
      expect(segs.length).toBeGreaterThanOrEqual(6);
      expect(layout.zones.length).toBeLessThanOrEqual(BUDGETS.zone); // a fill can bind every slot
      expect(segs[0]!.tag).toBe("ledge");
      for (const kind of ["gaps", "steps", "beam", "pit"]) expect(segs.some((z) => z.tag === kind), `seed ${seed}: ${kind}`).toBe(true);
      segs.forEach((z, i) => {
        if (i > 0) expect(z.tag, `seed ${seed}: ${segs[i - 1]!.tag} twice`).not.toBe(segs[i - 1]!.tag);
        expect(Object.keys(z.anchors)).toContain(`pickup_${i + 1}`);
        if (i < segs.length - 1) expect(Object.keys(z.anchors)).toContain(`cp_${i + 1}`);
        if (z.tag === "pit") expect(Object.keys(z.anchors)).toContain(`pit_${i + 1}`);
      });
      expect(layout.zones[0]!.anchors.spawn_pad).toBeDefined();
      expect(layout.zones.find((z) => z.slot === "finish")!.anchors.goal).toBeDefined();
    }
  });

  it("every anchor is reachable under the T1 jump model; the opening wall needs every jump (50 seeds × 1–3 jumps)", () => {
    for (const k of [1, 2, 3]) {
      for (const seed of course.ci.seeds) {
        const layout = gen(seed, lawsK(k));
        const need = JSON.stringify({ op: "expect", id: "x_wall", prop: "requires", a: "sp_red", b: "z_seg_1", need: [`jumps>=${k}`] });
        const fin = JSON.stringify({ op: "expect", id: "x_fin", prop: "reachable", a: "sp_red", b: "z_finish" });
        const b = place(seed, lawsK(k), layout, [need, fin]);
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
        // one jump fewer: stuck on the start pad, the fall floor and the stairs (all in the start zone)
        const fewer = reachable(ss, start, { ...L, jumpsMax: k - 1 }, k - 1);
        expect(ss.filter((s) => fewer.has(s.id) && s.zone !== "z_start").map((s) => s.zone), `${k} jumps, seed ${seed}`).toEqual([]);
        // and the proof's own T1 agrees
        const chips = t1(b, L);
        expect(chips.find((c) => c.id === "T1:x_wall")?.status, `seed ${seed}`).toBe("verified");
        expect(chips.find((c) => c.id === "T1:x_fin")?.status, `seed ${seed}`).toBe("verified");
      }
    }
  });

  it("sizes every hop from the laws: gaps ≤ 0.8 × T1 reach (0.95 × when harder), jumped hops rise or drop ≥ 0.41 m", () => {
    const worst = { normal: 0, harder: 0 };
    for (const harder of [false, true]) {
      for (const k of [1, 2, 3]) {
        for (const seed of course.ci.seeds) {
          const L = clampLaws(lawsK(k));
          const route = courseRoute(place(seed, L, gen(seed, L, harder)));
          for (let i = 1; i < route.length; i++) {
            const [a, n] = [route[i - 1]!, route[i]!];
            const rise = n.top - a.top;
            const g = gap(a, n);
            const where = `${harder ? "harder" : "normal"}, ${k} jumps, seed ${seed}, hop ${i}: gap ${g.toFixed(2)} rise ${rise.toFixed(2)}`;
            if (g <= 0.01) {
              expect(Math.abs(rise) < 0.41 || rise <= apex(L, k), where).toBe(true); // a walk, or a climb of one face
              continue;
            }
            expect(Math.abs(rise), where).toBeGreaterThanOrEqual(0.41); // T1 treats smaller rises as walking
            const use = g / reachAt(L, k, rise);
            expect(use, where).toBeLessThanOrEqual((harder ? 0.95 : 0.8) + 1e-9);
            worst[harder ? "harder" : "normal"] = Math.max(worst[harder ? "harder" : "normal"], use);
          }
        }
      }
    }
    expect(worst.harder).toBeGreaterThan(0.8); // harder really does relax the rule
  });

  it("keeps every anchor 1 m clear of anything solid", () => {
    for (const k of [1, 2]) {
      for (const seed of course.ci.seeds) {
        const layout = gen(seed, lawsK(k));
        for (const { slot, name, a } of allAnchors(layout)) expect(solidsNear(layout, a), `${k} jumps, seed ${seed}: ${slot}.${name}`).toEqual([]);
      }
    }
  });

  it("is deterministic per seed and differs across seeds", () => {
    expect(JSON.stringify(gen(7))).toBe(JSON.stringify(gen(7)));
    const seen = new Set(course.ci.seeds.map((s) => JSON.stringify(gen(s).statics)));
    expect(seen.size).toBe(course.ci.seeds.length);
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

  it("a scripted runner beats it in physics; one jump short, it can't climb the opening wall", () => {
    const t0 = performance.now();
    for (const seed of course.ci.seeds) {
      const layout = gen(seed);
      const b = place(seed, lawsK(2), layout);
      const out = runCourse(R, b, goalAt(layout));
      expect(out.result, `seed ${seed}: stopped after hop ${out.reached} of ${out.hops}`).toBe("win");
      expect(out.jumps[0]).toBe(2); // the opening wall took the double jump
      if (seed <= 10) {
        expect(runCourse(R, b, goalAt(layout), { laws: { jumpsMax: 1 } }).reached, `seed ${seed}`).toBe(0);
        for (const k of [1, 3]) {
          const lk = gen(seed, lawsK(k));
          expect(runCourse(R, place(seed, lawsK(k), lk), goalAt(lk)).result, `${k} jumps, seed ${seed}`).toBe("win");
        }
        const hard = gen(seed, lawsK(2), true);
        expect(runCourse(R, place(seed, lawsK(2), hard), goalAt(hard)).result, `harder, seed ${seed}`).toBe("win");
      }
    }
    console.log(`course physics runs: ${Math.round(performance.now() - t0)} ms`);
  });

  it("every fall is recoverable: the fall floor's stairs lead back up to the start pad (T1 × 50 seeds, navmesh × 3)", () => {
    for (const seed of course.ci.seeds) {
      const layout = gen(seed);
      const b = place(seed, lawsK(2), layout);
      const anchors = layout.zones[0]!.anchors;
      const ss = surfaces(b);
      const floor = surfaceUnder(ss, anchors.fall!)!;
      const pad = surfaceUnder(ss, anchors.spawn_pad!)!;
      expect(floor.top).toBeLessThan(-2.9);
      expect(reachable(ss, floor, clampLaws(b.laws), 1).has(pad.id), `seed ${seed}`).toBe(true); // up the 0.3 m stairs
      if (seed <= 3) {
        const nav = buildNav(b);
        expect(nav.path(anchors.fall!, anchors.spawn_pad!), `seed ${seed}`).not.toBeNull();
        nav.destroy();
      }
    }
  });
});
