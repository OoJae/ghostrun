// MCP at /mcp, over Streamable HTTP: JSON-RPC 2.0, one message per POST, one JSON answer per
// request (the tools are in mcp-tools.ts). Dual-era, as the spec allows: a request carrying the
// 2026-07-28 per-request _meta is served statelessly under that revision (server/discover, the
// MCP-Protocol-Version / Mcp-Method / Mcp-Name header checks, resultType on every result); an
// `initialize` selects a handshake revision (2025-03-26 to 2025-11-25), served without a session:
// none is minted, so none is needed. Every request needs a judge or dev token (Authorization:
// Bearer, or ?t= for a client that can't set headers), counts against that token's own buckets,
// and spends only through the web app's own routes, so the governor and its caps apply unchanged.
import { Buckets, intVar, WINDOW_MS } from "./buckets";
import { devOpen, ipOf, judgeCaller, type Caller } from "./gate";
import type { Env } from "./handler";
import { readJson } from "./http";
import { callTool, cloudProver, TOOLS, type Prover, type Tool, type ToolCtx, type ToolResult } from "./mcp-tools";

export interface McpEnv extends Env {
  /** Requests per token per isolate per 10 min on /mcp (default 120). */
  MCP_PER_WINDOW?: string;
  /** build_world and edit_world calls per token per isolate per 10 min (default 20); the governor's caps bound the spend besides. */
  MCP_BUILDS_PER_WINDOW?: string;
  /** Comma list of other origins a browser-based MCP client may call from (the endpoint's own always may). */
  MCP_ORIGINS?: string;
}

export interface McpDeps {
  /** The edge's own routes, called in-process (no HTTP hop): they gate, spend and cache as for the web app. */
  route(req: Request): Promise<Response>;
  /** The full proof, once a cloud proof is wired (default: POST /v1/proof, which answers 404 until it lands). */
  prover?: Prover;
}

/** Revisions with per-request metadata, and the handshake revisions still served (newest first). */
export const MODERN = ["2026-07-28"];
export const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const SUPPORTED = [...MODERN, ...LEGACY];

export const SERVER_INFO = {
  name: "ghostrun",
  title: "GHOSTRUN",
  version: "1.0.0",
  description: "Turns a prompt into a playable, proved 3D world: build, change, explain and check worlds.",
  websiteUrl: "https://play.ghostrun.workers.dev",
};

const INSTRUCTIONS =
  "GHOSTRUN builds playable 3D worlds from a prompt and proves them. Call build_world with a prompt; pass the `world` it returns (a share id) to edit_world, explain_world or get_receipt. list_gallery lists recorded worlds whose slugs work as `world` too. Every result carries a link that opens the world to play in a browser. The edge proves what needs no physics (T0 rule graph, T1 jump and reach models); AI runners prove the rest when a link is opened, and the receipt always says which is which.";

const M = "io.modelcontextprotocol/";
const CODE = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, headerMismatch: -32020, unsupportedVersion: -32022 } as const;
// ours, outside JSON-RPC's reserved range, as the spec asks of codes it doesn't define
const UNAUTHORIZED = -31401;
const RATE_LIMITED = -31429;
const MAX_BODY = 64 * 1024;
const TOOLS_TTL_MS = 60 * 60 * 1000;

const requests = new Buckets();
const spends = new Buckets();

type Id = string | number;
type Json = Record<string, unknown>;

const isObject = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);

function reply(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

const result = (id: Id, r: Json) => reply({ jsonrpc: "2.0", id, result: r });
const error = (id: Id | null, code: number, message: string, status = 200, data?: unknown, headers: Record<string, string> = {}) =>
  reply({ jsonrpc: "2.0", ...(id !== null ? { id } : {}), error: { code, message, ...(data !== undefined ? { data } : {}) } }, status, headers);

/** A header value as the client meant it: the =?base64?…?= sentinel decoded (undefined when it doesn't decode). */
function headerText(raw: string | null): string | null | undefined {
  if (raw === null) return null;
  const m = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(raw);
  if (!m) return raw;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** CORS for an origin that may call (the endpoint's own needs none); null when it may not. */
function corsFor(origin: string | null, url: URL, env: McpEnv): Record<string, string> | null {
  if (!origin || origin === url.origin) return {};
  const allowed = (env.MCP_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return { "access-control-allow-origin": origin, "access-control-expose-headers": "www-authenticate", vary: "origin" };
}

/** The caller: a judge or dev token (Bearer, or ?t=), or the open dev gate on localhost. */
async function callerOf(req: Request, url: URL, env: McpEnv): Promise<{ caller: Caller; token: string | null } | { given: boolean }> {
  const bearer = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  const token = bearer ?? url.searchParams.get("t");
  const caller = await judgeCaller(token, env);
  if (caller) return { caller, token };
  if (!token && devOpen(env, url)) return { caller: { pool: "dev", via: "dev" }, token: null };
  return { given: token !== null };
}

export async function mcp(req: Request, env: McpEnv, deps: McpDeps): Promise<Response> {
  const url = new URL(req.url);
  // a browser page on another origin must not drive the endpoint (DNS rebinding, stray tabs)
  const cors = corsFor(req.headers.get("origin"), url, env);
  if (!cors) return error(null, CODE.invalidRequest, "Forbidden: this origin may not call GHOSTRUN's MCP endpoint", 403);
  const res = await serve(req, url, env, deps);
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

async function serve(req: Request, url: URL, env: McpEnv, deps: McpDeps): Promise<Response> {
  if (req.method === "OPTIONS") {
    const asked = (req.headers.get("access-control-request-headers") ?? "").replace(/[^\w, -]/g, "");
    return new Response(null, { status: 204, headers: { "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": asked || "authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name", "access-control-max-age": "600" } });
  }
  // no standalone stream (GET) and no sessions to end (DELETE): POST is the whole transport
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, OPTIONS" } });

  const who = await callerOf(req, url, env);
  if ("given" in who) {
    const challenge = who.given ? `Bearer realm="ghostrun", error="invalid_token", error_description="not a judge or dev token"` : `Bearer realm="ghostrun"`;
    const message = who.given
      ? "Unauthorized: that token isn't a GHOSTRUN judge or dev token."
      : "Unauthorized: GHOSTRUN's MCP endpoint needs a judge or dev token. Send Authorization: Bearer <token>, or add ?t=<token> to the URL for a client that can't set headers.";
    return error(null, UNAUTHORIZED, message, 401, undefined, { "www-authenticate": challenge });
  }
  const ip = ipOf(req);
  const key = who.caller.session ?? `ip:${ip}`;
  if (!requests.allow(key, intVar(env.MCP_PER_WINDOW, 120))) return error(null, RATE_LIMITED, "Rate limited: too many requests for this token; slow down.", 429, { retryMs: WINDOW_MS }, { "retry-after": String(WINDOW_MS / 1000) });

  const body = await readJson(req, MAX_BODY);
  if (!body.ok) return body.status === 413 ? error(null, CODE.invalidRequest, "Request too large", 413) : error(null, CODE.parse, "Parse error: the body isn't JSON", 400);
  const msg = body.value;
  if (Array.isArray(msg)) return error(null, CODE.invalidRequest, "Invalid Request: batches aren't supported; send one JSON-RPC message per POST", 400);
  if (!isObject(msg) || msg.jsonrpc !== "2.0") return error(null, CODE.invalidRequest, "Invalid Request: not a JSON-RPC 2.0 message", 400);
  if (typeof msg.method !== "string") {
    // a response from the client (the handshake revisions allow one): nothing here is waiting for it
    if (("result" in msg || "error" in msg) && "id" in msg) return new Response(null, { status: 202 });
    return error(null, CODE.invalidRequest, "Invalid Request: no method", 400);
  }
  // a notification (initialized, cancelled): accepted, and nothing to answer
  if (!("id" in msg)) return new Response(null, { status: 202 });
  const id = msg.id;
  if (typeof id !== "string" && !(typeof id === "number" && Number.isInteger(id))) return error(null, CODE.invalidRequest, "Invalid Request: id must be a string or an integer", 400);
  if (msg.params !== undefined && !isObject(msg.params)) return error(id, CODE.invalidParams, "Invalid params: params must be an object", 400);
  const params: Json = msg.params ?? {};

  const tokenHeaders = (h: Headers) => {
    if (who.token) h.set("x-judge-token", who.token);
    for (const k of ["cf-connecting-ip", "x-forwarded-for"]) {
      const v = req.headers.get(k);
      if (v) h.set(k, v);
    }
  };
  const call: ToolCtx["call"] = (path, json) => {
    const headers = new Headers({ "content-type": "application/json" });
    tokenHeaders(headers);
    return deps.route(new Request(new URL(path, url.origin), json === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(json) }));
  };
  const ctx: ToolCtx = {
    call,
    origin: url.origin,
    prover: deps.prover ?? cloudProver(call),
    spend: () => spends.allow(key, intVar(env.MCP_BUILDS_PER_WINDOW, 20)),
  };

  const meta = isObject(params._meta) ? params._meta : null;
  const asked = meta?.[`${M}protocolVersion`];
  const header = req.headers.get("mcp-protocol-version");
  if (asked !== undefined || (header !== null && MODERN.includes(header))) {
    if (typeof asked === "string" && LEGACY.includes(asked)) return legacy(id, msg.method, params, asked, header, ctx);
    return modern(req, id, msg.method, params, meta, header, ctx);
  }
  return legacy(id, msg.method, params, undefined, header, ctx);
}

/** 2026-07-28: everything a request needs is in the request; its headers must say what its body says. */
async function modern(req: Request, id: Id, method: string, params: Json, meta: Json | null, header: string | null, ctx: ToolCtx): Promise<Response> {
  const asked = meta?.[`${M}protocolVersion`];
  if (typeof asked !== "string" || !isObject(meta?.[`${M}clientCapabilities`])) return error(id, CODE.invalidParams, `Invalid params: _meta needs ${M}protocolVersion and ${M}clientCapabilities`, 400);
  if (header === null) return error(id, CODE.headerMismatch, "Header mismatch: the MCP-Protocol-Version header is missing", 400);
  if (header !== asked) return error(id, CODE.headerMismatch, `Header mismatch: MCP-Protocol-Version header value '${header}' does not match body value '${asked}'`, 400);
  if (!MODERN.includes(asked)) return error(id, CODE.unsupportedVersion, "Unsupported protocol version", 400, { supported: SUPPORTED, requested: asked });
  const mcpMethod = req.headers.get("mcp-method");
  if (mcpMethod === null) return error(id, CODE.headerMismatch, "Header mismatch: the Mcp-Method header is missing", 400);
  if (mcpMethod !== method) return error(id, CODE.headerMismatch, `Header mismatch: Mcp-Method header value '${mcpMethod}' does not match body value '${method}'`, 400);
  if (method === "tools/call") {
    const name = headerText(req.headers.get("mcp-name"));
    if (name === null) return error(id, CODE.headerMismatch, "Header mismatch: the Mcp-Name header is missing", 400);
    if (name === undefined || name !== params.name) return error(id, CODE.headerMismatch, `Header mismatch: Mcp-Name header value does not match body value '${String(params.name)}'`, 400);
  }
  const done = (r: Json) => result(id, { resultType: "complete", ...r, _meta: { [`${M}serverInfo`]: SERVER_INFO } });
  switch (method) {
    case "server/discover":
      return done({ supportedVersions: SUPPORTED, capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS, ttlMs: TOOLS_TTL_MS, cacheScope: "public" });
    case "tools/list":
      if (params.cursor !== undefined) return error(id, CODE.invalidParams, "Invalid params: unknown cursor (the list is one page)");
      return done({ tools: TOOLS.map((t) => listed(t, asked)), ttlMs: TOOLS_TTL_MS, cacheScope: "public" });
    case "tools/call": {
      const r = await toolCall(id, params, asked, ctx);
      return r instanceof Response ? r : done(r);
    }
    default:
      return error(id, CODE.methodNotFound, `Method not found: ${method}`, 404);
  }
}

/** 2025-03-26 to 2025-11-25: the handshake picks the revision; no session, so every request stands alone. */
async function legacy(id: Id, method: string, params: Json, inMeta: string | undefined, header: string | null, ctx: ToolCtx): Promise<Response> {
  if (method === "initialize") {
    const asked = params.protocolVersion;
    if (typeof asked !== "string") return error(id, CODE.invalidParams, "Invalid params: initialize needs a protocolVersion");
    // the version asked for when it's one of ours, else the newest handshake revision we serve
    const version = LEGACY.includes(asked) ? asked : LEGACY[0]!;
    return result(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
  }
  // a request without the header predates it (2025-03-26), as the transport says to assume
  const version = inMeta ?? header ?? "2025-03-26";
  if (!LEGACY.includes(version)) return error(id, CODE.unsupportedVersion, "Unsupported protocol version", 400, { supported: SUPPORTED, requested: version });
  if (header !== null && header !== version) return error(id, CODE.invalidRequest, `Bad Request: MCP-Protocol-Version header value '${header}' does not match '${version}'`, 400);
  switch (method) {
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS.map((t) => listed(t, version)) });
    case "tools/call": {
      const r = await toolCall(id, params, version, ctx);
      return r instanceof Response ? r : result(id, r);
    }
    default:
      return error(id, CODE.methodNotFound, `Method not found: ${method}`);
  }
}

// titles and structured output arrived in 2025-06-18: a 2025-03-26 client gets neither
const before0618 = (version: string) => version < "2025-06-18";

function listed(t: Tool, version: string): Json {
  const base = { name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } };
  return before0618(version) ? base : { ...base, title: t.title, outputSchema: t.outputSchema };
}

async function toolCall(id: Id, params: Json, version: string, ctx: ToolCtx): Promise<Response | Json> {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return error(id, CODE.invalidParams, `Unknown tool: ${String(params.name).slice(0, 64)}`);
  const args = params.arguments ?? {};
  if (!isObject(args)) return error(id, CODE.invalidParams, "Invalid params: arguments must be an object");
  const r: ToolResult = await callTool(tool, args, ctx);
  if (before0618(version)) return { content: r.content, ...(r.isError ? { isError: true } : {}) };
  return { content: r.content, ...(r.structuredContent ? { structuredContent: r.structuredContent } : {}), ...(r.isError ? { isError: true } : {}) };
}
