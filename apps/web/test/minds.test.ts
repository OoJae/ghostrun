import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimEvent } from "@ghostrun/sim";
import { Minds } from "../src/minds";
import { buildWorld } from "../src/pipeline";
import type { RapierSim } from "../src/sim/rapier";

// Just what Minds reads from the simulation.
function fakeSim(words: string[] = [], coins = 0) {
  const f = {
    sim: { tick: 0, scores: {} as Record<string, number>, pos: () => [0, 0, 0] as [number, number, number], entity: () => undefined, blind: () => false, words, purse: () => coins },
    replaying: false,
    idle: 0,
    get idleTicks() {
      return f.idle;
    },
    optionOf: () => "rival.defend",
    queueMind: vi.fn(),
    queueAct: vi.fn(),
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

describe("speech acts", () => {
  const answer = (body: unknown) => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => (calls.push(JSON.parse(String(init.body))), new Response(JSON.stringify(body)))));
    return calls;
  };
  it("talked to, the guard is told the acts its rules accept and the facts it knows; an accepted bribe goes into the sim as an act, not as the option it earns", async () => {
    const calls = answer({ option: "guard.look_away", line: "Twenty. Fine.", act: "offer", what: "coins", n: 20, slot: "" });
    const sim = fakeSim(["coins"], 20);
    const minds = new Minds(buildWorld("", "museum"), sim as unknown as RapierSim, () => {});
    minds.talk("guard", "here's 20 coins, look the other way");
    await flush();
    expect(calls[0]).toMatchObject({ acts: [{ act: "offer", what: "coins", n: 20, gives: "guard.look_away" }], said: "here's 20 coins, look the other way" });
    expect(String(calls[0]!.situation)).toContain("the player has 20 coins");
    expect((calls[0]!.facts as string[]).some((f) => f.includes("the vault key is in the West gallery"))).toBe(true);
    expect(sim.queueAct).toHaveBeenCalledWith({ to: "guard", act: "offer", what: "coins", n: 20, slot: "" });
    expect(sim.queueMind).not.toHaveBeenCalled();
  });
  it("coins the player hasn't got change no hands; a booking waits for the player's yes, with today's date and zone sent along", async () => {
    answer({ option: "guard.watch", line: "Deal.", act: "offer", what: "coins", n: 20, slot: "" });
    const poor = fakeSim(["coins"], 5);
    const notes: string[] = [];
    new Minds(buildWorld("", "museum"), poor as unknown as RapierSim, () => {}, { onNote: (t) => notes.push(t) }).talk("guard", "20 coins?");
    await flush();
    expect(poor.queueAct).not.toHaveBeenCalled();
    expect(notes).toEqual(["You have 5 coins."]);
    const calls = answer({ option: "guide.welcome", line: "Saturday at three it is.", act: "book", what: "", n: 0, slot: "2026-11-07T15:00" });
    const sim = fakeSim();
    const asked: unknown[] = [];
    new Minds(buildWorld("", "villa"), sim as unknown as RapierSim, () => {}, { onConfirm: (npc, name, a) => asked.push([npc, name, a]) }).talk("guide", "can I book a viewing on Saturday at 3?");
    await flush();
    expect(calls[0]).toMatchObject({ acts: [{ act: "book" }], tz: expect.any(String), today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}, [A-Z][a-z]+day$/) });
    expect(asked).toEqual([["guide", "estate agent", { to: "guide", act: "book", what: "", n: 0, slot: "2026-11-07T15:00" }]]);
    expect(sim.queueAct).not.toHaveBeenCalled();
  });
});
