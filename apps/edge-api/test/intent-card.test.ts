// The Intent card's rebuilds: POST /v1/build with an `intent` the person pinned (a pack, a mode,
// a genre). The pins are checked before anything is spent, told to the intent model, and replace
// its choices, so the fill is written for the pinned pack; a pinned build is its own cache entry.
// And structural edits: /v1/edit shows the edit model the layout the world stands on now (a
// structural edit's numbers are in its fill) and what this pack's layout op may set.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLaneHealth } from "@ghostrun/llm";
import { capsFromEnv, Governor, MemoryLedger } from "../src/governor";
import { handle, type Env } from "../src/handler";
import { fakeFetch, governorNs, INTENT, memR2, readSse, TURNSTILE, waiter, type Upstream } from "./fakes";

const JKEY = "judge-key-for-tests-only";
const TOKEN = "judge_token_0123456789abcdef";
const SECRET = "session-secret-for-tests-only-0123456789";
const ENGINE = "4e9890fd2df60072f9db06a33e4030221249c1b3687b722b2388c21f09e97551";
const judge = { "x-judge-token": TOKEN };
const mac = (t: string) => createHmac("sha256", JKEY).update(t).digest("hex");
let ipN = 0;
const freshIp = () => `192.0.2.${++ipN}`;

function world(up: Upstream = {}) {
  const gov = new Governor(new MemoryLedger(), capsFromEnv({}));
  const f = fakeFetch(up);
  vi.stubGlobal("fetch", f.fn);
  const env: Env = { CEREBRAS_API_KEY: "k", TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: SECRET, JUDGE_TOKEN_KEY: JKEY, JUDGE_TOKEN_HASHES: mac(TOKEN), GOVERNOR: governorNs(gov), GOVERNOR_TIMEOUT_MS: "50", SHARES: memR2() };
  const build = async (body: Record<string, unknown>) => {
    const ctx = waiter();
    const res = await handle(new Request("https://g.example/v1/build", { method: "POST", headers: { "cf-connecting-ip": freshIp(), ...judge }, body: JSON.stringify({ prompt: "Capture the flag on neon rooftops", seed: 7, engine: ENGINE, ...body }) }), env, ctx);
    const events = res.status === 200 ? await readSse(res) : [];
    await ctx.settled();
    return { res, events };
  };
  const edit = async (body: Record<string, unknown>) => {
    const ctx = waiter();
    const res = await handle(new Request("https://g.example/v1/edit", { method: "POST", headers: { "cf-connecting-ip": freshIp(), ...judge }, body: JSON.stringify(body) }), env, ctx);
    const events = res.status === 200 ? await readSse(res) : [];
    await ctx.settled();
    return { res, events };
  };
  const calls = () => f.hits.filter((h) => h.url.includes("cerebras")).map((h) => JSON.parse(h.body) as { messages: { content: string }[] });
  return { build, edit, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetLaneHealth();
});

describe("POST /v1/build with a pinned intent", () => {
  it("the pinned pack replaces the model's (with only the sub-zones it has), the model is told, and the fill is written for it", async () => {
    const w = world({ intent: { inTok: 1000, outTok: 200, body: { ...INTENT, pack: "city_block", sub: ["rooftop"] } } });
    const { res, events } = await w.build({ intent: { pack: "maze" } });
    expect(res.status).toBe(200);
    const intent = events.find((e) => e.event === "intent")!.data.intent;
    expect(intent).toMatchObject({ pack: "maze", sub: [], genre: INTENT.genre });
    const [intentCall, fillCall] = w.calls();
    expect(intentCall!.messages[0]!.content).toContain('The person chose these themselves: {"pack":"maze"}');
    expect(fillCall!.messages.map((m) => m.content).join("\n")).toContain('pack "maze"');
  });

  it("a pinned mode and genre win over the model, and over a goal phrase that would make it a game", async () => {
    const w = world();
    const { events } = await w.build({ prompt: "Find the key and escape the castle", intent: { mode: "wander", genre: " tour " } });
    expect(events.find((e) => e.event === "intent")!.data.intent).toMatchObject({ mode: "wander", genre: "tour", pack: INTENT.pack });
  });

  it("a pin that isn't one is refused before any model call: an unknown pack, a sub-zone the pack lacks, a bad mode, safety", async () => {
    const w = world();
    for (const intent of [{ pack: "volcano" }, { pack: "maze", sub: ["rooftop"] }, { mode: "fly" }, { safety: "ok" }, { genre: "" }, "maze"]) {
      const { res } = await w.build({ intent });
      expect(res.status, JSON.stringify(intent)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/^bad intent/);
    }
    expect(w.calls()).toHaveLength(0);
  });

  it("a pinned rebuild is its own cache entry: the same words built as a maze are not the city replayed", async () => {
    const w = world();
    await w.build({});
    const n = w.calls().length;
    const again = await w.build({});
    expect(again.events[0]!.event).toBe("cached");
    expect(w.calls()).toHaveLength(n);
    const pinned = await w.build({ intent: { pack: "maze" } });
    expect(pinned.events[0]!.event).toBe("intent");
    expect(w.calls().length).toBeGreaterThan(n);
    expect((await w.build({ intent: { pack: "maze" } })).events[0]!.event).toBe("cached");
  });
});

describe("POST /v1/edit for a structural change", () => {
  const fill = (meta: Record<string, unknown>) => [JSON.stringify({ op: "meta", mode: "play", pack: "floor_plan", sub: [], seed: 5, ...meta }), '{"op":"zone","id":"z_hall","slot":"main_room","tag":"hall"}', '{"op":"end","layer":"gameplay"}'].join("\n");
  const req = (f: string) => ({ prompt: "a museum heist", change: "add a floor", intent: { ...INTENT, pack: "floor_plan" }, fill: f, seed: 5 });

  it("teaches the edit model this pack's layout op, with its numbers as they are now", async () => {
    const w = world({ fill: { inTok: 8000, outTok: 40, lines: ['{"op":"layout","params":{"floors":2}}'] } });
    const { events } = await w.edit(req(fill({})));
    expect(events.filter((e) => e.event === "op").map((e) => e.data.line)).toEqual(['{"op":"layout","params":{"floors":2}}']);
    const sent = w.calls()[0]!.messages[0]!.content;
    expect(sent).toContain('{"op":"layout","params":{"floors":2}}');
    expect(sent).toContain("floors 1-2 (now 1: 2 adds an upper floor");
    expect(sent).toContain("width 24-40 (now 28");
    expect(sent).not.toContain('slot "upper_hall"');
  });

  it("a world already reshaped is shown on its new layout: the upper floor's slots, its numbers", async () => {
    const w = world({ fill: { inTok: 8000, outTok: 40, lines: ['{"op":"layout","params":{"width":32}}'] } });
    await w.edit(req(fill({ layout: { floors: 2 } })));
    const sent = w.calls()[0]!.messages[0]!.content;
    expect(sent).toContain('slot "upper_hall" (hall)');
    expect(sent).toContain("floors 1-2 (now 2");
  });
});
