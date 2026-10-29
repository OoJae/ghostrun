import { beforeAll, describe, expect, it } from "vitest";
import { castBrain } from "@ghostrun/bots";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { SimWorld, type Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { facts, story } from "../src/host";
import { buildWorld } from "../src/pipeline";

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

describe("the Host's story", () => {
  it("a CTF loss: blue's points, who carried the orb in, from the causal log", () => {
    const { bundle } = buildWorld("", "ctf");
    const sim = new SimWorld(R, bundle, { brain: castBrain(buildNav(bundle), bundle) });
    for (let t = 0; t < 60 * 180 && !sim.result; t++) sim.step(null); // the player stands still
    expect(sim.result).toBe("lose");
    const s = story(bundle, sim.log)!;
    console.log([s.ending, ...s.moments.map((m) => `${m.tick} ${m.text}`)].join("\n"));
    expect(s.ending).toMatch(/^You lost at \d+:\d\d: blue team reached 3\.$/);
    // the same thing three times is one moment, replayed at the decisive point
    expect(s.moments.map((m) => m.text)).toEqual(["Rival 1 carried the glowing orb into the neon goal ring, 3 times (blue 1–3)"]);
    expect(s.moments[0]!.at).toEqual(bundle.entities.find((e) => e.id === "goal_blue")!.pos);
    // what the Host may answer from: the ending and the moments (replayable), then the world
    const f = facts(bundle, sim.log);
    expect(f[0]).toEqual({ text: s.ending.replace(/\.$/, ""), tick: sim.tick });
    expect(f.some((x) => x.text.endsWith("Rival 1 picked up the glowing orb") && x.tick !== null)).toBe(true);
    expect(f).toContainEqual({ text: "Movement: 2 jumps in a row, each about 1.6 m high, running 6 m/s", tick: null });
    expect(f).toContainEqual({ text: "Rule: WHEN player picks up glowing orb THEN glowing orb becomes carried, effect sparkle", tick: null });
    expect(f).toContainEqual({ text: "Rule: WHEN blue team reaches 3 THEN you lose (once)", tick: null });
    expect(f.length).toBeLessThanOrEqual(36);
    expect(s.moments.every((m, i, a) => i === 0 || a[i - 1]!.tick <= m.tick)).toBe(true);
  }, 60_000);

  it("a duel lost standing still: the rival wizard's frost knocked you out", () => {
    const { bundle } = buildWorld("", "duel");
    const sim = new SimWorld(R, bundle, { brain: castBrain(buildNav(bundle), bundle) });
    for (let t = 0; t < 60 * 120 && !sim.result; t++) sim.step(null);
    expect(sim.result).toBe("lose");
    const s = story(bundle, sim.log)!;
    expect(s.ending).toMatch(/^You lost at \d+:\d\d: you were knocked out\.$/);
    expect(s.moments.map((m) => m.text)).toEqual(["The rival wizard knocked you out"]);
    expect(facts(bundle, sim.log).some((x) => x.text.endsWith("The rival wizard hit you"))).toBe(true);
  }, 60_000);
});
