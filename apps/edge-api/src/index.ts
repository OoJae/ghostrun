// Cloudflare Worker entry: the edge API on /v1/* (every other path is a static asset of the web
// app, served before the Worker runs) and the spend governor's Durable Object class.
import type { WaitUntil } from "./cf";
import { handle, type Env } from "./handler";

export { GovernorDO } from "./governor";

export default {
  fetch(req: Request, env: Env, ctx: WaitUntil): Promise<Response> {
    return handle(req, env, ctx);
  },
};
