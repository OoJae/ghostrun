import { afterEach, describe, expect, it, vi } from "vitest";
import type { InputFrame } from "@ghostrun/sim";
import { BOARD_SIZE } from "../src/board";
import { mintSession } from "../src/gate";
import { handle, type Env } from "../src/handler";
import type { ShareIn } from "../src/share";
import { fakeFetch, memR2, TURNSTILE, waiter } from "./fakes";

const HEX = "4e9890fd2df60072f9db06a33e4030221249c1b3687b722b2388c21f09e97551";
const SPEC = "b".repeat(64);
const SECRET = "session-secret-for-tests-only-0123456789";

/** A winning run's inputs, kept up to the tick it won on (what the client stores for a best time). */
const won = (ticks: number, wx = 127): InputFrame[] => Array.from({ length: ticks }, (_, i) => ({ tick: i + 1, wx, wz: 0, btn: 0 }));
const share = (inputs: InputFrame[], spec = SPEC): ShareIn => ({ v: 1, engine: HEX, specHash: spec, seed: 7, fill: '{"op":"meta","v":1}\n', inputs });

afterEach(() => vi.unstubAllGlobals());

async function setup() {
  const SHARES = memR2();
  vi.stubGlobal("fetch", fakeFetch().fn);
  const env: Env = { CEREBRAS_API_KEY: "k", TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: SECRET, SHARES };
  const cookie = (await mintSession(SECRET)).cookie.split(";")[0]!;
  let n = 0;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { cookie }) => {
    const ctx = waiter();
    const res = handle(new Request(`https://g.example${path}`, { method, headers: { "cf-connecting-ip": `203.0.113.${++n % 250}`, ...headers }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), env, ctx);
    return res.then(async (r) => (await ctx.settled(), r));
  };
  const stored = async (inputs: InputFrame[], spec = SPEC) => ((await (await call("POST", "/v1/share", share(inputs, spec))).json()) as { id: string }).id;
  const board = async (spec = SPEC) => ((await (await call("GET", `/v1/board/${spec}`)).json()) as { entries: { shareId: string; ticks: number; name: string }[] }).entries;
  return { SHARES, env, call, stored, board };
}

describe("best-times board", () => {
  it("keeps entries backed by a stored run of this world that ends on the claimed tick, fastest first", async () => {
    const { call, stored, board, SHARES } = await setup();
    expect(await board()).toEqual([]);
    const slow = await stored(won(2600));
    const fast = await stored(won(2400, 100));
    const r1 = await call("POST", "/v1/board", { specHash: SPEC, shareId: slow, ticks: 2600, name: " Oo  Jae " });
    expect(r1.status).toBe(201);
    expect(((await r1.json()) as { entries: unknown[] }).entries).toEqual([{ shareId: slow, ticks: 2600, name: "Oo Jae" }]);
    expect((await call("POST", "/v1/board", { specHash: SPEC, shareId: fast, ticks: 2400 })).status).toBe(201);
    expect(await board()).toEqual([
      { shareId: fast, ticks: 2400, name: "" },
      { shareId: slow, ticks: 2600, name: "Oo Jae" },
    ]);
    // each entry is its own object (no read-modify-write to race), and the IP is stored hashed
    const keys = [...SHARES.objects.keys()].filter((k) => k.startsWith("boards/"));
    expect(keys).toEqual([`boards/${SPEC}/002600-${slow}`, `boards/${SPEC}/002400-${fast}`]);
    expect(SHARES.objects.get(keys[0]!)).not.toContain("203.0.113");
    // another world's board is its own
    expect(await board("c".repeat(64))).toEqual([]);
  });

  it("refuses a time the stored run can't back, a run of another world, a missing run and a bad name", async () => {
    const { call, stored, board } = await setup();
    const id = await stored(won(2400));
    expect((await call("POST", "/v1/board", { specHash: SPEC, shareId: id, ticks: 1200 })).status).toBe(400); // claims less than the run lasted
    expect((await call("POST", "/v1/board", { specHash: SPEC, shareId: id, ticks: 2401 })).status).toBe(400);
    const other = await stored(won(2400), "d".repeat(64));
    expect((await call("POST", "/v1/board", { specHash: SPEC, shareId: other, ticks: 2400 })).status).toBe(400);
    expect((await call("POST", "/v1/board", { specHash: SPEC, shareId: "aaaaaaaaaaaaaaaa", ticks: 2400 })).status).toBe(404);
    const rude = await call("POST", "/v1/board", { specHash: SPEC, shareId: id, ticks: 2400, name: "sh1t" });
    expect(rude.status).toBe(400);
    expect(await rude.json()).toEqual({ error: "name", why: "pick another name" });
    expect(((await (await call("POST", "/v1/board", { specHash: SPEC, shareId: id, ticks: 2400, name: "x!" })).json()) as { why: string }).why).toBe("3 to 12 characters");
    expect((await call("POST", "/v1/board", { specHash: SPEC, shareId: id, ticks: 0 })).status).toBe(400);
    expect((await call("POST", "/v1/board", { specHash: SPEC, shareId: id, ticks: 2400, extra: 1 })).status).toBe(400);
    expect((await call("POST", "/v1/board", "x".repeat(2000))).status).toBe(413);
    expect(await board()).toEqual([]);
  });

  it("first post keeps the name: posting the same run again can't rename it", async () => {
    const { call, stored, board } = await setup();
    const id = await stored(won(1800));
    expect((await call("POST", "/v1/board", { specHash: SPEC, shareId: id, ticks: 1800, name: "Ana" })).status).toBe(201);
    const again = await call("POST", "/v1/board", { specHash: SPEC, shareId: id, ticks: 1800, name: "Mallory" });
    expect(again.status).toBe(200);
    expect(await board()).toEqual([{ shareId: id, ticks: 1800, name: "Ana" }]);
  });

  it("shows the ten fastest", async () => {
    const { call, stored, board } = await setup();
    for (let i = 0; i < BOARD_SIZE + 3; i++) {
      const ticks = 3000 - i * 10;
      expect((await call("POST", "/v1/board", { specHash: SPEC, shareId: await stored(won(ticks)), ticks })).status).toBe(201);
    }
    const top = await board();
    expect(top).toHaveLength(BOARD_SIZE);
    expect(top.map((e) => e.ticks)).toEqual(Array.from({ length: BOARD_SIZE }, (_, i) => 2880 + i * 10));
  });

  it("sits behind the gate and the per-IP limit", async () => {
    const { env, call } = await setup();
    expect((await call("GET", `/v1/board/${SPEC}`, undefined, {})).status).toBe(401);
    expect((await call("POST", "/v1/board", { specHash: SPEC, shareId: "aaaaaaaaaaaaaaaa", ticks: 10 }, {})).status).toBe(401);
    expect((await call("GET", "/v1/board/not-a-spec")).status).toBe(404);
    const cookie = (await mintSession(SECRET)).cookie.split(";")[0]!;
    const limited = { ...env, RATE_PER_WINDOW: "2" };
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await handle(new Request(`https://g.example/v1/board/${SPEC}`, { headers: { cookie, "cf-connecting-ip": "192.0.2.77" } }), limited)).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
  });
});
