// Cloudflare Worker entry: the edge API on /v1/* and its MCP endpoint on /mcp (every other path is
// a static asset of the web app, served before the Worker runs), the canaries on their cron
// triggers, the spend governor's Durable Object class and the cloud proof's shards.
import { canary, type CanaryEnv } from "./canary";
import type { ScheduledController, WaitUntil } from "./cf";
import { useEngine } from "./engine";
import { workerdEngine } from "./engine-workerd";
import { handle, type Env } from "./handler";

export { GovernorDO } from "./governor";
export { ProofShardDO } from "./shard";

useEngine(workerdEngine);

export default {
  fetch(req: Request, env: Env, ctx: WaitUntil): Promise<Response> {
    return handle(req, env, ctx);
  },
  scheduled(controller: ScheduledController, env: Env & CanaryEnv, ctx: WaitUntil): void {
    ctx.waitUntil(canary(controller.cron, env, ctx));
  },
};
