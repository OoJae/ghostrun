// Edge API handler (Web-standard Request/Response, so it runs in Workers and in dev servers).
// POST /v1/build streams the fast lane as server-sent events:
//   intent {intent, ms}  →  op {i, line} per complete JSONL fill line  →  done {timings}
// Keys never leave the server. The client parses ops into the IR, places, simulates and proves.
// Every route but health sits behind the gate (gate.ts). A build reserves its worst-case cost with
// the governor before any model call and commits the metered cost when it ends (governor.ts).
import { DEFAULT_LAWS, gameplayLines } from "@ghostrun/ir";
import { chatJson, fillMessages, IntentOut, intentJsonSchema, intentMessages, LlmError, mindJsonSchema, mindMessages, repairMessages, streamChat } from "@ghostrun/llm";
import { ALL_SUBS, PACKS, packFor } from "@ghostrun/registry";
import * as v from "valibot";
// the vault heist teaches goal-dependent wins, doorway doors, keys and inspectable exhibits (an A/B
// on six live prompts: 5 of 5 headlines verified vs 1 of 6 with the CTF example, which got copied)
import EXAMPLE from "../../../packages/ir/fixtures/vault-heist.jsonl?raw";
import { Buckets, intVar, WINDOW_MS } from "./buckets";
import type { DoNamespace, KvNamespace, R2Bucket, WaitUntil } from "./cf";
import { buildEstimate, costMicroUsd, FILL_MAX_OUT, FILL_MODEL, INTENT_MAX_OUT, INTENT_MODEL, REPAIR_MAX_IN, REPAIR_MAX_OUT } from "./cost";
import { capsFromEnv, doCall, Governor, governorClient, localCall, MemoryLedger, type GovernorApi, type GovernorEnv } from "./governor";
import { devOpen, gateMode, identify, ipKey, ipOf, mintSession, verifyTurnstile, type Caller, type GateEnv } from "./gate";
import { json, ntfy, readJson } from "./http";
import { getShare, memoryBlobs, postReport, postShare, postWrong, r2Blobs, type BlobStore, type ShareCtx } from "./share";

export interface Env extends GateEnv, GovernorEnv {
  CEREBRAS_API_KEY: string;
  /** Public Turnstile sitekey, echoed by /v1/health for the client widget. */
  TURNSTILE_SITEKEY?: string;
  /** Tokenless builds per IP per isolate per 10 min (default 30). */
  BUILDS_PER_WINDOW?: string;
  /** Session/share/report/wrong requests per IP per isolate per 10 min (default 60). */
  RATE_PER_WINDOW?: string;
  /** Builds per judge token per isolate per 10 min while the governor is unreachable (default 10). */
  JUDGE_FALLBACK_PER_WINDOW?: string;
  /** NPC mind calls per IP (or judge session) per isolate per 10 min (default 120). */
  MINDS_PER_WINDOW?: string;
  /** How long a build waits for the governor's reservation answer (default 300 ms). */
  GOVERNOR_TIMEOUT_MS?: string;
  GOVERNOR?: DoNamespace;
  FLAGS?: KvNamespace;
  SHARES?: R2Bucket;
}

const MAX_PROMPT = 500;
/** KV key in FLAGS: any value pauses new builds (an instant, deploy-free kill switch). */
export const PAUSE_FLAG = "builds:paused";

const buildBuckets = new Buckets();
const apiBuckets = new Buckets();
const judgeBuckets = new Buckets();
const mindBuckets = new Buckets();
let devGovernor: Governor | undefined;
let devBlobs: BlobStore | undefined;

function governorFor(env: Env, url: URL): GovernorApi | undefined {
  const ms = intVar(env.GOVERNOR_TIMEOUT_MS, 300);
  if (env.GOVERNOR) return governorClient(doCall(env.GOVERNOR), ms, ms * 10);
  if (!devOpen(env, url)) return undefined;
  devGovernor ??= new Governor(new MemoryLedger(), capsFromEnv(env));
  return governorClient(localCall(devGovernor), ms, ms * 10);
}

function blobsFor(env: Env, url: URL): BlobStore | undefined {
  if (env.SHARES) return r2Blobs(env.SHARES);
  return devOpen(env, url) ? (devBlobs ??= memoryBlobs()) : undefined;
}

async function paused(env: Env): Promise<boolean> {
  try {
    return (await env.FLAGS?.get(PAUSE_FLAG, { cacheTtl: 60 })) != null;
  } catch {
    return false;
  }
}

export async function handle(req: Request, env: Env, ctx?: WaitUntil): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const later = (p: Promise<unknown>) => (ctx ? ctx.waitUntil(p) : void p.catch(() => undefined));
  if (path === "/v1/health") return json({ ok: true, packs: PACKS.map((p) => p.id), llm: Boolean(env.CEREBRAS_API_KEY), gate: gateMode(env, url), sitekey: env.TURNSTILE_SITEKEY ?? null });
  if (path === "/v1/session" && req.method === "POST") return session(req, env, url);
  if (path === "/v1/build" && req.method === "POST") return build(req, env, url, later);
  if (path === "/v1/repair" && req.method === "POST") return repair(req, env, url, later);
  if (path === "/v1/mind" && req.method === "POST") return mind(req, env, url);
  const shareId = /^\/v1\/share\/([a-z2-7]{16})$/.exec(path)?.[1];
  const post = req.method === "POST";
  const route =
    path === "/v1/share" && post ? postShare
    : path === "/v1/report" && post ? postReport
    : path === "/v1/wrong" && post ? postWrong
    : shareId && req.method === "GET" ? (_: Request, c: ShareCtx) => getShare(shareId, c)
    : undefined;
  if (!route) return json({ error: "not found" }, 404);

  const gate = await identify(req, url, env);
  if (!gate.ok) return json(gate.body, gate.status);
  const ip = ipOf(req);
  if (!apiBuckets.allow(ip, intVar(env.RATE_PER_WINDOW, 60))) return json({ error: "rate limited", retryMs: WINDOW_MS }, 429);
  const store = blobsFor(env, url);
  if (!store) return json({ error: "share store not configured" }, 503);
  const notify = (title: string, body: string) => env.NTFY_URL && later(ntfy(env.NTFY_URL, title, body));
  try {
    return await route(req, { store, caller: gate.caller, ip: await ipKey(env, ip), notify });
  } catch {
    return json({ error: "share store unavailable", retryable: true }, 503);
  }
}

async function session(req: Request, env: Env, url: URL): Promise<Response> {
  const ip = ipOf(req);
  if (!apiBuckets.allow(ip, intVar(env.RATE_PER_WINDOW, 60))) return json({ error: "rate limited", retryMs: WINDOW_MS }, 429);
  if (!env.TURNSTILE_SECRET) return devOpen(env, url) ? json({ ok: true, dev: true }) : json({ error: "turnstile not configured", retryable: false }, 503);
  if (!env.SESSION_SECRET) return json({ error: "gate misconfigured", retryable: false }, 503);
  const body = await readJson(req, 4096);
  if (!body.ok) return json({ error: body.error }, body.status);
  const verdict = await verifyTurnstile((body.value as { token?: unknown } | null)?.token, env.TURNSTILE_SECRET, ip, env.TURNSTILE_HOSTNAMES);
  if (!verdict.ok) return json({ error: "turnstile failed", codes: verdict.codes, retryable: verdict.status === 503 }, verdict.status);
  const s = await mintSession(env.SESSION_SECRET);
  return json({ ok: true, expiresAt: s.exp * 1000 }, 200, { "set-cookie": s.cookie });
}

/**
 * Reserve the worst case first. No answer in time: tokenless traffic fails closed; a judge token
 * falls back to a per-isolate bucket and the spend is recorded after the fact. Returns how to
 * settle the metered cost, or the refusal to send.
 */
async function reserveFor(env: Env, url: URL, caller: Caller, ip: string, estimateMicroUsd: number): Promise<((microUsd: number) => Promise<unknown>) | Response> {
  const gov = governorFor(env, url);
  const who = { pool: caller.pool, ...(caller.session ? { session: caller.session } : {}), ip: await ipKey(env, ip) };
  const hold = gov ? await gov.reserve({ ...who, estimateMicroUsd }) : ({ ok: false, reason: "unavailable" } as const);
  if (hold.ok) return (m) => gov!.commit(hold.id, m);
  if (hold.reason !== "unavailable") return json({ error: "budget", reason: hold.reason, retryable: false }, 429);
  if (caller.via !== "token") return json({ error: "governor unavailable", retryable: true }, 503);
  if (!judgeBuckets.allow(caller.session ?? ip, intVar(env.JUDGE_FALLBACK_PER_WINDOW, 10))) return json({ error: "rate limited", retryMs: WINDOW_MS }, 429);
  return (m) => gov?.record({ ...who, actualMicroUsd: m }) ?? Promise.resolve();
}

/** An SSE response whose writer stops paying for tokens once the client has gone. */
function sseStream() {
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const upstream = new AbortController();
  let gone = false;
  const send = async (event: string, data: unknown) => {
    if (gone) return;
    try {
      await w.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      gone = true;
      upstream.abort();
    }
  };
  const response = new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
  return { send, close: () => w.close().catch(() => undefined), signal: upstream.signal, response };
}

const OPTION = /^[\w.:-]{1,48}$/;
const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");

/**
 * POST /v1/mind: one NPC picks an option from its typed menu and says a line, in about a second
 * (the intent model, strict schema, no reasoning). The answer is checked against the menu again
 * here: a mind can never act off-menu, and the simulation plays the option deterministically.
 */
async function mind(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.CEREBRAS_API_KEY) return json({ error: "llm not configured" }, 503);
  const gate = await identify(req, url, env);
  if (!gate.ok) return json(gate.body, gate.status);
  const caller = gate.caller;
  const ip = ipOf(req);
  if (!mindBuckets.allow(caller.session ?? ip, intVar(env.MINDS_PER_WINDOW, 120))) return json({ error: "rate limited", retryMs: WINDOW_MS }, 429);
  const body = await readJson(req, 8192);
  if (!body.ok) return json({ error: body.error }, body.status);
  const i = (body.value ?? {}) as Record<string, unknown>;
  const menu = Array.isArray(i.menu) ? i.menu.filter((x): x is string => typeof x === "string" && OPTION.test(x)).slice(0, 8) : [];
  const current = str(i.current, 48);
  if (!menu.length || !str(i.npc, 32)) return json({ error: "bad mind request" }, 400);
  if (await paused(env)) return json({ error: "builds paused", retryable: true }, 503);
  const held = await reserveFor(env, url, caller, ip, costMicroUsd(INTENT_MODEL, 1500, 120));
  if (held instanceof Response) return held;
  let cost = costMicroUsd(INTENT_MODEL, 1500, 120);
  try {
    const r = await chatJson<{ option?: unknown; line?: unknown }>({
      apiKey: env.CEREBRAS_API_KEY,
      model: INTENT_MODEL,
      reasoningEffort: "none",
      maxTokens: 120,
      jsonSchema: { name: "mind", schema: mindJsonSchema(menu) },
      messages: mindMessages({ npc: str(i.npc, 32), role: str(i.role, 32), persona: str(i.persona, 400), menu, current, situation: str(i.situation, 600), event: str(i.event, 200), ...(typeof i.said === "string" ? { said: str(i.said, 200) } : {}) }),
    });
    if (r.inTok > 0) cost = costMicroUsd(INTENT_MODEL, r.inTok, r.outTok);
    const option = typeof r.value.option === "string" && menu.includes(r.value.option) ? r.value.option : menu.includes(current) ? current : menu[0]!;
    return json({ option, line: str(r.value.line, 120), ms: r.ms });
  } catch (e) {
    if (e instanceof LlmError && e.status !== 200) cost = 0;
    return json({ error: e instanceof Error ? e.message.slice(0, 200) : "mind failed", retryable: true }, 502);
  } finally {
    await held(cost).catch(() => undefined);
  }
}

/**
 * POST /v1/repair: the proof's counterexamples for a world go back to the fill model, which
 * answers with a patch (changed lines by id, new lines, deletions) streamed as op events. The
 * client merges, re-places and re-proves, and offers the repaired world only if it is better.
 */
async function repair(req: Request, env: Env, url: URL, later: (p: Promise<unknown>) => void): Promise<Response> {
  if (!env.CEREBRAS_API_KEY) return json({ error: "llm not configured" }, 503);
  const gate = await identify(req, url, env);
  if (!gate.ok) return json(gate.body, gate.status);
  const caller = gate.caller;
  const ip = ipOf(req);
  if (caller.via !== "token" && !buildBuckets.allow(ip, intVar(env.BUILDS_PER_WINDOW, 30))) return json({ error: "rate limited", retryMs: WINDOW_MS }, 429);
  const body = await readJson(req, 96 * 1024);
  if (!body.ok) return json({ error: body.error }, body.status);
  const input = (body.value ?? {}) as { prompt?: unknown; intent?: unknown; fill?: unknown; issues?: unknown; seed?: unknown };
  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, MAX_PROMPT) : "";
  const fill = typeof input.fill === "string" && input.fill.length <= 64 * 1024 ? input.fill : "";
  const issues = Array.isArray(input.issues) ? input.issues.filter((x): x is string => typeof x === "string").slice(0, 10).map((x) => x.slice(0, 600)) : [];
  const intent = v.safeParse(IntentOut, input.intent);
  if (!prompt || !fill || !issues.length || !intent.success || !Number.isInteger(input.seed)) return json({ error: "bad repair request" }, 400);
  if (await paused(env)) return json({ error: "builds paused", retryable: true }, 503);
  const held = await reserveFor(env, url, caller, ip, costMicroUsd(FILL_MODEL, REPAIR_MAX_IN, REPAIR_MAX_OUT));
  if (held instanceof Response) return held;
  const out = sseStream();
  later(
    (async () => {
      const t0 = Date.now();
      let cost = costMicroUsd(FILL_MODEL, REPAIR_MAX_IN, REPAIR_MAX_OUT);
      try {
        const pack = packFor(intent.output.pack);
        const layout = pack.generate({ seed: input.seed as number, params: pack.defaults, sub: intent.output.sub, laws: DEFAULT_LAWS, harder: false });
        let buf = "";
        let i = 0;
        for await (const ev of streamChat({ apiKey: env.CEREBRAS_API_KEY, model: FILL_MODEL, reasoningEffort: "low", maxTokens: REPAIR_MAX_OUT, messages: repairMessages(prompt, intent.output, layout, gameplayLines(fill), issues), signal: out.signal })) {
          if (ev.type === "usage") cost = costMicroUsd(FILL_MODEL, ev.inTok, ev.outTok);
          if (ev.type !== "text") continue;
          buf += ev.delta;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) await out.send("op", { i: i++, line });
          }
        }
        if (buf.trim()) await out.send("op", { i: i++, line: buf.trim() });
        await out.send("done", { totalMs: Date.now() - t0, lines: i });
      } catch (e) {
        if (e instanceof LlmError && e.status !== 200) cost = 0;
        await out.send("error", { message: e instanceof Error ? e.message.slice(0, 200) : "repair failed", retryable: e instanceof LlmError ? e.retryable : true });
      } finally {
        await out.close();
        await held(cost).catch(() => undefined);
      }
    })(),
  );
  return out.response;
}

async function build(req: Request, env: Env, url: URL, later: (p: Promise<unknown>) => void): Promise<Response> {
  if (!env.CEREBRAS_API_KEY) return json({ error: "llm not configured" }, 503);
  const gate = await identify(req, url, env);
  if (!gate.ok) return json(gate.body, gate.status);
  const caller = gate.caller;
  const ip = ipOf(req);
  // Judges may share one NAT; their tokens are bounded by session caps instead.
  if (caller.via !== "token" && !buildBuckets.allow(ip, intVar(env.BUILDS_PER_WINDOW, 30))) return json({ error: "rate limited", retryMs: WINDOW_MS }, 429);

  const body = await readJson(req, 8192);
  if (!body.ok) return json({ error: body.error }, body.status);
  const input = (body.value ?? {}) as { prompt?: unknown; seed?: unknown };
  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, MAX_PROMPT) : "";
  if (!prompt) return json({ error: "empty prompt" }, 400);
  const seed = Number.isInteger(input.seed) ? (input.seed as number) : 1 + Math.floor(Date.now() % 100000);
  if (await paused(env)) return json({ error: "builds paused", retryable: true }, 503);

  const intentMsgs = intentMessages(prompt, PACKS);
  const est = buildEstimate(intentMsgs);
  const held = await reserveFor(env, url, caller, ip, est.intent + est.fill);
  if (held instanceof Response) return held;
  const settle = held;

  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const upstream = new AbortController();
  let gone = false;
  const send = async (event: string, data: unknown) => {
    if (gone) return;
    try {
      await w.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      gone = true; // the client left: stop paying for tokens nobody will read
      upstream.abort();
    }
  };

  later(
    (async () => {
      const t0 = Date.now();
      // A call is charged at its estimate until it reports usage (fail closed); an HTTP error is free.
      let phase: "intent" | "fill" | "after" = "intent";
      let intentCost = est.intent;
      let fillCost = 0;
      try {
        const intentRes = await chatJson<unknown>({
          apiKey: env.CEREBRAS_API_KEY,
          model: INTENT_MODEL,
          reasoningEffort: "none",
          messages: intentMsgs,
          jsonSchema: { name: "intent", schema: intentJsonSchema(PACKS.map((p) => p.id), ALL_SUBS) },
          maxTokens: INTENT_MAX_OUT,
          signal: upstream.signal,
        });
        if (intentRes.inTok > 0) intentCost = costMicroUsd(INTENT_MODEL, intentRes.inTok, intentRes.outTok);
        const intent = v.parse(IntentOut, intentRes.value);
        await send("intent", { intent, seed, ms: Date.now() - t0 });
        if (intent.safety === "block") {
          await send("refusal", { message: "That one's outside what GHOSTRUN builds. Try a game, a place or a challenge." });
          return;
        }
        const pack = packFor(intent.pack);
        const layout = pack.generate({ seed, params: pack.defaults, sub: intent.sub, laws: DEFAULT_LAWS, harder: false });
        phase = "fill";
        fillCost = est.fill;
        let buf = "";
        let i = 0;
        let firstMs = -1;
        const stream = streamChat({ apiKey: env.CEREBRAS_API_KEY, model: FILL_MODEL, reasoningEffort: "low", maxTokens: FILL_MAX_OUT, messages: fillMessages(prompt, intent, layout, EXAMPLE, seed), signal: upstream.signal });
        for await (const ev of stream) {
          if (ev.type === "usage") fillCost = costMicroUsd(FILL_MODEL, ev.inTok, ev.outTok);
          if (ev.type === "first_token") firstMs = Date.now() - t0;
          if (ev.type !== "text") continue;
          buf += ev.delta;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) await send("op", { i: i++, line });
          }
        }
        phase = "after";
        if (buf.trim()) await send("op", { i: i++, line: buf.trim() });
        await send("done", { intentMs: intentRes.ms, fillFirstTokenMs: firstMs, totalMs: Date.now() - t0, lines: i });
      } catch (e) {
        if (e instanceof LlmError && e.status !== 200) {
          if (phase === "intent") intentCost = 0;
          if (phase === "fill") fillCost = 0;
        }
        const retryable = e instanceof LlmError ? e.retryable : true;
        await send("error", { message: e instanceof Error ? e.message.slice(0, 200) : "build failed", retryable });
      } finally {
        await w.close().catch(() => undefined);
        await settle(intentCost + fillCost).catch(() => undefined);
      }
    })(),
  );

  return new Response(readable, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
