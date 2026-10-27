// The Worker's globalOutbound in the workerd test: every fetch() the edge makes lands here.
// Fakes Cerebras (JSON intent + SSE fill, both with usage), Turnstile siteverify (the documented
// test-secret behaviour) and ntfy, and logs what it saw at GET /__log on its own socket.
const log = [];

const INTENT = {
  lang: "en", mode: "play", genre: "ctf", setting: "neon city", role: "runner", goal: "carry the orb home", fail: "lose the orb",
  mood: "tense", pack: "city_block", sub: [], safety: "ok", headline: "Rooftop lane needs double jump", nouns: [],
  moodVec: { valence: 0.2, arousal: 0.6, tension: 0.5 },
};
const LINES = ['{"op":"meta","v":1}', '{"op":"zone","id":"z_a"}', '{"op":"end","layer":"gameplay"}'];

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__log") return Response.json(log);
    const body = await req.text();
    log.push({ host: url.hostname, path: url.pathname, title: req.headers.get("title"), body: url.hostname === "challenges.cloudflare.com" ? "(form)" : body.slice(0, 200) });
    if (url.hostname === "api.cerebras.ai") {
      const o = JSON.parse(body);
      if (!o.stream) return Response.json({ choices: [{ message: { content: JSON.stringify(INTENT) } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } });
      const sse = LINES.map((l) => `data: ${JSON.stringify({ choices: [{ delta: { content: `${l}\n` } }] })}\n\n`).join("");
      return new Response(`${sse}data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3000, completion_tokens: 1500 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.hostname === "challenges.cloudflare.com") {
      const form = new URLSearchParams(body);
      const pass = form.get("secret") === "1x0000000000000000000000000000000AA" && form.get("response") === "XXXX.DUMMY.TOKEN.XXXX";
      return Response.json(pass ? { success: true, hostname: "localhost", "error-codes": [] } : { success: false, "error-codes": ["invalid-input-response"] });
    }
    if (url.hostname === "ntfy.test") return new Response("ok");
    return new Response("upstream: no route", { status: 599 });
  },
};
