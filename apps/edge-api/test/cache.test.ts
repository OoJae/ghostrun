import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLaneHealth } from "@ghostrun/llm";
import EXAMPLE from "../../../packages/ir/fixtures/vault-heist.jsonl?raw";
import { cacheKey, closesGameplay, MAX_CACHE_BYTES, normalisePrompt, promptSeed, templateHash, type CacheEntry } from "../src/cache";
import type { DoNamespace } from "../src/cf";
import { costMicroUsd, FILL_MODEL, INTENT_MODEL } from "../src/cost";
import { capsFromEnv, Governor, MemoryLedger } from "../src/governor";
import { CACHE_FLAG, handle, type Env } from "../src/handler";
import { fakeFetch, governorNs, INTENT, memR2, readSse, silentNs, TURNSTILE, waiter, type Upstream } from "./fakes";

const JKEY = "judge-key-for-tests-only";
const TOKEN = "judge_token_0123456789abcdef";
const SECRET = "session-secret-for-tests-only-0123456789";
const ENGINE = "4e9890fd2df60072f9db06a33e4030221249c1b3687b722b2388c21f09e97551";
const PROMPT = "Create a capture-the-flag game in a neon city. Add double jump.";
const judge = { "x-judge-token": TOKEN };
const metered = costMicroUsd(INTENT_MODEL, 1000, 200) + costMicroUsd(FILL_MODEL, 3000, 1500);
const mac = (t: string) => createHmac("sha256", JKEY).update(t).digest("hex");
let ipN = 0;
const freshIp = () => `198.51.100.${++ipN}`;

function world(opts: { up?: Upstream; env?: Partial<Env>; ns?: (g: Governor) => DoNamespace } = {}) {
  const gov = new Governor(new MemoryLedger(), capsFromEnv({}));
  const ns = opts.ns ? opts.ns(gov) : governorNs(gov);
  const f = fakeFetch(opts.up);
  vi.stubGlobal("fetch", f.fn);
  const r2 = memR2();
  const env: Env = { CEREBRAS_API_KEY: "k", TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: SECRET, JUDGE_TOKEN_KEY: JKEY, JUDGE_TOKEN_HASHES: mac(TOKEN), GOVERNOR: ns, GOVERNOR_TIMEOUT_MS: "50", SHARES: r2, ...opts.env };
  const build = async (headers: Record<string, string>, body: Record<string, unknown> = {}, ip = freshIp()) => {
    const ctx = waiter();
    const res = await handle(new Request("https://g.example/v1/build", { method: "POST", headers: { "cf-connecting-ip": ip, ...headers }, body: JSON.stringify({ prompt: PROMPT, engine: ENGINE, ...body }) }), env, ctx);
    return { res, ctx };
  };
  /** Build, read the whole stream, and wait for the work after it (the commit, the cache write). */
  const full = async (headers: Record<string, string> = judge, body: Record<string, unknown> = {}, ip?: string) => {
    const { res, ctx } = await build(headers, body, ip);
    const events = res.status === 200 ? await readSse(res) : [];
    await ctx.settled();
    return { res, events };
  };
  const entries = () => [...r2.objects.keys()].filter((k) => k.startsWith("cache/"));
  const pool = (p: string) => gov.status().pools.find((x) => x.pool === p)!;
  return { gov, ns: ns as ReturnType<typeof governorNs>, f, env, r2, build, full, entries, pool };
}

const opLines = (events: { event: string; data: any }[]) => events.filter((e) => e.event === "op").map((e) => e.data.line as string);
const keyFor = async (prompt: string, opts: { template?: string; engine?: string } = {}) => cacheKey(prompt, await promptSeed(prompt), opts.template ?? (await templateHash(EXAMPLE)), opts.engine ?? ENGINE);
const entry = (lines: string[], at = "2026-10-28T09:30:00.000Z"): CacheEntry => ({
  v: 1,
  at,
  intentModel: INTENT_MODEL,
  fillModel: FILL_MODEL,
  events: [{ event: "intent", data: { intent: INTENT, seed: 7, ms: 400 } }, ...lines.map((line, i) => ({ event: "op" as const, data: { i, line } })), { event: "done", data: { lines: lines.length } }],
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetLaneHealth();
});

describe("the exact-repeat build cache", () => {
  it("a repeat is served from the cache: `cached` first, then the same stream, with no hold, no model call and nothing spent", async () => {
    const w = world();
    const first = await w.full();
    expect(first.events.map((e) => e.event)).toEqual(["intent", "op", "op", "op", "done"]);
    expect(w.entries()).toHaveLength(1);
    expect(w.ns.calls).toEqual(["/reserve", "/commit"]);
    expect(w.pool("judge")).toMatchObject({ spent: metered, held: 0 });
    const upstream = w.f.hits.length;

    // the same prompt with other spacing and case is the same entry
    const again = await w.full(judge, { prompt: `  create a CAPTURE-the-flag game   in a neon city. add double jump. ` });
    expect(again.events.map((e) => e.event)).toEqual(["cached", "intent", "op", "op", "op", "done"]);
    expect(again.events[0]!.data).toEqual({ at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), intentModel: INTENT_MODEL, fillModel: FILL_MODEL });
    expect(again.events.slice(1)).toEqual(first.events);
    expect(w.f.hits.length).toBe(upstream); // no model call
    expect(w.ns.calls).toEqual(["/reserve", "/commit"]); // no hold, no commit
    expect(w.pool("judge")).toMatchObject({ spent: metered, held: 0 });
  });

  it("with no seed sent, the seed comes from the prompt, so a repeat has the same layout", async () => {
    const w = world();
    const a = await w.full(judge, { prompt: "A maze with ghosts", engine: undefined }); // no engine: no cache, two live builds
    const b = await w.full(judge, { prompt: "a maze  with ghosts", engine: undefined });
    const seedOf = (es: { event: string; data: any }[]) => es.find((e) => e.event === "intent")!.data.seed as number;
    expect(seedOf(a.events)).toBe(await promptSeed("a maze with ghosts"));
    expect(seedOf(b.events)).toBe(seedOf(a.events));
    expect((await w.full(judge, { prompt: "A maze with ghosts", seed: 11 })).events.find((e) => e.event === "intent")!.data.seed).toBe(11);
  });

  it("fresh: true bypasses the cache, and its build overwrites the entry", async () => {
    const up: Upstream = { fill: { inTok: 3000, outTok: 1500, lines: ['{"op":"meta","v":1}', '{"op":"zone","id":"z_old"}', '{"op":"end","layer":"gameplay"}'] } };
    const w = world({ up });
    await w.full();
    up.fill!.lines = ['{"op":"meta","v":1}', '{"op":"zone","id":"z_new"}', '{"op":"end","layer":"gameplay"}'];
    expect(opLines((await w.full()).events)).toContain('{"op":"zone","id":"z_old"}'); // still the cached one
    const fresh = await w.full(judge, { fresh: true });
    expect(fresh.events[0]!.event).toBe("intent"); // live: no `cached` event
    expect(opLines(fresh.events)).toContain('{"op":"zone","id":"z_new"}');
    expect(w.f.to("api.cerebras.ai")).toHaveLength(4);
    expect(w.pool("judge").spent).toBe(2 * metered);
    const after = await w.full();
    expect(after.events[0]!.event).toBe("cached");
    expect(opLines(after.events)).toContain('{"op":"zone","id":"z_new"}');
    expect(w.entries()).toHaveLength(1);
  });

  it("the key holds the template hash and the engine: an entry under another template or engine misses; the real key hits", async () => {
    const w = world();
    const planted = ['{"op":"meta","v":1}', '{"op":"zone","id":"z_planted"}', '{"op":"end","layer":"gameplay"}'];
    w.r2.objects.set(await keyFor(PROMPT, { template: "0".repeat(64) }), JSON.stringify(entry(planted)));
    w.r2.objects.set(await keyFor(PROMPT, { engine: "f".repeat(64) }), JSON.stringify(entry(planted)));
    const miss = await w.full();
    expect(miss.events[0]!.event).toBe("intent");
    expect(w.f.to("api.cerebras.ai")).toHaveLength(2);

    const other = "a museum heist at night";
    w.r2.objects.set(await keyFor(other), JSON.stringify(entry(planted)));
    const hit = await w.full(judge, { prompt: other });
    expect(hit.events[0]).toEqual({ event: "cached", data: { at: "2026-10-28T09:30:00.000Z", intentModel: INTENT_MODEL, fillModel: FILL_MODEL } });
    expect(opLines(hit.events)).toEqual(planted);
    expect(w.f.to("api.cerebras.ai")).toHaveLength(2);
    // the template hash moves with what the models are sent
    expect(await templateHash(EXAMPLE)).toMatch(/^[0-9a-f]{64}$/);
    expect(await cacheKey(PROMPT, 1, "a".repeat(64), ENGINE)).not.toBe(await cacheKey(PROMPT, 1, "b".repeat(64), ENGINE));
    expect(await cacheKey(PROMPT, 1, "a".repeat(64), ENGINE)).not.toBe(await cacheKey(PROMPT, 2, "a".repeat(64), ENGINE));
  });

  it("without an engine hash there is no cache at all: nothing read, nothing written", async () => {
    const w = world();
    await w.full(judge, { engine: undefined });
    await w.full(judge, { engine: "not-a-hash" });
    expect(w.entries()).toHaveLength(0);
    expect(w.f.to("api.cerebras.ai")).toHaveLength(4);
  });

  it("the kill switch: ff.public_cache=off neither serves an entry nor writes one", async () => {
    const off = world({ env: { FLAGS: { get: async (k: string) => (k === CACHE_FLAG ? "off" : null) } } });
    off.r2.objects.set(await keyFor(PROMPT), JSON.stringify(entry(['{"op":"meta","v":1}'])));
    for (let n = 0; n < 2; n++) expect((await off.full()).events[0]!.event).toBe("intent");
    expect(off.f.to("api.cerebras.ai")).toHaveLength(4);
    expect(off.entries()).toHaveLength(1); // only the planted one
    // any other value leaves it on
    const on = world({ env: { FLAGS: { get: async (k: string) => (k === CACHE_FLAG ? "on" : null) } } });
    await on.full();
    expect((await on.full()).events[0]!.event).toBe("cached");
  });

  it("failed builds aren't kept: an upstream error, a refusal, a client that left mid-fill, an oversized stream; an arcade game is", async () => {
    const failed = world({ up: { fill: { inTok: 0, outTok: 0, status: 500 } } });
    expect((await failed.full()).events.at(-1)!.event).toBe("error");
    expect(failed.entries()).toHaveLength(0);

    const refused = world({ up: { intent: { inTok: 1000, outTok: 200, body: { ...INTENT, safety: "block" } } } });
    expect((await refused.full()).events.map((e) => e.event)).toEqual(["intent", "refusal"]);
    expect(refused.entries()).toHaveLength(0);

    const arcade = world({ up: { intent: { inTok: 1000, outTok: 200, body: { ...INTENT, safety: "arcade" } } } });
    expect((await arcade.full()).events.at(-1)!.event).toBe("done");
    expect(arcade.entries()).toHaveLength(1);

    const left = world({ up: { fill: { inTok: 3000, outTok: 1500, paceMs: 5 } } });
    const { res, ctx } = await left.build(judge);
    const reader = res.body!.getReader();
    await reader.read(); // the intent
    await reader.cancel(); // before the gameplay layer closed
    await ctx.settled();
    expect(left.entries()).toHaveLength(0);

    const big = world({ up: { fill: { inTok: 3000, outTok: 1500, lines: [...Array.from({ length: 200 }, (_, i) => JSON.stringify({ op: "dress", id: `d_${i}`, noun: "x".repeat(900) })), '{"op":"end","layer":"gameplay"}'] } } });
    expect((await big.full()).events.at(-1)!.event).toBe("done");
    expect(big.entries()).toHaveLength(0);
    expect(200 * 900).toBeGreaterThan(MAX_CACHE_BYTES);
  });

  it("a client that leaves once the gameplay layer is complete still leaves a clean entry behind", async () => {
    const lines = ['{"op":"meta","v":1}', '{"op":"zone","id":"z_a"}', '{"op":"end","layer":"gameplay"}', '{"op":"dress","id":"d_1","noun":"crate"}', '{"op":"end","layer":"cosmetic"}'];
    const w = world({ up: { fill: { inTok: 3000, outTok: 1500, lines, paceMs: 5 } } });
    const { res, ctx } = await w.build(judge);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let seen = "";
    while (!seen.includes('\\"layer\\":\\"gameplay\\"')) seen += dec.decode((await reader.read()).value);
    await reader.cancel(); // the app stops reading here: play starts
    await ctx.settled();
    expect(w.entries()).toHaveLength(1);
    const replay = await w.full();
    expect(replay.events[0]!.event).toBe("cached");
    // the cosmetic tail was never paid for: the fill stopped when the client did (a line in flight may ride along)
    const kept = opLines(replay.events);
    expect(kept.slice(0, 3)).toEqual(lines.slice(0, 3));
    expect(kept.length).toBeLessThan(lines.length);
    expect(w.f.to("api.cerebras.ai")[1]!.signal?.aborted).toBe(true);
    expect(replay.events.at(-1)).toMatchObject({ event: "done", data: { lines: kept.length, intentModel: INTENT_MODEL, fillModel: FILL_MODEL } });
  });

  it("a cached prompt still needs the gate and counts against the per-IP build limit, and plays on with the governor down", async () => {
    const w = world({ env: { BUILDS_PER_WINDOW: "2" } });
    await w.full();
    const anon = await w.full({});
    expect(anon.res.status).toBe(401);
    const cookie = await session(w.env);
    const ip = freshIp();
    expect((await w.full({ cookie }, {}, ip)).events[0]!.event).toBe("cached");
    expect((await w.full({ cookie }, {}, ip)).events[0]!.event).toBe("cached");
    expect((await w.full({ cookie }, {}, ip)).res.status).toBe(429);

    // a silent governor fails tokenless builds closed, but a cached one needs no hold
    const quiet = world({ ns: () => silentNs() });
    quiet.r2.objects.set(await keyFor(PROMPT), JSON.stringify(entry(['{"op":"meta","v":1}', '{"op":"end","layer":"gameplay"}'])));
    const c2 = await session(quiet.env);
    expect((await quiet.full({ cookie: c2 })).events[0]!.event).toBe("cached");
    expect((await quiet.full({ cookie: c2 }, { prompt: "something never built" })).res.status).toBe(503);
  });

  it("an unreadable or slow store is a miss, never a failed build", async () => {
    const w = world();
    w.r2.objects.set(await keyFor(PROMPT), "{not json");
    expect((await w.full()).events[0]!.event).toBe("intent");
    const slow = world({ env: { SHARES: { ...memR2(), get: () => new Promise(() => {}) } } });
    const t0 = performance.now();
    expect((await slow.full()).events.map((e) => e.event)).toEqual(["intent", "op", "op", "op", "done"]);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("helpers: prompt normalisation and the gameplay-end line, glued or not", () => {
    expect(normalisePrompt("  A   Maze\twith GHOSTS \n")).toBe("a maze with ghosts");
    expect(closesGameplay('{"op":"end","layer":"gameplay"}')).toBe(true);
    expect(closesGameplay('{"op":"rule","id":"r","then":[{"e":"win"}]}{"op":"end","layer":"gameplay"}')).toBe(true);
    expect(closesGameplay('{"op":"end","layer":"cosmetic"}')).toBe(false);
    expect(closesGameplay('{"op":"ent","id":"x","noun":"the end"}')).toBe(false);
  });
});

async function session(env: Env): Promise<string> {
  const res = await handle(new Request("https://g.example/v1/session", { method: "POST", headers: { "cf-connecting-ip": freshIp() }, body: JSON.stringify({ token: TURNSTILE.dummyToken }) }), env);
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
