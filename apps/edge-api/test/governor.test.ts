import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoStorage, SqlValue } from "../src/cf";
import { capsFromEnv, Governor, governorClient, HOLD_MS, localCall, MemoryLedger, notifyAlerts, serveGovernor, SqlLedger, type Caps, type LedgerStore } from "../src/governor";
import { fakeFetch } from "./fakes";

const caps = (over: Partial<Record<keyof Caps, Partial<Caps[keyof Caps]>>> = {}): Caps => {
  const c = capsFromEnv({});
  return { session: { ...c.session, ...over.session }, ipDay: { ...c.ipDay, ...over.ipDay }, pool: { ...c.pool, ...over.pool } };
};

function clock(start = Date.UTC(2026, 10, 9, 12)) {
  let t = start;
  let n = 0;
  return { now: () => t, id: () => `h${++n}`, tick: (ms: number) => (t += ms) };
}

/** node:sqlite behind the DO storage shape, so SqlLedger's SQL runs for real in the unit suite. */
function sqliteStorage(): DoStorage {
  const db = new DatabaseSync(":memory:");
  return {
    sql: {
      exec(query: string, ...bindings: SqlValue[]) {
        if (!bindings.length && query.includes(";")) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const rows = db.prepare(query).all(...(bindings as (string | number | null)[]));
        return { toArray: () => rows as Record<string, SqlValue>[] };
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

const stores: [string, () => LedgerStore][] = [
  ["MemoryLedger", () => new MemoryLedger()],
  ["SqlLedger (sqlite)", () => new SqlLedger(sqliteStorage())],
];

afterEach(() => vi.unstubAllGlobals());

describe.each(stores)("governor over %s", (_, makeStore) => {
  it("enforces session, IP-day and pool caps against spent + held", () => {
    const c = clock();
    const g = new Governor(makeStore(), caps({ pool: { public: 1_000_000 } }), c);
    const r = (session: string, ip: string, est = 50_000) => g.reserve({ pool: "public", session, ip, estimateMicroUsd: est });
    // $0.15 public session cap: three 50k holds fit, the fourth does not.
    const s1 = [r("s1", "ip1"), r("s1", "ip1"), r("s1", "ip1")];
    expect(s1.every((x) => x.ok)).toBe(true);
    expect(r("s1", "ip1")).toEqual({ ok: false, reason: "session_cap" });
    for (const h of s1) if (h.ok) g.commit(h.id, 50_000);
    // $0.30 per IP per day across sessions.
    expect([r("s2", "ip1"), r("s2", "ip1"), r("s2", "ip1")].every((x) => x.ok)).toBe(true);
    expect(r("s3", "ip1")).toEqual({ ok: false, reason: "ip_cap" });
    // A new UTC day resets the IP cap, not the session cap.
    c.tick(24 * 3600_000);
    expect(r("s3", "ip1").ok).toBe(true);
    expect(r("s1", "ip9")).toEqual({ ok: false, reason: "session_cap" });
    // Pool cap ($1 here) is the backstop for everything.
    const big = new Governor(makeStore(), caps({ pool: { judge: 100_000 } }), clock());
    expect(big.reserve({ pool: "judge", session: "j", ip: "x", estimateMicroUsd: 100_000 }).ok).toBe(true);
    expect(big.reserve({ pool: "judge", session: "k", ip: "y", estimateMicroUsd: 1 })).toEqual({ ok: false, reason: "pool_cap" });
  });

  it("commit charges the metered cost and frees the hold; release frees it; replays charge nothing", () => {
    const g = new Governor(makeStore(), caps(), clock());
    const a = g.reserve({ pool: "judge", session: "j1", ip: "ip", estimateMicroUsd: 9000 });
    const b = g.reserve({ pool: "judge", session: "j1", ip: "ip", estimateMicroUsd: 9000 });
    if (!a.ok || !b.ok) throw new Error("reserve failed");
    expect(g.status().pools.find((p) => p.pool === "judge")).toMatchObject({ spent: 0, held: 18000 });
    expect(g.commit(a.id, 4321)).toMatchObject({ ok: true, chargedMicroUsd: 4321 });
    expect(g.release(b.id)).toMatchObject({ ok: true, chargedMicroUsd: 0 });
    expect(g.commit(a.id, 4321)).toEqual({ ok: false, reason: "unknown_hold" });
    expect(g.status().pools.find((p) => p.pool === "judge")).toMatchObject({ spent: 4321, held: 0 });
  });

  it("holds lapse after 60 s; a late commit is still charged", () => {
    const c = clock();
    const g = new Governor(makeStore(), caps(), c);
    const h = g.reserve({ pool: "public", session: "s", ip: "ip", estimateMicroUsd: 150_000 });
    if (!h.ok) throw new Error("reserve failed");
    expect(g.reserve({ pool: "public", session: "s", ip: "ip", estimateMicroUsd: 1 })).toEqual({ ok: false, reason: "session_cap" });
    c.tick(HOLD_MS);
    const pool = () => g.status().pools.find((p) => p.pool === "public")!;
    expect(pool()).toMatchObject({ held: 0, spent: 0 });
    expect(g.commit(h.id, 7000)).toMatchObject({ ok: true });
    expect(pool()).toMatchObject({ held: 0, spent: 7000 });
  });

  it("rejects malformed input and never takes a zero or absurd hold", () => {
    const g = new Governor(makeStore(), caps(), clock());
    for (const bad of [
      { pool: "vip", ip: "x", estimateMicroUsd: 10 },
      { pool: "public", ip: "", estimateMicroUsd: 10 },
      { pool: "public", ip: "x", estimateMicroUsd: 0 },
      { pool: "public", ip: "x", estimateMicroUsd: 1.5 },
      { pool: "public", ip: "x", estimateMicroUsd: 6_000_000 },
      { pool: "public", ip: "x", session: "y".repeat(200), estimateMicroUsd: 10 },
    ]) {
      expect(g.reserve(bad as never)).toEqual({ ok: false, reason: "bad_request" });
    }
    expect(g.commit("h1", -5)).toEqual({ ok: false, reason: "bad_request" });
  });

  it("100 parallel debits through the wire protocol never overspend", async () => {
    const g = new Governor(makeStore(), caps({ pool: { canary: 50_000 } }));
    const api = governorClient(localCall(g), 5000);
    const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 5));
    const results = await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        await jitter();
        return api.reserve({ pool: "canary", session: `c${i}`, ip: `ip${i % 7}`, estimateMicroUsd: 1000 });
      }),
    );
    const ok = results.filter((r) => r.ok);
    expect(ok.length).toBe(50);
    expect(results.filter((r) => !r.ok && r.reason === "pool_cap").length).toBe(50);
    await Promise.all(ok.map(async (r) => (await jitter(), api.commit((r as { id: string }).id, 1000))));
    expect(g.status().pools.find((p) => p.pool === "canary")).toMatchObject({ spent: 50_000, held: 0 });
    // Over-commit attempts on settled holds change nothing.
    await Promise.all(ok.map((r) => api.commit((r as { id: string }).id, 1000)));
    expect(g.status().pools.find((p) => p.pool === "canary")!.spent).toBe(50_000);
  });

  it("alerts once at 50% and once at 80% of a pool, re-armed when the cap changes", () => {
    const store = makeStore();
    const g = new Governor(store, caps({ pool: { dev: 100_000 } }), clock());
    const spend = (m: number) => g.record({ pool: "dev", ip: "x", actualMicroUsd: m });
    expect(spend(40_000)).toMatchObject({ alerts: [] });
    expect(spend(15_000)).toMatchObject({ alerts: [{ pool: "dev", threshold: 0.5, spentMicroUsd: 55_000, capMicroUsd: 100_000 }] });
    expect(spend(1)).toMatchObject({ alerts: [] });
    expect(spend(30_000)).toMatchObject({ alerts: [{ threshold: 0.8 }] });
    expect(spend(30_000)).toMatchObject({ alerts: [] });
    const raised = new Governor(store, caps({ pool: { dev: 200_000 } }), clock());
    expect(raised.record({ pool: "dev", ip: "x", actualMicroUsd: 1 })).toMatchObject({ alerts: [{ threshold: 0.5 }] });
  });
});

describe("governor failure modes", () => {
  it("a storage fault mid-reserve rolls back and the wire answers 500 (client: unavailable)", async () => {
    const store = new MemoryLedger();
    const g = new Governor(store, caps(), clock());
    const real = store.putHold.bind(store);
    store.putHold = () => {
      throw new Error("disk on fire");
    };
    expect(() => g.reserve({ pool: "judge", session: "j", ip: "x", estimateMicroUsd: 500 })).toThrow("disk on fire");
    expect(store.total("p:judge")).toEqual({ spent: 0, held: 0 });
    const res = await serveGovernor(g, new Request("https://governor/reserve", { method: "POST", body: JSON.stringify({ pool: "judge", ip: "x", estimateMicroUsd: 500 }) }));
    expect(res.status).toBe(500);
    expect(await governorClient(localCall(g)).reserve({ pool: "judge", ip: "x", estimateMicroUsd: 500 })).toEqual({ ok: false, reason: "unavailable" });
    store.putHold = real;
    expect((await governorClient(localCall(g)).reserve({ pool: "judge", ip: "x", estimateMicroUsd: 500 })).ok).toBe(true);
  });

  it("a governor that does not answer is unavailable within the deadline", async () => {
    const api = governorClient(() => new Promise<Response>(() => {}), 40);
    const t0 = performance.now();
    expect(await api.reserve({ pool: "public", ip: "x", estimateMicroUsd: 1 })).toEqual({ ok: false, reason: "unavailable" });
    expect(performance.now() - t0).toBeLessThan(400);
  });

  it("settlements retry once (commit is idempotent)", async () => {
    const g = new Governor(new MemoryLedger(), caps(), clock());
    const h = g.reserve({ pool: "judge", ip: "x", estimateMicroUsd: 100 });
    if (!h.ok) throw new Error("reserve failed");
    let n = 0;
    const flaky = localCall(g);
    const api = governorClient((path, body) => (++n === 1 ? Promise.resolve(new Response(null, { status: 503 })) : flaky(path, body)), 300, 300);
    expect(await api.commit(h.id, 77)).toMatchObject({ ok: true, chargedMicroUsd: 77 });
    expect(n).toBe(2);
  });

  it("caps come from env vars with the documented defaults", () => {
    expect(capsFromEnv({})).toMatchObject({
      session: { judge: 600_000, public: 150_000 },
      ipDay: { public: 300_000 },
      pool: { judge: 40_000_000, public: 25_000_000, dev: 5_000_000, canary: 2_000_000 },
    });
    const c = capsFromEnv({ CAP_SESSION_PUBLIC_USD: "0.05", CAP_POOL_JUDGE_USD: "$12.5", CAP_IP_DAY_USD: "nonsense" });
    expect(c.session.public).toBe(50_000);
    expect(c.pool.judge).toBe(12_500_000);
    expect(c.ipDay.public).toBe(300_000);
  });

  it("notifies ntfy when NTFY_URL is set, and skips it otherwise", async () => {
    const f = fakeFetch();
    vi.stubGlobal("fetch", f.fn);
    await notifyAlerts(undefined, [{ pool: "judge", threshold: 0.5, spentMicroUsd: 20_000_000, capMicroUsd: 40_000_000 }]);
    expect(f.hits.length).toBe(0);
    await notifyAlerts("https://ntfy.test/ghostrun-x", [{ pool: "judge", threshold: 0.8, spentMicroUsd: 32_000_000, capMicroUsd: 40_000_000 }]);
    expect(f.hits[0]!.body).toBe("judge pool at 80%: $32.00 of $40.00");
    expect(f.hits[0]!.headers.get("priority")).toBe("high");
  });
});
