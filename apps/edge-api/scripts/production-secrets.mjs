// Sets the production Worker's secrets. Run it yourself; it asks for each key with hidden input
// (paste and press Enter) and never prints or saves a model key:
//   pnpm --filter @ghostrun/edge-api secrets:production
// - Cerebras and Anthropic keys: Enter reuses the one in .dev.vars. Better for Anthropic: a key from a
//   separate production workspace with its own spend limit, so judging can't be stopped by dev use.
// - Turnstile secret: from the "ghostrun-production" widget (Cloudflare dashboard → Turnstile).
// - Generated here: the session secret, the judge-token key, one judge token and one canary token.
//   The token key and the two tokens are kept in .dev.vars (PROD_*) so more tokens can be minted and
//   the canary can run; they are ours, not a vendor's.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import readline from "node:readline";
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

/** One line of hidden input (nothing echoes while you paste). */
function hidden(question) {
  return new Promise((done) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => s.startsWith(question) && process.stdout.write(question);
    rl.question(question, (answer) => {
      process.stdout.write("\n");
      rl.close();
      done(answer.trim());
    });
  });
}

const cerebras = (await hidden("Cerebras API key (Enter = the one in .dev.vars): ")) || vars.CEREBRAS_API_KEY || "";
const anthropic = (await hidden("Anthropic API key (Enter = the one in .dev.vars): ")) || vars.ANTHROPIC_API_KEY || "";
const turnstile = await hidden("Turnstile secret key of the ghostrun-production widget: ");
if (!cerebras && !anthropic) throw new Error("no model key");
if (!/^0x4/.test(turnstile)) throw new Error("that doesn't look like a Turnstile secret key (they start with 0x4)");

if (!vars.PROD_JUDGE_TOKEN_KEY || !vars.PROD_JUDGE_TOKEN || !vars.PROD_CANARY_TOKEN) {
  vars.PROD_JUDGE_TOKEN_KEY = randomBytes(32).toString("base64url");
  vars.PROD_JUDGE_TOKEN = newToken();
  vars.PROD_CANARY_TOKEN = newToken();
  appendFileSync(file, `PROD_JUDGE_TOKEN_KEY=${vars.PROD_JUDGE_TOKEN_KEY}\nPROD_JUDGE_TOKEN=${vars.PROD_JUDGE_TOKEN}\nPROD_CANARY_TOKEN=${vars.PROD_CANARY_TOKEN}\n`);
  chmodSync(file, 0o600);
}
const key = vars.PROD_JUDGE_TOKEN_KEY;
const secrets = {
  ...(cerebras ? { CEREBRAS_API_KEY: cerebras } : {}),
  ...(anthropic ? { ANTHROPIC_API_KEY: anthropic } : {}),
  TURNSTILE_SECRET: turnstile,
  SESSION_SECRET: randomBytes(32).toString("base64url"),
  JUDGE_TOKEN_KEY: key,
  JUDGE_TOKEN_HASHES: `${tokenHash(key, vars.PROD_JUDGE_TOKEN)},canary:${tokenHash(key, vars.PROD_CANARY_TOKEN)}`,
  // the 12-hourly canary's live build sends it
  CANARY_TOKEN: vars.PROD_CANARY_TOKEN,
};
console.log(`setting ${Object.keys(secrets).join(", ")} on the production Worker (values not shown)`);
const w = spawn("pnpm", ["dlx", "wrangler@4.152.0", "secret", "bulk", "--env", "production"], {
  cwd: root,
  env: { ...process.env, CLOUDFLARE_API_TOKEN: vars.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: vars.CLOUDFLARE_ACCOUNT_ID },
  stdio: ["pipe", "inherit", "inherit"],
});
w.stdin.end(JSON.stringify(secrets)); // wrangler reads the JSON from stdin when no file is given
w.on("exit", (code) => process.exit(code ?? 1));
