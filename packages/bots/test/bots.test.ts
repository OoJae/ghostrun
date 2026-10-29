import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { buildNav, type NavWorld } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { cityBlock } from "@ghostrun/pack-city-block";
import { SimWorld, type Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { behaviourOf, castBrain } from "../src";

const ctf = readFileSync(new URL("../../ir/fixtures/ctf-neon.jsonl", import.meta.url), "utf8");
let R: Rapier;
let world: WorldBundle;
let nav: NavWorld;

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
  const fill = parseFill(ctf, { seed: 7 });
  const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  world = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout).bundle;
  nav = buildNav(world);
});

function play(ticks: number, each?: (sim: SimWorld) => void) {
  const sim = new SimWorld(R, world, { brain: castBrain(nav, world) });
  for (let i = 0; i < ticks && !sim.result; i++) {
    sim.step(null);
    each?.(sim);
  }
  return sim;
}

describe("cast brains", () => {
  it("reads the verb of a menu option", () => {
    expect(behaviourOf("rival.attack")).toBe("attack");
    expect(behaviourOf("teammate.defend")).toBe("defend");
    expect(behaviourOf("rival.intercept")).toBe("intercept");
    expect(behaviourOf("teammate.follow")).toBe("follow");
    expect(behaviourOf("guard.patrol")).toBe("patrol");
    expect(behaviourOf("merchant.haggle")).toBe("idle");
  });

  it("plays CTF for real: with the player standing still, blue takes the orb home three times", () => {
    const sim = play(4 * 60 * 60);
    const scores = sim.log.filter((e) => e.k === "score");
    expect(scores.map((e) => e.a)).toEqual(["team:blue", "team:blue", "team:blue"]);
    expect(sim.result).toBe("lose");
    expect(sim.log.some((e) => e.k === "pickup" && e.b === "rival_1")).toBe(true);
    sim.free();
  }, 60_000);

  it("is deterministic: same world, same inputs, same state hash", () => {
    const a = play(1500);
    const b = play(1500);
    expect(a.stateHash()).toBe(b.stateHash());
    expect(a.log.length).toBe(b.log.length);
    a.free();
    b.free();
  });

  it("a tag knocks the orb loose and the tagger takes it", () => {
    let tagged = false;
    const sim = play(4 * 60 * 60, (s) => {
      const orb = s.entity("orb")!;
      if (!tagged && orb.carrier === "rival_1") {
        const p = s.pos("rival_1");
        s.teleport("player", [p[0] - 0.9, p[1], p[2]]);
        tagged = true;
      }
      if (tagged && s.log.some((e) => e.k === "tag")) s.result = "win"; // stop here
    });
    const tag = sim.log.find((e) => e.k === "tag")!;
    expect(tag).toMatchObject({ a: "player", b: "rival_1" });
    expect(sim.log.some((e) => e.k === "drop" && e.a === "orb" && e.b === "rival_1" && e.tick === tag.tick)).toBe(true);
    expect(sim.entity("orb")!.carrier).toBe("player");
    sim.free();
  }, 60_000);

  it("an armed rival fights back: it fires at the player in range, no faster than its weapon allows, and hits", () => {
    const armed: WorldBundle = {
      ...world,
      verbs: [
        ...world.verbs,
        { id: "vb_frost", src: "ai", layer: "gameplay", verb: "combat_sport.shoot", on: "rival_1", params: { range: 12, damage: 10, cooldown: 1 }, signature: false },
        { id: "vb_hp", src: "ai", layer: "gameplay", verb: "combat_sport.health", on: "player", params: { hp: 1000 }, signature: false },
      ],
    };
    const sim = new SimWorld(R, armed, { brain: castBrain(nav, armed) });
    const orb = sim.pos("orb");
    sim.teleport("player", [orb[0] + 4, orb[1] + 0.7, orb[2]]); // where rival_1 is headed
    for (let i = 0; i < 20 * 60 && !sim.result; i++) sim.step(null);
    const shots = sim.log.filter((e) => e.k === "shoot" && e.a === "rival_1");
    expect(shots.length).toBeGreaterThan(2);
    for (let i = 1; i < shots.length; i++) expect(shots[i]!.tick - shots[i - 1]!.tick).toBeGreaterThanOrEqual(60);
    expect(sim.log.some((e) => e.k === "hit" && e.a === "player" && e.b === "rival_1")).toBe(true);
    expect(sim.hp("player")).toBeLessThan(1000);
    // the unarmed ones never fire
    expect(sim.log.some((e) => e.k === "shoot" && e.a !== "rival_1")).toBe(false);
    sim.free();
  }, 60_000);

  it("an armed character with no menu is a sentry: it fires back from where it stands at half its weapon's rate, and holds fire on a player down to a quarter of their hit points", () => {
    const rival = world.entities.find((e) => e.id === "rival_1")!;
    const orb = world.entities.find((e) => e.id === "orb")!;
    const at: [number, number, number] = [orb.pos[0] + 4, orb.pos[1] + 0.7, orb.pos[2]];
    const armed: WorldBundle = {
      ...world,
      entities: [...world.entities, { ...rival, id: "archer", pos: [at[0], at[1], at[2] + 6] }],
      verbs: [
        ...world.verbs,
        { id: "vb_bow", src: "ai", layer: "gameplay", verb: "combat_sport.shoot", on: "archer", params: { range: 12, damage: 10, cooldown: 1 }, signature: false },
        { id: "vb_hp", src: "ai", layer: "gameplay", verb: "combat_sport.health", on: "player", params: { hp: 100, respawn: false }, signature: false },
      ],
    };
    const sim = new SimWorld(R, armed, { brain: castBrain(nav, armed) });
    const home = sim.pos("archer");
    for (let i = 0; i < 30 * 60 && !sim.result; i++) {
      sim.teleport("player", at); // standing still in its sights
      sim.step(null);
    }
    const shots = sim.log.filter((e) => e.k === "shoot" && e.a === "archer");
    expect(shots.length).toBeGreaterThan(2);
    for (let i = 1; i < shots.length; i++) expect(shots[i]!.tick - shots[i - 1]!.tick).toBeGreaterThanOrEqual(120);
    expect(sim.hp("player")).toBeLessThan(100);
    expect(sim.hp("player")).toBeGreaterThanOrEqual(15); // it stopped at a quarter (one shot under)
    const p = sim.pos("archer");
    expect(Math.hypot(p[0] - home[0], p[2] - home[2])).toBeLessThan(0.5);
    sim.free();
    // and it never decides the game alone: a hit from it that loses outright, or a player with no
    // hit points, and it holds fire
    for (const world2 of [
      { ...armed, rules: [...armed.rules, { id: "r_caught", src: "ai" as const, layer: "gameplay" as const, when: { t: "hit" as const, a: "player", b: "archer", s: "", n: 0, act: "" as const }, if: [], then: [{ e: "lose" as const, target: "player", v: "", n: 0, fx: "" }], once: true, cooldownS: 0, prio: 0 }] },
      { ...armed, verbs: armed.verbs.filter((v) => v.id !== "vb_hp") },
    ]) {
      const s2 = new SimWorld(R, world2, { brain: castBrain(nav, world2) });
      for (let i = 0; i < 10 * 60 && !s2.result; i++) {
        s2.teleport("player", at);
        s2.step(null);
      }
      expect(s2.log.some((e) => e.k === "shoot" && e.a === "archer")).toBe(false);
      s2.free();
    }
  }, 60_000);

  it("minds may only choose from the typed menu", () => {
    const brain = castBrain(nav, world);
    expect(brain.choose("rival_1", "rival.defend")).toBe(true);
    expect(brain.choose("rival_1", "rival.fly_away")).toBe(false);
    expect(brain.bots.find((b) => b.id === "rival_1")!.beh).toBe("defend");
  });
});
