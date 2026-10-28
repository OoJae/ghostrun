// Builds the web app and deploys it with the Worker to one environment, authenticated with the
// scoped Cloudflare token in the repo's gitignored .dev.vars:
//   pnpm --filter @ghostrun/edge-api deploy:staging
//   pnpm --filter @ghostrun/edge-api deploy:production   (run by the owner)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./build.mjs";

const env = process.argv[2];
if (env !== "staging" && env !== "production") throw new Error("usage: deploy.mjs staging|production");
const vars = Object.fromEntries(
  readFileSync(resolve(root, "../../.dev.vars"), "utf8")
    .split("\n")
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (!vars[k]) throw new Error(`${k} missing from .dev.vars`);
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, CLOUDFLARE_API_TOKEN: vars.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: vars.CLOUDFLARE_ACCOUNT_ID } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run("pnpm", ["--filter", "@ghostrun/web", "build"], resolve(root, "../.."));
run("pnpm", ["dlx", "wrangler@4.152.0", "deploy", "--env", env], root);
