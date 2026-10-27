// Runs the fixture on Node, workerd, Chromium, Firefox and WebKit, then compares the
// chained per-tick hashes. Exit code 1 if any runtime diverges.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ticks = Number(process.argv[process.argv.indexOf("--ticks") + 1] || 2000);
const wasm = resolve(root, "dist/worker/rapier_wasm3d_bg.wasm");
const results = [];

// Node
results.push(JSON.parse(execFileSync(process.execPath, [resolve(root, "dist/node/entry-node.js"), wasm, String(ticks)], { encoding: "utf8" })));

// workerd: the same runtime binary wrangler 4.152.0 deploys with, driven by a minimal capnp config.
const workerdPort = 18787;
writeFileSync(
  resolve(root, "dist/worker/config.capnp"),
  `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "main", worker = .det) ],
  sockets = [ (name = "http", address = "127.0.0.1:${workerdPort}", http = (), service = "main") ],
);
const det :Workerd.Worker = (
  modules = [
    (name = "entry-worker.js", esModule = embed "entry-worker.js"),
    (name = "rapier_wasm3d_bg.wasm", wasm = embed "rapier_wasm3d_bg.wasm"),
  ],
  compatibilityDate = "2026-10-19",
);
`,
);
const workerd = spawn(resolve(root, "node_modules/.bin/workerd"), ["serve", "config.capnp"], {
  cwd: resolve(root, "dist/worker"),
  stdio: ["ignore", "inherit", "inherit"],
});
try {
  let res;
  for (let i = 0; i < 100 && !res; i++) {
    res = await fetch(`http://127.0.0.1:${workerdPort}/?ticks=${ticks}`).catch(() => new Promise((r) => setTimeout(r, 100)));
  }
  if (!res?.ok) throw new Error(`workerd responded ${res?.status}: ${await res?.text()}`);
  results.push(await res.json());
} finally {
  workerd.kill();
}

// Browsers
const types = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };
const dist = resolve(root, "dist/browser");
const server = createServer((req, res) => {
  const path = join(dist, new URL(req.url, "http://x").pathname.replace(/\/$/, "/index.html"));
  try {
    const body = readFileSync(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const port = server.address().port;
for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  const browser = await type.launch();
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/?ticks=${ticks}`);
  const r = await page.waitForFunction(() => globalThis.__DET__, null, { timeout: 300_000 }).then((h) => h.jsonValue());
  results.push({ ...r, runtime: `${name} ${browser.version()}` });
  await browser.close();
}
server.close();

// Compare
const ref = results[0];
let ok = true;
for (const r of results) {
  const firstBad = r.checkpoints.findIndex((c, i) => c !== ref.checkpoints[i]);
  const same = r.final === ref.final && firstBad === -1;
  ok &&= same;
  console.log(
    `${same ? "MATCH " : "DIFFER"}  ${r.final}  ${String(r.ms).padStart(6)} ms  ${r.runtime}` +
      (same ? "" : `  (first divergent checkpoint: tick ${(firstBad + 1) * 100})`),
  );
}
const wasmSha = createHash("sha256").update(readFileSync(wasm)).digest("hex");
const report = { date: new Date().toISOString(), ticks, bodies: ref.bodies, wasmSha256: wasmSha, pass: ok, results };
writeFileSync(resolve(root, `report-${ticks}.json`), JSON.stringify(report, null, 2));
console.log(`\n${ok ? "S0 PASS" : "S0 FAIL"}: ${ticks} ticks × ${ref.bodies} bodies on ${results.length} runtimes · rapier wasm sha256 ${wasmSha.slice(0, 16)}…`);
process.exit(ok ? 0 : 1);
