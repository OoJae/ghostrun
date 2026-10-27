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

  it("minds may only choose from the typed menu", () => {
    const brain = castBrain(nav, world);
    expect(brain.choose("rival_1", "rival.defend")).toBe(true);
    expect(brain.choose("rival_1", "rival.fly_away")).toBe(false);
    expect(brain.bots.find((b) => b.id === "rival_1")!.beh).toBe("defend");
  });
});
