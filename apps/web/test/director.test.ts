import { beforeAll, describe, expect, it } from "vitest";
import { loadNavNode } from "@ghostrun/nav/node";
import { prove } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { propose, twistWorld } from "../src/director";
import { buildWorld, ENGINE_HASH } from "../src/pipeline";

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

describe("the Director", () => {
  it("after a win, the rivals start on intercept; the twisted world rebuilds from its fill and still proves winnable", async () => {
    const world = buildWorld("", "ctf");
    // a run that kept to one side of the street
    const trail: [number, number, number][] = Array.from({ length: 20 }, (_, i) => [-30 + i * 2, 0.95, 5]);
    const p = propose(world, trail, { k: "win", tick: 3000, rule: "r_win" })!;
    expect(p.label).toBe("rival 1 starts on intercept, rival 2 starts on intercept");
    expect(p.line).toMatch(/side .*% of the time\. The rivals noticed/);
    const w2 = twistWorld(world, p.fill);
    expect(w2.bundle.cast.filter((c) => c.role === "rival").map((c) => c.dflt)).toEqual(["rival.intercept", "rival.intercept"]);
    expect(w2.bundle.statics).toEqual(world.bundle.statics); // only the cast changed
    const r = await prove(R, w2.bundle, { engine: ENGINE_HASH, runs: 6 });
    expect(r.chips.find((c) => c.id === "T3:win")!.k).toBeGreaterThan(0);
  }, 120_000);

  it("after a loss, the teammate starts on attack; a world without a cast gets no twist", () => {
    const world = buildWorld("", "ctf");
    expect(propose(world, [], { k: "lose", tick: 3000, rule: "r_lose" })!.label).toContain("mate 1 starts on attack");
    expect(propose(buildWorld("", "coin-rush"), [], { k: "win", tick: 600, rule: "r_win" })).toBeNull();
  });
});
