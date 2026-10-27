import { afterEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import type { InputFrame } from "@ghostrun/sim";
import { mintSession } from "../src/gate";
import { handle, type Env } from "../src/handler";
import { MAX_FRAMES, packFrames, ShareIn, shareRecord, unpackFrames } from "../src/share";
import { fakeFetch, memR2, TURNSTILE, waiter } from "./fakes";

const HEX = "4e9890fd2df60072f9db06a33e4030221249c1b3687b722b2388c21f09e97551";
const SPEC = "a".repeat(64);
const SECRET = "session-secret-for-tests-only-0123456789";

/** A minute of play: held keys with a few changes, then a jump. */
function run(ticks = 3600): InputFrame[] {
  const out: InputFrame[] = [];
  for (let t = 0; t < ticks; t++) out.push({ tick: t, wx: t < 1800 ? 127 : -64, wz: t % 600 < 300 ? 0 : 90, btn: t === 2000 ? 1 : 0 });
  return out;
}

const share = (over: Partial<ShareIn> = {}): ShareIn => ({ v: 1, engine: HEX, specHash: SPEC, seed: 11, fill: '{"op":"meta","v":1}\n', inputs: run(), ...over });

afterEach(() => vi.unstubAllGlobals());

describe("frame codec", () => {
  it("round-trips dense and sparse frames and run-length encodes held input", () => {
    const dense = run();
    const packed = packFrames(dense);
    expect(unpackFrames(packed)).toEqual(dense);
    expect(packed.length).toBeLessThan(200); // 3,600 frames → a handful of runs
    const sparse: InputFrame[] = [{ tick: 0, wx: -127, wz: 127, btn: 15 }, { tick: 5, wx: 0, wz: 0, btn: 0 }, { tick: 100_000, wx: 3, wz: -3, btn: 255 }];
    expect(unpackFrames(packFrames(sparse))).toEqual(sparse);
    expect(unpackFrames(packFrames([]))).toEqual([]);
    const noisy = Array.from({ length: MAX_FRAMES }, (_, t) => ({ tick: t, wx: (t * 37) % 255 - 127, wz: (t * 11) % 255 - 127, btn: t % 16 }));
    expect(unpackFrames(packFrames(noisy))).toEqual(noisy);
  });
});

describe("share validation", () => {
  const ok = (x: unknown) => v.safeParse(ShareIn, x).success;
  it("accepts a well-formed share at the caps and rejects anything past them", () => {
    expect(ok(share())).toBe(true);
    expect(ok(share({ fill: "x".repeat(64 * 1024) }))).toBe(true);
    expect(ok(share({ fill: "x".repeat(64 * 1024 + 1) }))).toBe(false);
    expect(ok(share({ fill: "é".repeat(32 * 1024 + 1) }))).toBe(false); // bytes, not chars
    expect(ok(share({ inputs: run(MAX_FRAMES) }))).toBe(true);
    expect(ok(share({ inputs: run(MAX_FRAMES + 1) }))).toBe(false);
    expect(ok(share({ inputs: [{ tick: 3, wx: 0, wz: 0, btn: 0 }, { tick: 3, wx: 1, wz: 0, btn: 0 }] }))).toBe(false);
    expect(ok(share({ inputs: [{ tick: 0, wx: 128, wz: 0, btn: 0 }] }))).toBe(false);
    expect(ok(share({ inputs: [{ tick: 0, wx: 0.5, wz: 0, btn: 0 }] }))).toBe(false);
    expect(ok({ ...share(), extra: 1 })).toBe(false);
    expect(ok({ ...share(), v: 2 })).toBe(false);
    expect(ok({ ...share(), specHash: "A".repeat(64) })).toBe(false);
  });

  it("ids are short content addresses", async () => {
    const a = await shareRecord(share());
    expect(a.id).toMatch(/^[a-z2-7]{16}$/);
    expect((await shareRecord(share())).id).toBe(a.id);
    expect((await shareRecord(share({ seed: 12 }))).id).not.toBe(a.id);
  });
});

describe("share routes", () => {
  async function setup() {
    const SHARES = memR2();
    const f = fakeFetch();
    vi.stubGlobal("fetch", f.fn);
    const env: Env = { CEREBRAS_API_KEY: "k", TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: SECRET, SHARES, NTFY_URL: "https://ntfy.test/ghostrun-reports" };
    const cookie = (await mintSession(SECRET)).cookie.split(";")[0]!;
    let n = 0;
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie }) => {
      const ctx = waiter();
      const ip = `198.51.100.${++n % 250}`;
      const res = handle(new Request(`https://g.example${path}`, { method, headers: { "cf-connecting-ip": ip, ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), env, ctx);
      return res.then(async (r) => (await ctx.settled(), r));
    };
    return { SHARES, f, env, call, cookie };
  }

  it("stores a share once, under its content address, and serves it back", async () => {
    const { SHARES, call } = await setup();
    const first = await call("POST", "/v1/share", share());
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };
    const again = await call("POST", "/v1/share", share());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, created: false });
    expect([...SHARES.objects.keys()]).toEqual([`shares/${id}.json`]);
    expect(SHARES.objects.get(`shares/${id}.json`)!.length).toBeLessThan(400); // 3,600 frames stored as runs
    const got = await call("GET", `/v1/share/${id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toContain("immutable");
    expect(await got.json()).toEqual({ id, ...share() });
    expect((await call("GET", "/v1/share/aaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await call("GET", "/v1/share/not-an-id")).status).toBe(404);
  });

  it("validates, caps the body size and sits behind the gate", async () => {
    const { call } = await setup();
    expect((await call("POST", "/v1/share", { ...share(), fill: 3 })).status).toBe(400);
    expect((await call("POST", "/v1/share", "{nope")).status).toBe(400);
    expect((await call("POST", "/v1/share", "x".repeat(2 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await call("POST", "/v1/share", share(), {})).status).toBe(401);
    expect((await call("GET", "/v1/share/aaaaaaaaaaaaaaaa", undefined, { cookie: "gr_sess=v1.forged" })).status).toBe(401);
  });

  it("stores reports under reports/ and pings ntfy", async () => {
    const { SHARES, f, call } = await setup();
    const res = await call("POST", "/v1/report", { shareId: "abcdefghijklmnop", reason: "offensive", text: "not cool" });
    expect(res.status).toBe(201);
    const [key] = [...SHARES.objects.keys()];
    expect(key).toMatch(/^reports\/\d{4}-\d\d-\d\d\/[a-z0-9]+-[0-9a-f]{8}\.json$/);
    expect(JSON.parse(SHARES.objects.get(key!)!)).toMatchObject({ shareId: "abcdefghijklmnop", reason: "offensive", text: "not cool", pool: "public", via: "cookie" });
    expect(SHARES.objects.get(key!)).not.toContain("198.51.100"); // the IP is stored hashed
    const pings = f.to("ntfy.test");
    expect(pings.length).toBe(1);
    expect(pings[0]!.headers.get("title")).toBe("GHOSTRUN report: offensive");
    expect(pings[0]!.body).toBe("share abcdefghijklmnop: not cool");
    expect((await call("POST", "/v1/report", { reason: "offensive", text: "no target" })).status).toBe(400);
    expect((await call("POST", "/v1/report", { specHash: SPEC, reason: "rude" })).status).toBe(400);
    expect((await call("POST", "/v1/report", { specHash: SPEC, reason: "broken", text: "x".repeat(501) })).status).toBe(400);
    expect((await call("POST", "/v1/report", { specHash: SPEC, reason: "broken" })).status).toBe(201);
  });

  it("stores 'This is wrong' captures under wrong/, inputs run-length encoded", async () => {
    const { SHARES, call } = await setup();
    const res = await call("POST", "/v1/wrong", { specHash: SPEC, chipId: "expect.x_roof", note: "I won without the double jump", inputs: run() });
    expect(res.status).toBe(201);
    const [key] = [...SHARES.objects.keys()];
    expect(key).toMatch(/^wrong\//);
    const stored = JSON.parse(SHARES.objects.get(key!)!) as { inputs: string; enc: string; chipId: string };
    expect(stored).toMatchObject({ enc: "rle1", chipId: "expect.x_roof" });
    expect(unpackFrames(stored.inputs)).toEqual(run());
    expect((await call("POST", "/v1/wrong", { specHash: SPEC })).status).toBe(201);
    expect((await call("POST", "/v1/wrong", { specHash: SPEC, note: "x".repeat(501) })).status).toBe(400);
    expect((await call("POST", "/v1/wrong", { chipId: "x" })).status).toBe(400);
  });

  it("rate limits per IP", async () => {
    const { env } = await setup();
    const cookie = (await mintSession(SECRET)).cookie.split(";")[0]!;
    const limited = { ...env, RATE_PER_WINDOW: "3" };
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await handle(new Request("https://g.example/v1/share/aaaaaaaaaaaaaaaa", { headers: { cookie, "cf-connecting-ip": "192.0.2.99" } }), limited);
      statuses.push(r.status);
    }
    expect(statuses).toEqual([404, 404, 404, 429, 429]);
  });

  it("is unavailable (not open) when no store is bound", async () => {
    const cookie = (await mintSession(SECRET)).cookie.split(";")[0]!;
    const res = await handle(new Request("https://g.example/v1/share/aaaaaaaaaaaaaaaa", { headers: { cookie, "cf-connecting-ip": "192.0.2.98" } }), { CEREBRAS_API_KEY: "k", TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: SECRET });
    expect(res.status).toBe(503);
  });
});
