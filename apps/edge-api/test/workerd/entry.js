// workerd test entry: wraps the exact bundle wrangler deploys (dist/worker/index.js) and adds
// /__gov/* straight through to the governor Durable Object, so the test can drive it directly.
// Used only by scripts/test-workerd.mjs; never deployed.
import worker from "./index.js";

export { GovernorDO } from "./index.js";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/__gov/")) return worker.fetch(req, env, ctx);
    const stub = env.GOVERNOR.get(env.GOVERNOR.idFromName("global"));
    const init = req.method === "POST" ? { method: "POST", body: await req.text(), headers: { "content-type": "application/json" } } : {};
    return stub.fetch(`https://governor/${url.pathname.slice("/__gov/".length)}`, init);
  },
};
