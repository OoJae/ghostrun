import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FillParser } from "@ghostrun/ir";
import type { DoNamespace } from "../src/cf";
import { costMicroUsd, FILL_MODEL, INTENT_MODEL } from "../src/cost";
import { capsFromEnv, Governor, localCall, MemoryLedger, type Caps } from "../src/governor";
import { handle, PAUSE_FLAG, type Env } from "../src/handler";
import { fakeFetch, governorNs, INTENT, readSse, silentNs, TURNSTILE, waiter, type Upstream } from "./fakes";

// Only read the gitignored keys file when the live test is explicitly requested.
function key(): string | undefined {
  const f = new URL("../../../.dev.vars", import.meta.url);
  if (!existsSync(f)) return undefined;
  return /^CEREBRAS_API_KEY=(.+)$/m.exec(readFileSync(f, "utf8"))?.[1];
}

const JKEY = "judge-key-for-tests-only";
const TOKEN = "judge_token_0123456789abcdef";
const SECRET = "session-secret-for-tests-only-0123456789";
const mac = (t: string) => createHmac("sha256", JKEY).update(t).digest("hex");
let ipN = 0;
const freshIp = () => `203.0.113.${++ipN}`;

function world(opts: { caps?: Partial<Caps["pool"]>; up?: Upstream; ns?: (g: Governor) => DoNamespace; env?: Partial<Env> } = {}) {
  const c = capsFromEnv({});
  const gov = new Governor(new MemoryLedger(), { ...c, pool: { ...c.pool, ...opts.caps } });
  const ns = opts.ns ? opts.ns(gov) : governorNs(gov);
  const f = fakeFetch(opts.up);
  vi.stubGlobal("fetch", f.fn);
  const env: Env = { CEREBRAS_API_KEY: "k", TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: SECRET, JUDGE_TOKEN_KEY: JKEY, JUDGE_TOKEN_HASHES: mac(TOKEN), GOVERNOR: ns, GOVERNOR_TIMEOUT_MS: "50", ...opts.env };
  const pool = (p: string) => gov.status().pools.find((x) => x.pool === p)!;
  const build = async (headers: Record<string, string>, body: unknown = { prompt: "a maze with ghosts and a key that opens the exit", seed: 11 }) => {
    const ctx = waiter();
    const res = await handle(new Request("https://g.example/v1/build", { method: "POST", headers: { "cf-connecting-ip": freshIp(), ...headers }, body: JSON.stringify(body) }), env, ctx);
    return { res, ctx };
  };
  return { gov, ns, f, env, pool, build };
}

const judge = { "x-judge-token": TOKEN };
const metered = costMicroUsd(INTENT_MODEL, 1000, 200) + costMicroUsd(FILL_MODEL, 3000, 1500);

afterEach(() => vi.unstubAllGlobals());

describe("POST /v1/mind", () => {
  const call = async (env: Env, body: unknown) =>
    handle(new Request("https://g.example/v1/mind", { method: "POST", headers: { "cf-connecting-ip": freshIp(), "x-judge-token": TOKEN }, body: JSON.stringify(body) }), env, waiter());
  const ask = { npc: "rival_1", role: "rival", persona: "", menu: ["rival.attack", "rival.defend", "rival.intercept"], current: "rival.attack", situation: "red 1, blue 0", event: "red scored" };
  it("returns the chosen menu option and a line, charged to the caller's pool", async () => {
    const w = world({ up: { intent: { inTok: 900, outTok: 30, body: { option: "rival.defend", line: "Nobody scores twice on my watch." } } } });
    const r = await call(w.env, ask);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ option: "rival.defend", line: "Nobody scores twice on my watch." });
    expect(w.pool("judge").spent).toBe(costMicroUsd(INTENT_MODEL, 900, 30));
    // the model sees the menu as a strict enum
    expect(w.f.hits.find((h) => h.url.includes("cerebras"))!.body).toContain('"enum":["rival.attack","rival.defend","rival.intercept"]');
  });
  it("never acts off-menu: an unknown option falls back to the current one; a bad request costs nothing", async () => {
    const w = world({ up: { intent: { inTok: 900, outTok: 30, body: { option: "rival.fly_away", line: "Bye!" } } } });
    expect(await (await call(w.env, ask)).json()).toMatchObject({ option: "rival.attack" });
    const bad = await call(w.env, { npc: "rival_1", menu: [] });
    expect(bad.status).toBe(400);
  });
});

describe("POST /v1/repair", () => {
  it("streams the model's patch lines, charges the caller's pool, and rejects bad requests before any model call", async () => {
    const w = world({ up: { fill: { inTok: 9000, outTok: 300, lines: ['{"op":"rule","id":"r_win","when":{"t":"enter","a":"gem","b":"exit"},"then":[{"e":"win","target":"player"}]}', '{"op":"del","id":"x_old"}'] } } });
    const call = async (body: unknown) => {
      const ctx = waiter();
      const res = await handle(new Request("https://g.example/v1/repair", { method: "POST", headers: { "cf-connecting-ip": freshIp(), "x-judge-token": TOKEN }, body: JSON.stringify(body) }), w.env, ctx);
      return { res, ctx };
    };
    const bad = await call({ prompt: "x", fill: "", issues: [], seed: 1 });
    expect(bad.res.status).toBe(400);
    expect(w.f.hits.filter((h) => h.url.includes("cerebras"))).toHaveLength(0);
    const fill = '{"op":"meta","mode":"play","pack":"arena","seed":3}\n{"op":"end","layer":"gameplay"}\n{"op":"dress","id":"d1","noun":"crate","zone":"z","anchor":""}';
    const { res, ctx } = await call({ prompt: "steal the gem", intent: { ...INTENT, pack: "arena" }, fill, issues: ["won in 1.2 s: the win needs nothing"], seed: 3 });
    const events = await readSse(res);
    await ctx.settled();
    expect(events.filter((e) => e.event === "op").map((e) => (e.data as { line: string }).line)).toHaveLength(2);
    expect(events.at(-1)!.event).toBe("done");
    // the model saw the issues and only the gameplay lines (the cosmetic tail is never sent)
    const sent = w.f.hits.find((h) => h.url.includes("cerebras"))!.body;
    expect(sent).toContain("won in 1.2 s");
    expect(sent).not.toContain("crate");
    expect(w.pool("judge").spent).toBe(costMicroUsd(FILL_MODEL, 9000, 300));
  });
});

describe("POST /v1/edit", () => {
  it("streams the patch for the person's change, charged like a repair; anonymous callers are gated", async () => {
    const w = world({ up: { fill: { inTok: 8000, outTok: 120, lines: ['{"op":"law","player":{"jumpsMax":1}}'] } } });
    const call = async (headers: Record<string, string>, body: unknown) => {
      const ctx = waiter();
      const res = await handle(new Request("https://g.example/v1/edit", { method: "POST", headers: { "cf-connecting-ip": freshIp(), ...headers }, body: JSON.stringify(body) }), w.env, ctx);
      return { res, ctx };
    };
    const fill = '{"op":"meta","mode":"play","pack":"arena","seed":3}\n{"op":"end","layer":"gameplay"}';
    const req = { prompt: "steal the gem", change: "only one jump", intent: { ...INTENT, pack: "arena" }, fill, seed: 3 };
    expect((await call({}, req)).res.status).toBe(401);
    expect((await call(judge, { ...req, change: " " })).res.status).toBe(400);
    expect(w.f.hits.filter((h) => h.url.includes("cerebras"))).toHaveLength(0);
    const { res, ctx } = await call(judge, req);
    const events = await readSse(res);
    await ctx.settled();
    expect(events.filter((e) => e.event === "op").map((e) => (e.data as { line: string }).line)).toEqual(['{"op":"law","player":{"jumpsMax":1}}']);
    const sent = w.f.hits.find((h) => h.url.includes("cerebras"))!.body;
    expect(sent).toContain("The change to make: only one jump");
    expect(sent).toContain("never try to make a check pass");
    expect(w.pool("judge").spent).toBe(costMicroUsd(FILL_MODEL, 8000, 120));
  });
});

describe("edge API", () => {
  it("health and input validation", async () => {
    const dev: Env = { CEREBRAS_API_KEY: "k", DEV_OPEN: "1" };
    const h = await handle(new Request("http://localhost/v1/health"), dev);
    expect(await h.json()).toMatchObject({ ok: true, llm: true, gate: "dev", sitekey: null });
    const empty = await handle(new Request("http://localhost/v1/build", { method: "POST", body: JSON.stringify({ prompt: "  " }) }), dev);
    expect(empty.status).toBe(400);
    const bad = await handle(new Request("http://localhost/v1/build", { method: "POST", body: "{" }), dev);
    expect(bad.status).toBe(400);
    expect((await handle(new Request("http://localhost/v1/nope"), dev)).status).toBe(404);
  });

  it("the gate is closed by default, and DEV_OPEN only opens it on localhost", async () => {
    const req = (u: string) => new Request(u, { method: "POST", body: JSON.stringify({ prompt: "x" }) });
    expect((await handle(req("https://g.example/v1/build"), { CEREBRAS_API_KEY: "k" })).status).toBe(503);
    expect((await handle(req("https://g.example/v1/build"), { CEREBRAS_API_KEY: "k", DEV_OPEN: "1" })).status).toBe(503);
    expect(await (await handle(new Request("https://g.example/v1/health"), { CEREBRAS_API_KEY: "k", DEV_OPEN: "1" })).json()).toMatchObject({ gate: "closed" });
    const { build } = world();
    const anon = await build({});
    expect(anon.res.status).toBe(401);
    expect(await anon.res.json()).toMatchObject({ need: "turnstile" });
  });

  it("reserves before calling the model and commits the metered cost from usage", async () => {
    const w = world();
    const { res, ctx } = await w.build(judge);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const events = await readSse(res);
    expect(events.map((e) => e.event)).toEqual(["intent", "op", "op", "op", "done"]);
    await ctx.settled();
    expect((w.ns as ReturnType<typeof governorNs>).calls).toEqual(["/reserve", "/commit"]);
    expect(w.pool("judge")).toMatchObject({ spent: metered, held: 0 });
    expect(w.f.to("api.cerebras.ai").length).toBe(2);
  });

  it("a budget denial is a 429 and costs nothing upstream", async () => {
    const w = world({ caps: { judge: 1000 } });
    const { res } = await w.build(judge);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "budget", reason: "pool_cap", retryable: false });
    expect(w.f.to("api.cerebras.ai").length).toBe(0);
  });

  it("governor silent: tokenless traffic fails closed with 503 retryable; a judge token falls back", async () => {
    const w = world({ ns: () => silentNs() });
    const cookie = await session(w.env);
    const t0 = performance.now();
    const anon = await w.build({ cookie });
    expect(anon.res.status).toBe(503);
    expect(await anon.res.json()).toEqual({ error: "governor unavailable", retryable: true });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(w.f.to("api.cerebras.ai").length).toBe(0);
    const j = await w.build(judge);
    expect(j.res.status).toBe(200);
    expect((await readSse(j.res)).at(-1)!.event).toBe("done");
  });

  it("judge fallback is bounded per isolate and recorded when the governor comes back for /record", async () => {
    // Reserve never answers; record does.
    const own = { "x-judge-token": "judge_token_fallback_only_01" }; // the bucket is per token, per isolate
    const w = world({
      env: { JUDGE_FALLBACK_PER_WINDOW: "2", JUDGE_TOKEN_HASHES: mac(own["x-judge-token"]) },
      ns: (g) => {
        const call = localCall(g);
        return { idFromName: (n: string) => n, get: () => ({ fetch: (u: string, init?: RequestInit) => (u.endsWith("/reserve") ? new Promise<Response>(() => {}) : call(new URL(u).pathname, JSON.parse(String(init!.body)))) }) };
      },
    });
    for (let i = 0; i < 2; i++) {
      const { res, ctx } = await w.build(own);
      expect(res.status).toBe(200);
      await readSse(res);
      await ctx.settled();
    }
    expect(w.pool("judge")).toMatchObject({ spent: 2 * metered, held: 0 });
    expect((await w.build(own)).res.status).toBe(429);
  });

  it("POST /v1/session verifies Turnstile server-side and its cookie opens /v1/build (public pool)", async () => {
    const w = world();
    const cookie = await session(w.env);
    const { res, ctx } = await w.build({ cookie });
    expect((await readSse(res)).at(-1)!.event).toBe("done");
    await ctx.settled();
    expect(w.pool("public")).toMatchObject({ spent: metered, held: 0 });
    const fail = await handle(new Request("https://g.example/v1/session", { method: "POST", body: JSON.stringify({ token: TURNSTILE.dummyToken }) }), { ...w.env, TURNSTILE_SECRET: TURNSTILE.secretFail });
    expect(fail.status).toBe(403);
    expect(fail.headers.get("set-cookie")).toBeNull();
    const spent = await handle(new Request("https://g.example/v1/session", { method: "POST", body: JSON.stringify({ token: TURNSTILE.dummyToken }) }), { ...w.env, TURNSTILE_SECRET: TURNSTILE.secretSpent });
    expect(await spent.json()).toMatchObject({ codes: ["timeout-or-duplicate"] });
  });

  it("the FLAGS kill switch pauses builds before any reservation", async () => {
    const w = world({ env: { FLAGS: { get: async (k: string) => (k === PAUSE_FLAG ? "1" : null) } } });
    const { res } = await w.build(judge);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "builds paused", retryable: true });
    expect((w.ns as ReturnType<typeof governorNs>).calls).toEqual([]);
  });

  it("an upstream HTTP error is free; a stream without usage is charged at its estimate", async () => {
    const e = world({ up: { intent: { inTok: 0, outTok: 0, status: 429 } } });
    const r1 = await e.build(judge);
    const ev = await readSse(r1.res);
    expect(ev.at(-1)).toMatchObject({ event: "error", data: { retryable: true } });
    await r1.ctx.settled();
    expect(e.pool("judge")).toMatchObject({ spent: 0, held: 0 });

    const n = world({ up: { fill: { inTok: 3000, outTok: 1500, usage: false } } });
    const r2 = await n.build(judge);
    await readSse(r2.res);
    await r2.ctx.settled();
    expect(n.pool("judge").spent).toBeGreaterThan(metered); // intent metered + fill at its (higher) estimate
  });

  it("a client that disconnects aborts the upstream call", async () => {
    const w = world();
    const { res, ctx } = await w.build(judge);
    const reader = res.body!.getReader();
    await reader.read(); // the intent event
    await reader.cancel();
    await ctx.settled();
    const fill = w.f.to("api.cerebras.ai")[1];
    expect(fill?.signal?.aborted).toBe(true);
    expect(w.pool("judge").held).toBe(0);
  });

  // Live LLM test: opt-in (LIVE=1) so the default suite stays free and deterministic.
  it.skipIf(!process.env.LIVE || !key())("streams intent then fill ops that parse into a world (live Cerebras)", async () => {
    const res = await handle(
      new Request("http://localhost/v1/build", { method: "POST", body: JSON.stringify({ prompt: "a maze with ghosts and a key that opens the exit", seed: 11 }) }),
      { CEREBRAS_API_KEY: key()!, DEV_OPEN: "1" },
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const events = await readSse(res);
    expect(events[0]!.event).toBe("intent");
    const ops = events.filter((e) => e.event === "op");
    expect(ops.length).toBeGreaterThan(8);
    const p = new FillParser({ seed: 11 });
    for (const o of ops) p.push(`${o.data.line}\n`);
    p.end();
    expect(p.stats.invalid / Math.max(1, p.stats.lines)).toBeLessThan(0.1);
    expect(p.draft.zones.length).toBeGreaterThan(0);
    expect(events.at(-1)!.event).toBe("done");
  }, 60_000);
});

async function session(env: Env): Promise<string> {
  const res = await handle(new Request("https://g.example/v1/session", { method: "POST", headers: { "cf-connecting-ip": freshIp() }, body: JSON.stringify({ token: TURNSTILE.dummyToken }) }), env);
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
