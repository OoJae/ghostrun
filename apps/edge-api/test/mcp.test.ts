// The MCP endpoint end to end against the handler, offline: JSON-RPC over POST /mcp in both eras
// (the 2026-07-28 per-request metadata and the initialize handshake), tokens, malformed messages,
// the governor's caps and each tool on the fake LLM, with shares kept in an in-memory R2.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLaneHealth } from "@ghostrun/llm";
import type { Receipt } from "@ghostrun/proof/static";
import { costMicroUsd, FILL_MODEL, INTENT_MODEL } from "../src/cost";
import { capsFromEnv, Governor, MemoryLedger, type Caps } from "../src/governor";
import { handle, PAUSE_FLAG } from "../src/handler";
import { mcp, SUPPORTED, type McpEnv } from "../src/mcp";
import { cloudProver, TOOLS, type Prover } from "../src/mcp-tools";
import { ENGINE_HASH, GALLERY, placeFill } from "../src/world";
import { fakeFetch, governorNs, memR2, TURNSTILE, waiter, type Upstream } from "./fakes";

const JKEY = "judge-key-for-tests-only";
const SECRET = "session-secret-for-tests-only-0123456789";
const mac = (t: string) => createHmac("sha256", JKEY).update(t).digest("hex");
let n = 0;
const freshIp = () => `198.51.100.${++n % 250}`;
const CTF = readFileSync(new URL("../../../packages/ir/fixtures/ctf-neon.jsonl", import.meta.url), "utf8").trim().split("\n");
const SHARE = /^[a-z2-7]{16}$/;
const MODERN = "2026-07-28";
const metered = costMicroUsd(INTENT_MODEL, 1000, 200) + costMicroUsd(FILL_MODEL, 3000, 1500);

type Rpc = { status: number; headers: Headers; body: any };

/** A Worker with its own judge token (so the per-token buckets start empty), the fake LLM and an in-memory R2. */
function world(opts: { caps?: Partial<Caps["pool"]>; up?: Upstream; env?: Partial<McpEnv>; prover?: Prover; noShares?: boolean } = {}) {
  const token = `judge_token_${++n}_0123456789abcdef`;
  const c = capsFromEnv(opts.env ?? {});
  const gov = new Governor(new MemoryLedger(), { ...c, pool: { ...c.pool, ...opts.caps } });
  const r2 = memR2();
  let f = fakeFetch(opts.up);
  vi.stubGlobal("fetch", f.fn);
  const env: McpEnv = { CEREBRAS_API_KEY: "k", TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: SECRET, JUDGE_TOKEN_KEY: JKEY, JUDGE_TOKEN_HASHES: mac(token), GOVERNOR: governorNs(gov), GOVERNOR_TIMEOUT_MS: "50", ...(opts.noShares ? {} : { SHARES: r2 }), ...opts.env };
  const ctx = waiter();
  const post = async (body: unknown, headers: Record<string, string> = {}, path = "/mcp"): Promise<Rpc> => {
    const req = new Request(`https://g.example${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": freshIp(), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const res = opts.prover ? await mcp(req, env, { route: (r) => handle(r, env, ctx), prover: opts.prover }) : await handle(req, env, ctx);
    const text = await res.text();
    await ctx.settled();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  /** A 2026-07-28 request: the version and capabilities in _meta, mirrored into the headers. */
  const modern = (method: string, params: Record<string, unknown> = {}, id: string | number = 1, headers: Record<string, string> = {}) =>
    post(
      { jsonrpc: "2.0", id, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": MODERN, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" } } } },
      { "mcp-protocol-version": MODERN, "mcp-method": method, ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}), ...headers },
    );
  /** A handshake-era request (after initialize), at 2025-11-25 unless told otherwise. */
  const legacy = (method: string, params?: Record<string, unknown>, version = "2025-11-25", id: string | number = 1) => post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, { "mcp-protocol-version": version });
  const tool = async (name: string, args: Record<string, unknown>) => (await modern("tools/call", { name, arguments: args })).body.result as { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean; resultType: string };
  const pool = (p: string) => gov.status().pools.find((x) => x.pool === p)!;
  const upstream = (up: Upstream) => {
    f = fakeFetch(up);
    vi.stubGlobal("fetch", f.fn);
  };
  return { token, env, r2, post, modern, legacy, tool, pool, upstream, hits: () => f.hits, gov };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetLaneHealth();
});

/** Enough of JSON Schema 2020-12 to hold a result to its tool's outputSchema. */
function conforms(schema: any, x: unknown, at = "$"): string[] {
  if (schema.anyOf) return schema.anyOf.some((s: unknown) => conforms(s, x, at).length === 0) ? [] : [`${at}: matches none of anyOf`];
  const type = schema.type as string | undefined;
  const is = (t: string) => (t === "integer" ? Number.isInteger(x) : t === "number" ? typeof x === "number" : t === "array" ? Array.isArray(x) : t === "null" ? x === null : t === "object" ? typeof x === "object" && x !== null && !Array.isArray(x) : typeof x === t);
  if (type && !is(type)) return [`${at}: not ${type}`];
  if (schema.enum && !schema.enum.includes(x)) return [`${at}: ${String(x)} not in enum`];
  const out: string[] = [];
  if (type === "object") {
    const o = x as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) out.push(`${at}.${k}: missing`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in o) out.push(...conforms(s, o[k], `${at}.${k}`));
  }
  if (type === "array") (x as unknown[]).forEach((y, i) => out.push(...conforms(schema.items ?? {}, y, `${at}[${i}]`)));
  return out;
}
const outputOf = (name: string) => TOOLS.find((t) => t.name === name)!.outputSchema;

describe("MCP lifecycle and discovery", () => {
  it("initialize negotiates a handshake revision, without minting a session", async () => {
    const w = world();
    const r = await w.post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "ghostrun", version: "1.0.0" } } });
    expect(r.body.result.instructions).toContain("build_world");
    expect(r.headers.get("mcp-session-id")).toBeNull();
    // a revision we don't serve gets our newest handshake one, as the lifecycle says
    expect((await w.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).body.result.protocolVersion).toBe("2025-11-25");
    // the initialized notification (and any other) is accepted with no body
    const note = await w.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect([note.status, note.body]).toEqual([202, null]);
    expect((await w.legacy("ping")).body).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("server/discover answers a 2026-07-28 request with every revision served, the capabilities and who it is", async () => {
    const w = world();
    const r = await w.modern("server/discover", {}, "d-1");
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ resultType: "complete", supportedVersions: SUPPORTED, capabilities: { tools: { listChanged: false } }, cacheScope: "public", _meta: { "io.modelcontextprotocol/serverInfo": { name: "ghostrun" } } });
    expect(SUPPORTED[0]).toBe(MODERN);
    expect(r.body.result.ttlMs).toBeGreaterThan(0);
  });

  it("tools/list: five tools in a fixed order, each with its schemas; a 2025-03-26 client gets the shape it knows", async () => {
    const w = world();
    const r = await w.modern("tools/list");
    const tools = r.body.result.tools as { name: string; title: string; description: string; inputSchema: any; outputSchema: any; annotations: any }[];
    expect(tools.map((t) => t.name)).toEqual(["build_world", "edit_world", "explain_world", "get_receipt", "list_gallery"]);
    expect(r.body.result).toMatchObject({ resultType: "complete", cacheScope: "public" });
    for (const t of tools) {
      expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(t.outputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(80);
      expect(t.title).toBeTruthy();
    }
    expect(tools[0]!.inputSchema.required).toEqual(["prompt"]);
    expect(tools.find((t) => t.name === "explain_world")!.annotations).toMatchObject({ readOnlyHint: true });
    expect((await w.modern("tools/list")).body.result.tools).toEqual(tools); // deterministic, for the clients' caches
    const old = (await w.legacy("tools/list", undefined, "2025-03-26")).body.result.tools;
    expect(old.map((t: { name: string }) => t.name)).toEqual(tools.map((t) => t.name));
    expect(old[0].outputSchema).toBeUndefined();
    expect((await w.legacy("tools/list")).body.result.tools[0].outputSchema).toBeDefined();
    // no header at all is the oldest handshake revision, as the transport says to assume
    expect((await w.post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).body.result.tools[0].outputSchema).toBeUndefined();
  });
});

describe("MCP auth and limits", () => {
  it("no token is 401 with a clear message and a Bearer challenge; a wrong one says it's wrong; ?t= works for clients without headers", async () => {
    const w = world();
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
    const none = await w.post(init, { authorization: "" });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe('Bearer realm="ghostrun"');
    expect(none.body.error.message).toMatch(/needs a judge or dev token.*Authorization: Bearer <token>/);
    const wrong = await w.post(init, { authorization: "Bearer not_a_real_token_0000000" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await w.post(init, { authorization: "" }, `/mcp?t=${w.token}`)).status).toBe(200);
    // a session cookie (the web app's) is not a way in: agents use tokens
    expect((await w.post(init, { authorization: "", cookie: "gr_sess=whatever" })).status).toBe(401);
  });

  it("each token has its own request bucket", async () => {
    const w = world({ env: { MCP_PER_WINDOW: "2" } });
    expect((await w.modern("tools/list")).status).toBe(200);
    expect((await w.modern("tools/list")).status).toBe(200);
    const third = await w.modern("tools/list");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("600");
    expect(third.body.error).toMatchObject({ code: -31429 });
    expect((await world({ env: { MCP_PER_WINDOW: "2" } }).modern("tools/list")).status).toBe(200); // another token is unaffected
  });

  it("a page on another origin is refused; an origin on the allow list gets CORS", async () => {
    const w = world({ env: { MCP_ORIGINS: "https://inspector.example" } });
    const evil = await w.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const ok = await w.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://inspector.example" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://inspector.example");
    expect((await w.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://g.example" })).status).toBe(200);
  });
});

describe("MCP malformed requests", () => {
  it("answers each with the JSON-RPC error the spec names, and the right status", async () => {
    const w = world();
    const cases: [string, Promise<Rpc>, number, number][] = [
      ["not JSON", w.post("{nope"), 400, -32700],
      ["a batch", w.post([{ jsonrpc: "2.0", id: 1, method: "ping" }]), 400, -32600],
      ["no jsonrpc", w.post({ id: 1, method: "ping" }), 400, -32600],
      ["a null id", w.post({ jsonrpc: "2.0", id: null, method: "ping" }), 400, -32600],
      ["params not an object", w.post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: [1] }), 400, -32602],
      ["an unknown method (handshake era)", w.legacy("resources/list"), 200, -32601],
      ["an unknown method (2026-07-28)", w.modern("resources/list"), 404, -32601],
      ["no MCP-Protocol-Version header", w.modern("tools/list", {}, 1, { "mcp-protocol-version": "" }), 400, -32020],
      ["no Mcp-Method header", w.modern("tools/list", {}, 1, { "mcp-method": "" }), 400, -32020],
      ["a header that disagrees with the body", w.modern("tools/list", {}, 1, { "mcp-method": "tools/call" }), 400, -32020],
      ["a Mcp-Name that disagrees", w.modern("tools/call", { name: "list_gallery", arguments: {} }, 1, { "mcp-name": "build_world" }), 400, -32020],
      ["an unknown tool", w.modern("tools/call", { name: "launch_rockets", arguments: {} }), 200, -32602],
      ["arguments not an object", w.modern("tools/call", { name: "list_gallery", arguments: "x" }), 200, -32602],
      ["an unsupported handshake header", w.legacy("tools/list", undefined, "1999-01-01"), 400, -32022],
    ];
    for (const [what, p, status, code] of cases) {
      const r = await p;
      expect([what, r.status, r.body?.error?.code]).toEqual([what, status, code]);
    }
  });

  it("a 2026-07-28 request missing its required _meta, or at a version nobody serves, is a 400 with what to do", async () => {
    const w = world();
    const noCaps = await w.post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } } }, { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" });
    expect([noCaps.status, noCaps.body.error.code]).toEqual([400, -32602]);
    const future = await w.post({ jsonrpc: "2.0", id: 7, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01", "io.modelcontextprotocol/clientCapabilities": {} } } }, { "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" });
    expect(future.status).toBe(400);
    expect(future.body).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32022, message: "Unsupported protocol version", data: { supported: SUPPORTED, requested: "2099-01-01" } } });
  });

  it("a Mcp-Name in the base64 sentinel is decoded before it is compared; GET and DELETE are 405", async () => {
    const w = world();
    const r = await w.modern("tools/call", { name: "list_gallery", arguments: {} }, 1, { "mcp-name": `=?base64?${btoa("list_gallery")}?=` });
    expect(r.status).toBe(200);
    for (const method of ["GET", "DELETE"]) {
      const res = await handle(new Request("https://g.example/mcp", { method, headers: { authorization: `Bearer ${w.token}` } }), w.env, waiter());
      expect([res.status, res.headers.get("allow")]).toEqual([405, "POST, OPTIONS"]);
    }
  });

  it("bad arguments are a tool error the model can read and correct, not a protocol error", async () => {
    const w = world();
    const r = await w.tool("build_world", { prompt: "", seed: 1.5 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Invalid arguments for build_world: prompt: prompt is empty; seed: seed must be an integer/);
    expect(w.hits()).toHaveLength(0); // nothing reached a model
    expect((await w.tool("explain_world", { world: "x", extra: 1 })).content[0]!.text).toMatch(/Invalid arguments/);
  });
});

describe("build_world", () => {
  it("builds on the fake LLM end to end: the intent, the rules in sentences, a share that rebuilds to its spec, and the static proof", async () => {
    const w = world({ up: { fill: { inTok: 3000, outTok: 1500, lines: CTF } } });
    const r = await w.tool("build_world", { prompt: "Capture the flag in a neon city. Add double jump. Score when the orb reaches the goal.", seed: 7 });
    expect(r.isError).toBeUndefined();
    expect(r.resultType).toBe("complete");
    const s = r.structuredContent;
    expect(conforms(outputOf("build_world"), s)).toEqual([]);
    expect(s.world).toMatch(SHARE);
    expect(s.link).toBe(`https://g.example/?s=${s.world}`);
    expect(s.intent).toMatchObject({ genre: "ctf", setting: "neon city", pack: "city_block", mode: "play", headline: "Rooftop lane needs double jump" });
    expect(s.rules).toContain("· WHEN glowing orb enters neon goal ring IF glowing orb carrier team = red THEN +1 red team, reset glowing orb");
    // the rules that win or lose come last, as the X-ray orders them; the shards are said once, as secrets
    expect(s.rules.slice(-2)).toEqual(["· WHEN red team reaches 3 THEN you win (once)", "· WHEN blue team reaches 3 THEN you lose (once)"]);
    expect(s.secrets).toMatch(/^★ 5 secret neon shards/);
    expect(s.expects).toContainEqual({ text: "Rooftop lane needs double jump", headline: true, prop: "requires", status: "verified" });
    // the proof run here is T0 and T1 only, and says what's left for the AI runners
    expect(s.proof.source).toBe("edge");
    expect(new Set(s.proof.chips.map((c: { tier: string }) => c.tier))).toEqual(new Set(["T0", "T1"]));
    expect(s.proof.pending).toMatch(/AI runners prove it when you open the link/);
    expect(s.proof.lines[0]).toMatch(/^Receipt for spec [0-9a-f]{8} · static checks at the edge/);
    expect(s.proof.lines.some((l: string) => l.startsWith("✓ [T0]"))).toBe(true);
    // the share is the world exactly: rebuilt from its record, it hashes to the spec the tool gave
    const stored = JSON.parse(w.r2.objects.get(`shares/${s.world}.json`)!) as { fill: string; seed: number; specHash: string; prompt: string; inputs: string };
    expect(stored).toMatchObject({ specHash: s.spec, seed: 7, prompt: "Capture the flag in a neon city. Add double jump. Score when the orb reaches the goal." });
    expect((await placeFill(stored.fill, stored.seed, { pack: "city_block" })).spec).toBe(s.spec);
    // the text says the same, for a client that only reads text
    const text = r.content[0]!.text;
    expect(text).toContain(`Play it: https://g.example/?s=${s.world}`);
    expect(text).toContain("Rules (WHEN / IF / THEN");
    expect(text).toContain("Headline: Rooftop lane needs double jump");
    // spent through the build route: one hold, committed at the metered cost on the token's pool
    expect(w.pool("judge")).toMatchObject({ spent: metered, held: 0 });
  });

  it("an exact repeat replays from the build cache, for free, and says so", async () => {
    const w = world({ up: { fill: { inTok: 3000, outTok: 1500, lines: CTF } } });
    const first = await w.tool("build_world", { prompt: "capture the flag on neon rooftops", seed: 7 });
    const calls = w.hits().length;
    const again = await w.tool("build_world", { prompt: "capture the flag on neon rooftops", seed: 7 });
    expect(again.structuredContent.world).toBe(first.structuredContent.world); // content-addressed: the same world is the same link
    expect(again.structuredContent.cached).toMatchObject({ intentModel: INTENT_MODEL });
    expect(again.content[0]!.text).toContain("Replayed from the build cache");
    expect(w.hits().length).toBe(calls);
    expect(w.pool("judge").spent).toBe(metered);
  });

  it("the governor's caps stop it before any model call, and the model is told why", async () => {
    const capped = world({ caps: { judge: 10 } });
    const r = await capped.tool("build_world", { prompt: "a maze with a key" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("The build was turned away: the pool's budget is used up (governor: pool_cap).");
    expect(capped.hits()).toHaveLength(0);
    const session = world({ env: { CAP_SESSION_JUDGE_USD: "0.000001" } });
    expect((await session.tool("build_world", { prompt: "a maze with a key" })).content[0]!.text).toContain("this token's spending cap is used up (governor: session_cap)");
    const paused = world({ env: { FLAGS: { get: async (k: string) => (k === PAUSE_FLAG ? "1" : null) } } });
    expect((await paused.tool("build_world", { prompt: "a maze with a key" })).content[0]!.text).toBe("The build was turned away: builds paused (try again shortly).");
  });

  it("a token's builds are counted on top of the budget; a refusal and a failed lane come back as tool errors", async () => {
    const w = world({ env: { MCP_BUILDS_PER_WINDOW: "1" }, up: { fill: { inTok: 3000, outTok: 1500, lines: CTF } } });
    expect((await w.tool("build_world", { prompt: "a neon chase" })).isError).toBeUndefined();
    expect((await w.tool("build_world", { prompt: "another neon chase" })).content[0]!.text).toMatch(/its share of builds and edits/);
    const blocked = world({ up: { intent: { inTok: 900, outTok: 50, body: { ...JSON.parse(JSON.stringify({ lang: "en", mode: "play", genre: "x", setting: "x", role: "x", goal: "x", fail: "x", mood: "x", pack: "arena", sub: [], headline: "x", nouns: [], moodVec: { valence: 0, arousal: 0, tension: 0 } })), safety: "block" } } } });
    expect((await blocked.tool("build_world", { prompt: "something we don't build" })).content[0]!.text).toMatch(/outside what GHOSTRUN builds/);
    const down = world({ up: { fill: { inTok: 0, outTok: 0, status: 500 } } });
    expect((await down.tool("build_world", { prompt: "a maze" })).content[0]!.text).toMatch(/^The live AI couldn't build that just now/);
  });

  it("with no share store it still builds and proves, and says there's no link", async () => {
    const w = world({ noShares: true, up: { fill: { inTok: 3000, outTok: 1500, lines: CTF } } });
    const r = await w.tool("build_world", { prompt: "capture the flag", seed: 3 });
    expect(r.structuredContent).toMatchObject({ world: null, link: null, proof: { source: "edge" } });
    expect(r.structuredContent.notes.join(" ")).toContain("share store not configured");
    expect(conforms(outputOf("build_world"), r.structuredContent)).toEqual([]);
  });
});

describe("edit_world, explain_world, get_receipt, list_gallery", () => {
  const slug = GALLERY.find((g) => g.pack === "arena" && g.mode === "play")!.slug;

  it("edit_world patches a world by its ids, re-checks it, and shares it as a remix with its line", async () => {
    const w = world({ up: { fill: { inTok: 3000, outTok: 1500, lines: CTF } } });
    const built = (await w.tool("build_world", { prompt: "capture the flag in a neon city", seed: 7 })).structuredContent;
    w.upstream({ fill: { inTok: 4000, outTok: 80, lines: ['{"op":"law","player":{"jumpsMax":1,"jumpH":1.6}}', '{"op":"verb","id":"vb_jump","verb":"locomotion.jump","on":"player","params":{"jumpsMax":1}}'] } });
    const r = await w.tool("edit_world", { world: built.link, change: "only one jump" });
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent;
    expect(conforms(outputOf("edit_world"), s)).toEqual([]);
    expect(s.summary).toEqual(["jumps 2 → 1", "1 verb retuned"]);
    expect(s.delta).toEqual([]); // one jump still can't reach the roof, so "needs double jump" still holds
    expect(r.content[0]!.text.split("\n")[2]).toBe("Receipt: no number moved (static checks; AI runners re-prove it on the new link)");
    expect(s.from).toEqual({ world: built.world, link: built.link, spec: built.spec });
    expect(s.world).toMatch(SHARE);
    expect(s.world).not.toBe(built.world);
    expect(s.spec).not.toBe(built.spec);
    // the model saw the change and the world's own lines (pinned to its layout)
    const sent = (JSON.parse(w.hits().find((h) => h.url.includes("cerebras"))!.body) as { messages: { content: string }[] }).messages[1]!.content;
    expect(sent).toContain("The change to make: only one jump");
    expect(sent).toContain('"fit":{"jumpH":1.6,"jumpsMax":2');
    const stored = JSON.parse(w.r2.objects.get(`shares/${s.world}.json`)!);
    expect(stored).toMatchObject({ remixOf: built.world, origin: { id: built.world, prompt: "capture the flag in a neon city", spec: built.spec }, lineage: [{ id: built.world, change: "only one jump" }], changes: 1, prompt: "capture the flag in a neon city" });
    expect(r.content[0]!.text).toMatch(/What changed: jumps 2 → 1/);
    // a change of a change carries the line on
    w.upstream({ fill: { inTok: 4000, outTok: 80, lines: ['{"op":"meta","timeOfDay":12}'] } });
    const again = (await w.tool("edit_world", { world: s.world, change: "make it daytime" })).structuredContent;
    const line = JSON.parse(w.r2.objects.get(`shares/${again.world}.json`)!);
    expect(line).toMatchObject({ remixOf: s.world, origin: { id: built.world }, changes: 2, lineage: [{ change: "only one jump" }, { id: s.world, change: "make it daytime" }] });
    expect(again.summary).toContain("now day");
  });

  it("an edit that breaks a promise shows up in the receipt's numbers, with the proof's reason", async () => {
    const w = world({ up: { fill: { inTok: 3000, outTok: 1500, lines: CTF } } });
    const built = (await w.tool("build_world", { prompt: "capture the flag in a neon city", seed: 7 })).structuredContent;
    w.upstream({ fill: { inTok: 4000, outTok: 80, lines: ['{"op":"law","player":{"jumpsMax":2,"jumpH":3.4}}'] } });
    const r = await w.tool("edit_world", { world: built.world, change: "super high jumps" });
    const s = r.structuredContent;
    expect(s.summary).toEqual(["jump height 1.6 → 3.4 m"]);
    expect(s.delta).toContainEqual({ label: "Headline", from: "verified", to: "counterexample", sign: -1 });
    expect(s.failures).toHaveLength(1);
    expect(s.failures[0]).toBe("Rooftop lane needs double jump — reachable with 1 jump: highest step 2.6 m, apex 3.2 m");
    expect(r.content[0]!.text).toMatch(/Receipt: Headline verified → counterexample · Counterexamples 0 → 1/);
    expect(s.expects).toContainEqual(expect.objectContaining({ text: "Rooftop lane needs double jump", status: "counterexample" }));
  });

  it("an edit of a gallery world remixes g:<slug>; one that changes nothing says so", async () => {
    const w = world({ up: { fill: { inTok: 4000, outTok: 80, lines: ['{"op":"meta","timeOfDay":3}'] } } });
    const r = await w.tool("edit_world", { world: slug, change: "make it the middle of the night" });
    const s = r.structuredContent;
    expect(s.from.world).toBe(`g:${slug}`);
    expect(JSON.parse(w.r2.objects.get(`shares/${s.world}.json`)!)).toMatchObject({ remixOf: `g:${slug}`, origin: { id: `g:${slug}`, prompt: GALLERY.find((g) => g.slug === slug)!.prompt } });
    w.upstream({ fill: { inTok: 4000, outTok: 10, lines: ['{"op":"del","id":"nothing_here"}'] } });
    expect((await w.tool("edit_world", { world: slug, change: "do nothing" })).content[0]!.text).toBe("Nothing in the world changed. Try saying it differently.");
  });

  it("explain_world says a gallery world's rules, verbs and promises; a ?g= link and a slug are the same world", async () => {
    const w = world();
    const r = await w.tool("explain_world", { world: slug });
    const s = r.structuredContent;
    expect(conforms(outputOf("explain_world"), s)).toEqual([]);
    expect(s).toMatchObject({ world: `g:${slug}`, link: `https://g.example/?g=${slug}`, pack: "arena", exact: true });
    expect(s.rules.every((x: string) => /^[✓✗~–·] WHEN .+ THEN .+/.test(x))).toBe(true);
    expect(s.expects.some((x: { headline: boolean }) => x.headline)).toBe(true);
    expect(r.content[0]!.text).toContain("Promises (expectations):");
    expect((await w.tool("explain_world", { world: `https://play.ghostrun.workers.dev/?g=${slug}` })).structuredContent.spec).toBe(s.spec);
    expect((await w.tool("explain_world", { world: "no-such-world" })).content[0]!.text).toMatch(/isn't a world I can find/);
    expect((await w.tool("explain_world", { world: "aaaaaaaaaaaaaaaa" })).content[0]!.text).toMatch(/There's no share aaaaaaaaaaaaaaaa/);
  });

  it("get_receipt is the honest-label receipt: the cloud proof's when one answers for this spec, else the static one", async () => {
    const edge = await world().tool("get_receipt", { world: slug });
    expect(conforms(outputOf("get_receipt"), edge.structuredContent)).toEqual([]);
    expect(edge.structuredContent.proof).toMatchObject({ source: "edge", par: null, band: null });
    expect(edge.content[0]!.text).toMatch(/Not proved here: T2/);
    // a cloud proof (lane E's route) answers: its receipt is used, labels and all
    const prover: Prover = {
      prove: async (p) => ({ v: 1, spec: p.spec, engine: "e", host: "edge", headline: { expect: "x", text: "Rooftop lane needs double jump", status: "verified", method: "jump model + AI runners" }, chips: [{ id: "T3:win", tier: "T3", subject: { kind: "world", id: "win" }, status: "played", method: "physics, 12 AI runners", n: 12, k: 11, text: "AI runners won", cx: null, src: "", ms: 0 }], par: { goldS: 31, runs: 12, won: 11 }, ms: 900 }) satisfies Receipt,
    };
    const cloud = await world({ prover }).tool("get_receipt", { world: slug });
    expect(cloud.structuredContent.proof).toMatchObject({ source: "cloud", pending: null, par: { goldS: 31 } });
    expect(cloud.structuredContent.proof.lines).toEqual(["Receipt for spec " + cloud.structuredContent.spec.slice(0, 8) + " · the full proof, run on edge · 900 ms", "Headline: Rooftop lane needs double jump: verified (jump model + AI runners)", "✓ [T3] AI runners won · 11 of 12  (physics, 12 AI runners)", "AI par 31 s · 11 of 12 runners won"]);
  });

  it("the cloud proof's seam: POST /v1/proof with the world as a share stores it; only a receipt for this very spec counts", async () => {
    const p = await placeFill(CTF.join("\n"), 7, { pack: "city_block" });
    const sent: unknown[] = [];
    const answer = (body: unknown, status = 200) => async (path: string, json?: unknown) => (sent.push([path, json]), Response.json(body, { status }));
    const receipt = { v: 1, spec: p.spec, engine: "e", host: "edge", headline: null, chips: [], par: null, ms: 1 };
    expect(await cloudProver(answer({ receipt })).prove(p)).toEqual(receipt);
    expect(sent[0]).toEqual(["/v1/proof", { v: 1, engine: ENGINE_HASH, specHash: p.spec, seed: 7, fill: p.fill }]);
    expect(await cloudProver(answer(receipt)).prove(p)).toEqual(receipt); // bare works too
    expect(await cloudProver(answer({ ...receipt, spec: "f".repeat(64) })).prove(p)).toBeNull();
    expect(await cloudProver(answer({ error: "not found" }, 404)).prove(p)).toBeNull();
    // today the route isn't there: the default seam asks the real handler and falls back to the static proof
    expect((await world().tool("get_receipt", { world: slug })).structuredContent.proof.source).toBe("edge");
  });

  it("list_gallery lists every recorded world with a link that opens it", async () => {
    const r = await world().tool("list_gallery", {});
    expect(conforms(outputOf("list_gallery"), r.structuredContent)).toEqual([]);
    expect(r.structuredContent.worlds).toHaveLength(GALLERY.length);
    expect(r.structuredContent.worlds[0]).toMatchObject({ slug: GALLERY[0]!.slug, link: `https://g.example/?g=${GALLERY[0]!.slug}` });
    expect(r.content[0]!.text.split("\n")[0]).toBe(`${GALLERY.length} gallery worlds (slug: prompt · pack · game or place):`);
  });

  it("a shared world's link and its id are the same world", async () => {
    const w = world({ up: { fill: { inTok: 3000, outTok: 1500, lines: CTF } } });
    const built = (await w.tool("build_world", { prompt: "neon flag run", seed: 5 })).structuredContent;
    const byLink = (await w.tool("explain_world", { world: built.link })).structuredContent;
    const byId = (await w.tool("explain_world", { world: built.world })).structuredContent;
    const sans = (x: { proof: object }) => ({ ...x, proof: { ...x.proof, lines: [] } }); // the ms it took differs
    expect(sans(byLink)).toEqual(sans(byId));
    expect(byId).toMatchObject({ world: built.world, spec: built.spec, prompt: "neon flag run", exact: true });
  });
});

describe("the handshake era end to end", () => {
  it("a 2025-06-18 client builds a world with structured content, without resultType", async () => {
    const w = world({ up: { fill: { inTok: 3000, outTok: 1500, lines: CTF } } });
    const r = await w.legacy("tools/call", { name: "build_world", arguments: { prompt: "neon flag run", seed: 5 } }, "2025-06-18");
    expect(r.body.result.resultType).toBeUndefined();
    expect(r.body.result.structuredContent.world).toMatch(SHARE);
    const old = await w.legacy("tools/call", { name: "explain_world", arguments: { world: r.body.result.structuredContent.world } }, "2025-03-26");
    expect(old.body.result.structuredContent).toBeUndefined();
    expect(old.body.result.content[0].text).toContain("WHEN");
  });
});
