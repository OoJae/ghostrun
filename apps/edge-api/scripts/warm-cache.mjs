// Builds each prompt in a list once through the normal POST /v1/build path, so the exact-repeat
// cache holds it before anyone asks (the organizer's brief, the landing starters). It asks exactly
// as the app does (no seed, the web app's engine hash), reads every stream to its end and paces
// live builds for the fast lane's 5 fills a minute. It needs a judge or dev token; never commit one:
//   GR_TOKEN=<token> pnpm --filter @ghostrun/edge-api warm-cache [prompts.txt] [--base <url>] [--fresh] [--tries n]
// Defaults: scripts/warm-prompts.txt, https://play.ghostrun.workers.dev. --fresh rebuilds and
// overwrites what is there (after a prompt or model change that the template hash didn't see).
// Every kept world is proved here first (the CLI's verify, the same proof the device runs): one
// with a counterexample on its receipt is built fresh again, up to --tries times (default 4), so
// the world everyone gets for these prompts is one that proved clean. Build the CLI first
// (pnpm --filter @ghostrun/cli build).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const base = opt("--base", "https://play.ghostrun.workers.dev").replace(/\/$/, "");
const fresh = args.includes("--fresh");
const tries = Number(opt("--tries", "4"));
const cli = resolve(here, "../../cli/dist/ghostrun.mjs");
if (!existsSync(cli)) throw new Error("build the CLI first: pnpm --filter @ghostrun/cli build");
const scratch = mkdtempSync(join(tmpdir(), "gr-warm-"));
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--base" && args[i - 1] !== "--tries") ?? resolve(here, "warm-prompts.txt");
const token = process.env.GR_TOKEN;
if (!token) throw new Error("set GR_TOKEN to a judge or dev token (pnpm --filter @ghostrun/edge-api judge-token dev)");

// the engine hash the web app sends: a cached build only ever serves the engine it was built for
const pipeline = readFileSync(resolve(here, "../../web/src/pipeline.ts"), "utf8");
const engine = /ENGINE_HASH = "([0-9a-f]{64})"/.exec(pipeline)?.[1];
if (!engine) throw new Error("ENGINE_HASH not found in apps/web/src/pipeline.ts");

const prompts = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const events = (text) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((b) => ({ event: /^event: (.+)$/m.exec(b)?.[1] ?? "", data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? "null") }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The world a stream carries, proved here: its counterexample lines (none: it proved clean). */
function prove(es, n) {
  const said = es.find((e) => e.event === "intent")?.data;
  const seed = said?.seed;
  const place = [...(said?.intent?.pack ? ["--pack", said.intent.pack] : []), ...(said?.intent?.mode ? ["--mode", said.intent.mode] : [])];
  const lines = es.filter((e) => e.event === "op").map((e) => e.data.line);
  const f = join(scratch, `w${n}.fill.jsonl`);
  writeFileSync(f, lines.join("\n") + "\n");
  const out = execFileSync("node", [cli, "verify", f, ...(Number.isInteger(seed) ? ["--seed", String(seed)] : []), ...place], { encoding: "utf8", maxBuffer: 16 << 20 });
  return out.split("\n").filter((l) => /^\s*✗ \[T/.test(l)).map((l) => l.trim().slice(0, 140));
}

let failed = 0;
for (const [n, prompt] of prompts.entries()) {
  const head = `[${n + 1}/${prompts.length}] ${prompt.slice(0, 60).padEnd(60)}`;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const t0 = Date.now();
    let live = false;
    let again = false;
    try {
      const res = await fetch(`${base}/v1/build`, { method: "POST", headers: { "content-type": "application/json", "x-judge-token": token }, body: JSON.stringify({ prompt, engine, ...(fresh || attempt > 1 ? { fresh: true } : {}) }) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const es = events(await res.text());
      const cached = es.find((e) => e.event === "cached");
      const bad = es.find((e) => e.event === "error" || e.event === "refusal");
      const safety = es.find((e) => e.event === "intent")?.data?.intent?.safety;
      const done = es.find((e) => e.event === "done");
      live = !cached;
      if (bad) throw new Error(`${bad.event}: ${bad.data?.message ?? ""}`);
      if (!done) throw new Error("stream ended before done");
      if (safety === "block") {
        console.log(`${head}  refused (safety 'block'), not kept`);
      } else {
        const cx = prove(es, n);
        const how = cached ? `already cached (built ${cached.data.at.slice(0, 16)} by ${cached.data.fillModel})` : `built and kept in ${Date.now() - t0} ms (${done.data.lines} lines by ${done.data.fillModel || "?"})`;
        if (!cx.length) console.log(`${head}  ${how}; proved clean${attempt > 1 ? ` on try ${attempt}` : ""}`);
        else if (attempt < tries) {
          console.log(`${head}  ${how}; ${cx.length} counterexample(s), building it fresh again: ${cx[0]}`);
          again = true;
        } else {
          failed++;
          console.log(`${head}  ${how}; still ${cx.length} counterexample(s) after ${tries} tries, kept as is: ${cx.join(" | ")}`);
        }
      }
    } catch (e) {
      failed++;
      console.log(`${head}  FAILED ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
    }
    if (live && (again || n < prompts.length - 1)) await sleep(13_000); // the fast lane's free tier allows 5 fills a minute
    if (!again) break;
  }
}
rmSync(scratch, { recursive: true, force: true });
console.log(failed ? `\nwarm-cache: ${failed} of ${prompts.length} not clean or failed` : `\nwarm-cache: ${prompts.length} prompts warm, each proved clean`);
process.exit(failed ? 1 : 0);
