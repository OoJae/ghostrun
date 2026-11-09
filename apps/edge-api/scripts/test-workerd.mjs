// Real-runtime test of the edge under workerd 1.20261019.1 (the runtime wrangler 4.152.0 ships), run
// against the exact bundle wrangler deploys (dist/worker/index.js and its wasm modules; see
// scripts/workerd.mjs): the spend governor (its Durable Object SQLite-backed on local disk), the
// build lane, and the cloud proof on real ProofShard DOs, whose receipt for the organizer's CTF brief
// must equal the one Node proves, chip for chip; then the canaries on their crons. globalOutbound
// points every fetch at a fake upstream (Cerebras, Claude, siteverify, ntfy), so no network and no
// keys. Exit code 1 on any failed check.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { nodeBundle, root } from "./build.mjs";
import { newToken, tokenHash } from "./judge-token.mjs";
import { serveWorkerd } from "./workerd.mjs";

const JKEY = "workerd-test-judge-key-0123456789abcdef";
const TOKEN = newToken();
const CANARY = newToken();
const vars = {
  CEREBRAS_API_KEY: "test-key",
  ANTHROPIC_API_KEY: "test-claude-key",
  TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
  SESSION_SECRET: "workerd-test-session-secret-0123456789",
  JUDGE_TOKEN_KEY: JKEY,
  JUDGE_TOKEN_HASHES: `${tokenHash(JKEY, TOKEN)},canary:${tokenHash(JKEY, CANARY)}`, // minted by Node; verified by workerd's WebCrypto
  CANARY_TOKEN: CANARY,
  NTFY_URL: "https://ntfy.test/ghostrun-alerts",
  CAP_POOL_CANARY_USD: "0.05",
  BUILDS_PER_WINDOW: "1000",
  RATE_PER_WINDOW: "1000",
};
const { base, logBase, start, stop } = await serveWorkerd("workerd-test", vars);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const log = await (await fetch(`${logBase}/__log`)).json();
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

  // 9b. MCP at /mcp in the deployed bundle: the handshake, the 2026-07-28 shape, the gallery and the
  // placer bundled in, and a build through the build route in-process, charged like any other.
  const rpc = (method, params, headers = {}) =>
    fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "198.51.100.6", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const modern = (method, params = {}) =>
    rpc(method, { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } }, { "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...(params.name ? { "mcp-name": params.name } : {}) });
  const init = await (await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "workerd-test", version: "1" } })).json();
  check("MCP initialize negotiates 2025-11-25 in workerd", init.result?.protocolVersion === "2025-11-25" && init.result?.serverInfo?.name === "ghostrun", JSON.stringify(init).slice(0, 200));
  const listed = await (await modern("tools/list")).json();
  check("MCP tools/list (2026-07-28) lists the five tools", listed.result?.resultType === "complete" && listed.result?.tools?.map((t) => t.name).join(",") === "build_world,edit_world,explain_world,get_receipt,list_gallery", JSON.stringify(listed).slice(0, 200));
  const gallery = (await (await modern("tools/call", { name: "list_gallery", arguments: {} })).json()).result?.structuredContent?.worlds ?? [];
  const explained = (await (await modern("tools/call", { name: "explain_world", arguments: { world: gallery[0]?.slug ?? "" } })).json()).result?.structuredContent;
  check("MCP explain_world places a gallery world and the cloud proof answers for it in workerd", gallery.length > 50 && explained?.rules?.length > 0 && explained?.proof?.source === "cloud" && explained.proof.chips.some((c) => c.tier === "T0"), `${gallery.length} worlds, ${JSON.stringify(explained?.proof?.lines?.slice(0, 2))}`);
  const mcpBefore = (await pool("judge")).spent;
  const built = (await (await modern("tools/call", { name: "build_world", arguments: { prompt: "mcp: capture the flag on neon rooftops", seed: 11 } })).json()).result;
  check("MCP build_world builds through the build route and shares it (the test entry's share store)", built?.isError === undefined && built?.structuredContent?.intent?.pack === "city_block" && /\?s=[a-z2-7]{16}$/.test(built.structuredContent.link ?? ""), JSON.stringify(built).slice(0, 300));
  const mcpJudge = await until(async () => ((await pool("judge")).spent === mcpBefore + METERED ? pool("judge") : null));
  check("the MCP build is committed at the metered cost on the token's pool", mcpJudge?.held === 0, `${JSON.stringify(await pool("judge"))} expected ${mcpBefore + METERED}`);
  const anonMcp = await rpc("tools/list", {}, { authorization: "" });
  check("MCP without a token is 401 with a Bearer challenge", anonMcp.status === 401 && anonMcp.headers.get("www-authenticate") === 'Bearer realm="ghostrun"', String(anonMcp.status));

  // 11. The cloud proof of the organizer's CTF brief, on real ProofShard DOs, against Node's.
  const nodeOut = await nodeBundle("test/workerd/node-proof.ts", "dist/node-proof", "node-proof.mjs");
  // the brief, and the two speech-act worlds (a bribe the proof plans for, a viewing the tour books)
  const [mine, ...more] = JSON.parse(execFileSync(process.execPath, [nodeOut, ...["ctf-neon", "museum-bribe", "villa-viewing"].map((f) => resolve(root, `../../packages/ir/fixtures/${f}.jsonl`))], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
  const ask = (headers, body = mine.input) => fetch(`${base}/v1/proof`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  // (once more on a reset: workerd closes the kept-alive connection while Node proves the brief)
  const health2 = await fetch(`${base}/v1/health`).catch(() => fetch(`${base}/v1/health`));
  check("health offers the cloud proof (the engine is wired in)", (await health2.json()).proof === true);
  const t0 = Date.now();
  const p1 = await ask({ "x-judge-token": TOKEN, "cf-connecting-ip": "198.51.100.20" });
  const a1 = p1.status === 200 ? await p1.json() : { error: await p1.text() };
  const coldMs = Date.now() - t0;
  // everything but the timings and where it ran: every chip, the par, the headline, the trails, the ghost, the playtest
  // (with T3h's chips and T4's model on it, their timings left out too)
  const stillPt = (p) => ({ ...p, ms: 0, ...(p.human ? { human: p.human.map((c) => ({ ...c, ms: 0 })) } : {}), ...(p.model ? { model: { ...p.model, ms: 0 } } : {}) });
  const still = (r) => JSON.parse(JSON.stringify({ ...r, ms: 0, host: "", chips: r.chips.map((c) => ({ ...c, ms: 0 })), ...(r.playtest ? { playtest: stillPt(r.playtest) } : {}) }));
  const cloud = a1.receipt ? still(a1.receipt) : null;
  const device = still(mine.receipt);
  const firstOff = cloud ? device.chips.findIndex((c, i) => JSON.stringify(c) !== JSON.stringify(cloud.chips[i])) : -1;
  check("the Worker proves the CTF brief on its shards, host edge", p1.status === 200 && a1.receipt.host === "edge" && a1.shards > 0 && a1.cached === null, `${p1.status} ${a1.error ?? ""} ${a1.shards} shards, ${coldMs} ms (Node ${mine.ms} ms)`);
  check("its receipt is Node's chip for chip", cloud !== null && firstOff === -1 && cloud.chips.length === device.chips.length, firstOff >= 0 ? `first differs: ${device.chips[firstOff].id}` : `${device.chips.length} chips`);
  check("its T3h chips and T4 model came with the playtest", Boolean(cloud?.playtest?.human?.length && cloud?.playtest?.model), cloud?.playtest ? `${cloud.playtest.human?.length ?? 0} T3h chips, T4 ${cloud.playtest.model ? "yes" : "no"}` : "no playtest");
  check("and in everything else: headline, par, trails, ghost, playtest", cloud !== null && JSON.stringify(cloud) === JSON.stringify(device), cloud ? ["headline", "par", "trails", "ghost", "playtest"].filter((k) => JSON.stringify(cloud[k]) !== JSON.stringify(device[k])).join(",") || "all same" : "no receipt");
  const t1 = Date.now();
  const p2 = await ask({ "x-judge-token": TOKEN, "cf-connecting-ip": "198.51.100.21" });
  const a2 = await p2.json();
  check("a repeat is answered from the store at once", p2.headers.get("x-proof") === "hit" && typeof a2.cached === "string" && JSON.stringify(still(a2.receipt)) === JSON.stringify(cloud), `${p2.headers.get("x-proof")} in ${Date.now() - t1} ms`);
  for (const [name, m] of [["museum-bribe", more[0]], ["villa-viewing", more[1]]]) {
    const r = await ask({ "x-judge-token": TOKEN, "cf-connecting-ip": "198.51.100.23" }, m.input);
    const a = r.status === 200 ? await r.json() : null;
    check(`${name}: the cloud's receipt is Node's, chip for chip and in everything else`, a !== null && JSON.stringify(still(a.receipt)) === JSON.stringify(still(m.receipt)), a ? `${a.receipt.chips.length} chips, ${a.shards} shards` : String(r.status));
  }
  const wrong = await ask({ "x-judge-token": TOKEN }, { ...mine.input, spec: "0".repeat(64) });
  check("a spec hash the fill doesn't place is turned away (409)", wrong.status === 409 && (await wrong.json()).spec === mine.input.spec);
  const anonProof = await ask({ "cf-connecting-ip": "198.51.100.22" });
  check("tokenless without a session cookie: 401, nothing proved", anonProof.status === 401);
  await fetch(`${base}/__flags`, { method: "POST", body: JSON.stringify({ "ff.edge_proof": "off" }) });
  const off = await ask({ "x-judge-token": TOKEN });
  const offHealth = await (await fetch(`${base}/v1/health`)).json();
  check("ff.edge_proof = off: 503, and health stops offering it", off.status === 503 && offHealth.proof === false, String(off.status));
  await fetch(`${base}/__flags`, { method: "POST", body: JSON.stringify({ "ff.edge_proof": null }) });

  // 12. The canaries, as their crons run them: health and the stored brief, the fresh golden proof (twice:
  // the second must equal the first), the live build on the canary pool. Each keeps its run in FLAGS.
  const cron = async (c) => (await fetch(`${base}/__cron?cron=${encodeURIComponent(c)}`)).json();
  const k15 = await cron("*/15 * * * *");
  const run = (kv, kind) => (kv[`canary:${kind}`] ? JSON.parse(kv[`canary:${kind}`]) : null);
  check("15-min canary: self health and the stored proof of the brief pass", run(k15, "health")?.ok === true && run(k15, "stored_proof")?.ok === true && /stored receipt/.test(run(k15, "stored_proof").detail), JSON.stringify([run(k15, "health"), run(k15, "stored_proof")]));
  await cron("5 */2 * * *");
  const k2 = await cron("5 */2 * * *");
  check("2-h canary: a fresh proof of the golden world equals the one kept", run(k2, "fresh_proof")?.ok === true && /same receipt/.test(run(k2, "fresh_proof").detail), JSON.stringify(run(k2, "fresh_proof")));
  const canaryBefore = (await pool("canary")).spent;
  const k12 = await cron("35 */12 * * *");
  const canaryAfter = await until(async () => ((await pool("canary")).spent > canaryBefore ? pool("canary") : null));
  check("12-h canary: one live build on the canary pool, committed there", run(k12, "live_build")?.ok === true && canaryAfter !== null && canaryAfter.held === 0, `${JSON.stringify(run(k12, "live_build"))} spent ${canaryBefore} → ${canaryAfter?.spent}`);
  const h = await (await fetch(`${base}/v1/health`)).json();
  check("health shows the canaries: {at, ok}", h.canary?.ok === true && typeof h.canary.at === "string", JSON.stringify(h.canary));

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
