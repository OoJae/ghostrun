// Cloudflare Worker entry for the edge API (deployed later, behind Turnstile + the governor).
import { handle, type Env } from "./handler";

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env);
  },
};
