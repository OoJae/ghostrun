// The cloud proof beside the device's (cloud.ts): whichever receipt is out first fills it, the two
// are compared once both are in, the same says so and a difference keeps this device's and is
// reported; no edge leaves the device proving alone. And the client's half of POST /v1/proof.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crossLine, type Chip, type Playtest, type Receipt } from "@ghostrun/proof/light";
import { PROOF_VERSION } from "@ghostrun/world";
import { dualProof, proveInCloud, type CloudHooks } from "../src/cloud";
import type { ProofState } from "../src/hud/Proof";
import { buildWorld, ENGINE_HASH, hashWorld } from "../src/pipeline";

const chip = (id: string, k = 12): Chip => ({ id, tier: "T3", subject: { kind: "property", id }, status: "played", method: "physics, 12 AI runners", n: 12, k, text: "AI runners won", cx: null, src: "", ms: 5 });
const receipt = (host: Receipt["host"], k = 12, ms = 100): Receipt => ({ v: 1, spec: "s".repeat(64), engine: ENGINE_HASH, host, headline: null, chips: [chip("T0:refs"), chip("T3:win", k)], par: { goldS: 31, runs: 12, won: k }, ms });
const PT: Playtest = { levels: [{ level: "expert", runs: 12, won: 12 }], band: "Normal", trails: [], steps: [], ms: 9 };
const tick = () => new Promise((r) => setTimeout(r, 5));

/** A proof run with a device and a cloud the test drives by hand. */
function run(cloud: boolean) {
  let state: ProofState = { status: "proving", chips: [], receipt: null };
  const landed: Receipt[] = [];
  const dev: { chip?: (c: Chip) => void; playtest?: (p: Playtest | null) => void; done?: (r: Receipt) => void; fail?: (e: Error) => void } = {};
  const cld: { on?: CloudHooks; end?: (ok: boolean) => void } = {};
  dualProof({
    device: (onChip, onPlaytest) => ((dev.chip = onChip), (dev.playtest = onPlaytest), new Promise<Receipt>((res, rej) => ((dev.done = res), (dev.fail = rej)))),
    cloud: cloud ? (on) => ((cld.on = on), new Promise<boolean>((res) => (cld.end = res))) : null,
    set: (f) => void (state = f(state)),
    landed: (r) => void landed.push(r),
    live: () => true,
    spec: "s".repeat(64),
  });
  return { dev, cld, landed, state: () => state, line: () => (state.cross ? crossLine(state.cross) : "") };
}

beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => undefined });
});
afterEach(() => vi.unstubAllGlobals());

describe("dualProof", () => {
  it("the cloud first: its receipt fills it, this device checks it, then the same result says so", async () => {
    const p = run(true);
    p.dev.chip!(chip("T0:refs"));
    p.cld.on!.receipt(receipt("edge"));
    p.dev.chip!(chip("T3:win")); // a device chip after the cloud's receipt adds nothing
    expect(p.state().receipt?.host).toBe("edge");
    expect(p.state().chips).toHaveLength(2);
    expect(p.line()).toBe("proved in the cloud · this device is checking it…");
    p.cld.on!.playtest(PT);
    p.cld.end!(true);
    expect(p.state().receipt?.playtest).toEqual(PT);
    p.dev.done!(receipt("device", 12, 9000));
    await tick();
    p.dev.playtest!({ ...PT, ms: 3000 });
    await tick();
    expect(p.state().cross?.cloud).toBe("same");
    expect(p.line()).toBe("proved in the cloud · same result on this device");
    expect(p.landed.map((r) => r.host)).toEqual(["edge"]);
  });

  it("a different result says so and keeps this device's, with both hashes logged and reported", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => (sent.push(`${url} ${String(init?.body ?? "")}`), Response.json({ ok: true }, { status: 201 })));
    const p = run(true);
    p.dev.done!(receipt("device"));
    await tick();
    expect(p.line()).toBe("proved on your device · the cloud is proving it too");
    p.dev.playtest!(PT);
    p.cld.on!.receipt(receipt("edge", 11));
    p.cld.on!.playtest(PT);
    await tick();
    expect(p.state().cross?.cloud).toBe("different");
    expect(p.state().receipt?.host).toBe("device");
    expect(p.state().receipt?.par?.won).toBe(12);
    const h = p.state().cross!.hashes!;
    expect(p.line()).toBe(`the cloud and this device got different results (cloud ${h.cloud.slice(0, 8)}, device ${h.device.slice(0, 8)}): showing this device's`);
    expect(warn.mock.calls[0]![0]).toContain(h.device);
    expect(sent.some((s) => s.startsWith("/v1/wrong") && s.includes(h.cloud) && s.includes("cloud-proof"))).toBe(true);
  });

  it("no edge: the device proves alone, as before", async () => {
    const p = run(false);
    p.dev.done!(receipt("device"));
    await tick();
    expect(p.line()).toBe("proved on your device");
    expect(p.landed).toHaveLength(1);
  });

  it("the cloud failing leaves the device's; the device failing while the cloud answers leaves the cloud's", async () => {
    const a = run(true);
    a.cld.end!(false);
    await tick();
    a.dev.done!(receipt("device"));
    await tick();
    expect(a.line()).toBe("proved on your device");
    const b = run(true);
    b.dev.fail!(new Error("worker crashed"));
    await tick();
    expect(b.state().status).toBe("proving");
    b.cld.on!.receipt(receipt("edge"));
    expect(b.line()).toBe("proved in the cloud · this device couldn't check it");
    const c = run(true);
    c.dev.fail!(new Error("worker crashed"));
    c.cld.end!(false);
    await tick();
    expect([c.state().status, c.state().error]).toEqual(["error", "worker crashed"]);
  });
});

describe("proveInCloud", () => {
  it("sends the world as the client has it and takes the receipt and playtest only for this very spec", async () => {
    const world = buildWorld("", "coin-rush");
    const spec = await hashWorld(world.bundle);
    const asked: unknown[] = [];
    const sse = (r: Receipt) => [`event: proving\ndata: {}\n\n`, `event: receipt\ndata: ${JSON.stringify({ receipt: r, version: PROOF_VERSION, cached: null })}\n\n`, `event: playtest\ndata: ${JSON.stringify({ playtest: PT })}\n\n`, `event: done\ndata: {}\n\n`].join("");
    let answer = { ...receipt("edge"), spec };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/v1/health") return Response.json({ ok: true, proof: true });
      asked.push(JSON.parse(String(init?.body)));
      return new Response(sse(answer), { headers: { "content-type": "text/event-stream" } });
    });
    const got: unknown[] = [];
    const on = { receipt: (r: Receipt) => void got.push(r.host), playtest: (p: Playtest | null) => void got.push(p?.band) };
    expect(await proveInCloud(world, on)).toBe(true);
    expect(got).toEqual(["edge", "Normal"]);
    expect(asked[0]).toEqual({ v: 1, fill: world.fill, seed: world.seed, pack: world.bundle.pack.id, mode: world.bundle.mode, engine: ENGINE_HASH, spec, version: PROOF_VERSION });
    answer = { ...answer, spec: "f".repeat(64) };
    expect(await proveInCloud(world, on)).toBe(false);
    expect(got).toHaveLength(2);
  });
});
