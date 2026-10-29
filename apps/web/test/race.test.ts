import { beforeAll, describe, expect, it } from "vitest";
import { loadNavNode } from "@ghostrun/nav/node";
import { replayRun, type Ghost, type ProgressSim } from "@ghostrun/proof";
import { BTN, type InputFrame, type Rapier, type SimEvent } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { buildWorld } from "../src/pipeline";
import { GhostTrack, RaceTracker, raceClock, resultCard, split, worldTitle } from "../src/race";
import { verdict } from "../src/rivals";
import { RapierSim } from "../src/sim/rapier";

/**
 * Out and back along x: 10 m out over 2 s with nothing in hand, the orb picked up at the far end,
 * home again by 4 s, and the point scored on the line (the win).
 */
function outAndBack(): Ghost {
  const xyz: number[] = [];
  const dir: number[] = [];
  const prog: number[] = [];
  for (let t = 0; t <= 240; t += 4) {
    const x = t <= 120 ? t / 12 : 10 - (t - 120) / 12;
    xyz.push(x, 0.95, 0);
    dir.push(t < 120 ? 127 : -127, 0);
    prog.push(t === 240 ? 512 : t >= 120 ? 1 : 0);
  }
  return { every: 4, ticks: 240, xyz, dir, prog };
}

/** A stand-in simulation: the player at x, carrying or not, with this many points. */
function player(tick: number, x: number, carrying: boolean, score = 0, z = 0): ProgressSim {
  return { tick, log: [] as SimEvent[], scores: { "team:red": score }, entity: () => ({ team: "red", carrying: carrying ? "orb" : "" }), pos: () => [x, 0.95, z] };
}

describe("a ghost's pose", () => {
  it("interpolates between samples by tick, faces the way it pushed, and holds at the finish", () => {
    const tr = new GhostTrack(outAndBack());
    expect(tr.pose(0).p).toEqual([0, 0.95, 0]);
    expect(tr.pose(6).p[0]).toBeCloseTo(0.5, 6); // halfway between the samples at 4 and 8
    expect(tr.pose(60).p[0]).toBeCloseTo(5, 6);
    expect(tr.pose(180).p[0]).toBeCloseTo(5, 6); // on the way home
    expect(tr.pose(9999).p[0]).toBeCloseTo(0, 6); // won: it waits on the line
    expect(tr.pose(30).yaw).toBeCloseTo(-Math.PI / 2, 6); // pushing +x: three.js yaw −90°
    expect(Math.abs(tr.pose(200).yaw)).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe("ahead or behind, live", () => {
  it("is zero on the ghost's own line, plus a second a second late, minus half a second half a second early", () => {
    const g = outAndBack();
    expect(new RaceTracker(new GhostTrack(g), new Set()).delta(player(60, 5, false))).toBeCloseTo(0, 1);
    expect(new RaceTracker(new GhostTrack(g), new Set()).delta(player(120, 5, false))).toBeCloseTo(1, 1);
    expect(new RaceTracker(new GhostTrack(g), new Set()).delta(player(30, 5, false))).toBeCloseTo(-0.5, 1);
  });

  it("matches on the stage of the win: at 8 m with the orb you're on the way home, not the way out", () => {
    const g = outAndBack();
    const t = new RaceTracker(new GhostTrack(g), new Set());
    // the ghost passed 8 m outbound at tick 96 and homebound at tick 144
    expect(t.delta(player(150, 8, true))).toBeCloseTo((150 - 144) / 60, 1);
    expect(new RaceTracker(new GhostTrack(g), new Set()).delta(player(150, 8, false))).toBeCloseTo((150 - 96) / 60, 1);
  });

  it("says nothing off its route, and once it has finished you're at least that far behind", () => {
    const g = outAndBack();
    expect(new RaceTracker(new GhostTrack(g), new Set()).delta(player(60, 5, false, 0, 30))).toBeNull();
    expect(new RaceTracker(new GhostTrack(g), new Set()).delta(player(300, 5, false, 0, 30))).toBeCloseTo(1, 6);
    expect(new RaceTracker(new GhostTrack(g), new Set()).delta(player(300, 2, false))).toBeGreaterThanOrEqual(1);
  });
});

describe("race text", () => {
  it("clocks in tenths and splits with a sign", () => {
    expect(raceClock(2481)).toBe("0:41.4");
    expect(raceClock(60 * 75 + 30)).toBe("1:15.5");
    expect(split(-1.24)).toBe("−1.2 s");
    expect(split(0.96)).toBe("+1.0 s");
    expect(split(0.01)).toBe("±0.0 s");
  });

  it("the result card is one line of numbers the receipt and the run state, the link last", () => {
    const w = buildWorld("", "ctf");
    expect(worldTitle(w, "anything")).toBe("capture-the-flag"); // a recorded world by its fill
    expect(worldTitle({ fill: "", intent: { ...w.intent, live: { genre: "sumo", setting: "", goal: "", fail: "", role: "" } } }, "x")).toBe("sumo");
    expect(worldTitle({ fill: "", intent: w.intent }, "A wizard duel on floating islands: knock your rival off")).toBe("A wizard duel on floating");
    expect(worldTitle({ fill: "", intent: w.intent }, "Shared run")).toBe("Rooftop lane needs double jump");
    expect(resultCard({ title: "capture-the-flag", won: { k: 12, n: 12 }, me: { ticks: 2538, won: true }, aiTicks: 2481, link: "https://play.ghostrun.workers.dev/?race=abcdefghijklmnop" })).toBe(
      "GHOSTRUN · capture-the-flag · 12 of 12 AI runners won · me 0:42.3 · AI 0:41.4 · beat it: https://play.ghostrun.workers.dev/?race=abcdefghijklmnop",
    );
    expect(resultCard({ title: "coin rush", won: null, me: { ticks: 900, won: false }, aiTicks: null, rival: { name: "Ana", ticks: 800 }, link: null })).toBe("GHOSTRUN · coin rush · me out at 0:15.0 · Ana 0:13.3");
  });
});

describe("a stored run, replayed headless", () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await loadRapierNode();
    await loadNavNode();
  });

  it("ends exactly where the game's own replay of it ends, minds included", () => {
    const { bundle } = buildWorld("", "ctf");
    // a scripted run: east toward the orb, weaving, jumping now and then (sparse frames hold until the next)
    const inputs: InputFrame[] = [];
    for (let t = 1; t <= 1500; t += t % 7 === 0 ? 3 : 1) inputs.push({ tick: t, wx: Math.floor(t / 240) % 4 < 2 ? 127 : -127, wz: ((t * 7) % 61) - 30, btn: t % 53 === 0 ? BTN.JUMP : 0 });
    const minds = [
      { tick: 200, npc: "rival_1", option: "rival.intercept" },
      { tick: 900, npc: "mate_1", option: "teammate.attack" },
    ];
    const game = new RapierSim(R, bundle, true);
    // fast-forward through the game's own replay path, synchronously, to the last recorded tick
    // (past it the game hands over to live input, which a stored run doesn't have)
    game.replay(inputs, minds, inputs.at(-1)!.tick);
    const headless = replayRun(R, bundle, inputs, minds);
    expect(headless.ticks).toBe(game.sim.tick);
    expect(headless.hash).toBe(game.sim.stateHash());
    expect(headless.result).toBe(game.sim.result);
    game.stop();
  });

  it("verifies a claim only when it wins on exactly that tick", () => {
    const g = outAndBack();
    const won = { result: "win" as const, winTick: 240, ticks: 240, ghost: g, hash: "x" };
    expect(verdict(won, 240).status).toBe("verified");
    expect(verdict(won, null).status).toBe("verified");
    expect(verdict(won, 239)).toEqual({ status: "mismatch", winTick: 240 });
    expect(verdict({ result: null, winTick: null, ticks: 500, ghost: null, hash: "x" }, 240)).toEqual({ status: "mismatch", winTick: null });
  });
});
