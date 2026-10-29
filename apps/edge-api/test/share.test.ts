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

describe("remix lineage", () => {
  const ok = (x: unknown) => v.safeParse(ShareIn, x).success;
  const SRC = "abcdefghijklmnop";
  // a gallery world, changed twice by Tester and shared (SRC), then changed once more on top of that share
  const line = (over: Record<string, unknown> = {}) =>
    share({
      prompt: "A museum heist",
      remixOf: SRC,
      origin: { id: "g:museum-heist", prompt: "A museum heist", spec: SPEC },
      lineage: [
        { id: "g:museum-heist", change: "make it night", name: "Tester" },
        { id: "g:museum-heist", change: "add three more coins", name: "Tester" },
        { id: SRC, change: "more guards" },
      ],
      changes: 3,
      ...over,
    } as Partial<ShareIn>);
  const step = (change: string, id = SRC) => ({ id, change });

  it("accepts a remix's line up to its caps: eight changes, 300 characters each", () => {
    expect(ok(line())).toBe(true);
    expect(ok(share({ prompt: "A plain shared world" }))).toBe(true); // any share may say its prompt
    const eight = Array.from({ length: 8 }, (_, i) => step(`change ${i}`));
    expect(ok(line({ lineage: eight, changes: 12 }))).toBe(true); // the newest 8 of 12
    expect(ok(line({ lineage: [step("x".repeat(300))], changes: 1, origin: { id: SRC, prompt: "", spec: SPEC } }))).toBe(true); // an old share had no prompt
    expect(ok(line({ prompt: "p".repeat(300) }))).toBe(true);
  });

  it("rejects a line past its caps or malformed", () => {
    expect(ok(line({ lineage: Array.from({ length: 9 }, (_, i) => step(`c${i}`)), changes: 9 }))).toBe(false);
    expect(ok(line({ lineage: [], changes: 1 }))).toBe(false);
    expect(ok(line({ lineage: [step("x".repeat(301))], changes: 1 }))).toBe(false);
    expect(ok(line({ prompt: "p".repeat(301) }))).toBe(false);
    expect(ok(line({ lineage: [step("   ")], changes: 1 }))).toBe(false); // blank
    expect(ok(line({ lineage: [step("make it\nnight")], changes: 1 }))).toBe(false); // one line
    expect(ok(line({ lineage: [step("ok", "G:Upper")], changes: 1, remixOf: "G:Upper" }))).toBe(false);
    expect(ok(line({ remixOf: "not-a-share-id" }))).toBe(false);
    expect(ok(line({ lineage: [{ ...step("ok"), name: "sh1t" }], changes: 1 }))).toBe(false); // the board's nickname rules
    expect(ok(line({ lineage: [{ ...step("ok"), name: " Tester " }], changes: 1 }))).toBe(false); // and as the board would store it
    expect(ok(line({ lineage: [{ ...step("ok"), spec: SPEC }], changes: 1 }))).toBe(false); // no extra fields
    expect(ok(line({ origin: { id: SRC, prompt: "x", spec: "nope" } }))).toBe(false);
    // the parts come together, and agree
    expect(ok(share({ remixOf: SRC }))).toBe(false);
    expect(ok(line({ origin: undefined }))).toBe(false);
    expect(ok(line({ changes: undefined }))).toBe(false);
    expect(ok(line({ remixOf: "bcdefghijklmnopq" }))).toBe(false); // the newest change wasn't made on it
    expect(ok(line({ changes: 2 }))).toBe(false); // fewer than it lists
    expect(ok(line({ lineage: [step("first"), step("second")], changes: 2 }))).toBe(false); // the whole line, but not from its origin
  });

  it("is stored with the share and served back, and changes the address; a share without one keeps its old id", async () => {
    const plain = await shareRecord(share());
    expect(plain.text).not.toMatch(/prompt|remixOf|lineage/);
    const remix = await shareRecord(line());
    expect(remix.id).not.toBe(plain.id);
    expect(JSON.parse(remix.text)).toMatchObject({ prompt: "A museum heist", remixOf: SRC, changes: 3 });
    const SHARES = memR2();
    vi.stubGlobal("fetch", fakeFetch().fn);
    const env: Env = { CEREBRAS_API_KEY: "k", TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: SECRET, SHARES };
    const cookie = (await mintSession(SECRET)).cookie.split(";")[0]!;
    const call = (method: string, path: string, body?: unknown) => handle(new Request(`https://g.example${path}`, { method, headers: { cookie, "cf-connecting-ip": "198.51.100.7" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, waiter());
    const posted = await call("POST", "/v1/share", line());
    expect(posted.status).toBe(201);
    const { id } = (await posted.json()) as { id: string };
    expect(id).toBe(remix.id);
    const got = (await (await call("GET", `/v1/share/${id}`)).json()) as Record<string, unknown>;
    expect(got).toMatchObject({ prompt: "A museum heist", remixOf: SRC, origin: { id: "g:museum-heist", prompt: "A museum heist", spec: SPEC }, changes: 3 });
    expect(got.lineage).toEqual(line().lineage);
    expect((await call("POST", "/v1/share", line({ changes: 1 }))).status).toBe(400);
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
    expect(await got.json()).toEqual({ id, ...share(), minds: [] });
    // NPC mind choices ride along (and change the content address)
    const minds = [{ tick: 120, npc: "rival_1", option: "rival.defend" }];
    const withMinds = await call("POST", "/v1/share", { ...share(), minds });
    const { id: id2 } = (await withMinds.json()) as { id: string };
    expect(id2).not.toBe(id);
    expect(((await (await call("GET", `/v1/share/${id2}`)).json()) as { minds: unknown }).minds).toEqual(minds);
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
