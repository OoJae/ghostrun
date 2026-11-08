// Times the cloud proof per world (pnpm --filter @ghostrun/edge-api time:proof), three ways:
//   node     the proof in Node as the device runs it (one thread, playtest included)
//   workerd  the deployed bundle in local workerd, through POST /v1/proof: cold (nothing stored),
//            whole in the Worker and on 6 shards, then stored. workerd serves on one thread, so
//            locally the shards take turns: this is the whole proof's CPU on one core
//   edge     the wall time to expect where shards run side by side: the Worker's own part beside
//            the shard jobs dealt to 6 lanes as each frees (after each lane places the world and
//            builds its navmesh), from every part's time in Node; Cloudflare's cores are slower
//            per thread than a laptop's, so read it as a lower bound and the workerd cold time,
//            divided out over the lanes, as the other end
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { nodeBundle, root } from "./build.mjs";
import { newToken, tokenHash } from "./judge-token.mjs";
import { serveWorkerd } from "./workerd.mjs";

const WORLDS = {
  "CTF brief": "../../packages/ir/fixtures/ctf-neon.jsonl",
  zombies: "../../packages/ir/fixtures/zombie-survival.jsonl",
  "kart race": "../../packages/ir/fixtures/kart-race.jsonl",
  "museum heist": "../../packages/ir/fixtures/vault-heist.jsonl",
  "heist (live)": "../../packages/ir/fixtures/heist-live-1.jsonl",
  "gallery: science museum": "../web/src/gallery/worlds/a-science-museum-with-a-dinosaur-skeleto.json",
};
const WIDTH = 6;
const HOP_MS = 5; // one shard job's round trip inside a colo

const nodeOut = await nodeBundle("test/workerd/node-proof.ts", "dist/node-proof", "node-proof.mjs");
const parts = JSON.parse(execFileSync(process.execPath, [nodeOut, "--jobs", ...Object.values(WORLDS).map((p) => resolve(root, p))], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));

const KEY = "time-proof-judge-key-0123456789abcdef";
const TOKEN = newToken();
const vars = { JUDGE_TOKEN_KEY: KEY, JUDGE_TOKEN_HASHES: tokenHash(KEY, TOKEN), SESSION_SECRET: "time-proof-session-secret-0123456789", PROOFS_PER_WINDOW: "1000" };
const sharded = await serveWorkerd("time-proof", { ...vars, PROOF_SHARDS: String(WIDTH) });
const whole = await serveWorkerd("time-proof-whole", { ...vars, PROOF_SHARDS: "0" });
await sharded.start();
await whole.start();
const ask = async (base, input) => {
  const t0 = Date.now();
  const res = await fetch(`${base}/v1/proof`, { method: "POST", headers: { "content-type": "application/json", "x-judge-token": TOKEN }, body: JSON.stringify(input) });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return { ms: Date.now() - t0, hit: res.headers.get("x-proof") === "hit", body };
};

const rows = [];
try {
  for (const [name, p] of Object.entries(WORLDS).map(([n], i) => [n, parts[i]])) {
    // the expected edge wall time: lanes free after their set-up, each takes the next job as it frees
    const lanes = Array.from({ length: Math.min(WIDTH, p.jobs.length) }, () => p.setupMs);
    for (const j of p.jobs) {
      const i = lanes.indexOf(Math.min(...lanes));
      lanes[i] += j.ms + HOP_MS;
    }
    const shardsMs = lanes.length ? Math.max(...lanes) : 0;
    const edgeMs = Math.max(p.coordinatorMs, shardsMs);
    const w = await ask(whole.base, p.input);
    const s = await ask(sharded.base, p.input);
    const c = await ask(sharded.base, p.input);
    rows.push({ name, node: p.ms, whole: w.ms, sharded: s.ms, stored: c.hit ? c.ms : NaN, jobs: p.jobs.length, longest: Math.max(0, ...p.jobs.map((j) => j.ms)), setup: p.setupMs, worker: p.coordinatorMs, edge: edgeMs });
  }
} finally {
  await sharded.stop();
  await whole.stop();
}
const pad = (x, n) => String(x).padStart(n);
console.log(`\n${"world".padEnd(24)} ${pad("node", 6)} ${pad("wd whole", 9)} ${pad("wd 6 shards", 12)} ${pad("stored", 7)}   ${pad("jobs", 4)} ${pad("longest", 8)} ${pad("set-up", 7)} ${pad("worker", 7)} ${pad("edge est", 9)}  (ms)`);
for (const r of rows) console.log(`${r.name.padEnd(24)} ${pad(r.node, 6)} ${pad(r.whole, 9)} ${pad(r.sharded, 12)} ${pad(r.stored, 7)}   ${pad(r.jobs, 4)} ${pad(r.longest, 8)} ${pad(r.setup, 7)} ${pad(r.worker, 7)} ${pad(r.edge, 9)}`);
