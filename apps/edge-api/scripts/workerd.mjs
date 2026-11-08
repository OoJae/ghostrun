// Serves the exact bundle wrangler deploys (dist/worker/index.js and its two wasm modules) in
// workerd 1.20261019.1, the runtime wrangler 4.152.0 ships, behind the test entry (test/workerd/
// entry.js): the governor DO SQLite-backed on local disk, the ProofShard DOs beside it (they store
// nothing), and every fetch the Worker makes sent to a fake upstream (test/workerd/upstream.js).
// No network, no keys.
// Used by scripts/test-workerd.mjs and scripts/time-proof.mjs.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { root, WASM } from "./build.mjs";

const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (s) => JSON.stringify(s);

/** Start workerd on the bundle with these text bindings; `stop` and `start` restart it on the same disk. */
export async function serveWorkerd(name, vars) {
  const dir = resolve(root, `dist/${name}`);
  const bundle = resolve(root, "dist/worker/index.js");
  if (!existsSync(bundle)) throw new Error("dist/worker/index.js missing: run scripts/build.mjs first");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, "do"), { recursive: true });
  copyFileSync(bundle, resolve(dir, "index.js"));
  for (const f of Object.keys(WASM)) copyFileSync(resolve(root, "dist/worker", f), resolve(dir, f));
  for (const f of ["entry.js", "upstream.js"]) copyFileSync(resolve(root, "test/workerd", f), resolve(dir, f));
  const port = await freePort();
  const logPort = await freePort();
  writeFileSync(
    resolve(dir, "config.capnp"),
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .edge),
    (name = "upstream", worker = .upstream),
    (name = "do-disk", disk = (path = ${str(resolve(dir, "do"))}, writable = true))
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:${port}", http = (), service = "main"),
    (name = "log", address = "127.0.0.1:${logPort}", http = (), service = "upstream")
  ],
);
const edge :Workerd.Worker = (
  modules = [
    (name = "entry.js", esModule = embed "entry.js"),
    (name = "index.js", esModule = embed "index.js"),
    ${Object.keys(WASM).map((f) => `(name = ${str(f)}, wasm = embed ${str(f)})`).join(",\n    ")}
  ],
  compatibilityDate = "2026-10-19",
  bindings = [
    (name = "GOVERNOR", durableObjectNamespace = (className = "GovernorDO")),
    (name = "PROOF_SHARD", durableObjectNamespace = (className = "ProofShardDO")),
    ${Object.entries(vars).map(([k, v]) => `(name = ${str(k)}, text = ${str(v)})`).join(",\n    ")}
  ],
  durableObjectNamespaces = [
    (className = "GovernorDO", uniqueKey = "ghostrun-governor-workerd-test", enableSql = true),
    (className = "ProofShardDO", uniqueKey = "ghostrun-proof-shard-workerd-test", enableSql = true)
  ],
  durableObjectStorage = (localDisk = "do-disk"),
  globalOutbound = "upstream",
);
const upstream :Workerd.Worker = (
  modules = [(name = "upstream.js", esModule = embed "upstream.js")],
  compatibilityDate = "2026-10-19",
);
`,
  );
  const base = `http://127.0.0.1:${port}`;
  let proc;
  const start = async () => {
    proc = spawn(resolve(root, "node_modules/.bin/workerd"), ["serve", "config.capnp"], { cwd: dir, stdio: ["ignore", "inherit", "inherit"] });
    for (let i = 0; i < 150; i++) {
      const res = await fetch(`${base}/v1/health`).catch(() => null);
      if (res?.ok) return res.json();
      await sleep(100);
    }
    throw new Error("workerd did not come up");
  };
  const stop = async () => {
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill();
    await exited;
  };
  return { base, logBase: `http://127.0.0.1:${logPort}`, start, stop };
}
