// Spend governor. One SQLite-backed Durable Object (named "global") owns every dollar of LLM spend:
// a build reserves an estimate before it calls a model and commits the metered cost afterwards; a
// hold nobody settles lapses after 60 s. Caps are checked against spent + held inside a single
// synchronous storage transaction, so concurrent builds cannot overspend, and any fault denies.
// The accounting is a pure class over LedgerStore (MemoryLedger for tests and local dev, SqlLedger
// inside the DO); the DO speaks a small JSON-over-fetch protocol that governorClient wraps.
import type { DoNamespace, DoState, DoStorage } from "./cf";
import { ntfy } from "./http";

export const POOLS = ["judge", "public", "dev", "canary"] as const;
export type Pool = (typeof POOLS)[number];

export const HOLD_MS = 60_000;
const LATE_COMMIT_MS = 60 * 60_000; // a lapsed hold still accepts its (late) commit for an hour
const PURGE_EVERY_MS = 10 * 60_000;
const MAX_MICRO = 5_000_000; // no single build is worth $5; a bigger number is garbage
const ALERT_AT = [0.5, 0.8];
const USD = 1_000_000;

/** Micro-USD caps per pool. Infinity = that limit does not apply to the pool. */
export interface Caps {
  session: Record<Pool, number>;
  ipDay: Record<Pool, number>;
  pool: Record<Pool, number>;
}

export interface CapsEnv {
  CAP_SESSION_JUDGE_USD?: string;
  CAP_SESSION_PUBLIC_USD?: string;
  CAP_IP_DAY_USD?: string;
  CAP_POOL_JUDGE_USD?: string;
  CAP_POOL_PUBLIC_USD?: string;
  CAP_POOL_DEV_USD?: string;
  CAP_POOL_CANARY_USD?: string;
}

function usd(raw: string | undefined, dflt: number): number {
  const s = raw?.trim().replace(/^\$/, "") ?? "";
  const n = Number(s);
  return Math.round((s !== "" && Number.isFinite(n) && n >= 0 ? n : dflt) * USD);
}

export function capsFromEnv(env: CapsEnv): Caps {
  const none = Infinity;
  return {
    session: { judge: usd(env.CAP_SESSION_JUDGE_USD, 0.6), public: usd(env.CAP_SESSION_PUBLIC_USD, 0.15), dev: none, canary: none },
    ipDay: { judge: none, public: usd(env.CAP_IP_DAY_USD, 0.3), dev: none, canary: none },
    pool: { judge: usd(env.CAP_POOL_JUDGE_USD, 40), public: usd(env.CAP_POOL_PUBLIC_USD, 25), dev: usd(env.CAP_POOL_DEV_USD, 5), canary: usd(env.CAP_POOL_CANARY_USD, 2) },
  };
}

export interface ReserveInput {
  pool: Pool;
  session?: string;
  ip: string;
  estimateMicroUsd: number;
}
export interface RecordInput {
  pool: Pool;
  session?: string;
  ip: string;
  actualMicroUsd: number;
}
export type DenyReason = "session_cap" | "ip_cap" | "pool_cap" | "bad_request";
export type ReserveResult = { ok: true; id: string; expiresAt: number } | { ok: false; reason: DenyReason };
export interface Alert {
  pool: Pool;
  threshold: number;
  spentMicroUsd: number;
  capMicroUsd: number;
}
export type SettleResult = { ok: true; chargedMicroUsd: number; alerts: Alert[] } | { ok: false; reason: "unknown_hold" | "bad_request" };
export interface Status {
  pools: { pool: Pool; spent: number; held: number; cap: number }[];
  caps: Caps;
}

export interface Hold {
  id: string;
  pool: Pool;
  keys: string[];
  amount: number;
  expires: number;
  lapsed: boolean;
}

/** Everything the governor needs from storage. All calls are synchronous; atomic() rolls back on throw. */
export interface LedgerStore {
  total(key: string): { spent: number; held: number };
  add(key: string, spent: number, held: number): void;
  getHold(id: string): Hold | undefined;
  putHold(h: Hold): void;
  deleteHold(id: string): void;
  dueHolds(now: number): Hold[];
  /** Drop lapsed holds that expired before `lapsedBefore` and per-IP day totals keyed below `ipKeysBelow`. */
  purge(lapsedBefore: number, ipKeysBelow: string): void;
  /** True the first time a flag is raised. */
  once(flag: string): boolean;
  atomic<T>(fn: () => T): T;
}

const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const isPool = (p: unknown): p is Pool => typeof p === "string" && (POOLS as readonly string[]).includes(p);
const isKey = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 128;
const isMicro = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= MAX_MICRO;

export class Governor {
  private lastPurge = -Infinity;

  constructor(
    private readonly store: LedgerStore,
    readonly caps: Caps,
    private readonly clock: { now: () => number; id: () => string } = { now: () => Date.now(), id: () => crypto.randomUUID() },
  ) {}

  reserve(r: ReserveInput): ReserveResult {
    if (!r || !isPool(r.pool) || !isKey(r.ip) || (r.session !== undefined && !isKey(r.session)) || !isMicro(r.estimateMicroUsd) || r.estimateMicroUsd === 0) {
      return { ok: false, reason: "bad_request" };
    }
    const now = this.clock.now();
    return this.store.atomic((): ReserveResult => {
      this.sweep(now);
      const limits = this.limits(r.pool, r.session, r.ip, now);
      for (const [key, cap, reason] of limits) {
        const t = this.store.total(key);
        if (t.spent + t.held + r.estimateMicroUsd > cap) return { ok: false, reason };
      }
      const id = this.clock.id();
      for (const [key] of limits) this.store.add(key, 0, r.estimateMicroUsd);
      this.store.putHold({ id, pool: r.pool, keys: limits.map((l) => l[0]), amount: r.estimateMicroUsd, expires: now + HOLD_MS, lapsed: false });
      return { ok: true, id, expiresAt: now + HOLD_MS };
    });
  }

  /** Settle a hold at its metered cost. A lapsed hold is still charged (the money was spent). */
  commit(id: string, actualMicroUsd: number): SettleResult {
    if (!isKey(id) || !isMicro(actualMicroUsd)) return { ok: false, reason: "bad_request" };
    return this.store.atomic((): SettleResult => {
      const h = this.store.getHold(id);
      if (!h) return { ok: false, reason: "unknown_hold" };
      for (const key of h.keys) this.store.add(key, actualMicroUsd, h.lapsed ? 0 : -h.amount);
      this.store.deleteHold(id);
      return { ok: true, chargedMicroUsd: actualMicroUsd, alerts: this.alerts(h.pool) };
    });
  }

  release(id: string): SettleResult {
    return this.commit(id, 0);
  }

  /** Post-hoc charge for work done without a hold (a judge build while the governor was unreachable). */
  record(r: RecordInput): SettleResult {
    if (!r || !isPool(r.pool) || !isKey(r.ip) || (r.session !== undefined && !isKey(r.session)) || !isMicro(r.actualMicroUsd)) {
      return { ok: false, reason: "bad_request" };
    }
    const now = this.clock.now();
    return this.store.atomic((): SettleResult => {
      for (const [key] of this.limits(r.pool, r.session, r.ip, now)) this.store.add(key, r.actualMicroUsd, 0);
      return { ok: true, chargedMicroUsd: r.actualMicroUsd, alerts: this.alerts(r.pool) };
    });
  }

  status(): Status {
    const now = this.clock.now();
    return this.store.atomic(() => {
      this.sweep(now);
      return { pools: POOLS.map((pool) => ({ pool, ...this.store.total(`p:${pool}`), cap: this.caps.pool[pool] })), caps: this.caps };
    });
  }

  private limits(pool: Pool, session: string | undefined, ip: string, now: number): [string, number, DenyReason][] {
    const out: [string, number, DenyReason][] = [];
    if (session !== undefined && Number.isFinite(this.caps.session[pool])) out.push([`s:${pool}:${session}`, this.caps.session[pool], "session_cap"]);
    if (Number.isFinite(this.caps.ipDay[pool])) out.push([`i:${day(now)}:${ip}`, this.caps.ipDay[pool], "ip_cap"]);
    out.push([`p:${pool}`, this.caps.pool[pool], "pool_cap"]);
    return out;
  }

  private sweep(now: number): void {
    for (const h of this.store.dueHolds(now)) {
      for (const key of h.keys) this.store.add(key, 0, -h.amount);
      this.store.putHold({ ...h, lapsed: true });
    }
    if (now - this.lastPurge >= PURGE_EVERY_MS) {
      this.store.purge(now - LATE_COMMIT_MS, `i:${day(now)}`);
      this.lastPurge = now;
    }
  }

  private alerts(pool: Pool): Alert[] {
    const cap = this.caps.pool[pool];
    if (!(cap > 0)) return [];
    const spent = this.store.total(`p:${pool}`).spent;
    // The cap is part of the flag so raising a cap re-arms its alerts.
    return ALERT_AT.filter((t) => spent >= t * cap && this.store.once(`alert:${pool}:${cap}:${t}`)).map((threshold) => ({ pool, threshold, spentMicroUsd: spent, capMicroUsd: cap }));
  }
}

export class MemoryLedger implements LedgerStore {
  private totals = new Map<string, { spent: number; held: number }>();
  private holds = new Map<string, Hold>();
  private flags = new Set<string>();

  total(key: string) {
    return this.totals.get(key) ?? { spent: 0, held: 0 };
  }
  add(key: string, spent: number, held: number) {
    const t = this.total(key);
    this.totals.set(key, { spent: t.spent + spent, held: Math.max(0, t.held + held) });
  }
  getHold(id: string) {
    return this.holds.get(id);
  }
  putHold(h: Hold) {
    this.holds.set(h.id, h);
  }
  deleteHold(id: string) {
    this.holds.delete(id);
  }
  dueHolds(now: number) {
    return [...this.holds.values()].filter((h) => !h.lapsed && h.expires <= now);
  }
  purge(lapsedBefore: number, ipKeysBelow: string) {
    for (const h of this.holds.values()) if (h.lapsed && h.expires < lapsedBefore) this.holds.delete(h.id);
    for (const k of this.totals.keys()) if (k.startsWith("i:") && k < ipKeysBelow) this.totals.delete(k);
  }
  once(flag: string) {
    if (this.flags.has(flag)) return false;
    this.flags.add(flag);
    return true;
  }
  atomic<T>(fn: () => T): T {
    // Values are replaced, never mutated, so shallow copies are a complete snapshot.
    const snap = [new Map(this.totals), new Map(this.holds), new Set(this.flags)] as const;
    try {
      return fn();
    } catch (e) {
      [this.totals, this.holds, this.flags] = snap;
      throw e;
    }
  }
}

export class SqlLedger implements LedgerStore {
  constructor(private readonly storage: DoStorage) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS totals (k TEXT PRIMARY KEY, spent INTEGER NOT NULL, held INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS holds (id TEXT PRIMARY KEY, pool TEXT NOT NULL, keys TEXT NOT NULL, amount INTEGER NOT NULL, expires INTEGER NOT NULL, lapsed INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS holds_due ON holds (lapsed, expires);
      CREATE TABLE IF NOT EXISTS flags (name TEXT PRIMARY KEY);`);
  }
  private rows(q: string, ...b: (string | number)[]) {
    return this.storage.sql.exec(q, ...b).toArray();
  }
  private hold(r: Record<string, unknown>): Hold {
    return { id: String(r.id), pool: r.pool as Pool, keys: JSON.parse(String(r.keys)) as string[], amount: Number(r.amount), expires: Number(r.expires), lapsed: Number(r.lapsed) === 1 };
  }
  total(key: string) {
    const r = this.rows("SELECT spent, held FROM totals WHERE k = ?", key)[0];
    return r ? { spent: Number(r.spent), held: Number(r.held) } : { spent: 0, held: 0 };
  }
  add(key: string, spent: number, held: number) {
    this.rows("INSERT INTO totals (k, spent, held) VALUES (?, ?, MAX(0, ?)) ON CONFLICT (k) DO UPDATE SET spent = spent + excluded.spent, held = MAX(0, held + ?)", key, spent, held, held);
  }
  getHold(id: string) {
    const r = this.rows("SELECT * FROM holds WHERE id = ?", id)[0];
    return r ? this.hold(r) : undefined;
  }
  putHold(h: Hold) {
    this.rows("INSERT OR REPLACE INTO holds (id, pool, keys, amount, expires, lapsed) VALUES (?, ?, ?, ?, ?, ?)", h.id, h.pool, JSON.stringify(h.keys), h.amount, h.expires, h.lapsed ? 1 : 0);
  }
  deleteHold(id: string) {
    this.rows("DELETE FROM holds WHERE id = ?", id);
  }
  dueHolds(now: number) {
    return this.rows("SELECT * FROM holds WHERE lapsed = 0 AND expires <= ?", now).map((r) => this.hold(r));
  }
  purge(lapsedBefore: number, ipKeysBelow: string) {
    this.rows("DELETE FROM holds WHERE lapsed = 1 AND expires < ?", lapsedBefore);
    this.rows("DELETE FROM totals WHERE k >= 'i:' AND k < ?", ipKeysBelow);
  }
  once(flag: string) {
    if (this.rows("SELECT 1 FROM flags WHERE name = ?", flag).length) return false;
    this.rows("INSERT INTO flags (name) VALUES (?)", flag);
    return true;
  }
  atomic<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

/** The DO's wire protocol: POST /reserve | /commit | /release | /record, GET /status. A fault is a 500. */
export async function serveGovernor(gov: Governor, req: Request, onAlerts?: (a: Alert[]) => void): Promise<Response> {
  const path = new URL(req.url).pathname;
  try {
    if (path === "/status" && req.method === "GET") return Response.json(gov.status());
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const b = ((await req.json()) ?? {}) as Record<string, unknown>;
    let out: ReserveResult | SettleResult;
    if (path === "/reserve") out = gov.reserve(b as unknown as ReserveInput);
    else if (path === "/commit") out = gov.commit(b.id as string, b.actualMicroUsd as number);
    else if (path === "/release") out = gov.release(b.id as string);
    else if (path === "/record") out = gov.record(b as unknown as RecordInput);
    else return new Response(null, { status: 404 });
    if ("alerts" in out && out.alerts.length) onAlerts?.(out.alerts);
    return Response.json(out);
  } catch {
    return Response.json({ ok: false, reason: "error" }, { status: 500 });
  }
}

/** ntfy push for pool alerts (skipped when NTFY_URL is unset). Never rejects. */
export function notifyAlerts(ntfyUrl: string | undefined, alerts: Alert[]): Promise<unknown> {
  if (!ntfyUrl) return Promise.resolve();
  const $ = (m: number) => `$${(m / USD).toFixed(2)}`;
  return Promise.all(
    alerts.map((a) =>
      ntfy(ntfyUrl, "GHOSTRUN spend alert", `${a.pool} pool at ${Math.round(a.threshold * 100)}%: ${$(a.spentMicroUsd)} of ${$(a.capMicroUsd)}`, a.threshold >= 0.8 ? "high" : "default"),
    ),
  );
}

export interface GovernorEnv extends CapsEnv {
  NTFY_URL?: string;
}

export class GovernorDO {
  private readonly gov: Governor;

  constructor(
    private readonly state: DoState,
    private readonly env: GovernorEnv,
  ) {
    this.gov = new Governor(new SqlLedger(state.storage), capsFromEnv(env));
  }

  fetch(req: Request): Promise<Response> {
    return serveGovernor(this.gov, req, (alerts) => {
      const p = notifyAlerts(this.env.NTFY_URL, alerts);
      this.state.waitUntil?.(p);
    });
  }
}

// ---- client (used by the Worker) ----

export type Unavailable = { ok: false; reason: "unavailable" };
export interface GovernorApi {
  reserve(r: ReserveInput): Promise<ReserveResult | Unavailable>;
  commit(id: string, actualMicroUsd: number): Promise<SettleResult | Unavailable>;
  release(id: string): Promise<SettleResult | Unavailable>;
  record(r: RecordInput): Promise<SettleResult | Unavailable>;
  status(): Promise<Status | Unavailable>;
}

type Call = (path: string, body?: unknown) => Promise<Response>;

/** Resolves undefined if `p` rejects or takes longer than `ms`. */
export function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((r) => (timer = setTimeout(r, ms, undefined)));
  return Promise.race([p.catch(() => undefined), late]).finally(() => clearTimeout(timer));
}

const UNAVAILABLE: Unavailable = { ok: false, reason: "unavailable" };

/**
 * Typed client. Never throws: a timeout, transport error, 5xx or malformed answer is "unavailable",
 * and the caller decides how to fail closed. Settlements get a longer deadline and one retry
 * (commit is idempotent: a replay finds no hold and charges nothing).
 */
export function governorClient(call: Call, reserveTimeoutMs = 300, settleTimeoutMs = 5000): GovernorApi {
  const ask = async <T extends { ok: boolean }>(path: string, body: unknown, ms: number, tries = 1): Promise<T | Unavailable> => {
    for (let i = 0; i < tries; i++) {
      const res = await within(call(path, body), ms);
      if (!res?.ok) continue;
      const j = (await within(res.json() as Promise<T>, ms)) ?? null;
      if (j && typeof j.ok === "boolean") return j;
    }
    return UNAVAILABLE;
  };
  return {
    reserve: async (r) => {
      const out = await ask<ReserveResult>("/reserve", r, reserveTimeoutMs);
      return out.ok && typeof out.id !== "string" ? UNAVAILABLE : out;
    },
    commit: (id, actualMicroUsd) => ask("/commit", { id, actualMicroUsd }, settleTimeoutMs, 2),
    release: (id) => ask("/release", { id }, settleTimeoutMs, 2),
    record: (r) => ask("/record", r, settleTimeoutMs, 2),
    status: async () => {
      const res = await within(call("/status"), settleTimeoutMs);
      return res?.ok ? ((await res.json()) as Status) : UNAVAILABLE;
    },
  };
}

const init = (body: unknown): RequestInit =>
  body === undefined ? { method: "GET" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };

/** Transport to the "global" DO instance. */
export function doCall(ns: DoNamespace): Call {
  const stub = ns.get(ns.idFromName("global"));
  return (path, body) => stub.fetch(`https://governor${path}`, init(body));
}

/** In-process transport (local dev and tests): same protocol, no DO. */
export function localCall(gov: Governor, onAlerts?: (a: Alert[]) => void): Call {
  return (path, body) => serveGovernor(gov, new Request(`https://governor${path}`, init(body)), onAlerts);
}
