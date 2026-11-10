// A place's life contract: at least three creatures that react to the player, chosen by the look,
// and none of it in the world (the bundle, its spec hash and its proof are exactly as before).
import { describe, expect, it } from "vitest";
import { lifeOf, NOTICE, settingOf, stepLife, type Creature } from "../src/life";
import { lifeWords } from "../src/hud/Life";
import { buildWorld, hashWorld } from "../src/pipeline";
import { pickLook } from "../src/render/pick";

const placeOf = (fixture: string) => {
  const w = buildWorld("", fixture);
  return { w, setting: settingOf(w.bundle, pickLook(w.cue).id) };
};
const dist = (c: Creature, p: [number, number, number]) => Math.hypot(c.p[0] - p[0], c.p[2] - p[2]);
const run = (cs: Creature[], player: [number, number, number], s: number, t0 = 0) => {
  const evs = [];
  for (let i = 0; i < s * 60; i++) evs.push(...stepLife(cs, 1 / 60, player, t0 + i / 60));
  return evs;
};

describe("a place's ambient life", () => {
  it("is chosen by the place: a forest's fireflies, deer and owls; a villa's attendant and visitors", () => {
    expect(placeOf("glade").setting).toBe("forest");
    expect(placeOf("villa").setting).toBe("museum");
    expect(placeOf("fengshui").setting).toBe("museum");
    expect(lifeWords(placeOf("glade").w.bundle, placeOf("glade").w.cue)).toBe("16 fireflies, 2 deer and 2 owls");
    expect(lifeWords(placeOf("villa").w.bundle, placeOf("villa").w.cue)).toBe("1 attendant and 3 visitors");
    // a game has none: life is a place's contract
    expect(lifeWords(placeOf("ctf").w.bundle, placeOf("ctf").w.cue)).toBeNull();
  });

  it("at least three creatures, none on top of where you start", () => {
    for (const f of ["glade", "villa", "fengshui"]) {
      const { w, setting } = placeOf(f);
      const cs = lifeOf(w.bundle, setting);
      expect(cs.length, f).toBeGreaterThanOrEqual(3);
      const spawn = w.bundle.entities.find((e) => e.kind === "spawn")!.pos;
      for (const c of cs) expect(Math.hypot(c.home[0] - spawn[0], c.home[2] - spawn[2]), f).toBeGreaterThan(1.5);
    }
  });

  it("reacts to the player: fireflies gather round you, a deer startles and bolts, an owl watches you then flies", () => {
    const { w, setting } = placeOf("glade");
    const cs = lifeOf(w.bundle, setting);
    const far: [number, number, number] = [1e3, 0, 1e3];
    run(cs, far, 2);
    expect(cs.every((c) => c.reacted === 0)).toBe(true);

    const deer = cs.find((c) => c.kind === "deer")!;
    const at: [number, number, number] = [deer.p[0] + NOTICE.deer - 2, deer.p[1] + 0.9, deer.p[2]];
    const before = dist(deer, at);
    const evs = run(cs, at, 1.2);
    expect(evs.some((e) => e.kind === "deer" && e.mood === "startled")).toBe(true);
    expect(dist(deer, at)).toBeGreaterThan(before + 2); // it ran from you

    const flies = cs.filter((c) => c.kind === "firefly");
    const swarm = flies[0]!;
    const near: [number, number, number] = [swarm.home[0] + 4, swarm.home[1] - 1, swarm.home[2]];
    run(cs, near, 4, 10);
    const gathered = flies.filter((c) => c.mood === "flock");
    expect(gathered.length).toBeGreaterThanOrEqual(3);
    for (const c of gathered) expect(dist(c, near)).toBeLessThan(3); // circling you

    const owl = cs.find((c) => c.kind === "owl")!;
    const under: [number, number, number] = [owl.home[0] + 2.5, owl.home[1] - 2.3, owl.home[2]];
    const owlEvs = run(cs, under, 1, 20);
    expect(owlEvs.some((e) => e.kind === "owl" && e.mood === "fly")).toBe(true);
  });

  it("in a villa an attendant nods as you come by and a visitor steps aside", () => {
    const { w, setting } = placeOf("villa");
    const cs = lifeOf(w.bundle, setting);
    const att = cs.find((c) => c.kind === "attendant")!;
    const evs = run(cs, [att.p[0] + 2, att.p[1] + 0.9, att.p[2]], 0.5);
    expect(evs.filter((e) => e.kind === "attendant" && e.mood === "nod")).toHaveLength(1); // once, not every frame
    const v = cs.find((c) => c.kind === "visitor")!;
    const evs2 = run(cs, [v.p[0] + 1, v.p[1] + 0.9, v.p[2]], 0.5);
    expect(evs2.some((e) => e.kind === "visitor" && e.mood === "aside")).toBe(true);
  });

  it("is never in the world: the bundle and its spec hash are untouched", async () => {
    const { w, setting } = placeOf("glade");
    const before = JSON.stringify(w.bundle);
    const hash = await hashWorld(w.bundle);
    const cs = lifeOf(w.bundle, setting);
    run(cs, [0, 0, 0], 3);
    expect(JSON.stringify(w.bundle)).toBe(before);
    expect(await hashWorld(w.bundle)).toBe(hash);
  });
});
