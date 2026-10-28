import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimEvent } from "@ghostrun/sim";
import { Minds } from "../src/minds";
import { buildWorld } from "../src/pipeline";
import type { RapierSim } from "../src/sim/rapier";

// Just what Minds reads from the simulation.
function fakeSim() {
  const f = {
    sim: { tick: 0, scores: {} as Record<string, number>, pos: () => [0, 0, 0] as [number, number, number], entity: () => undefined },
    replaying: false,
    idle: 0,
    get idleTicks() {
      return f.idle;
    },
    optionOf: () => "rival.defend",
    queueMind: vi.fn(),
  };
  return f;
}

function answering(status = 200) {
  const calls: { npc: string; event: string; said?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(status === 200 ? { option: "rival.intercept", line: "Mine now." } : { error: "rate limited" }), { status });
    }),
  );
  return calls;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const pickup: SimEvent[] = [{ k: "pickup", a: "orb", b: "rival_1", tick: 0 } as unknown as SimEvent];

afterEach(() => vi.unstubAllGlobals());

describe("NPC minds", () => {
  it("a world of bots picking up the orb all the time: one NPC thinks every 8 s, about 75 calls in 10 minutes", async () => {
    const calls = answering();
    const sim = fakeSim();
    const minds = new Minds(buildWorld("", "ctf"), sim as unknown as RapierSim, () => {});
    expect(minds.minded.length).toBeGreaterThan(1);
    for (let t = 1; t <= 10 * 60 * 60; t++) {
      sim.sim.tick = t;
      minds.observe(pickup);
      if (t % 60 === 0) await flush();
    }
    expect(calls.length).toBeGreaterThanOrEqual(70);
    expect(calls.length).toBeLessThanOrEqual(76); // the edge allows 120 per session in 10 minutes
    expect(new Set(calls.slice(0, minds.minded.length).map((c) => c.npc)).size).toBe(minds.minded.length); // they take turns
  });

  it("nobody playing (a minute without input) or a replay: no calls", async () => {
    const calls = answering();
    const sim = fakeSim();
    const minds = new Minds(buildWorld("", "ctf"), sim as unknown as RapierSim, () => {});
    sim.idle = 60 * 60 + 1;
    for (let t = 1; t <= 3000; t++) ((sim.sim.tick = t), minds.observe(pickup));
    sim.idle = 0;
    sim.replaying = true;
    for (let t = 3001; t <= 6000; t++) ((sim.sim.tick = t), minds.observe(pickup));
    await flush();
    expect(calls).toEqual([]);
  });

  it("talking always gets an answer, even mid-thought and right after one", async () => {
    const calls = answering();
    const sim = fakeSim();
    const barks: string[] = [];
    const minds = new Minds(buildWorld("", "ctf"), sim as unknown as RapierSim, (_n, name, line) => barks.push(`${name}: ${line}`));
    sim.sim.tick = 600;
    minds.observe(pickup); // the first NPC starts thinking
    const first = minds.minded[0]!.npc;
    minds.talk(first, "where is the orb?");
    await flush();
    expect(calls.map((c) => c.said ?? null)).toEqual([null, "where is the orb?"]);
    expect(barks).toHaveLength(2);
    expect(sim.queueMind).toHaveBeenCalled();
  });

  it("rate limited: they stop thinking on their own for a minute", async () => {
    const calls = answering(429);
    const sim = fakeSim();
    const minds = new Minds(buildWorld("", "ctf"), sim as unknown as RapierSim, () => {});
    for (let t = 1; t <= 600 + 60 * 60; t++) {
      sim.sim.tick = t;
      minds.observe(pickup);
      if (t % 60 === 0) await flush();
    }
    expect(calls).toHaveLength(2); // at 8 s, then once the minute is up
  });
});
