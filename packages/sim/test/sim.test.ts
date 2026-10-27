import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { cityBlock } from "@ghostrun/pack-city-block";
import { placeWorld } from "@ghostrun/layout";
import { BTN, SimWorld, steerTo, type Rapier } from "../src";
import { loadRapierNode } from "../src/rapier/node";

const ctf = readFileSync(new URL("../../ir/fixtures/ctf-neon.jsonl", import.meta.url), "utf8");
let R: Rapier;
let world: WorldBundle;

beforeAll(async () => {
  R = await loadRapierNode();
  const fill = parseFill(ctf, { seed: 7 });
  const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  world = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout).bundle;
});

/** Drive the player through waypoints; returns ticks used or -1 on timeout. */
function drive(sim: SimWorld, pts: { x: number; z: number }[], maxTicks = 3000): number {
  let i = 0;
  for (let t = 0; t < maxTicks && !sim.result; t++) {
    const p = sim.pos("player");
    const wp = pts[i]!;
    if ((p[0] - wp.x) ** 2 + (p[2] - wp.z) ** 2 < 0.5 * 0.5) {
      i++;
      if (i >= pts.length) return t;
      continue;
    }
    sim.step(steerTo(sim.tick + 1, { x: p[0], z: p[2] }, wp));
  }
  return i >= pts.length ? maxTicks : -1;
}

describe("SimWorld on the CTF brief", () => {
  it("carries the orb into the red goal three times and wins", () => {
    const sim = new SimWorld(R, world);
    const orb = sim.pos("orb");
    const goal = sim.pos("goal_red");
    const lap = [{ x: -35, z: 2.2 }, { x: orb[0] - 0.2, z: 1.2 }, { x: orb[0], z: 0 }, { x: goal[0] + 3, z: 0.5 }, { x: goal[0], z: 0 }];
    for (let k = 0; k < 3 && !sim.result; k++) drive(sim, lap.slice(k === 0 ? 0 : 1));
    const scores = sim.log.filter((e) => e.k === "score");
    expect(scores.map((e) => e.rule)).toEqual(["r_score_red", "r_score_red", "r_score_red"]);
    expect(sim.log.filter((e) => e.k === "pickup")).toHaveLength(3);
    expect(sim.result).toBe("win");
    expect(sim.log.at(-1)).toMatchObject({ k: "win", rule: "r_win" });
    sim.free();
  });

  it("is deterministic: same inputs, same event log and state hash", () => {
    const run = () => {
      const sim = new SimWorld(R, world);
      for (let t = 1; t <= 600; t++) sim.step({ tick: t, wx: t < 300 ? 127 : -60, wz: (t % 97) - 48, btn: t % 45 === 0 ? BTN.JUMP : 0 });
      const out = { hash: sim.stateHash(), events: JSON.stringify(sim.log) };
      sim.free();
      return out;
    };
    expect(run()).toEqual(run());
  });

  it("double jump reaches the rooftop lane; a single jump cannot", () => {
    const ledgeTop = Math.max(...world.statics.filter((s) => s.surf === "ledge").map((s) => s.pos[1] + s.size[1] / 2));
    const lane = world.statics.find((s) => s.surf === "ledge" && Math.abs(s.pos[0]) < 1)!; // middle segment
    const faceZ = lane.pos[2] - lane.size[2] / 2;
    const attempt = (jumpsMax: number) => {
      const sim = new SimWorld(R, world, { laws: { jumpsMax } });
      drive(sim, [{ x: -35, z: 2.2 }, { x: -12, z: 2.5 }, { x: 0, z: faceZ - 0.6 }]);
      let best = -Infinity;
      for (let t = 0; t < 120; t++) {
        const vy = sim.player.vy;
        const btn = t === 0 || (t > 5 && vy <= 0.5 && sim.player.jumpsUsed === 1) ? BTN.JUMP : 0;
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 127, btn });
        if (t > 2 && btn) sim.step({ tick: sim.tick + 1, wx: 0, wz: 127, btn: 0 }); // release so the next press is fresh
        best = Math.max(best, sim.pos("player")[1]);
      }
      const p = sim.pos("player");
      sim.free();
      return { onLane: p[2] > faceZ && p[1] > ledgeTop, best };
    };
    expect(attempt(2).onLane).toBe(true);
    expect(attempt(1).onLane).toBe(false);
  });
});
