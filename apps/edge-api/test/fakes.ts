// Offline stand-ins for everything the edge API talks to: Cerebras (JSON + SSE with usage),
// Turnstile siteverify (behaving as Cloudflare documents its test secrets), ntfy, R2 and the
// governor DO namespace. Tests never touch the network or real keys.
import type { DoNamespace, R2Bucket, WaitUntil } from "../src/cf";
import { localCall, type Governor } from "../src/governor";

// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
export const TURNSTILE = {
  sitekeyPass: "1x00000000000000000000AA",
  secretPass: "1x0000000000000000000000000000000AA",
  secretFail: "2x0000000000000000000000000000000AA",
  secretSpent: "3x0000000000000000000000000000000AA",
  dummyToken: "XXXX.DUMMY.TOKEN.XXXX",
};

export const INTENT = {
  lang: "en",
  mode: "play",
  genre: "ctf",
  setting: "neon city",
  role: "runner",
  goal: "carry the orb home",
  fail: "lose the orb",
  mood: "tense",
  pack: "city_block",
  sub: [],
  safety: "ok",
  headline: "Rooftop lane needs double jump",
  nouns: [],
  moodVec: { valence: 0.2, arousal: 0.6, tension: 0.5 },
};

export interface Upstream {
  intent?: { inTok: number; outTok: number; status?: number; body?: unknown };
  fill?: { inTok: number; outTok: number; lines?: string[]; status?: number; usage?: boolean };
  /** Delay before Cerebras answers (to let a test cancel mid-flight). */
  delayMs?: number;
  /** The Claude fallback: the same intent and fill lines, over the Messages API. */
  claude?: { inTok: number; outTok: number; status?: number };
}

export interface Hit {
  url: string;
  body: string;
  headers: Headers;
  signal?: AbortSignal | null;
}

export function fakeFetch(up: Upstream = {}) {
  const hits: Hit[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const body = await req.text();
    hits.push({ url: req.url, body, headers: req.headers, signal: init?.signal ?? null });
    const url = new URL(req.url);
    if (url.hostname === "api.cerebras.ai") {
      if (up.delayMs) await new Promise((r) => setTimeout(r, up.delayMs));
      const o = JSON.parse(body) as { stream: boolean };
      if (!o.stream) {
        const i = up.intent ?? { inTok: 1000, outTok: 200 };
        if (i.status && i.status !== 200) return new Response("upstream says no", { status: i.status });
        return Response.json({ choices: [{ message: { content: JSON.stringify(i.body ?? INTENT) } }], usage: { prompt_tokens: i.inTok, completion_tokens: i.outTok } });
      }
      const f = up.fill ?? { inTok: 3000, outTok: 1500 };
      if (f.status && f.status !== 200) return new Response("upstream says no", { status: f.status });
      const lines = f.lines ?? ['{"op":"meta","v":1}', '{"op":"zone","id":"z_a"}', '{"op":"end","layer":"gameplay"}'];
      const chunks = lines.map((l) => `data: ${JSON.stringify({ choices: [{ delta: { content: `${l}\n` } }] })}\n\n`);
      if (f.usage !== false) chunks.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: f.inTok, completion_tokens: f.outTok } })}\n\n`);
      chunks.push("data: [DONE]\n\n");
      return new Response(chunks.join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.hostname === "api.anthropic.com") {
      const o = JSON.parse(body) as { stream: boolean };
      const c = up.claude ?? { inTok: 900, outTok: 300 };
      if (c.status && c.status !== 200) return new Response("upstream says no", { status: c.status });
      if (!o.stream) return Response.json({ content: [{ type: "text", text: JSON.stringify(up.intent?.body ?? INTENT) }], stop_reason: "end_turn", usage: { input_tokens: c.inTok, output_tokens: c.outTok } });
      const lines = up.fill?.lines ?? ['{"op":"meta","v":1}', '{"op":"zone","id":"z_a"}', '{"op":"end","layer":"gameplay"}'];
      const events = [
        { type: "message_start", message: { usage: { input_tokens: c.inTok } } },
        ...lines.map((l) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${l}\n` } })),
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: c.outTok } },
        { type: "message_stop" },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.hostname === "challenges.cloudflare.com") {
      const form = new URLSearchParams(body);
      const ok = (codes: string[]) => Response.json({ success: false, "error-codes": codes });
      if (form.get("secret") === TURNSTILE.secretFail) return ok(["invalid-input-response"]);
      if (form.get("secret") === TURNSTILE.secretSpent) return ok(["timeout-or-duplicate"]);
      if (form.get("secret") !== TURNSTILE.secretPass) return ok(["invalid-input-secret"]);
      if (form.get("response") !== TURNSTILE.dummyToken) return ok(["invalid-input-response"]); // test secrets accept only the dummy token
      return Response.json({ success: true, challenge_ts: "2022-02-28T15:14:30.096Z", hostname: "localhost", "error-codes": [], action: "test", cdata: "test-data" });
    }
    if (url.hostname === "ntfy.test") return new Response("ok");
    return new Response("no route in fakeFetch", { status: 599 });
  };
  return { fn: fn as typeof fetch, hits, to: (host: string) => hits.filter((h) => new URL(h.url).hostname === host) };
}

/** A DO namespace whose only object runs the given governor in-process, behind the real wire protocol. */
export function governorNs(gov: Governor, opts: { delayMs?: number } = {}): DoNamespace & { calls: string[] } {
  const call = localCall(gov);
  const calls: string[] = [];
  return {
    calls,
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (input: string, init?: RequestInit) => {
        const path = new URL(input).pathname;
        calls.push(path);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return call(path, init?.body ? JSON.parse(String(init.body)) : undefined);
      },
    }),
  };
}

/** A governor that never answers. */
export const silentNs = (): DoNamespace => ({ idFromName: (n: string) => n, get: () => ({ fetch: () => new Promise<Response>(() => {}) }) });

export function memR2(): R2Bucket & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    get: async (k) => (objects.has(k) ? { text: async () => objects.get(k)! } : null),
    head: async (k) => (objects.has(k) ? {} : null),
    put: async (k, value) => void objects.set(k, value),
  };
}

export function waiter(): WaitUntil & { settled(): Promise<void> } {
  const ps: Promise<unknown>[] = [];
  return {
    waitUntil: (p) => void ps.push(p),
    settled: async () => {
      while (ps.length) await Promise.allSettled(ps.splice(0));
    },
  };
}

export async function readSse(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => ({ event: /^event: (.+)$/m.exec(block)?.[1] ?? "", data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "null") }));
}
