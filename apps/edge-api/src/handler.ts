// Edge API handler (Web-standard Request/Response, so it runs in Workers and in dev servers).
// POST /v1/build streams the fast lane as server-sent events:
//   intent {intent, ms}  →  op {i, line} per complete JSONL fill line  →  done {timings}
// Keys never leave the server. The client parses ops into the IR, places, simulates and proves.
import { DEFAULT_LAWS } from "@ghostrun/ir";
import { chatJson, fillMessages, IntentOut, intentJsonSchema, intentMessages, LlmError, streamChat } from "@ghostrun/llm";
import { ALL_SUBS, PACKS, packFor } from "@ghostrun/registry";
import * as v from "valibot";
import EXAMPLE from "../../../packages/ir/fixtures/ctf-neon.jsonl?raw";

export interface Env {
  CEREBRAS_API_KEY: string;
  /** Per-isolate guard until the Durable Object governor lands: builds per IP per window. */
  BUILDS_PER_WINDOW?: string;
}

const MAX_PROMPT = 500;
const WINDOW_MS = 10 * 60 * 1000;
const buckets = new Map<string, { n: number; since: number }>();

function allow(ip: string, limit: number, now: number): boolean {
  const b = buckets.get(ip);
  if (!b || now - b.since > WINDOW_MS) {
    buckets.set(ip, { n: 1, since: now });
    return true;
  }
  if (b.n >= limit) return false;
  b.n++;
  return true;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/v1/health") return json({ ok: true, packs: PACKS.map((p) => p.id), llm: Boolean(env.CEREBRAS_API_KEY) });
  if (url.pathname !== "/v1/build" || req.method !== "POST") return json({ error: "not found" }, 404);
  if (!env.CEREBRAS_API_KEY) return json({ error: "llm not configured" }, 503);

  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "local";
  if (!allow(ip, Number(env.BUILDS_PER_WINDOW ?? 30), Date.now())) return json({ error: "rate limited", retryMs: WINDOW_MS }, 429);

  let input: { prompt?: unknown; seed?: unknown };
  try {
    input = (await req.json()) as typeof input;
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, MAX_PROMPT) : "";
  if (!prompt) return json({ error: "empty prompt" }, 400);
  const seed = Number.isInteger(input.seed) ? (input.seed as number) : 1 + Math.floor(Date.now() % 100000);

  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const send = (event: string, data: unknown) => w.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  (async () => {
    const t0 = Date.now();
    try {
      const intentRes = await chatJson<unknown>({
        apiKey: env.CEREBRAS_API_KEY,
        model: "qwen-3.8-27b",
        reasoningEffort: "none",
        messages: intentMessages(prompt, PACKS),
        jsonSchema: { name: "intent", schema: intentJsonSchema(PACKS.map((p) => p.id), ALL_SUBS) },
        maxTokens: 800,
      });
      const intent = v.parse(IntentOut, intentRes.value);
      await send("intent", { intent, seed, ms: Date.now() - t0 });
      if (intent.safety === "block") {
        await send("refusal", { message: "That one's outside what GHOSTRUN builds. Try a game, a place or a challenge." });
        return;
      }
      const pack = packFor(intent.pack);
      const layout = pack.generate({ seed, params: pack.defaults, sub: intent.sub, laws: DEFAULT_LAWS, harder: false });
      let buf = "";
      let i = 0;
      let firstMs = -1;
      for await (const ev of streamChat({ apiKey: env.CEREBRAS_API_KEY, model: "gpt-oss-120b", reasoningEffort: "low", maxTokens: 6000, messages: fillMessages(prompt, intent, layout, EXAMPLE, seed) })) {
        if (ev.type === "first_token") firstMs = Date.now() - t0;
        if (ev.type !== "text") continue;
        buf += ev.delta;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) await send("op", { i: i++, line });
        }
      }
      if (buf.trim()) await send("op", { i: i++, line: buf.trim() });
      await send("done", { intentMs: intentRes.ms, fillFirstTokenMs: firstMs, totalMs: Date.now() - t0, lines: i });
    } catch (e) {
      const retryable = e instanceof LlmError ? e.retryable : true;
      await send("error", { message: e instanceof Error ? e.message.slice(0, 200) : "build failed", retryable });
    } finally {
      await w.close();
    }
  })();

  return new Response(readable, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
