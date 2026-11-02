// Builds each prompt in a list once through the normal POST /v1/build path, so the exact-repeat
// cache holds it before anyone asks (the organizer's brief, the landing starters). It asks exactly
// as the app does (no seed, the web app's engine hash), reads every stream to its end and paces
// live builds for the fast lane's 5 fills a minute. It needs a judge or dev token; never commit one:
//   GR_TOKEN=<token> pnpm --filter @ghostrun/edge-api warm-cache [prompts.txt] [--base <url>] [--fresh]
// Defaults: scripts/warm-prompts.txt, https://play.ghostrun.workers.dev. --fresh rebuilds and
// overwrites what is there (after a prompt or model change that the template hash didn't see).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const base = opt("--base", "https://play.ghostrun.workers.dev").replace(/\/$/, "");
const fresh = args.includes("--fresh");
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--base") ?? resolve(here, "warm-prompts.txt");
const token = process.env.GR_TOKEN;
if (!token) throw new Error("set GR_TOKEN to a judge or dev token (pnpm --filter @ghostrun/edge-api judge-token dev)");

// the engine hash the web app sends: a cached build only ever serves the engine it was built for
const world = readFileSync(resolve(here, "../../../packages/world/src/index.ts"), "utf8");
const engine = /ENGINE_HASH = "([0-9a-f]{64})"/.exec(world)?.[1];
if (!engine) throw new Error("ENGINE_HASH not found in packages/world/src/index.ts");

const prompts = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const events = (text) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((b) => ({ event: /^event: (.+)$/m.exec(b)?.[1] ?? "", data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? "null") }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
for (const [n, prompt] of prompts.entries()) {
  const t0 = Date.now();
  const head = `[${n + 1}/${prompts.length}] ${prompt.slice(0, 60).padEnd(60)}`;
  let live = false;
  try {
    const res = await fetch(`${base}/v1/build`, { method: "POST", headers: { "content-type": "application/json", "x-judge-token": token }, body: JSON.stringify({ prompt, engine, ...(fresh ? { fresh: true } : {}) }) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const es = events(await res.text());
    const cached = es.find((e) => e.event === "cached");
    const bad = es.find((e) => e.event === "error" || e.event === "refusal");
    const safety = es.find((e) => e.event === "intent")?.data?.intent?.safety;
    const done = es.find((e) => e.event === "done");
    live = !cached;
    if (bad) throw new Error(`${bad.event}: ${bad.data?.message ?? ""}`);
    if (!done) throw new Error("stream ended before done");
    if (cached) console.log(`${head}  already cached (built ${cached.data.at.slice(0, 16)} by ${cached.data.fillModel})`);
    else if (safety === "block") console.log(`${head}  refused (safety 'block'), not kept`);
    else console.log(`${head}  built and kept in ${Date.now() - t0} ms (${done.data.lines} lines by ${done.data.fillModel || "?"})`);
  } catch (e) {
    failed++;
    console.log(`${head}  FAILED ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
  }
  if (live && n < prompts.length - 1) await sleep(13_000); // the fast lane's free tier allows 5 fills a minute
}
console.log(failed ? `\nwarm-cache: ${failed} of ${prompts.length} failed` : `\nwarm-cache: ${prompts.length} prompts warm`);
process.exit(failed ? 1 : 0);
