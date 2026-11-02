// Edge API handler (Web-standard Request/Response, so it runs in Workers and in dev servers).
// POST /v1/build streams the fast lane as server-sent events:
//   intent {intent, ms}  →  op {i, line} per complete JSONL fill line  →  done {timings}
// A build may bring a photo or sketch (image.ts): Claude Haiku reads it into a scene brief first,
// sent as `inspired {brief, prompt}`, and the brief joins the prompt the fast lane writes from.
// Keys never leave the server. The client parses ops into the IR, places, simulates and proves.
// An exact repeat of a clean build replays from the cache (cache.ts) behind a `cached` event, free.
// Every route but health sits behind the gate (gate.ts). A build reserves its worst-case cost with
// the governor before any model call and commits the metered cost when it ends (governor.ts).
// Each model call runs on the fast lane with Claude Haiku as the rung below it (llm/lanes.ts).
import { DEFAULT_LAWS, gameplayLines, jcs } from "@ghostrun/ir";
import { BRIEF_MAX_CHARS, BriefOut, briefJsonSchema, directorMessages, editMessages, fillMessages, hostJsonSchema, hostMessages, inspiredPrompt, IntentOut, intentJsonSchema, intentMessages, jsonLanes, lanesFor, LlmError, mindJsonSchema, mindMessages, pinIntent, pinLine, readPin, repairMessages, settleBrief, settleIntent, streamLanes, visionMessages, type ChatMessage, type Job, type Keys, type Provider } from "@ghostrun/llm";
import { ALL_SUBS, layoutLine, layoutOf, PACKS, packFor } from "@ghostrun/registry";
import * as v from "valibot";
// the vault heist teaches goal-dependent wins, doorway doors, keys and inspectable exhibits (an A/B
// on six live prompts: 5 of 5 headlines verified vs 1 of 6 with the CTF example, which got copied)
import EXAMPLE from "../../../packages/ir/fixtures/vault-heist.jsonl?raw";
import { Buckets, intVar, WINDOW_MS } from "./buckets";
import { cacheKey, closesGameplay, ENGINE_RE, promptSeed, readCache, replayBody, templateHash, writeCache, type CachedEvent } from "./cache";
import type { DoNamespace, KvNamespace, R2Bucket, WaitUntil } from "./cf";
import { buildEstimate, costMicroUsd, FILL_MAX_OUT, FILL_MODEL, INTENT_MAX_OUT, INTENT_MODEL, jobEstimate, REPAIR_MAX_IN, REPAIR_MAX_OUT, VISION_MAX_OUT, visionEstimate } from "./cost";
import { capsFromEnv, doCall, Governor, governorClient, localCall, MemoryLedger, type GovernorApi, type GovernorEnv } from "./governor";
import { devOpen, gateMode, identify, ipKey, ipOf, mintSession, verifyTurnstile, type Caller, type GateEnv } from "./gate";
import { json, ntfy, readJson } from "./http";
import { MAX_IMAGE_URL, readImage } from "./image";
import { getBoard, postBoard } from "./board";
import { getShare, memoryBlobs, postReport, postShare, postWrong, r2Blobs, type BlobStore, type ShareCtx } from "./share";

export interface Env extends GateEnv, GovernorEnv {
  CEREBRAS_API_KEY: string;
  /** Claude Haiku: the fallback when the fast lane is busy or down (and the primary under route:primary). */
  ANTHROPIC_API_KEY?: string;
  /** Public Turnstile sitekey, echoed by /v1/health for the client widget. */
  TURNSTILE_SITEKEY?: string;
  /** Tokenless builds per IP per isolate per 10 min (default 30). */
  BUILDS_PER_WINDOW?: string;
  /** Session/share/board/report/wrong requests per IP per isolate per 10 min (default 60). */
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
/** A build body: a few small fields, and a picture's data URL when it brings one. */
const MAX_BUILD_BODY = 8192 + MAX_IMAGE_URL;
const REFUSAL = "That one's outside what GHOSTRUN builds. Try a game, a place or a challenge.";
const PICTURE_REFUSAL = "That picture is outside what GHOSTRUN builds from. Try a photo or sketch of a place.";
/** KV key in FLAGS: any value pauses new builds (an instant, deploy-free kill switch). */
export const PAUSE_FLAG = "builds:paused";
/** KV key in FLAGS: "anthropic" (or "cerebras") puts that provider first for every job (the runbook's "Cerebras down"). */
export const PRIMARY_FLAG = "route:primary";
/** KV key in FLAGS: "off" turns the Sonnet jobs (the Director's cut, hard repairs) off, deploy-free. */
export const SONNET_FLAG = "ff.sonnet_lane";
/** KV key in FLAGS: "off" turns the exact-repeat build cache off (no lookups, no writes), deploy-free. */
export const CACHE_FLAG = "ff.public_cache";

const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" };

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

const keysOf = (env: Env): Keys => ({ cerebras: env.CEREBRAS_API_KEY || undefined, anthropic: env.ANTHROPIC_API_KEY || undefined });
const hasModel = (env: Env) => Boolean(env.CEREBRAS_API_KEY || env.ANTHROPIC_API_KEY);

/** The pause switch and the provider to put first, read together (both cached at the edge for a minute). */
async function switches(env: Env): Promise<{ paused: boolean; primary: Provider | undefined }> {
  const [stop, primary] = await Promise.all([
    paused(env),
    env.FLAGS?.get(PRIMARY_FLAG, { cacheTtl: 60 }).catch(() => null),
  ]);
  return { paused: stop, primary: primary === "anthropic" || primary === "cerebras" ? primary : undefined };
}

/** Is the exact-repeat cache on? Unless FLAGS says "off" (read at the edge once a minute). */
async function cacheOn(env: Env): Promise<boolean> {
  return (await env.FLAGS?.get(CACHE_FLAG, { cacheTtl: 60 }).catch(() => null)) !== "off";
}

export async function handle(req: Request, env: Env, ctx?: WaitUntil): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const later = (p: Promise<unknown>) => (ctx ? ctx.waitUntil(p) : void p.catch(() => undefined));
  // `vision`: a build can bring a picture (the client offers one only then)
  if (path === "/v1/health") return json({ ok: true, packs: PACKS.map((p) => p.id), llm: hasModel(env), fallback: Boolean(env.CEREBRAS_API_KEY && env.ANTHROPIC_API_KEY), vision: lanesFor("vision", keysOf(env), { messages: [] }).length > 0, gate: gateMode(env, url), sitekey: env.TURNSTILE_SITEKEY ?? null });
  if (path === "/v1/session" && req.method === "POST") return session(req, env, url);
  if (path === "/v1/build" && req.method === "POST") return build(req, env, url, later);
  if (path === "/v1/repair" && req.method === "POST") return patch("repair", req, env, url, later);
  if (path === "/v1/edit" && req.method === "POST") return patch("edit", req, env, url, later);
  if (path === "/v1/director" && req.method === "POST") return patch("director", req, env, url, later);
  if (path === "/v1/mind" && req.method === "POST") return mind(req, env, url);
  if (path === "/v1/host" && req.method === "POST") return host(req, env, url);
  const shareId = /^\/v1\/share\/([a-z2-7]{16})$/.exec(path)?.[1];
  const boardOf = /^\/v1\/board\/([0-9a-f]{64})$/.exec(path)?.[1];
  const post = req.method === "POST";
  const route =
    path === "/v1/share" && post ? postShare
    : path === "/v1/report" && post ? postReport
    : path === "/v1/wrong" && post ? postWrong
    : path === "/v1/board" && post ? postBoard
    : shareId && req.method === "GET" ? (_: Request, c: ShareCtx) => getShare(shareId, c)
    : boardOf && req.method === "GET" ? (_: Request, c: ShareCtx) => getBoard(boardOf, c)
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
  const response = new Response(readable, { headers: SSE_HEADERS });
  return { send, close: () => w.close().catch(() => undefined), signal: upstream.signal, response };
}

const OPTION = /^[\w.:-]{1,48}$/;
const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
/** A pack's sub-zones (undefined: no such pack), for checking what an Intent card pinned. */
const subsOf = (id: string) => PACKS.find((p) => p.id === id)?.subs;

/**
 * POST /v1/mind: one NPC picks an option from its typed menu and says a line, in about a second
 * (the intent model, strict schema, no reasoning). The answer is checked against the menu again
 * here: a mind can never act off-menu, and the simulation plays the option deterministically.
 */
async function mind(req: Request, env: Env, url: URL): Promise<Response> {
  if (!hasModel(env)) return json({ error: "llm not configured" }, 503);
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
  const sw = await switches(env);
  if (sw.paused) return json({ error: "builds paused", retryable: true }, 503);
  const held = await reserveFor(env, url, caller, ip, costMicroUsd(INTENT_MODEL, 1500, 120));
  if (held instanceof Response) return held;
  let cost = costMicroUsd(INTENT_MODEL, 1500, 120);
  try {
    const r = await jsonLanes<{ option?: unknown; line?: unknown }>(
      lanesFor("mind", keysOf(env), {
        primary: sw.primary,
        maxTokens: 120,
        jsonSchema: { name: "mind", schema: mindJsonSchema(menu) },
        messages: mindMessages({ npc: str(i.npc, 32), role: str(i.role, 32), persona: str(i.persona, 400), menu, current, situation: str(i.situation, 600), event: str(i.event, 200), ...(typeof i.said === "string" ? { said: str(i.said, 200) } : {}) }),
      }),
    );
    if (r.inTok > 0) cost = costMicroUsd(r.model, r.inTok, r.outTok);
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
 * POST /v1/host: the player's question about their run, answered from the numbered facts the
 * client sends (the run's causal log and the world's rules) and nothing else, with the facts cited.
 * Same lane and limits as a mind: the fast model, a strict schema, no reasoning.
 */
async function host(req: Request, env: Env, url: URL): Promise<Response> {
  if (!hasModel(env)) return json({ error: "llm not configured" }, 503);
  const gate = await identify(req, url, env);
  if (!gate.ok) return json(gate.body, gate.status);
  const caller = gate.caller;
  const ip = ipOf(req);
  if (!mindBuckets.allow(caller.session ?? ip, intVar(env.MINDS_PER_WINDOW, 120))) return json({ error: "rate limited", retryMs: WINDOW_MS }, 429);
  const body = await readJson(req, 16 * 1024);
  if (!body.ok) return json({ error: body.error }, body.status);
  const i = (body.value ?? {}) as { question?: unknown; facts?: unknown };
  const question = str(i.question, 200).trim();
  const facts = Array.isArray(i.facts) ? i.facts.filter((x): x is string => typeof x === "string").slice(0, 40).map((x) => x.slice(0, 200)) : [];
  if (!question || !facts.length) return json({ error: "bad host request" }, 400);
  const sw = await switches(env);
  if (sw.paused) return json({ error: "builds paused", retryable: true }, 503);
  const est = costMicroUsd(INTENT_MODEL, 3000, 200);
  const held = await reserveFor(env, url, caller, ip, est);
  if (held instanceof Response) return held;
  let cost = est;
  try {
    const r = await jsonLanes<{ answer?: unknown; cites?: unknown }>(
      lanesFor("host", keysOf(env), { primary: sw.primary, maxTokens: 200, jsonSchema: { name: "host", schema: hostJsonSchema(facts.length) }, messages: hostMessages(question, facts) }),
    );
    if (r.inTok > 0) cost = costMicroUsd(r.model, r.inTok, r.outTok);
    const cites = Array.isArray(r.value.cites) ? [...new Set(r.value.cites.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= facts.length))].slice(0, 4) : [];
    return json({ answer: str(r.value.answer, 280), cites, ms: r.ms });
  } catch (e) {
    if (e instanceof LlmError && e.status !== 200) cost = 0;
    return json({ error: e instanceof Error ? e.message.slice(0, 200) : "host failed", retryable: true }, 502);
  } finally {
    await held(cost).catch(() => undefined);
  }
}

/**
 * POST /v1/repair and /v1/edit: the fill model answers with a patch (changed lines by id, new
 * lines, deletions) streamed as op events. A repair is asked to fix the proof's counterexamples;
 * an edit makes the person's own change. Either way the client merges, re-places and re-proves:
 * a repair is offered only if the receipt got better, an edit comes back with its new numbers.
 */
async function patch(kind: "repair" | "edit" | "director", req: Request, env: Env, url: URL, later: (p: Promise<unknown>) => void): Promise<Response> {
  if (!hasModel(env)) return json({ error: "llm not configured" }, 503);
  const gate = await identify(req, url, env);
  if (!gate.ok) return json(gate.body, gate.status);
  const caller = gate.caller;
  const ip = ipOf(req);
  if (caller.via !== "token" && !buildBuckets.allow(ip, intVar(env.BUILDS_PER_WINDOW, 30))) return json({ error: "rate limited", retryMs: WINDOW_MS }, 429);
  const body = await readJson(req, 96 * 1024);
  if (!body.ok) return json({ error: body.error }, body.status);
  const input = (body.value ?? {}) as { prompt?: unknown; change?: unknown; intent?: unknown; fill?: unknown; issues?: unknown; seed?: unknown; notes?: unknown; hard?: unknown };
  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, MAX_PROMPT * 2) : "";
  const fill = typeof input.fill === "string" && input.fill.length <= 64 * 1024 ? input.fill : "";
  const issues = Array.isArray(input.issues) ? input.issues.filter((x): x is string => typeof x === "string").slice(0, 10).map((x) => x.slice(0, 600)) : [];
  const change = typeof input.change === "string" ? input.change.trim().slice(0, MAX_PROMPT) : "";
  const notes = Array.isArray(input.notes) ? input.notes.filter((x): x is string => typeof x === "string").slice(0, 8).map((x) => x.slice(0, 300)) : [];
  const intent = v.safeParse(IntentOut, input.intent);
  if (!prompt || !fill || !intent.success || !Number.isInteger(input.seed) || (kind === "repair" && !issues.length) || (kind === "edit" && !change)) return json({ error: `bad ${kind} request` }, 400);
  // the Director's cut and a repair the fast lane gave up on are Sonnet's; everything else the patch lane's
  const job: Job = kind === "director" ? "director" : kind === "repair" && input.hard === true ? "hard_repair" : "patch";
  const sw = await switches(env);
  if (sw.paused) return json({ error: "builds paused", retryable: true }, 503);
  if (job !== "patch" && (await env.FLAGS?.get(SONNET_FLAG, { cacheTtl: 60 }).catch(() => null)) === "off") return json({ error: "the Sonnet lane is off", retryable: false }, 503);
  if (!lanesFor(job, keysOf(env), { messages: [] }).length) return json({ error: `no model provider for ${kind}`, retryable: false }, 503);
  let messages: ChatMessage[];
  try {
    const pack = packFor(intent.output.pack);
    // the layout the world stands on now: a structural edit's numbers and sub-zones are in its fill
    const shape = layoutOf(pack, fill);
    const layout = pack.generate({ seed: input.seed as number, params: shape.params, sub: shape.sub, laws: DEFAULT_LAWS, harder: false });
    const lines = gameplayLines(fill);
    messages =
      kind === "repair" ? repairMessages(prompt, intent.output, layout, lines, issues)
      : kind === "edit" ? editMessages(prompt, change, intent.output, layout, lines, layoutLine(layout.packId, shape.params, shape.sub))
      : directorMessages(prompt, intent.output, layout, lines, notes);
  } catch {
    return json({ error: `bad ${kind} request` }, 400);
  }
  const est = job === "patch" ? costMicroUsd(FILL_MODEL, REPAIR_MAX_IN, REPAIR_MAX_OUT) : jobEstimate(job, messages, REPAIR_MAX_OUT);
  const held = await reserveFor(env, url, caller, ip, est);
  if (held instanceof Response) return held;
  const out = sseStream();
  later(
    (async () => {
      const t0 = Date.now();
      let cost = est;
      try {
        let buf = "";
        let i = 0;
        let model = "";
        for await (const ev of streamLanes(lanesFor(job, keysOf(env), { primary: sw.primary, maxTokens: REPAIR_MAX_OUT, messages, signal: out.signal }))) {
          if (ev.type === "usage") [cost, model] = [costMicroUsd(ev.model, ev.inTok, ev.outTok), ev.model];
          if (ev.type === "fallback") await out.send("fallback", ev);
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
        await out.send("done", { totalMs: Date.now() - t0, lines: i, model });
      } catch (e) {
        if (e instanceof LlmError && e.status !== 200) cost = 0;
        await out.send("error", { message: e instanceof Error ? e.message.slice(0, 200) : `${kind} failed`, retryable: e instanceof LlmError ? e.retryable : true });
      } finally {
        await out.close();
        await held(cost).catch(() => undefined);
      }
    })(),
  );
  return out.response;
}

async function build(req: Request, env: Env, url: URL, later: (p: Promise<unknown>) => void): Promise<Response> {
  if (!hasModel(env)) return json({ error: "llm not configured" }, 503);
  const gate = await identify(req, url, env);
  if (!gate.ok) return json(gate.body, gate.status);
  const caller = gate.caller;
  const ip = ipOf(req);
  // Judges may share one NAT; their tokens are bounded by session caps instead.
  if (caller.via !== "token" && !buildBuckets.allow(ip, intVar(env.BUILDS_PER_WINDOW, 30))) return json({ error: "rate limited", retryMs: WINDOW_MS }, 429);

  const body = await readJson(req, MAX_BUILD_BODY);
  if (!body.ok) return json({ error: body.error }, body.status);
  const input = (body.value ?? {}) as { prompt?: unknown; seed?: unknown; engine?: unknown; fresh?: unknown; image?: unknown; intent?: unknown };
  const said = typeof input.prompt === "string" ? input.prompt.trim().slice(0, MAX_PROMPT) : "";
  // what the person pinned on the Intent card (a pack, a mode, a genre): checked before anything is spent
  const pinned = readPin(input.intent, subsOf);
  if (!pinned.ok) return json({ error: pinned.error }, 400);
  const pin = pinned.pin;
  const hasPin = Object.keys(pin).length > 0;
  // A picture is checked (its type, its bytes, its size) before anything is spent; with one, the words are optional.
  const pic = input.image == null ? undefined : readImage(input.image);
  if (pic && !pic.ok) return json({ error: pic.error }, pic.status);
  const image = pic?.image;
  if (!said && !image) return json({ error: "empty prompt" }, 400);
  const asked = Number.isInteger(input.seed) ? (input.seed as number) : undefined;
  // a picture's build takes its seed from the prompt its brief makes (below), so the same picture and words lay out alike
  let seed = asked ?? (image ? 0 : await promptSeed(said));
  const [sw, caching] = await Promise.all([switches(env), cacheOn(env)]);
  if (sw.paused) return json({ error: "builds paused", retryable: true }, 503);
  const keys = keysOf(env);
  if (image && !lanesFor("vision", keys, { messages: [] }).length) return json({ error: "building from a picture needs the Claude lane", retryable: false }, 503);

  // The exact-repeat cache, for a caller that names the engine it builds with. A hit replays now,
  // before any hold or model call; `fresh` skips the lookup, and its build overwrites the entry.
  // A build from a picture is never looked up or kept: its key would be the picture, which is kept nowhere.
  const store = !image && caching && typeof input.engine === "string" && ENGINE_RE.test(input.engine) ? blobsFor(env, url) : undefined;
  // a pinned rebuild is its own entry: the same words built as a maze are another world
  const key = store ? await cacheKey(hasPin ? `${said}\n#pinned ${jcs(pin)}` : said, seed, await templateHash(EXAMPLE), input.engine as string) : undefined;
  if (store && key && input.fresh !== true) {
    const hit = await readCache(store, key);
    if (hit) return new Response(replayBody(hit), { headers: SSE_HEADERS });
  }

  const visionMsgs = image ? visionMessages(said, image) : [];
  const est = { vision: image ? visionEstimate(visionMsgs, image.width, image.height) : 0, ...buildEstimate(intentMessages(said, PACKS), image ? BRIEF_MAX_CHARS : 0) };
  const held = await reserveFor(env, url, caller, ip, est.vision + est.intent + est.fill);
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
  // what the cache keeps: everything sent but a fallback
  const tape: CachedEvent[] = [];
  const keep = (event: CachedEvent["event"], data: unknown) => (tape.push({ event, data }), send(event, data));

  later(
    (async () => {
      const t0 = Date.now();
      // A call is charged at its estimate until it reports usage (fail closed); an HTTP error is free.
      let phase: "vision" | "intent" | "fill" | "after" = image ? "vision" : "intent";
      let visionCost = est.vision;
      let intentCost = image ? 0 : est.intent;
      let fillCost = 0;
      // for the cache: a safe intent, the gameplay layer closed (the client plays from there), the end reached
      let safe = false;
      let closed = false;
      let done = false;
      let lines = 0;
      let firstMs = -1;
      let intentRes: { ms: number; model: string } | undefined;
      let writer = "";
      let prompt = said;
      try {
        if (image) {
          // the picture is read once, into a scene brief; from here on the world is built from words
          const seen = await jsonLanes<unknown>(lanesFor("vision", keys, { primary: sw.primary, messages: visionMsgs, jsonSchema: { name: "brief", schema: briefJsonSchema() }, maxTokens: VISION_MAX_OUT, signal: upstream.signal }));
          if (seen.inTok > 0) visionCost = costMicroUsd(seen.model, seen.inTok, seen.outTok);
          const out = v.parse(BriefOut, seen.value);
          if (out.safety === "block") {
            await send("refusal", { message: PICTURE_REFUSAL });
            return;
          }
          const brief = settleBrief(out);
          prompt = inspiredPrompt(said, brief);
          if (asked === undefined) seed = await promptSeed(prompt);
          await send("inspired", { brief, prompt, ms: seen.ms, model: seen.model });
          phase = "intent";
        }
        const intentMsgs = intentMessages(prompt, PACKS, hasPin ? pinLine(pin) : undefined);
        if (image) intentCost = buildEstimate(intentMsgs).intent;
        const res = await jsonLanes<unknown>(
          lanesFor("intent", keys, { primary: sw.primary, messages: intentMsgs, jsonSchema: { name: "intent", schema: intentJsonSchema(PACKS.map((p) => p.id), ALL_SUBS) }, maxTokens: INTENT_MAX_OUT, signal: upstream.signal }),
        );
        intentRes = res;
        if (res.inTok > 0) intentCost = costMicroUsd(res.model, res.inTok, res.outTok);
        if (res.fellBack) await send("fallback", { job: "intent", to: res.model });
        // the pins win over the model (and over a goal phrase's "it's a game"): the person chose them
        const intent = pinIntent(settleIntent(prompt, v.parse(IntentOut, res.value)), pin, subsOf);
        safe = intent.safety !== "block"; // arcade games (shooters, monsters, heists) are ordinary worlds to keep
        await keep("intent", { intent, seed, ms: Date.now() - t0 });
        if (intent.safety === "block") {
          await send("refusal", { message: REFUSAL });
          return;
        }
        const pack = packFor(intent.pack);
        const layout = pack.generate({ seed, params: pack.defaults, sub: intent.sub, laws: DEFAULT_LAWS, harder: false });
        phase = "fill";
        fillCost = est.fill;
        let buf = "";
        let fillModel = "";
        const fillLanes = lanesFor("fill", keys, { primary: sw.primary, maxTokens: FILL_MAX_OUT, messages: fillMessages(prompt, intent, layout, EXAMPLE, seed), signal: upstream.signal });
        writer = fillLanes[0]?.model ?? "";
        const line = async (text: string) => {
          await keep("op", { i: lines++, line: text });
          closed ||= closesGameplay(text);
        };
        for await (const ev of streamLanes(fillLanes)) {
          if (ev.type === "usage") [fillCost, fillModel] = [costMicroUsd(ev.model, ev.inTok, ev.outTok), ev.model];
          if (ev.type === "fallback") {
            writer = ev.to;
            await send("fallback", { job: "fill", ...ev });
          }
          if (ev.type === "first_token") firstMs = Date.now() - t0;
          if (ev.type !== "text") continue;
          buf += ev.delta;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const text = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (text) await line(text);
          }
        }
        phase = "after";
        if (buf.trim()) await line(buf.trim());
        writer = fillModel || writer;
        await keep("done", { intentMs: res.ms, fillFirstTokenMs: firstMs, totalMs: Date.now() - t0, lines, intentModel: res.model, fillModel });
        done = true;
      } catch (e) {
        if (e instanceof LlmError && e.status !== 200) {
          if (phase === "vision") visionCost = 0;
          if (phase === "intent") intentCost = 0;
          if (phase === "fill") fillCost = 0;
        }
        const retryable = e instanceof LlmError ? e.retryable : true;
        // Claude declining to look at the picture (a refusal stop, HTTP 200) is a refusal, said as one
        if (phase === "vision" && e instanceof LlmError && e.status === 200 && !e.retryable) await send("refusal", { message: PICTURE_REFUSAL });
        else await send("error", { message: e instanceof Error ? e.message.slice(0, 200) : "build failed", retryable });
      } finally {
        await w.close().catch(() => undefined);
        await settle(visionCost + intentCost + fillCost).catch(() => undefined);
        // Kept only when clean: it reached done, or its client left once the gameplay layer was
        // complete (the client stops reading there, so the cosmetic tail is never part of a world).
        if (store && key && intentRes && safe && (done || (closed && gone))) {
          if (!done) tape.push({ event: "done", data: { intentMs: intentRes.ms, fillFirstTokenMs: firstMs, totalMs: Date.now() - t0, lines, intentModel: intentRes.model, fillModel: writer } });
          await writeCache(store, key, { v: 1, at: new Date(t0).toISOString(), intentModel: intentRes.model, fillModel: writer, events: tape }).catch(() => false);
        }
      }
    })(),
  );

  return new Response(readable, { headers: SSE_HEADERS });
}
