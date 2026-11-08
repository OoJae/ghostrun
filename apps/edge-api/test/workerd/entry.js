// workerd test entry: wraps the exact bundle wrangler deploys (dist/worker/index.js) and adds
// /__gov/* straight through to the governor Durable Object, so the test can drive it directly.
// workerd alone has no R2 or KV, so the share store and FLAGS are small in-memory stand-ins here
// (the cloud proof keeps its receipts in one; the canaries their last runs in the other), set
// through /__flags; /__cron?cron=… runs the scheduled handler as a cron trigger would.
// Used only by scripts/test-workerd.mjs and scripts/time-proof.mjs; never deployed.
import worker from "./index.js";

export { GovernorDO, ProofShardDO } from "./index.js";

const objects = new Map();
const kv = new Map();
const SHARES = {
  get: async (k) => (objects.has(k) ? { text: async () => objects.get(k) } : null),
  head: async (k) => (objects.has(k) ? {} : null),
  put: async (k, v) => void objects.set(k, v),
  list: async ({ prefix = "", limit = 1000 }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((key) => ({ key, customMetadata: {} })) }),
};
const FLAGS = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const e = { ...env, SHARES, FLAGS };
    if (url.pathname === "/__flags") {
      if (req.method === "POST") for (const [k, v] of Object.entries(await req.json())) v === null ? kv.delete(k) : kv.set(k, v);
      return Response.json(Object.fromEntries(kv));
    }
    if (url.pathname === "/__forget") {
      objects.clear();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__cron") {
      const waits = [];
      await worker.scheduled({ cron: url.searchParams.get("cron"), scheduledTime: Date.now() }, e, { waitUntil: (p) => waits.push(p) });
      await Promise.allSettled(waits);
      return Response.json(Object.fromEntries(kv));
    }
    if (!url.pathname.startsWith("/__gov/")) return worker.fetch(req, e, ctx);
    const stub = env.GOVERNOR.get(env.GOVERNOR.idFromName("global"));
    const init = req.method === "POST" ? { method: "POST", body: await req.text(), headers: { "content-type": "application/json" } } : {};
    return stub.fetch(`https://governor/${url.pathname.slice("/__gov/".length)}`, init);
  },
};
