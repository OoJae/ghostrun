// Sets CANARY_TOKEN, the raw canary judge token the 12-hourly canary's live build sends, on one
// environment, from the repo's gitignored .dev.vars, without printing it. Run it yourself:
//   pnpm --filter @ghostrun/edge-api secrets:canary production|staging
// Production already lists PROD_CANARY_TOKEN's canary: hash in JUDGE_TOKEN_HASHES (secrets:production
// made both). Staging had a dev token only: a canary token is minted and kept in .dev.vars as
// STAGING_CANARY_TOKEN, and JUDGE_TOKEN_HASHES is set again with both hashes.
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./build.mjs";
import { newToken, tokenHash } from "./judge-token.mjs";

const env = process.argv[2];
if (env !== "staging" && env !== "production") throw new Error("usage: canary-secret.mjs staging|production");
const file = resolve(root, "../../.dev.vars");
const vars = Object.fromEntries(
  readFileSync(file, "utf8")
    .split("\n")
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (!vars[k]) throw new Error(`${k} missing from .dev.vars`);
let secrets;
if (env === "production") {
  if (!vars.PROD_CANARY_TOKEN) throw new Error("PROD_CANARY_TOKEN missing from .dev.vars (run secrets:production first)");
  secrets = { CANARY_TOKEN: vars.PROD_CANARY_TOKEN };
} else {
  if (!vars.STAGING_JUDGE_TOKEN_KEY || !vars.STAGING_DEV_TOKEN) throw new Error("staging token key missing from .dev.vars (run secrets:staging first)");
  if (!vars.STAGING_CANARY_TOKEN) {
    vars.STAGING_CANARY_TOKEN = newToken();
    appendFileSync(file, `STAGING_CANARY_TOKEN=${vars.STAGING_CANARY_TOKEN}\n`);
    chmodSync(file, 0o600);
  }
  const key = vars.STAGING_JUDGE_TOKEN_KEY;
  secrets = { CANARY_TOKEN: vars.STAGING_CANARY_TOKEN, JUDGE_TOKEN_HASHES: `dev:${tokenHash(key, vars.STAGING_DEV_TOKEN)},canary:${tokenHash(key, vars.STAGING_CANARY_TOKEN)}` };
}
console.log(`setting ${Object.keys(secrets).join(", ")} on ${env} (values not shown)`);
const w = spawn("pnpm", ["dlx", "wrangler@4.152.0", "secret", "bulk", "--env", env], {
  cwd: root,
  env: { ...process.env, CLOUDFLARE_API_TOKEN: vars.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: vars.CLOUDFLARE_ACCOUNT_ID },
  stdio: ["pipe", "inherit", "inherit"],
});
w.stdin.end(JSON.stringify(secrets)); // wrangler reads the JSON from stdin when no file is given
w.on("exit", (code) => process.exit(code ?? 1));
