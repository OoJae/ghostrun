import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base32, ctEqual, devOpen, identify, judgeCaller, mintSession, SESSION_COOKIE, sessionFrom, SITEVERIFY, verifyTurnstile } from "../src/gate";
import { fakeFetch, TURNSTILE } from "./fakes";

const KEY = "judge-key-for-tests-only";
const TOKEN = "judge_token_0123456789abcdef";
const mac = (t: string) => createHmac("sha256", KEY).update(t).digest("hex");
const SECRET = "session-secret-for-tests-only-0123456789";

afterEach(() => vi.unstubAllGlobals());

describe("judge tokens", () => {
  it("accept an HMAC listed in JUDGE_TOKEN_HASHES (openssl-compatible), with an optional pool label", async () => {
    const env = { JUDGE_TOKEN_KEY: KEY, JUDGE_TOKEN_HASHES: `deadbeef, ${"0".repeat(64)},\n${mac(TOKEN)} canary:${mac("canary_token_0123456789")}` };
    expect(await judgeCaller(TOKEN, env)).toEqual({ pool: "judge", session: mac(TOKEN).slice(0, 16), via: "token" });
    expect(await judgeCaller("canary_token_0123456789", env)).toMatchObject({ pool: "canary" });
    expect(await judgeCaller(TOKEN.replace("0", "1"), env)).toBeNull();
    expect(await judgeCaller("short", env)).toBeNull();
    expect(await judgeCaller(TOKEN, { JUDGE_TOKEN_HASHES: mac(TOKEN) })).toBeNull(); // no key, no tokens
  });

  it("are read from ?t= or x-judge-token", async () => {
    const env = { JUDGE_TOKEN_KEY: KEY, JUDGE_TOKEN_HASHES: mac(TOKEN), TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: SECRET };
    const viaQuery = await identify(new Request(`https://g.example/v1/build?t=${TOKEN}`), new URL(`https://g.example/v1/build?t=${TOKEN}`), env);
    const viaHeader = await identify(new Request("https://g.example/v1/build", { headers: { "x-judge-token": TOKEN } }), new URL("https://g.example/v1/build"), env);
    expect(viaQuery).toMatchObject({ ok: true, caller: { pool: "judge", via: "token" } });
    expect(viaHeader).toMatchObject({ ok: true, caller: { pool: "judge", via: "token" } });
  });

  it("constant-time compare is a correct equality", () => {
    expect(ctEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(ctEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(ctEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe("session cookie", () => {
  it("is HttpOnly, Secure, SameSite=Strict, 30 minutes, and verifies until it expires", async () => {
    const now = Date.UTC(2026, 10, 9, 12);
    const s = await mintSession(SECRET, now);
    expect(s.cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.[a-z2-7]{16}\\.\\d+\\.[\\w-]{43}; Path=/v1; Max-Age=1800; HttpOnly; Secure; SameSite=Strict$`));
    const value = s.cookie.split(";")[0]!;
    const req = (cookie: string) => new Request("https://g.example/v1/build", { headers: { cookie } });
    expect(await sessionFrom(req(`other=1; ${value}`), SECRET, now)).toBe(s.sid);
    expect(await sessionFrom(req(value), SECRET, now + 1799_000)).toBe(s.sid);
    expect(await sessionFrom(req(value), SECRET, now + 1800_000)).toBeNull();
    expect(await sessionFrom(req(value), "another-secret-entirely-0123456789", now)).toBeNull();
    const [name, body] = value.split("=") as [string, string];
    const parts = body.split(".");
    parts[2] = String(Number(parts[2]) + 3600); // extend the expiry without re-signing
    expect(await sessionFrom(req(`${name}=${parts.join(".")}`), SECRET, now)).toBeNull();
  });
});

describe("Turnstile siteverify (Cloudflare's documented test secrets)", () => {
  it("passes, fails and reports a spent token exactly as documented", async () => {
    const f = fakeFetch();
    vi.stubGlobal("fetch", f.fn);
    expect(await verifyTurnstile(TURNSTILE.dummyToken, TURNSTILE.secretPass, "203.0.113.7")).toEqual({ ok: true });
    const sent = new URLSearchParams(f.hits[0]!.body);
    expect(f.hits[0]!.url).toBe(SITEVERIFY);
    expect(Object.fromEntries(sent)).toEqual({ secret: TURNSTILE.secretPass, response: TURNSTILE.dummyToken, remoteip: "203.0.113.7" });
    expect(await verifyTurnstile(TURNSTILE.dummyToken, TURNSTILE.secretFail, "203.0.113.7")).toEqual({ ok: false, status: 403, codes: ["invalid-input-response"] });
    expect(await verifyTurnstile(TURNSTILE.dummyToken, TURNSTILE.secretSpent, "203.0.113.7")).toEqual({ ok: false, status: 403, codes: ["timeout-or-duplicate"] });
    expect(await verifyTurnstile("", TURNSTILE.secretPass, "203.0.113.7")).toMatchObject({ ok: false, status: 400 });
    expect(await verifyTurnstile("x".repeat(2049), TURNSTILE.secretPass, "203.0.113.7")).toMatchObject({ ok: false, status: 400 });
    expect(await verifyTurnstile(TURNSTILE.dummyToken, TURNSTILE.secretPass, "local")).toEqual({ ok: true });
    expect(new URLSearchParams(f.hits.at(-1)!.body).has("remoteip")).toBe(false);
    expect(await verifyTurnstile(TURNSTILE.dummyToken, TURNSTILE.secretPass, "1.2.3.4", "ghostrun.example")).toEqual({ ok: false, status: 403, codes: ["hostname-mismatch"] });
    expect(await verifyTurnstile(TURNSTILE.dummyToken, TURNSTILE.secretPass, "1.2.3.4", "ghostrun.example, localhost")).toEqual({ ok: true });
  });

  it("treats an unreachable siteverify as retryable (503), never as a pass", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("network down")));
    expect(await verifyTurnstile(TURNSTILE.dummyToken, TURNSTILE.secretPass, "1.2.3.4")).toEqual({ ok: false, status: 503, codes: ["siteverify-unavailable"] });
  });

  // Opt-in: the real endpoint with the real test secret (free, no account needed).
  it.skipIf(!process.env.LIVE)("live siteverify agrees with the documented test secrets", async () => {
    expect(await verifyTurnstile(TURNSTILE.dummyToken, TURNSTILE.secretPass, "203.0.113.7")).toEqual({ ok: true });
    expect(await verifyTurnstile(TURNSTILE.dummyToken, TURNSTILE.secretFail, "203.0.113.7")).toMatchObject({ ok: false, status: 403 });
    expect(await verifyTurnstile(TURNSTILE.dummyToken, TURNSTILE.secretSpent, "203.0.113.7")).toMatchObject({ ok: false, codes: ["timeout-or-duplicate"] });
  }, 20_000);
});

describe("the gate", () => {
  const req = (url: string, init?: RequestInit) => [new Request(url, init), new URL(url)] as const;

  it("is closed without TURNSTILE_SECRET unless DEV_OPEN=1 on localhost", async () => {
    expect(await identify(...req("https://g.example/v1/build"), {})).toMatchObject({ ok: false, status: 503 });
    expect(await identify(...req("https://g.example/v1/build"), { DEV_OPEN: "1" })).toMatchObject({ ok: false, status: 503 });
    expect(await identify(...req("http://localhost:8787/v1/build"), { DEV_OPEN: "true" })).toMatchObject({ ok: false, status: 503 });
    expect(await identify(...req("http://localhost:8787/v1/build"), { DEV_OPEN: "1" })).toEqual({ ok: true, caller: { pool: "dev", via: "dev" } });
    expect(devOpen({ DEV_OPEN: "1" }, new URL("http://127.0.0.1/"))).toBe(true);
    expect(devOpen({ DEV_OPEN: "1" }, new URL("http://[::1]:8787/"))).toBe(true);
    // A Turnstile secret always wins over DEV_OPEN.
    expect(await identify(...req("http://localhost/v1/build"), { DEV_OPEN: "1", TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: SECRET })).toMatchObject({ ok: false, status: 401 });
  });

  it("with Turnstile on, wants a valid cookie (and fails closed if the cookie secret is missing)", async () => {
    const env = { TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: SECRET };
    const s = await mintSession(SECRET);
    expect(await identify(...req("https://g.example/v1/build", { headers: { cookie: s.cookie.split(";")[0]! } }), env)).toEqual({ ok: true, caller: { pool: "public", session: s.sid, via: "cookie" } });
    expect(await identify(...req("https://g.example/v1/build"), env)).toMatchObject({ ok: false, status: 401, body: { need: "turnstile" } });
    expect(await identify(...req("https://g.example/v1/build"), { TURNSTILE_SECRET: TURNSTILE.secretPass })).toMatchObject({ ok: false, status: 503 });
  });

  it("base32 is RFC 4648 (lowercase, unpadded)", () => {
    expect(base32(new TextEncoder().encode("foobar"))).toBe("mzxw6ytboi");
    expect(base32(new Uint8Array(10).fill(255))).toBe("7".repeat(16));
  });
});
