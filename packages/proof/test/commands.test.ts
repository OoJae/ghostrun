// Team AI in the proof: every option a command can pick on the CTF mate's menu gets a forced-state
// test (said as a command act, the mate plays it from the next tick and heads where it takes it),
// and a teammate whose menu can't do what it is told is a counterexample, not a pass.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { cityBlock } from "@ghostrun/pack-city-block";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { chipLine, t2Commands } from "../src";

let R: Rapier;
let world: WorldBundle;

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
  const text = readFileSync(new URL("../../ir/fixtures/ctf-neon.jsonl", import.meta.url), "utf8");
  const fill = parseFill(text, { seed: 7 });
  const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  world = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout).bundle;
});

describe("commanding a teammate", () => {
  it("forces each option a command picks on the CTF mate's menu: it plays it and acts on it", () => {
    const nav = buildNav(world);
    const chips = t2Commands(R, world, nav, "red");
    nav.destroy();
    console.log(["", ...chips.map(chipLine)].join("\n"));
    expect(chips.map((c) => c.id)).toEqual(["T2:command:mate_1:teammate.attack", "T2:command:mate_1:teammate.defend", "T2:command:mate_1:teammate.follow"]);
    for (const c of chips) expect(c).toMatchObject({ tier: "T2", status: "verified", n: 1, k: 1, method: "forced-state ≤180 ticks" });
    expect(chips[2]!.text).toBe("the teammate mate_1 plays teammate.follow when told");
    // from the blue side, the rivals are the team: theirs are forced too
    const nav2 = buildNav(world);
    expect(new Set(t2Commands(R, world, nav2, "blue").map((c) => c.subject.id))).toEqual(new Set(["command:rival_1", "command:rival_2"]));
    nav2.destroy();
  }, 60_000);

  it("a teammate that can't get where an order takes it is a counterexample", () => {
    // the mate walled in where it stands: told anything that means going somewhere, it can't
    const pad = world.entities.find((e) => e.id === "mate_1")!;
    const box = (id: string, dx: number, dz: number, sx: number, sz: number) => ({ id, src: "ai" as const, layer: "gameplay" as const, zone: pad.zone, shape: "box" as const, pos: [pad.pos[0] + dx, pad.pos[1] + 1, pad.pos[2] + dz] as [number, number, number], rotY: 0, size: [sx, 4, sz] as [number, number, number], surf: "wall" as const });
    const walled = { ...world, statics: [...world.statics, box("w_n", 0, 0.75, 1.9, 0.4), box("w_s", 0, -0.75, 1.9, 0.4), box("w_e", 0.75, 0, 0.4, 1.9), box("w_w", -0.75, 0, 0.4, 1.9)] };
    const nav = buildNav(walled);
    const chips = t2Commands(R, walled, nav, "red");
    nav.destroy();
    const bad = chips.filter((c) => c.status === "counterexample");
    expect(bad.length).toBeGreaterThan(0);
    expect(bad[0]!.cx?.text).toMatch(/^told teammate\.[a-z]+, it got no nearer where that takes it$/);
  }, 60_000);
});
