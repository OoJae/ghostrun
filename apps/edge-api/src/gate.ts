// Who is calling. A judge token (?t= or x-judge-token), HMAC'd and compared in constant time with
// JUDGE_TOKEN_HASHES; otherwise a 30-minute signed cookie minted by POST /v1/session after a
// server-side Turnstile check. Without TURNSTILE_SECRET the gate is closed, unless DEV_OPEN=1 is
// set *and* the request is for localhost, so a deployed Worker cannot be misconfigured into open.
import type { Pool } from "./governor";

export interface GateEnv {
  TURNSTILE_SECRET?: string;
  /** Optional comma list; when set, siteverify's hostname must be one of these. */
  TURNSTILE_HOSTNAMES?: string;
  SESSION_SECRET?: string;
  JUDGE_TOKEN_KEY?: string;
  /** Comma/space list of `[pool:]hex(HMAC-SHA256(JUDGE_TOKEN_KEY, token))`, pool ∈ judge|dev|canary (default judge). */
  JUDGE_TOKEN_HASHES?: string;
  DEV_OPEN?: string;
}

export interface Caller {
  pool: Pool;
  session?: string;
  via: "token" | "cookie" | "dev";
}
export type Gate = { ok: true; caller: Caller } | { ok: false; status: number; body: Record<string, unknown> };

export const SESSION_COOKIE = "gr_sess";
export const SESSION_TTL_S = 30 * 60;
export const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

const enc = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();
function key(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keys.set(secret, k);
  }
  return k;
}

export async function hmac(secret: string, msg: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(msg)));
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** RFC 4648 base32, lowercase, unpadded. */
export function base32(b: Uint8Array): string {
  const A = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const x of b) {
    acc = ((acc << 8) | x) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += A[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(acc << (5 - bits)) & 31];
  return out;
}

export function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Constant time for equal lengths (lengths here are fixed, so they leak nothing). */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

function tokenHashes(raw: string): { pool: Pool; mac: Uint8Array }[] {
  const out: { pool: Pool; mac: Uint8Array }[] = [];
  for (const entry of raw.split(/[\s,]+/)) {
    const m = /^(?:(judge|dev|canary):)?([0-9a-f]{64})$/i.exec(entry);
    if (m) out.push({ pool: (m[1]?.toLowerCase() ?? "judge") as Pool, mac: fromHex(m[2]!.toLowerCase()) });
  }
  return out;
}

/** A valid token's caller. Every listed hash is compared, whether or not an earlier one matched. */
export async function judgeCaller(token: string | null, env: GateEnv): Promise<Caller | null> {
  if (!token || !TOKEN_RE.test(token) || !env.JUDGE_TOKEN_KEY || !env.JUDGE_TOKEN_HASHES) return null;
  const mac = await hmac(env.JUDGE_TOKEN_KEY, token);
  let pool: Pool | null = null;
  for (const e of tokenHashes(env.JUDGE_TOKEN_HASHES)) if (ctEqual(mac, e.mac) && pool === null) pool = e.pool;
  return pool ? { pool, session: toHex(mac).slice(0, 16), via: "token" } : null;
}

export async function mintSession(secret: string, now = Date.now()): Promise<{ sid: string; exp: number; cookie: string }> {
  const sid = base32(crypto.getRandomValues(new Uint8Array(10)));
  const exp = Math.floor(now / 1000) + SESSION_TTL_S;
  const body = `v1.${sid}.${exp}`;
  const value = `${body}.${b64url(await hmac(secret, body))}`;
  return { sid, exp, cookie: `${SESSION_COOKIE}=${value}; Path=/v1; Max-Age=${SESSION_TTL_S}; HttpOnly; Secure; SameSite=Strict` };
}

export async function sessionFrom(req: Request, secret: string, now = Date.now()): Promise<string | null> {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const m = /^v1\.([a-z2-7]{16})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(part.slice(eq + 1).trim());
    if (!m || Number(m[2]) * 1000 <= now) continue;
    const sig = fromB64url(m[3]!);
    if (sig && (await crypto.subtle.verify("HMAC", await key(secret), sig, enc.encode(`v1.${m[1]}.${m[2]}`)))) return m[1]!;
  }
  return null;
}

export type Verdict = { ok: true } | { ok: false; status: 400 | 403 | 503; codes: string[] };

/** Server-side Turnstile check (siteverify). Unreachable or internal-error → 503 (retry), a bad token → 403. */
export async function verifyTurnstile(token: unknown, secret: string, ip: string, hostnames?: string): Promise<Verdict> {
  if (typeof token !== "string" || !token || token.length > 2048) return { ok: false, status: 400, codes: ["missing-input-response"] };
  const form = new URLSearchParams({ secret, response: token });
  if (/^[0-9a-f.:]+$/i.test(ip)) form.set("remoteip", ip);
  type Answer = { success?: unknown; hostname?: string; "error-codes"?: string[] } | null;
  let j: Answer;
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body: form, signal: AbortSignal.timeout(5000) });
    j = (await res.json()) as Answer;
  } catch {
    j = null;
  }
  if (!j || typeof j.success !== "boolean") return { ok: false, status: 503, codes: ["siteverify-unavailable"] };
  if (!j.success) {
    const codes = Array.isArray(j["error-codes"]) ? j["error-codes"].map(String) : [];
    return { ok: false, status: codes.includes("internal-error") ? 503 : 403, codes };
  }
  const allowed = hostnames?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  if (allowed.length && !allowed.includes(j.hostname ?? "")) return { ok: false, status: 403, codes: ["hostname-mismatch"] };
  return { ok: true };
}

export const devOpen = (env: GateEnv, url: URL) => !env.TURNSTILE_SECRET && env.DEV_OPEN === "1" && LOCAL_HOSTS.has(url.hostname);

export function gateMode(env: GateEnv, url: URL): "turnstile" | "dev" | "closed" {
  if (env.TURNSTILE_SECRET) return env.SESSION_SECRET ? "turnstile" : "closed";
  return devOpen(env, url) ? "dev" : "closed";
}

export async function identify(req: Request, url: URL, env: GateEnv, now = Date.now()): Promise<Gate> {
  const judge = await judgeCaller(url.searchParams.get("t") ?? req.headers.get("x-judge-token"), env);
  if (judge) return { ok: true, caller: judge };
  if (env.TURNSTILE_SECRET) {
    if (!env.SESSION_SECRET) return { ok: false, status: 503, body: { error: "gate misconfigured", retryable: false } };
    const sid = await sessionFrom(req, env.SESSION_SECRET, now);
    if (sid) return { ok: true, caller: { pool: "public", session: sid, via: "cookie" } };
    return { ok: false, status: 401, body: { error: "session required", need: "turnstile", retryable: true } };
  }
  if (devOpen(env, url)) return { ok: true, caller: { pool: "dev", via: "dev" } };
  return { ok: false, status: 503, body: { error: "gate closed", retryable: false } };
}

export const ipOf = (req: Request) => req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";

/** The IP as the ledger and report store see it: keyed hash, never the address. */
export async function ipKey(env: GateEnv, ip: string): Promise<string> {
  return base32(await hmac(env.SESSION_SECRET || "ghostrun-dev-ip", `ip:${ip}`)).slice(0, 16);
}
