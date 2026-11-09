// POST /v1/proof offline, on Node's engine (engine-node.ts, the same pinned wasm): the gate, the
// checks before any CPU (engine, proof version, spec hash), the receipt the device would make
// (whole in the Worker or dealt to in-process ProofShard DOs, a failing shard played here), kept
// in R2 and served again at once, the kill switch, the buckets, the stream the web client reads,
// the MCP tools getting the full receipt through the real route, and the canaries.
import "../src/engine-node";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadNavNode } from "@ghostrun/nav/node";
import { comparable, prove, receiptHash, TIERS, type Receipt } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { PROOF_VERSION } from "@ghostrun/world";
import { canary, CRONS, runCanary } from "../src/canary";
import { capsFromEnv, Governor, MemoryLedger } from "../src/governor";
import { handle, type Env } from "../src/handler";
import { canaryKey } from "../src/health";
import { mcp } from "../src/mcp";
import { cloudProver } from "../src/mcp-tools";
import { PROOF_FLAG, proofKey, type ProofInput } from "../src/proof";
import { dealOrder } from "../src/shard";
import { ENGINE_HASH, placeFill } from "../src/world";
import { fakeFetch, governorNs, memKv, memR2, readSse, shardNs, TURNSTILE, waiter } from "./fakes";

const JKEY = "judge-key-for-tests-only";
const SECRET = "session-secret-for-tests-only-0123456789";
const mac = (t: string) => createHmac("sha256", JKEY).update(t).digest("hex");
const fixture = (name: string) => readFileSync(new URL(`../../../packages/ir/fixtures/${name}.jsonl`, import.meta.url), "utf8");
const seedOf = (fill: string) => (JSON.parse(fill.split("\n", 1)[0]!) as { seed?: number }).seed ?? 7;
let n = 0;
const freshIp = () => `198.51.100.${++n % 250}`;
let R: Rapier;

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});
afterEach(() => vi.unstubAllGlobals());

async function input(name: string): Promise<ProofInput> {
  const fill = fixture(name);
  const p = await placeFill(fill, seedOf(fill));
  return { v: 1, fill: p.fill, seed: p.seed, engine: ENGINE_HASH, spec: p.spec, version: PROOF_VERSION };
}

/** The device's own receipt for a fixture: prove() as proof.worker.ts runs it (the later tiers as /v1/health says: the defaults here). */
async function device(name: string): Promise<Receipt> {
  const fill = fixture(name);
  return prove(R, (await placeFill(fill, seedOf(fill))).bundle, { engine: ENGINE_HASH, host: "device", playtest: true, ...TIERS });
}

function edge(env: Partial<Env> = {}) {
  const token = `judge_token_${++n}_0123456789abcdef`;
  const gov = new Governor(new MemoryLedger(), capsFromEnv({}));
  const f = fakeFetch();
  vi.stubGlobal("fetch", f.fn);
  const r2 = memR2();
  const flags = memKv();
  const e: Env = { CEREBRAS_API_KEY: "k", TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: SECRET, JUDGE_TOKEN_KEY: JKEY, JUDGE_TOKEN_HASHES: mac(token), GOVERNOR: governorNs(gov), GOVERNOR_TIMEOUT_MS: "50", SHARES: r2, FLAGS: flags, ...env };
  const ask = async (body: unknown, headers: Record<string, string> = { "x-judge-token": token }, ip = freshIp()) => {
    const ctx = waiter();
    const res = await handle(new Request("https://g.example/v1/proof", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers }, body: JSON.stringify(body) }), e, ctx);
    return { res, ctx };
  };
  const proof = async (body: unknown, headers?: Record<string, string>) => {
    const { res, ctx } = await ask(body, headers);
    const json = (await res.json()) as any;
    await ctx.settled();
    return { status: res.status, hit: res.headers.get("x-proof"), json };
  };
  return { token, env: e, r2, flags, f, ask, proof };
}

describe("POST /v1/proof", () => {
  it("proves the world whole in the Worker exactly as the device does, keeps it and serves it again at once", async () => {
    const w = edge();
    const i = await input("coin-rush");
    const first = await w.proof(i);
    expect(first.status).toBe(200);
    expect(first.hit).toBe("miss");
    expect(first.json).toMatchObject({ version: PROOF_VERSION, cached: null, shards: 0 });
    expect(first.json.receipt.host).toBe("edge");
    expect(first.json.receipt.playtest).toBeDefined();
    expect(comparable(first.json.receipt)).toEqual(comparable(await device("coin-rush")));
    expect(w.r2.objects.has(proofKey(i.spec))).toBe(true);
    expect(proofKey(i.spec)).toBe(`proof/${PROOF_VERSION}/${ENGINE_HASH}/${i.spec}.json`);
    const again = await w.proof(i);
    expect(again.hit).toBe("hit");
    expect(typeof again.json.cached).toBe("string");
    expect(await receiptHash(again.json.receipt)).toBe(await receiptHash(first.json.receipt));
  }, 120_000);

  it("deals T3 and the playtest out to shards (a shard that fails is played here) and gets the same receipt", async () => {
    const shards = shardNs({ down: (name) => name.endsWith(":2") });
    const w = edge({ PROOF_SHARD: shards, PROOF_SHARDS: "4" });
    const i = await input("vault-heist");
    const r = await w.proof(i);
    expect(r.status).toBe(200);
    expect(r.json.shards).toBe(4);
    expect(shards.names.size).toBe(4);
    expect([...shards.names].every((x) => x.startsWith(`${i.spec}:${PROOF_VERSION}:`))).toBe(true);
    expect(comparable(r.json.receipt)).toEqual(comparable(await device("vault-heist")));
  }, 120_000);

  for (const name of ["museum-bribe", "villa-viewing"]) {
    it(`gives the device's receipt for ${name} on shards, act runs and all`, async () => {
      const w = edge({ PROOF_SHARD: shardNs() });
      const r = await w.proof(await input(name));
      expect(r.status).toBe(200);
      expect(comparable(r.json.receipt)).toEqual(comparable(await device(name)));
    }, 180_000);
  }

  it("deals the likeliest long runs first and the jump attempts last", () => {
    const order = dealOrder([
      { kind: "jump", expect: "x", jumps: 2, attempt: 0, team: "red" },
      { kind: "run", seed: 1, team: "red" },
      { kind: "run", seed: 2, team: "red", schedule: [["g", "chase"]] },
      { kind: "run", seed: 3, team: "red", level: "average" },
      { kind: "run", seed: 4, team: "red", level: "novice" },
    ]);
    expect(order.map((w) => (w.kind === "jump" ? "jump" : w.seed))).toEqual([4, 3, 2, 1, "jump"]);
  });

  it("streams to a client that asks: proving, the receipt the moment it is out, then its playtest", async () => {
    const w = edge({ PROOF_SHARD: shardNs() });
    const i = await input("coin-rush");
    const { res, ctx } = await w.ask(i, { "x-judge-token": w.token, accept: "text/event-stream" });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const events = await readSse(res);
    await ctx.settled();
    expect(events.map((e) => e.event)).toEqual(["proving", "receipt", "playtest", "done"]);
    const r = events[1]!.data.receipt as Receipt;
    expect(r.playtest).toBeUndefined();
    const whole = await device("coin-rush");
    expect(comparable({ ...r, ...(events[2]!.data.playtest ? { playtest: events[2]!.data.playtest } : {}) })).toEqual(comparable(whole));
    // stored: the same events at once
    const { res: again } = await w.ask(i, { "x-judge-token": w.token, accept: "text/event-stream" });
    expect(again.headers.get("x-proof")).toBe("hit");
    expect((await readSse(again)).map((e) => e.event)).toEqual(["receipt", "playtest", "done"]);
  }, 120_000);

  it("checks before any CPU: the engine, the proof version, the spec hash, the body", async () => {
    const w = edge();
    const i = await input("heist-live-1");
    expect((await w.proof({ ...i, engine: "a".repeat(64) })).json).toMatchObject({ error: "engine differs", engine: ENGINE_HASH });
    const ver = await w.proof({ ...i, version: "b".repeat(64) });
    expect([ver.status, ver.json.error, ver.json.version]).toEqual([409, "proof version differs", PROOF_VERSION]);
    const spec = await w.proof({ ...i, spec: "0".repeat(64) });
    expect([spec.status, spec.json.spec]).toEqual([409, i.spec]);
    expect((await w.proof({ ...i, extra: 1 })).status).toBe(400);
    expect((await w.proof({ ...i, fill: "x".repeat(70 * 1024) })).status).toBe(413);
    expect(w.r2.objects.size).toBe(0);
  });

  it("fails closed: no token or session is 401, a closed gate is 503", async () => {
    const w = edge();
    const i = await input("heist-live-1");
    expect((await w.proof(i, {})).status).toBe(401);
    const closed = edge({ TURNSTILE_SECRET: undefined as unknown as string });
    expect((await closed.proof(i, {})).status).toBe(503);
  });

  it("ff.edge_proof = off turns it off, and /v1/health stops offering it", async () => {
    const w = edge();
    const i = await input("heist-live-1");
    const health = async () => (await (await handle(new Request("https://g.example/v1/health"), w.env)).json()) as { proof: boolean };
    expect((await health()).proof).toBe(true);
    w.flags.map.set(PROOF_FLAG, "off");
    const r = await w.proof(i);
    expect([r.status, r.json.error]).toEqual([503, "the cloud proof is off"]);
    expect((await health()).proof).toBe(false);
  });

  it("counts proofs, not stored receipts, per session: the 3rd new world in a window is turned away", async () => {
    const w = edge({ PROOFS_PER_WINDOW: "2" });
    const [a, b, c] = await Promise.all(["heist-live-1", "coin-rush", "vault-heist"].map(input));
    expect((await w.proof(a!)).status).toBe(200);
    expect((await w.proof(a!)).hit).toBe("hit");
    expect((await w.proof(b!)).status).toBe(200);
    const third = await w.proof(c!);
    expect([third.status, third.json.error]).toEqual([429, "rate limited"]);
    expect((await w.proof(a!)).status).toBe(200); // a stored one still answers
  }, 120_000);
});

describe("the MCP tools on the real route", () => {
  it("get_receipt carries the cloud's full receipt, T3 and all, run on the edge", async () => {
    const w = edge();
    const call = (path: string, body?: unknown) => handle(new Request(`https://g.example${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-judge-token": w.token, "cf-connecting-ip": "198.51.100.9" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), w.env);
    const fill = fixture("coin-rush");
    const p = await placeFill(fill, seedOf(fill));
    const r = await cloudProver(call).prove(p);
    expect(r?.host).toBe("edge");
    expect(r?.chips.some((c) => c.tier === "T3")).toBe(true);
    expect(comparable(r!)).toEqual(comparable(await device("coin-rush")));
    // and through the endpoint itself
    const res = await mcp(new Request("https://g.example/mcp", { method: "POST", headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_receipt", arguments: { world: "a-science-museum-with-a-dinosaur-skeleto" } } }) }), w.env, { route: (q) => handle(q, w.env) });
    const out = (await res.json()) as { result: { structuredContent: { proof: { source: string } } } };
    expect(out.result.structuredContent.proof.source).toBe("cloud");
  }, 120_000);
});

describe("the canaries", () => {
  it("every cron in wrangler.jsonc runs a kind, and the kinds are what CRONS says", () => {
    const jsonc = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    // staging's and production's
    const crons = [...jsonc.matchAll(/"triggers": \{ "crons": \[([^\]]*)\] \}/g)].map((m) => JSON.parse(`[${m[1]}]`) as string[]);
    expect(crons.length).toBe(2);
    for (const c of crons) expect(c.sort()).toEqual(Object.keys(CRONS).sort());
  });

  it("health and the stored brief every 15 min: no spend, the brief proved once and then read back", async () => {
    const w = edge();
    const ctx = waiter();
    // (the brief's first proof, whole on one core here, on a clock that only says it ran: its time is the shards' business)
    let t = Date.now();
    const first = [await runCanary("health", w.env, ctx), await runCanary("stored_proof", w.env, ctx, () => (t += 1))];
    await ctx.settled();
    expect(first.map((r) => [r.ok, r.detail])).toEqual([
      [true, "ok"],
      [true, expect.stringMatching(/^CTF brief: proved now on 0 shards/)],
    ]);
    const second = await canary("*/15 * * * *", w.env, ctx);
    expect(second[1]!.detail).toMatch(/^CTF brief: stored receipt/);
    expect(w.f.to("api.cerebras.ai")).toHaveLength(0);
    const health = (await (await handle(new Request("https://g.example/v1/health"), w.env)).json()) as { canary: { at: string; ok: boolean } };
    expect(health.canary).toEqual({ at: second[1]!.at, ok: true });
  }, 180_000);

  it("the 2-hourly fresh proof must equal the kept one: a change alerts once, then every 6 h, and says when it is ok again", async () => {
    const w = edge({ NTFY_URL: "https://ntfy.test/t" });
    const ctx = waiter();
    let t = Date.parse("2026-11-04T10:00:00Z");
    const now = () => t;
    expect((await runCanary("fresh_proof", w.env, ctx, now)).detail).toMatch(/kept for the next check/);
    expect((await runCanary("fresh_proof", w.env, ctx, now)).detail).toMatch(/same receipt as/);
    // the kept receipt is tampered with: the next fresh proof differs from it
    const key = [...w.r2.objects.keys()].find((k) => k.startsWith("proof/"))!;
    const kept = JSON.parse(w.r2.objects.get(key)!);
    kept.receipt.par.goldS += 1;
    w.r2.objects.set(key, JSON.stringify(kept));
    const bad = await runCanary("fresh_proof", w.env, ctx, now);
    expect([bad.ok, bad.detail]).toEqual([false, expect.stringMatching(/a fresh proof differs from the one kept/)]);
    const alerts = () => w.f.to("ntfy.test").map((h) => h.headers.get("title"));
    expect(alerts()).toEqual(["GHOSTRUN canary: fresh_proof failing"]);
    t += 2 * 3600_000;
    await runCanary("fresh_proof", w.env, ctx, now);
    expect(alerts()).toHaveLength(1); // still bad, alerted 2 h ago: quiet
    t += 5 * 3600_000;
    await runCanary("fresh_proof", w.env, ctx, now);
    expect(alerts()).toHaveLength(2); // 7 h on: again
    w.r2.objects.set(key, JSON.stringify({ ...kept, receipt: { ...kept.receipt, par: { ...kept.receipt.par, goldS: kept.receipt.par.goldS - 1 } } }));
    expect((await runCanary("fresh_proof", w.env, ctx, now)).ok).toBe(true);
    expect(alerts().at(-1)).toBe("GHOSTRUN canary: fresh_proof ok again");
    expect(JSON.parse(w.flags.map.get(canaryKey("fresh_proof"))!).ok).toBe(true);
  }, 180_000);

  it("the 12-hourly live build runs on the canary pool with its token, and says plainly when there is no token", async () => {
    const canaryToken = "canary_token_0123456789abcdef";
    const w = edge({});
    w.env.JUDGE_TOKEN_HASHES = `${w.env.JUDGE_TOKEN_HASHES},canary:${mac(canaryToken)}`;
    const ctx = waiter();
    const none = await runCanary("live_build", w.env, ctx);
    expect([none.ok, none.detail]).toEqual([false, "no CANARY_TOKEN secret: the live build can't run"]);
    const gov = new Governor(new MemoryLedger(), capsFromEnv({}));
    w.env.GOVERNOR = governorNs(gov);
    const built = await runCanary("live_build", { ...w.env, CANARY_TOKEN: canaryToken }, ctx);
    await ctx.settled();
    expect([built.ok, built.detail]).toEqual([true, expect.stringMatching(/^built 3 lines/)]);
    expect(gov.status().pools.find((p) => p.pool === "canary")!.spent).toBeGreaterThan(0);
    expect(JSON.parse(w.f.to("api.cerebras.ai").at(-1)!.body).messages).toBeDefined();
  });

  it("a slow run fails too", async () => {
    const w = edge();
    let t = 0;
    const slow = await runCanary("health", w.env, waiter(), () => (t += 4000));
    expect([slow.ok, slow.detail]).toEqual([false, expect.stringMatching(/^slow: \d+ ms \(over 3000\)/)]);
  });
});
