// The canaries: cron triggers (wrangler.jsonc) on which the Worker checks itself, and says so
// through the governor's alert path (ntfy, NTFY_URL) when something fails or is slow.
//   every 15 min  self health (the health route, the governor, the share store) and the stored
//                 cloud proof of the organizer's brief: proved once per proof version, then read
//                 back (no spend, and the brief's receipt stays warm for whoever opens it)
//   every 2 h     a full proof of a small golden world with the store skipped: it must equal the
//                 receipt kept for it, to the bit (determinism, checked at the edge on a schedule)
//   every 12 h    one live build on the canary pool (a canary: judge token, CANARY_TOKEN, and
//                 CAP_POOL_CANARY_USD): held and committed by the governor like any build, about
//                 half a cent, so the pool's cap is never near
// Each kind's last run is kept in FLAGS under canary:<kind>; /v1/health shows {at, ok} over all of
// them. A kind alerts when it turns bad, again every 6 h while it stays bad, and once it is good.
import { receiptHash } from "@ghostrun/proof";
import { ENGINE_HASH, PROOF_VERSION } from "@ghostrun/world";
import CTF from "../../../packages/ir/fixtures/ctf-neon.jsonl?raw";
import COINS from "../../../packages/ir/fixtures/coin-rush.jsonl?raw";
import type { WaitUntil } from "./cf";
import { doCall, governorClient } from "./governor";
import { handle, type Env } from "./handler";
import { canaryKey, lastRun, type CanaryKind, type CanaryRun } from "./health";
import { ntfy } from "./http";
import { proofKey, proofOn, proveWorld, readKept, tiersOn, type ProofInput } from "./proof";
import { r2Blobs } from "./share";
import { placeFill } from "./world";

export interface CanaryEnv {
  /** The raw canary judge token (its canary: hash is in JUDGE_TOKEN_HASHES): the live build's credential. */
  CANARY_TOKEN?: string;
}

/** Which kinds each cron runs. The schedules are wrangler.jsonc's triggers.crons, exactly. */
export const CRONS: Record<string, readonly CanaryKind[]> = {
  "*/15 * * * *": ["health", "stored_proof"],
  "5 */2 * * *": ["fresh_proof"],
  "35 */12 * * *": ["live_build"],
};

/** Slower than this is an alert too: the stamp target for a receipt is 9 s. */
export const SLOW_MS: Record<CanaryKind, number> = { health: 3000, stored_proof: 9000, fresh_proof: 9000, live_build: 20_000 };
const REALERT_MS = 6 * 60 * 60 * 1000;
/** A short world to write, on the cheap lane, with the build cache skipped (a cached replay calls no model). */
export const CANARY_PROMPT = "A small neon arena: grab the orb and carry it to the goal.";

type Outcome = { ok: boolean; detail: string };

const seedOf = (fill: string) => (JSON.parse(fill.split("\n", 1)[0] ?? "{}") as { seed?: number }).seed ?? 7;

async function golden(fill: string): Promise<ProofInput> {
  const seed = seedOf(fill);
  return { v: 1, fill, seed, engine: ENGINE_HASH, spec: (await placeFill(fill, seed)).spec, version: PROOF_VERSION };
}

async function health(env: Env & CanaryEnv, ctx: WaitUntil): Promise<Outcome> {
  const bad: string[] = [];
  const h = (await (await handle(new Request("https://canary.internal/v1/health"), env, ctx)).json()) as { ok?: boolean; llm?: boolean; proof?: boolean };
  if (h.ok !== true) bad.push("health not ok");
  if ((env.CEREBRAS_API_KEY || env.ANTHROPIC_API_KEY) && !h.llm) bad.push("no model lane");
  if (env.GOVERNOR && "reason" in (await governorClient(doCall(env.GOVERNOR), 1000, 3000).status())) bad.push("governor unavailable");
  if (env.SHARES) await env.SHARES.head("canary/none").catch(() => bad.push("share store unavailable"));
  return { ok: !bad.length, detail: bad.join("; ") || `ok${h.proof ? "" : " (cloud proof off)"}` };
}

async function storedProof(env: Env, ctx: WaitUntil): Promise<Outcome> {
  if (!(await proofOn(env))) return { ok: true, detail: "skipped: ff.edge_proof is off" };
  const r = await proveWorld(await golden(CTF), { env, later: (p) => ctx.waitUntil(p) });
  if (!r.ok) return { ok: false, detail: `CTF brief: ${r.status} ${r.error}` };
  return { ok: true, detail: r.cached ? `CTF brief: stored receipt (proved ${r.cached})` : `CTF brief: proved now on ${r.shards} shards (the first for this version)` };
}

async function freshProof(env: Env): Promise<Outcome> {
  if (!(await proofOn(env))) return { ok: true, detail: "skipped: ff.edge_proof is off" };
  const input = await golden(COINS);
  const kept = env.SHARES ? await readKept(r2Blobs(env.SHARES), proofKey(input.spec, ENGINE_HASH, PROOF_VERSION, await tiersOn(env))) : null;
  // the first fresh proof for a version is kept; after that the kept one is what a fresh one must equal
  const r = await proveWorld(input, { env, fresh: true, keep: kept === null });
  if (!r.ok) return { ok: false, detail: `coin rush: ${r.status} ${r.error}` };
  if (!kept) return { ok: true, detail: `coin rush: proved on ${r.shards} shards, kept for the next check` };
  const [was, now] = await Promise.all([receiptHash(kept.receipt), receiptHash(r.receipt)]);
  return was === now ? { ok: true, detail: `coin rush: proved on ${r.shards} shards, same receipt as ${kept.at} (${now.slice(0, 8)})` } : { ok: false, detail: `coin rush: a fresh proof differs from the one kept at ${kept.at} (kept ${was.slice(0, 8)}, now ${now.slice(0, 8)})` };
}

async function liveBuild(env: Env & CanaryEnv, ctx: WaitUntil): Promise<Outcome> {
  if (!env.CANARY_TOKEN) return { ok: false, detail: "no CANARY_TOKEN secret: the live build can't run" };
  const res = await handle(
    new Request("https://canary.internal/v1/build", { method: "POST", headers: { "content-type": "application/json", "x-judge-token": env.CANARY_TOKEN, "cf-connecting-ip": "canary" }, body: JSON.stringify({ prompt: CANARY_PROMPT, engine: ENGINE_HASH, fresh: true }) }),
    env,
    ctx,
  );
  if (!res.ok) return { ok: false, detail: `build ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const events = (await res.text()).split("\n\n").filter(Boolean).map((b) => ({ event: /^event: (.+)$/m.exec(b)?.[1] ?? "", data: /^data: (.+)$/m.exec(b)?.[1] ?? "" }));
  const ops = events.filter((e) => e.event === "op").length;
  const end = events.at(-1);
  if (end?.event !== "done" || !events.some((e) => e.event === "intent") || !ops) return { ok: false, detail: `build ended ${end?.event ?? "empty"}${end?.event === "error" ? `: ${end.data.slice(0, 160)}` : ""} after ${ops} lines` };
  const done = JSON.parse(end.data) as { fillModel?: string; intentModel?: string };
  return { ok: true, detail: `built ${ops} lines (intent ${done.intentModel ?? "?"}, fill ${done.fillModel ?? "?"})` };
}

async function check(kind: CanaryKind, env: Env & CanaryEnv, ctx: WaitUntil): Promise<Outcome> {
  if (kind === "health") return health(env, ctx);
  if (kind === "stored_proof") return storedProof(env, ctx);
  if (kind === "fresh_proof") return freshProof(env);
  return liveBuild(env, ctx);
}

/** Run one kind, keep its result and alert as its state calls for. */
export async function runCanary(kind: CanaryKind, env: Env & CanaryEnv, ctx: WaitUntil, now = () => Date.now()): Promise<CanaryRun> {
  const t0 = now();
  let out: Outcome;
  try {
    out = await check(kind, env, ctx);
  } catch (e) {
    out = { ok: false, detail: e instanceof Error ? e.message.slice(0, 200) : "canary failed" };
  }
  const ms = now() - t0;
  if (out.ok && ms > SLOW_MS[kind]) out = { ok: false, detail: `slow: ${ms} ms (over ${SLOW_MS[kind]}): ${out.detail}` };
  const prev = env.FLAGS ? await lastRun(env.FLAGS, kind) : null;
  const at = new Date(now()).toISOString();
  const alert = !out.ok && (!prev || prev.ok || !prev.alertedAt || now() - Date.parse(prev.alertedAt) > REALERT_MS);
  const run: CanaryRun = { at, ok: out.ok, ms, detail: out.detail, ...(alert ? { alertedAt: at } : !out.ok && prev?.alertedAt ? { alertedAt: prev.alertedAt } : {}) };
  if (env.NTFY_URL && alert) await ntfy(env.NTFY_URL, `GHOSTRUN canary: ${kind} failing`, out.detail, "high");
  if (env.NTFY_URL && out.ok && prev && !prev.ok) await ntfy(env.NTFY_URL, `GHOSTRUN canary: ${kind} ok again`, out.detail);
  await env.FLAGS?.put?.(canaryKey(kind), JSON.stringify(run)).catch(() => undefined);
  return run;
}

/** The scheduled handler: the kinds this cron runs, one after another. */
export async function canary(cron: string, env: Env & CanaryEnv, ctx: WaitUntil): Promise<CanaryRun[]> {
  const out: CanaryRun[] = [];
  for (const kind of CRONS[cron] ?? []) out.push(await runCanary(kind, env, ctx));
  return out;
}
