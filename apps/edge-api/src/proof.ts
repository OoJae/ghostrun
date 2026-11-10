// POST /v1/proof: the cloud proof. The client sends the world as it has it after a build, a share
// or a gallery open (the fill text, the seed, the pack and mode, the engine hash, the spec hash it
// computed and its proof version). The Worker places the same world with the same pipeline
// (world.ts, on @ghostrun/world), checks the spec hash is the one claimed, and runs the same prove() the device
// runs on the same pinned engine, its T3 and playtest runs dealt out to ProofShard DOs (shard.ts).
// The answer is the receipt exactly as the device makes it, with host "edge" and the playtest on it.
// A receipt is kept in R2 under proof/<version>/<engine>/<spec>.json and a repeat is answered from
// there at once. No model is called, so nothing is spent; the CPU is bounded by the gate, per-IP and
// per-session buckets, a cap on proofs in flight per isolate, and the kill switch ff.edge_proof.
import type { WorldBundle } from "@ghostrun/ir";
import { flagOn, HUMAN_RUNS, prove, SKILL_RUNS, t0, TIERS, witnesses, type Receipt, type Tiers, type Witness } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { ENGINE_HASH, PROOF_VERSION } from "@ghostrun/world";
import * as v from "valibot";
import { Buckets, intVar, WINDOW_MS } from "./buckets";
import type { DoNamespace, KvNamespace, R2Bucket } from "./cf";
import { engine, hasEngine } from "./engine";
import { identify, ipOf, type GateEnv } from "./gate";
import { json, readJson } from "./http";
import { playOnShards, type ShardWorld } from "./shard";
import { MAX_FILL_BYTES, r2Blobs, type BlobStore } from "./share";
import { placeFill, type Placed } from "./world";

/** KV key in FLAGS: "off" turns the cloud proof off (clients go on proving on the device), deploy-free. */
export const PROOF_FLAG = "ff.edge_proof";
/**
 * KV keys in FLAGS for the tiers after the playtest: "off" or "on" over the default (TIERS). T3h's
 * runs are dealt to the shards with the playtest's; T4 (milliseconds of arithmetic) runs here.
 */
export const T3H_FLAG = "ff.t3h";
export const T4_FLAG = "ff.t4";
/** T3's expert runners, as the device proves the world itself. */
const RUNS = 12;
const MAX_PROOF_BODY = MAX_FILL_BYTES + 4096;
/** A stored receipt bigger than this is not kept (CTF's, playtest and ghost included, is about 0.3 MB). */
const MAX_KEPT_BYTES = 4 * 1024 * 1024;
/** How long a lookup may hold a proof up before it is proved anew. */
const KEPT_READ_MS = 1500;
/** Proofs one isolate works on at once (each holds its thread while its own part of the ladder runs). */
const MAX_INFLIGHT = 6;

export interface ProofEnv extends GateEnv {
  FLAGS?: KvNamespace;
  SHARES?: R2Bucket;
  /** The ProofShard DO namespace; without it a proof runs whole in the Worker. */
  PROOF_SHARD?: DoNamespace;
  /** Shards one proof plays on at once (default 6; 0 plays it whole in the Worker). */
  PROOF_SHARDS?: string;
  /** How long one shard job may take before the Worker plays it itself (default 30 s). */
  PROOF_SHARD_TIMEOUT_MS?: string;
  /** Proofs (not stored receipts) per session, and per IP for a session cookie, per isolate per 10 min (default 20). */
  PROOFS_PER_WINDOW?: string;
  /** Requests per IP per isolate per 10 min, stored receipts included (default 60). */
  RATE_PER_WINDOW?: string;
}

const Hex64 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
export const ProofIn = v.strictObject({
  v: v.literal(1),
  fill: v.pipe(v.string(), v.minLength(1), v.check((s) => new TextEncoder().encode(s).length <= MAX_FILL_BYTES, "fill over 64 KB")),
  seed: v.pipe(v.number(), v.integer(), v.minValue(-(2 ** 31)), v.maxValue(2 ** 32 - 1)),
  pack: v.optional(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,31}$/))),
  mode: v.optional(v.picklist(["play", "wander"])),
  engine: Hex64,
  spec: Hex64,
  version: v.pipe(v.string(), v.regex(/^(?:dev|[0-9a-f]{64})$/)),
});
export type ProofInput = v.InferOutput<typeof ProofIn>;

export type ProofOutcome =
  | { ok: true; receipt: Receipt; /** When the stored receipt was proved (ISO 8601), or null: proved now. */ cached: string | null; ms: number; /** Shards it was played on (0: whole, here). */ shards: number }
  | { ok: false; status: 400 | 409 | 429 | 500 | 503; error: string; retryable: boolean; detail?: Record<string, unknown> };

export interface ProofCtx {
  env: ProofEnv;
  /** Keep work going after the answer (the receipt's write to R2). */
  later?: (p: Promise<unknown>) => void;
  /** Prove it anew whether or not a receipt is kept (the canary's check that a fresh proof still matches). */
  fresh?: boolean;
  /** Asked just before the CPU is spent (not for a stored receipt): false turns the proof away (429). */
  allow?: () => boolean;
  /** Keep the receipt for next time (default true). */
  keep?: boolean;
}

interface Kept {
  v: 1;
  at: string;
  receipt: Receipt;
}

/** Which later tiers a receipt holds, as its key says it ("" for the defaults, so those keys are as they were). */
const tiersTag = (t: Tiers) => (t.t3h === TIERS.t3h && t.t4 === TIERS.t4 ? "" : `~t3h${t.t3h ? 1 : 0}t4${t.t4 ? 1 : 0}`);
export const proofKey = (spec: string, engineHash = ENGINE_HASH, version = PROOF_VERSION, tiers: Tiers = TIERS) => `proof/${version}/${engineHash}/${spec}${tiersTag(tiers)}.json`;

/** The later tiers this edge runs (and tells clients to run: /v1/health), read once a minute. */
export async function tiersOn(env: ProofEnv): Promise<Tiers> {
  const read = (k: string) => env.FLAGS?.get(k, { cacheTtl: 60 }).catch(() => null) ?? Promise.resolve(null);
  const [t3h, t4] = await Promise.all([read(T3H_FLAG), read(T4_FLAG)]);
  return { t3h: flagOn(t3h, TIERS.t3h), t4: flagOn(t4, TIERS.t4) };
}

/** Is the cloud proof on? Unless FLAGS says "off" (read at the edge once a minute). */
export async function proofOn(env: ProofEnv): Promise<boolean> {
  return (await env.FLAGS?.get(PROOF_FLAG, { cacheTtl: 60 }).catch(() => null)) !== "off";
}

/** For /v1/health: whether a client should ask for the cloud proof. */
export async function proofHealth(env: ProofEnv): Promise<{ proof: boolean; tiers: Tiers }> {
  const [on, tiers] = await Promise.all([proofOn(env), tiersOn(env)]);
  return { proof: hasEngine() && on, tiers };
}

export async function readKept(store: BlobStore, key: string, ms = KEPT_READ_MS): Promise<Kept | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([store.get(key), new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]);
    if (text === null) return null;
    const k = JSON.parse(text) as Partial<Kept> | null;
    return k?.v === 1 && typeof k.at === "string" && k.receipt?.v === 1 && Array.isArray(k.receipt.chips) ? (k as Kept) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function keep(store: BlobStore, key: string, kept: Kept): Promise<boolean> {
  const text = JSON.stringify(kept);
  if (text.length > MAX_KEPT_BYTES) return false;
  await store.put(key, text, { at: kept.at, spec: kept.receipt.spec });
  return true;
}

/** A receipt as the device hands it out before its playtest. */
const bare = ({ playtest: _p, ...r }: Receipt): Receipt => r;

interface Running {
  /** The receipt, out before the playtest's runs are in. */
  first: Promise<Receipt>;
  /** It with its playtest. */
  done: Promise<{ receipt: Receipt; shards: number }>;
}

const inflight = new Map<string, Running>();
const fail = (status: Extract<ProofOutcome, { ok: false }>["status"], error: string, retryable: boolean, detail?: Record<string, unknown>): ProofOutcome => ({ ok: false, status, error, retryable, ...(detail ? { detail } : {}) });

function start(ctx: ProofCtx, R: Promise<Rapier>, b: WorldBundle, world: ShardWorld, tiers: Tiers): Running {
  let hand = (_r: Receipt) => {};
  const first = new Promise<Receipt>((r) => (hand = r));
  const done = (async () => {
    const ns = ctx.env.PROOF_SHARD;
    const width = intVar(ctx.env.PROOF_SHARDS, 6);
    let shards: ReturnType<typeof playOnShards> | undefined;
    const jobs = ns && width > 0 ? witnesses(b, t0(b, "red").chain, RUNS, "red", SKILL_RUNS, tiers.t3h ? HUMAN_RUNS : 0) : [];
    if (ns && jobs.length) {
      // the playtest's runs and T3h's are played after the receipt's
      const skill = (w: Witness) => w.kind === "human" || (w.kind === "run" && w.level !== undefined);
      shards = playOnShards(ns, world, { receipt: jobs.filter((w) => !skill(w)), playtest: jobs.filter(skill) }, { width, timeoutMs: intVar(ctx.env.PROOF_SHARD_TIMEOUT_MS, 30_000) });
      // let the first shard requests go out before the ladder's own part holds the thread
      await new Promise((r) => setTimeout(r, 0));
    }
    const receipt = await prove(await R, b, { engine: ENGINE_HASH, host: "edge", runs: RUNS, playtest: true, t3h: tiers.t3h, t4: tiers.t4, onReceipt: hand, ...(shards ? { played: shards.receipt, playtestPlayed: shards.all } : {}) });
    hand(bare(receipt));
    return { receipt, shards: shards ? Math.min(width, jobs.length) : 0 };
  })();
  void done.catch(() => undefined);
  return { first, done };
}

/**
 * Prove a world in the cloud (the route's work, and what any other caller at the edge uses, such
 * as an MCP tool): the stored receipt when there is one, else a proof now, kept for next time.
 * `onStart` says the CPU is being spent (every check passed); `onReceipt` hands the receipt over as
 * soon as it is out, before the playtest's runs are in, as the device does.
 */
export async function proveWorld(input: ProofInput, ctx: ProofCtx & { onStart?: () => void; onReceipt?: (r: Receipt) => void }): Promise<ProofOutcome> {
  const t0ms = Date.now();
  if (input.engine !== ENGINE_HASH) return fail(409, "engine differs", false, { engine: ENGINE_HASH });
  if (input.version !== PROOF_VERSION) return fail(409, "proof version differs", false, { version: PROOF_VERSION });
  let placed: Placed;
  try {
    placed = await placeFill(input.fill, input.seed, { pack: input.pack, mode: input.mode });
  } catch {
    return fail(400, "the fill does not place", false);
  }
  const spec = placed.spec;
  if (spec !== input.spec) return fail(409, "spec differs", false, { spec });
  const store = ctx.env.SHARES ? r2Blobs(ctx.env.SHARES) : undefined;
  const tiers = await tiersOn(ctx.env);
  const key = proofKey(spec, ENGINE_HASH, PROOF_VERSION, tiers);
  if (store && !ctx.fresh) {
    const hit = await readKept(store, key);
    if (hit) {
      ctx.onReceipt?.(bare(hit.receipt));
      return { ok: true, receipt: hit.receipt, cached: hit.at, ms: Date.now() - t0ms, shards: 0 };
    }
  }
  // the same world asked for twice at once in one isolate is proved once
  let running = ctx.fresh ? undefined : inflight.get(key);
  if (!running) {
    if (ctx.allow && !ctx.allow()) return fail(429, "rate limited", true, { retryMs: WINDOW_MS });
    if (inflight.size >= MAX_INFLIGHT) return fail(503, "the cloud proof is busy", true);
    const rapier = engine();
    if (!rapier) return fail(503, "no proof engine here", false);
    const world: ShardWorld = { fill: input.fill, seed: input.seed, ...(input.pack ? { pack: input.pack } : {}), ...(input.mode ? { mode: input.mode } : {}), spec };
    const mine = start(ctx, rapier, placed.bundle, world, tiers);
    running = mine;
    inflight.set(key, mine);
    void mine.done.finally(() => inflight.get(key) === mine && inflight.delete(key)).catch(() => undefined);
  }
  ctx.onStart?.();
  void running.first.then((r) => ctx.onReceipt?.(r));
  let done: { receipt: Receipt; shards: number };
  try {
    done = await running.done;
  } catch (e) {
    return fail(500, e instanceof Error ? e.message.slice(0, 200) : "proof failed", true);
  }
  if (store && ctx.keep !== false) {
    const write = keep(store, key, { v: 1, at: new Date().toISOString(), receipt: done.receipt }).catch(() => false);
    if (ctx.later) ctx.later(write);
    else await write;
  }
  return { ok: true, receipt: done.receipt, cached: null, ms: Date.now() - t0ms, shards: done.shards };
}

const ipBuckets = new Buckets();
const cpuBuckets = new Buckets();
const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" };

/**
 * The route. Answered as JSON ({receipt, version, cached, ms, shards}, the playtest on the receipt)
 * unless the caller asks for text/event-stream, as the web client does: then `proving {shards}`
 * once the CPU is being spent, `receipt {receipt, version, cached}` the moment it is out (its
 * playtest still playing), `playtest {playtest}` and `done {ms, shards}`. A request the checks
 * turn away is answered with its status and a JSON error either way.
 */
export async function proofRoute(req: Request, env: ProofEnv, url: URL, later: (p: Promise<unknown>) => void): Promise<Response> {
  const gate = await identify(req, url, env);
  if (!gate.ok) return json(gate.body, gate.status);
  const caller = gate.caller;
  const ip = ipOf(req);
  if (!ipBuckets.allow(ip, intVar(env.RATE_PER_WINDOW, 60))) return json({ error: "rate limited", retryMs: WINDOW_MS }, 429);
  if (!(await proofOn(env))) return json({ error: "the cloud proof is off", retryable: false }, 503);
  const body = await readJson(req, MAX_PROOF_BODY);
  if (!body.ok) return json({ error: body.error }, body.status);
  const input = v.safeParse(ProofIn, body.value);
  if (!input.success) return json({ error: "bad proof request" }, 400);
  // a judge token is counted by its session (judges may share one NAT); a session cookie by its session and its IP
  const limit = intVar(env.PROOFS_PER_WINDOW, 20);
  const allow = () => cpuBuckets.allow(`s:${caller.session ?? ip}`, limit) && (caller.via === "token" || cpuBuckets.allow(`ip:${ip}`, limit));
  const answer = (r: Extract<ProofOutcome, { ok: true }>) => ({ receipt: r.receipt, version: PROOF_VERSION, cached: r.cached, ms: r.ms, shards: r.shards });
  if (!(req.headers.get("accept") ?? "").includes("text/event-stream")) {
    const r = await proveWorld(input.output, { env, later, allow });
    if (!r.ok) return json({ error: r.error, retryable: r.retryable, ...r.detail }, r.status);
    return json(answer(r), 200, { "x-proof": r.cached ? "hit" : "miss" });
  }
  // a stream from the moment the proof starts; until then (a refusal, a stored receipt) one answer
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  let open = true;
  const send = (event: string, data: unknown) => open && void w.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => (open = false));
  let begun = () => {};
  const started = new Promise<"started">((r) => (begun = () => r("started")));
  let first: Receipt | null = null;
  const result = proveWorld(input.output, {
    env,
    later,
    allow,
    onStart: begun,
    onReceipt: (r) => ((first = r), send("receipt", { receipt: r, version: PROOF_VERSION, cached: null })),
  });
  const which = await Promise.race([started, result]);
  if (which !== "started") {
    if (!which.ok) return json({ error: which.error, retryable: which.retryable, ...which.detail }, which.status);
    const stored = `event: receipt\ndata: ${JSON.stringify({ receipt: bare(which.receipt), version: PROOF_VERSION, cached: which.cached })}\n\nevent: playtest\ndata: ${JSON.stringify({ playtest: which.receipt.playtest ?? null })}\n\nevent: done\ndata: ${JSON.stringify({ ms: which.ms, shards: 0 })}\n\n`;
    return new Response(stored, { headers: { ...SSE_HEADERS, "x-proof": "hit" } });
  }
  send("proving", { version: PROOF_VERSION });
  later(
    (async () => {
      const r = await result;
      if (!r.ok) send("error", { message: r.error, retryable: r.retryable });
      else {
        if (!first) send("receipt", { receipt: bare(r.receipt), version: PROOF_VERSION, cached: null });
        send("playtest", { playtest: r.receipt.playtest ?? null });
        send("done", { ms: r.ms, shards: r.shards });
      }
      await w.close().catch(() => undefined);
    })(),
  );
  return new Response(readable, { headers: { ...SSE_HEADERS, "x-proof": "miss" } });
}
