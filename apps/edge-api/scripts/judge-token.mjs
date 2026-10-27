// Mints a judge token and its JUDGE_TOKEN_HASHES entry:
//   JUDGE_TOKEN_KEY=… pnpm --filter @ghostrun/edge-api judge-token [judge|dev|canary]
// Give the judge the token (as https://<host>/?t=<token>); append the entry to the
// JUDGE_TOKEN_HASHES secret. Equivalent: printf %s "$TOKEN" | openssl dgst -sha256 -hmac "$JUDGE_TOKEN_KEY"
import { createHmac, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export const tokenHash = (key, token) => createHmac("sha256", key).update(token).digest("hex");
export const newToken = () => randomBytes(24).toString("base64url");

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  const key = process.env.JUDGE_TOKEN_KEY;
  const pool = process.argv[2] ?? "judge";
  if (!key || key.length < 32) throw new Error("set JUDGE_TOKEN_KEY (≥32 chars) to the same value as the Worker secret");
  if (!["judge", "dev", "canary"].includes(pool)) throw new Error("pool must be judge, dev or canary");
  const token = newToken();
  console.log(`token: ${token}\nentry: ${pool === "judge" ? "" : `${pool}:`}${tokenHash(key, token)}`);
}
