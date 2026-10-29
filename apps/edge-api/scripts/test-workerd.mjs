// Real-runtime test of the spend governor under workerd 1.20261019.1 (the runtime wrangler 4.152.0
// ships), run against the exact bundle wrangler deploys (dist/worker/index.js). The Durable Object
// is SQLite-backed on local disk; globalOutbound points every fetch at a fake upstream (Cerebras,
// siteverify, ntfy), so no network and no keys. Exit code 1 on any failed check.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { root } from "./build.mjs";
import { newToken, tokenHash } from "./judge-token.mjs";

const dir = resolve(root, "dist/workerd-test");
const bundle = resolve(root, "dist/worker/index.js");
if (!existsSync(bundle)) throw new Error("dist/worker/index.js missing: run scripts/build.mjs first");
rmSync(dir, { recursive: true, force: true });
mkdirSync(resolve(dir, "do"), { recursive: true });
copyFileSync(bundle, resolve(dir, "index.js"));
for (const f of ["entry.js", "upstream.js"]) copyFileSync(resolve(root, "test/workerd", f), resolve(dir, f));

const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const port = await freePort();
const logPort = await freePort();
const base = `http://127.0.0.1:${port}`;
const JKEY = "workerd-test-judge-key-0123456789abcdef";
const TOKEN = newToken();
const vars = {
  CEREBRAS_API_KEY: "test-key",
  ANTHROPIC_API_KEY: "test-claude-key",
  TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
  SESSION_SECRET: "workerd-test-session-secret-0123456789",
  JUDGE_TOKEN_KEY: JKEY,
  JUDGE_TOKEN_HASHES: tokenHash(JKEY, TOKEN), // minted by Node; verified by workerd's WebCrypto
  NTFY_URL: "https://ntfy.test/ghostrun-alerts",
  CAP_POOL_CANARY_USD: "0.05",
  BUILDS_PER_WINDOW: "1000",
  RATE_PER_WINDOW: "1000",
};
const str = (s) => JSON.stringify(s);
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
    (name = "index.js", esModule = embed "index.js")
  ],
  compatibilityDate = "2026-10-19",
  bindings = [
    (name = "GOVERNOR", durableObjectNamespace = (className = "GovernorDO")),
    ${Object.entries(vars).map(([k, v]) => `(name = ${str(k)}, text = ${str(v)})`).join(",\n    ")}
  ],
  durableObjectNamespaces = [(className = "GovernorDO", uniqueKey = "ghostrun-governor-workerd-test", enableSql = true)],
  durableObjectStorage = (localDisk = "do-disk"),
  globalOutbound = "upstream",
);
const upstream :Workerd.Worker = (
  modules = [(name = "upstream.js", esModule = embed "upstream.js")],
  compatibilityDate = "2026-10-19",
);
`,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc;
async function start() {
  proc = spawn(resolve(root, "node_modules/.bin/workerd"), ["serve", "config.capnp"], { cwd: dir, stdio: ["ignore", "inherit", "inherit"] });
  for (let i = 0; i < 150; i++) {
    const res = await fetch(`${base}/v1/health`).catch(() => null);
    if (res?.ok) return res.json();
    await sleep(100);
  }
  throw new Error("workerd did not come up");
}
async function stop() {
  if (proc.exitCode !== null) return;
  const exited = new Promise((r) => proc.once("exit", r));
  proc.kill();
  await exited;
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
const gov = async (path, body) => (await fetch(`${base}/__gov/${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })).json();
const pool = async (p) => (await gov("status")).pools.find((x) => x.pool === p);
const until = async (fn, ms = 3000) => {
  for (const t0 = Date.now(); ; await sleep(50)) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
  }
};
const events = (text) => text.split("\n\n").filter(Boolean).map((b) => /^event: (.+)$/m.exec(b)?.[1]);
const build = (headers, prompt = "capture the flag on neon rooftops") => fetch(`${base}/v1/build`, { method: "POST", headers, body: JSON.stringify({ prompt, seed: 11 }) });
const METERED = Math.ceil((1000 * 990 + 200 * 1490) / 1000) + Math.ceil((3000 * 350 + 1500 * 750) / 1000); // fake upstream usage at list price

try {
  const health = await start();
  check("worker boots in workerd with the governor DO bound", health.ok === true && health.gate === "turnstile", JSON.stringify(health));

  // 1. 100 parallel debits against a $0.05 pool: exactly 50 holds of $0.001 fit.
  const r1 = await Promise.all(Array.from({ length: 100 }, (_, i) => gov("reserve", { pool: "canary", session: `c${i}`, ip: `ip${i % 7}`, estimateMicroUsd: 1000 })));
  const ok1 = r1.filter((r) => r.ok);
  check("100 parallel reserves: exactly 50 granted, 50 denied pool_cap", ok1.length === 50 && r1.filter((r) => r.reason === "pool_cap").length === 50, `${ok1.length} granted`);
  check("held = 50 × estimate, nothing spent yet", JSON.stringify(await pool("canary")) === JSON.stringify({ pool: "canary", spent: 0, held: 50_000, cap: 50_000 }));

  // 2. Commit all 50 in parallel at the metered cost; replays charge nothing.
  const c1 = await Promise.all(ok1.map((r) => gov("commit", { id: r.id, actualMicroUsd: 600 })));
  const replay = await gov("commit", { id: ok1[0].id, actualMicroUsd: 600 });
  const after = await pool("canary");
  check("parallel commits charge the metered cost and free every hold", c1.every((r) => r.ok) && after.spent === 30_000 && after.held === 0, JSON.stringify(after));
  check("a replayed commit is refused (unknown_hold)", replay.ok === false && replay.reason === "unknown_hold");

  // 3. The 50% alert went out once, from inside the DO, to NTFY_URL.
  const alerts = await until(async () => {
    const log = await (await fetch(`http://127.0.0.1:${logPort}/__log`)).json();
    const a = log.filter((l) => l.host === "ntfy.test");
    return a.length ? a : null;
  });
  check("pool crossing 50% pings ntfy exactly once", alerts?.length === 1 && alerts[0].title === "GHOSTRUN spend alert" && alerts[0].body === "canary pool at 50%: $0.03 of $0.05", JSON.stringify(alerts));

  // 4. Another 100 in parallel: only the $0.02 left is granted, then released.
  const r2 = await Promise.all(Array.from({ length: 100 }, (_, i) => gov("reserve", { pool: "canary", ip: `ip${i}`, estimateMicroUsd: 1000 })));
  const ok2 = r2.filter((r) => r.ok);
  await Promise.all(ok2.map((r) => gov("release", { id: r.id })));
  const after2 = await pool("canary");
  check("second burst: exactly the remaining 20 granted; releases free them", ok2.length === 20 && after2.spent === 30_000 && after2.held === 0, `${ok2.length} granted, ${JSON.stringify(after2)}`);

  // 5. The ledger is durable: restart workerd on the same SQLite files.
  await stop();
  await start();
  const persisted = await pool("canary");
  check("ledger survives a workerd restart (SQLite on disk)", persisted.spent === 30_000 && persisted.held === 0, JSON.stringify(persisted));

  // 6. A judge build: reserve → intent → streamed ops → done → commit of the metered cost (waitUntil).
  const jb = await build({ "x-judge-token": TOKEN, "cf-connecting-ip": "198.51.100.1" });
  const jev = events(await jb.text());
  check("judge-token build streams intent → ops → done", jb.headers.get("content-type") === "text/event-stream" && jev.join(",") === "intent,op,op,op,done", jev.join(","));
  const judge = await until(async () => ((await pool("judge")).spent === METERED ? pool("judge") : null));
  check("judge build is committed at the metered cost from usage", judge?.spent === METERED && judge?.held === 0, `${JSON.stringify(judge)} expected ${METERED}`);

  // 7. Tokenless needs a Turnstile session.
  const anon = await build({ "cf-connecting-ip": "198.51.100.2" });
  check("tokenless build without a session cookie is 401", anon.status === 401, String(anon.status));
  const s = await fetch(`${base}/v1/session`, { method: "POST", headers: { "cf-connecting-ip": "198.51.100.3" }, body: JSON.stringify({ token: "XXXX.DUMMY.TOKEN.XXXX" }) });
  const setCookie = s.headers.get("set-cookie") ?? "";
  check("POST /v1/session (test secret + dummy token) sets the session cookie", s.status === 200 && /HttpOnly; Secure; SameSite=Strict/.test(setCookie) && /Max-Age=1800/.test(setCookie), setCookie);
  const cookie = setCookie.split(";")[0];
  const bad = await fetch(`${base}/v1/session`, { method: "POST", body: JSON.stringify({ token: "forged" }) });
  check("a token siteverify rejects gets no cookie", bad.status === 403 && !bad.headers.get("set-cookie"), String(bad.status));

  // 8. 60 parallel builds on one public session: the $0.15 session cap must stop some, never overspend.
  const before = (await pool("public")).spent;
  const runs = await Promise.all(
    Array.from({ length: 60 }, async () => {
      const r = await build({ cookie, "cf-connecting-ip": "198.51.100.4" });
      const text = await r.text();
      return { status: r.status, body: r.status === 200 ? events(text).at(-1) : JSON.parse(text) };
    }),
  );
  const okRuns = runs.filter((r) => r.status === 200 && r.body === "done").length;
  const capped = runs.filter((r) => r.status === 429 && r.body.reason === "session_cap").length;
  const settled = await until(async () => {
    const p = await pool("public");
    return p.held === 0 && p.spent - before === okRuns * METERED ? p : null;
  });
  check("60 parallel builds on one session: every one either built or was capped", okRuns + capped === 60, `${okRuns} built, ${capped} session_cap`);
  check("session spend is exactly builds × metered cost and within the $0.15 cap", settled !== null && okRuns * METERED <= 150_000 && capped > 0, `spent ${settled ? settled.spent - before : "?"} µ$`);

  // 9. A build from a picture: Haiku reads it into a brief first, held with the build and committed
  // with it at the metered price; the fast lane then writes the world.
  const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const judgeBefore = (await pool("judge")).spent;
  const ib = await fetch(`${base}/v1/build`, { method: "POST", headers: { "x-judge-token": TOKEN, "cf-connecting-ip": "198.51.100.5" }, body: JSON.stringify({ prompt: "a heist here", seed: 11, image: PIXEL }) });
  const ibody = await ib.text();
  const iev = events(ibody);
  check("a build from a picture streams inspired → intent → ops → done", iev.join(",") === "inspired,intent,op,op,op,done", iev.join(","));
  check("the inspired event carries the brief and the prompt it made, never the picture", ibody.includes("Inspired by a picture of a rainy neon alley at night") && !ibody.includes(PIXEL.slice(22, 60)));
  const LOOK = Math.ceil((1300 * 100 + 150 * 500) / 1000); // Haiku's look at the picture
  const judge3 = await until(async () => ((await pool("judge")).spent === judgeBefore + LOOK + METERED ? pool("judge") : null));
  check("the picture's build is committed at Haiku's look plus the fast lane's metered cost", judge3?.held === 0, `${JSON.stringify(await pool("judge"))} expected ${judgeBefore + LOOK + METERED}`);
  const tooBig = await fetch(`${base}/v1/build`, { method: "POST", headers: { "x-judge-token": TOKEN, "cf-connecting-ip": "198.51.100.5" }, body: JSON.stringify({ prompt: "x", image: `data:image/png;base64,${"A".repeat(600_000)}` }) });
  const afterBig = await pool("judge");
  check("a picture over the cap is turned away before any hold", tooBig.status === 413 && afterBig.held === 0 && afterBig.spent === judgeBefore + LOOK + METERED, `${tooBig.status} ${JSON.stringify(afterBig)}`);

  // 10. The fast lane is busy for this one: the fill fails over to Claude Haiku inside workerd. Last,
  // because the isolate then tries Cerebras second for 20 s, which would move the builds above to Haiku.
  const judgeMid = (await pool("judge")).spent;
  const fb = await build({ "x-judge-token": TOKEN, "cf-connecting-ip": "198.51.100.3" }, "busy lane: a maze with a key");
  const fev = events(await fb.text());
  check("a busy fast lane fails over to Haiku: intent → fallback → ops → done", fev.join(",") === "intent,fallback,op,op,op,done", fev.join(","));
  const HAIKU = Math.ceil((1000 * 990 + 200 * 1490) / 1000) + Math.ceil((4000 * 100 + 1800 * 500) / 1000); // fast-lane intent + Haiku fill
  const judge2 = await until(async () => ((await pool("judge")).spent === judgeMid + HAIKU ? pool("judge") : null));
  check("the failed-over build is committed at Haiku's price", judge2?.held === 0, `${JSON.stringify(await pool("judge"))} expected ${judgeMid + HAIKU}`);
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await stop();
}
console.log(failures ? `\nworkerd: ${failures} check(s) FAILED` : "\nworkerd: all checks passed");
process.exit(failures ? 1 : 0);
