// Sets the staging Worker's secrets from the repo's gitignored .dev.vars without printing any of
// them: the model keys, a fresh session secret, and the judge-token key with one dev token (both
// kept in .dev.vars as STAGING_JUDGE_TOKEN_KEY / STAGING_DEV_TOKEN, so more tokens can be minted).
// Run it yourself (it sends keys to Cloudflare):
//   pnpm --filter @ghostrun/edge-api secrets:staging
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./build.mjs";
import { newToken, tokenHash } from "./judge-token.mjs";

const file = resolve(root, "../../.dev.vars");
const vars = Object.fromEntries(
  readFileSync(file, "utf8")
    .split("\n")
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (!vars[k]) throw new Error(`${k} missing from .dev.vars`);
if (!vars.CEREBRAS_API_KEY && !vars.ANTHROPIC_API_KEY) throw new Error("no model key in .dev.vars");
if (!vars.STAGING_JUDGE_TOKEN_KEY || !vars.STAGING_DEV_TOKEN) {
  vars.STAGING_JUDGE_TOKEN_KEY = randomBytes(32).toString("base64url");
  vars.STAGING_DEV_TOKEN = newToken();
  appendFileSync(file, `STAGING_JUDGE_TOKEN_KEY=${vars.STAGING_JUDGE_TOKEN_KEY}\nSTAGING_DEV_TOKEN=${vars.STAGING_DEV_TOKEN}\n`);
  chmodSync(file, 0o600);
}
const secrets = {
  ...(vars.CEREBRAS_API_KEY ? { CEREBRAS_API_KEY: vars.CEREBRAS_API_KEY } : {}),
  ...(vars.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: vars.ANTHROPIC_API_KEY } : {}),
  SESSION_SECRET: randomBytes(32).toString("base64url"),
  JUDGE_TOKEN_KEY: vars.STAGING_JUDGE_TOKEN_KEY,
  JUDGE_TOKEN_HASHES: `dev:${tokenHash(vars.STAGING_JUDGE_TOKEN_KEY, vars.STAGING_DEV_TOKEN)}`,
};
console.log(`setting ${Object.keys(secrets).join(", ")} on ghostrun-edge-staging (values not shown)`);
const w = spawn("pnpm", ["dlx", "wrangler@4.152.0", "secret", "bulk", "--env", "staging"], {
  cwd: root,
  env: { ...process.env, CLOUDFLARE_API_TOKEN: vars.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: vars.CLOUDFLARE_ACCOUNT_ID },
  stdio: ["pipe", "inherit", "inherit"],
});
w.stdin.end(JSON.stringify(secrets)); // wrangler reads the JSON from stdin when no file is given
w.on("exit", (code) => process.exit(code ?? 1));
