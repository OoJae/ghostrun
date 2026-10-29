// Building from a photo or sketch: the picture is checked before anything is spent, read once by
// Claude Haiku into a scene brief (priced and held like any call), and kept nowhere.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIEF_MAX_CHARS, intentMessages, resetLaneHealth, visionMessages } from "@ghostrun/llm";
import { PACKS } from "@ghostrun/registry";
import { promptSeed } from "../src/cache";
import { buildEstimate, costMicroUsd, FILL_MODEL, INTENT_MODEL, visionEstimate } from "../src/cost";
import { capsFromEnv, Governor, localCall, MemoryLedger } from "../src/governor";
import { handle, type Env } from "../src/handler";
import { MAX_IMAGE_BYTES, readImage, sniff } from "../src/image";
import { BRIEF, fakeFetch, memR2, readSse, TURNSTILE, waiter, type Upstream } from "./fakes";

const JKEY = "judge-key-for-tests-only";
const TOKEN = "judge_token_0123456789abcdef";
const judge = { "x-judge-token": TOKEN };
const ENGINE = "a".repeat(64);
let ipN = 0;

// Just enough of each format's header for its size to be read (the fakes never decode pixels).
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const png = (w: number, h: number, pad = 16) => new Uint8Array([0x89, ...text("PNG\r\n\x1a\n"), 0, 0, 0, 13, ...text("IHDR"), ...be32(w), ...be32(h), 8, 2, 0, 0, 0, 0, 0, 0, 0, ...Array(pad).fill(0)]);
const jpeg = (w: number, h: number) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...text("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
const riff = (chunk: string, body: number[]) => new Uint8Array([...text("RIFF"), 0, 0, 0, 0, ...text("WEBP"), ...text(chunk), body.length, 0, 0, 0, ...body, 0, 0, 0, 0]);
const webpX = (w: number, h: number) => riff("VP8X", [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const webpLossy = (w: number, h: number) => riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, w & 255, w >> 8, h & 255, h >> 8]);
const webpLossless = (w: number, h: number) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff("VP8L", [0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
};
const dataUrl = (type: string, b: Uint8Array) => `data:${type};base64,${Buffer.from(b).toString("base64")}`;
const PICTURE = dataUrl("image/png", png(640, 480));
const B64 = PICTURE.slice(PICTURE.indexOf(",") + 1);

function world(opts: { up?: Upstream; env?: Partial<Env> } = {}) {
  const c = capsFromEnv({});
  const gov = new Governor(new MemoryLedger(), c);
  // the governor's wire, with what each call asked for
  const calls: { path: string; body: { estimateMicroUsd?: number } }[] = [];
  const call = localCall(gov);
  const ns = {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (u: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path: new URL(u).pathname, body });
        return call(new URL(u).pathname, body);
      },
    }),
  };
  const f = fakeFetch(opts.up);
  vi.stubGlobal("fetch", f.fn);
  const mac = createHmac("sha256", JKEY).update(TOKEN).digest("hex");
  const env: Env = { CEREBRAS_API_KEY: "k", ANTHROPIC_API_KEY: "ak", TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: "session-secret-for-tests-only-0123456789", JUDGE_TOKEN_KEY: JKEY, JUDGE_TOKEN_HASHES: mac, GOVERNOR: ns, GOVERNOR_TIMEOUT_MS: "50", ...opts.env };
  const pool = () => gov.status().pools.find((x) => x.pool === "judge")!;
  const build = async (body: unknown) => {
    const ctx = waiter();
    const res = await handle(new Request("https://g.example/v1/build", { method: "POST", headers: { "cf-connecting-ip": `198.51.100.${++ipN}`, ...judge }, body: typeof body === "string" ? body : JSON.stringify(body) }), env, ctx);
    return { res, ctx };
  };
  return { f, env, pool, build, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetLaneHealth();
});

describe("readImage", () => {
  it("reads the type and size from the file's own header: PNG, JPEG, and WebP in all three kinds", () => {
    expect(sniff(png(640, 480))).toEqual({ type: "image/png", width: 640, height: 480 });
    expect(sniff(jpeg(768, 512))).toEqual({ type: "image/jpeg", width: 768, height: 512 }); // past the JFIF segment to the frame header
    expect(sniff(webpX(768, 432))).toEqual({ type: "image/webp", width: 768, height: 432 });
    expect(sniff(webpLossy(300, 200))).toEqual({ type: "image/webp", width: 300, height: 200 });
    expect(sniff(webpLossless(513, 77))).toEqual({ type: "image/webp", width: 513, height: 77 });
    expect(readImage(dataUrl("image/jpeg", jpeg(768, 512)))).toMatchObject({ ok: true, image: { mediaType: "image/jpeg", width: 768, height: 512 } });
  });

  it("turns away anything else, before it is decoded further", () => {
    expect(readImage(42)).toMatchObject({ ok: false, status: 400 });
    expect(readImage("https://example.com/cat.png")).toMatchObject({ ok: false, status: 400 });
    expect(readImage("data:image/png;base64,abcde")).toMatchObject({ ok: false, status: 400 }); // not base64
    for (const type of ["image/gif", "image/svg+xml", "text/plain", "image/heic"]) expect(readImage(dataUrl(type, png(10, 10)))).toMatchObject({ ok: false, status: 415 });
    expect(readImage(dataUrl("image/jpeg", png(10, 10)))).toMatchObject({ ok: false, status: 415, error: expect.stringContaining("aren't the type it says") });
    expect(readImage(dataUrl("image/png", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")))).toMatchObject({ ok: false, status: 415 });
    expect(readImage(dataUrl("image/png", png(10, 10, MAX_IMAGE_BYTES)))).toMatchObject({ ok: false, status: 413 });
    expect(readImage(dataUrl("image/png", png(2048, 1536)))).toMatchObject({ ok: false, status: 413, error: expect.stringContaining("1024 px") });
    expect(readImage(dataUrl("image/png", png(0, 10)))).toMatchObject({ ok: false, status: 400 });
  });
});

describe("POST /v1/build with a picture", () => {
  it("Haiku reads it into a brief first, sent as `inspired`; the fast lane then writes the world from the brief", async () => {
    const w = world();
    const { res, ctx } = await w.build({ prompt: "a heist here", seed: 11, image: PICTURE });
    const events = await readSse(res);
    await ctx.settled();
    expect(events.map((e) => e.event)).toEqual(["inspired", "intent", "op", "op", "op", "done"]);
    const { safety: _, ...brief } = BRIEF;
    const prompt = "a heist here. Inspired by a picture of a rainy neon alley at night; mood tense; colours teal, magenta, wet black; with fire escape, dumpster, neon sign, puddle, crate; layout: a long corridor.";
    expect(events[0]!.data).toMatchObject({ brief, prompt, model: "claude-haiku-5-5" });
    // the picture goes to Claude once, as a base64 image block before the words, with the brief schema
    const seen = w.f.to("api.anthropic.com");
    expect(seen).toHaveLength(1);
    const sent = JSON.parse(seen[0]!.body) as { model: string; messages: { content: unknown }[]; output_config: { format: { type: string } } };
    expect(sent.model).toBe("claude-haiku-5-5");
    expect(sent.messages[0]!.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: B64 } },
      { type: "text", text: "Their prompt: a heist here" },
    ]);
    expect(sent.output_config.format.type).toBe("json_schema");
    // the fast lane never sees the picture, only the brief in the prompt: in the intent call and the fill
    const [intentCall, fillCall] = w.f.to("api.cerebras.ai");
    for (const h of [intentCall!, fillCall!]) {
      expect(h.body).toContain("Inspired by a picture of a rainy neon alley at night");
      expect(h.body).not.toContain(B64);
    }
    expect(JSON.parse(intentCall!.body).messages.at(-1)).toEqual({ role: "user", content: prompt });
    // nothing sent back carries the picture
    expect(JSON.stringify(events)).not.toContain(B64.slice(0, 40));
  });

  it("the look is priced by the picture's area, held with the build, and charged at Haiku's metered price", async () => {
    const w = world({ up: { vision: { inTok: 1450, outTok: 170 } } });
    const { res, ctx } = await w.build({ prompt: "a heist here", seed: 11, image: PICTURE });
    await readSse(res);
    await ctx.settled();
    expect(w.calls.map((c) => c.path)).toEqual(["/reserve", "/commit"]);
    const hold = visionEstimate(visionMessages("a heist here", { mediaType: "image/png", data: B64 }), 640, 480) + Object.values(buildEstimate(intentMessages("a heist here", PACKS), BRIEF_MAX_CHARS)).reduce((a, b) => a + b);
    expect(w.calls[0]!.body.estimateMicroUsd).toBe(hold);
    const spent = costMicroUsd("claude-haiku-5-5", 1450, 170) + costMicroUsd(INTENT_MODEL, 1000, 200) + costMicroUsd(FILL_MODEL, 3000, 1500);
    expect(w.pool()).toMatchObject({ spent, held: 0 });
    expect(spent).toBeLessThanOrEqual(hold);
  });

  it("with no words, the game the picture suggested leads the prompt, and the seed comes from that prompt", async () => {
    const w = world({ up: { vision: { inTok: 1300, outTok: 160, body: { ...BRIEF, genre: "heist", goal: "steal the neon sign and slip out" } } } });
    const { res } = await w.build({ image: PICTURE });
    const events = await readSse(res);
    const prompt = (events[0]!.data as { prompt: string }).prompt;
    expect(prompt.startsWith("Heist: steal the neon sign and slip out. Inspired by a picture of a rainy neon alley at night;")).toBe(true);
    expect(JSON.parse(w.f.to("api.anthropic.com")[0]!.body).messages[0].content[1]).toEqual({ type: "text", text: "They gave no prompt: suggest the genre and goal." });
    expect(events[1]).toMatchObject({ event: "intent", data: { seed: await promptSeed(prompt) } });
    expect(events.at(-1)!.event).toBe("done");
  });

  it("a picture too big, of the wrong type, or not a picture at all is turned away before any hold or model call", async () => {
    const w = world();
    const refused = [
      [dataUrl("image/png", png(10, 10, MAX_IMAGE_BYTES)), 413],
      [dataUrl("image/png", png(4000, 3000)), 413],
      [dataUrl("image/gif", png(10, 10)), 415],
      [dataUrl("image/webp", png(10, 10)), 415],
      ["https://example.com/cat.png", 400],
    ] as const;
    for (const [image, status] of refused) expect((await w.build({ prompt: "a heist here", image })).res.status, String(status)).toBe(status);
    // a body far past the cap is cut off as it streams in
    expect((await w.build(JSON.stringify({ prompt: "x", image: `data:image/png;base64,${"A".repeat(2_000_000)}` }))).res.status).toBe(413);
    // and with neither words nor a picture there is nothing to build
    expect((await w.build({ prompt: " " })).res.status).toBe(400);
    expect(w.calls).toEqual([]);
    expect(w.f.hits).toEqual([]);
  });

  it("never touches the exact-repeat cache: no lookup, no write, and nothing of the picture is stored", async () => {
    const r2 = memR2();
    const w = world({ env: { SHARES: r2 } });
    const text = await w.build({ prompt: "a heist here", seed: 11, engine: ENGINE });
    await readSse(text.res);
    await text.ctx.settled();
    const cached = [...r2.objects.keys()];
    expect(cached).toHaveLength(1); // the words alone are cached as before
    // the same words, seed and engine with a picture: not replayed from that entry, and nothing new kept
    const pic = await w.build({ prompt: "a heist here", seed: 11, engine: ENGINE, image: PICTURE });
    const events = await readSse(pic.res);
    await pic.ctx.settled();
    expect(events[0]!.event).toBe("inspired");
    expect(events.some((e) => e.event === "cached")).toBe(false);
    expect([...r2.objects.keys()]).toEqual(cached);
    expect([...r2.objects.values()].some((v) => v.includes(B64.slice(0, 40)) || v.includes("rainy neon alley"))).toBe(false);
  });

  it("an unsafe picture is refused politely and nothing is built; the look it took is still paid for", async () => {
    const w = world({ up: { vision: { inTok: 1300, outTok: 60, body: { ...BRIEF, safety: "block" } } } });
    const { res, ctx } = await w.build({ prompt: "a heist here", image: PICTURE });
    const events = await readSse(res);
    await ctx.settled();
    expect(events).toEqual([{ event: "refusal", data: { message: "That picture is outside what GHOSTRUN builds from. Try a photo or sketch of a place." } }]);
    expect(w.f.to("api.cerebras.ai")).toHaveLength(0);
    expect(w.pool()).toMatchObject({ spent: costMicroUsd("claude-haiku-5-5", 1300, 60), held: 0 });
  });

  it("Claude declining to look is the same polite refusal, charged at the look's estimate (no usage came back)", async () => {
    const w = world({ up: { vision: { inTok: 0, outTok: 0, refuse: true } } });
    const { res, ctx } = await w.build({ prompt: "a heist here", image: PICTURE });
    const events = await readSse(res);
    await ctx.settled();
    expect(events.map((e) => e.event)).toEqual(["refusal"]);
    expect(w.pool()).toMatchObject({ spent: visionEstimate(visionMessages("a heist here", { mediaType: "image/png", data: B64 }), 640, 480), held: 0 });
  });

  it("an HTTP error on the look is free and says so; without the Claude key a picture can't be read at all", async () => {
    const e = world({ up: { vision: { inTok: 0, outTok: 0, status: 400 } } });
    const r1 = await e.build({ prompt: "a heist here", image: PICTURE });
    expect((await readSse(r1.res)).at(-1)).toMatchObject({ event: "error", data: { retryable: false } });
    await r1.ctx.settled();
    expect(e.pool()).toMatchObject({ spent: 0, held: 0 });

    const keyless = world({ env: { ANTHROPIC_API_KEY: "" } });
    const r2 = await keyless.build({ prompt: "a heist here", image: PICTURE });
    expect(r2.res.status).toBe(503);
    expect(await r2.res.json()).toMatchObject({ error: "building from a picture needs the Claude lane" });
    expect(keyless.calls).toEqual([]);
    expect(keyless.f.hits).toEqual([]);
  });
});
