// The workerd test's Node side: worlds proved exactly as the device proves them (prove() with the
// playtest, the default runners), each printed with the request the client would send for it, so
// the test can ask the Worker for the same world and compare the receipts chip for chip.
//   node dist/node-proof/node-proof.mjs [--jobs] [fixture.jsonl | gallery world.json …]
// (default: the organizer's CTF brief). --jobs also times the proof's parts one by one for
// scripts/time-proof.mjs: each shard job alone, a shard's own set-up, and the Worker's own part.
import { readFileSync } from "node:fs";
import { specHash } from "@ghostrun/ir";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { playWitnesses, prove, SKILL_RUNS, t0, witnesses, witnessKey } from "@ghostrun/proof";
import { loadRapierNode } from "@ghostrun/sim/node";
import { ENGINE_HASH, placeFill, PROOF_VERSION } from "@ghostrun/world";
import CTF from "../../../../packages/ir/fixtures/ctf-neon.jsonl?raw";
import { dealOrder } from "../../src/shard";

type Mode = "play" | "wander";
/** A recorded fill (its meta line names its pack and mode), or a gallery world (its intent does). */
function world(path: string | null): { fill: string; pack?: string; mode?: Mode } {
  if (!path) return { fill: CTF };
  const text = readFileSync(path, "utf8");
  if (!path.endsWith(".json")) return { fill: text };
  const g = JSON.parse(text) as { fill: string; intent: { pack: string; mode: Mode } };
  return { fill: g.fill, pack: g.intent.pack, mode: g.intent.mode };
}

const R = await loadRapierNode();
await loadNavNode();
const timeJobs = process.argv.includes("--jobs");
const files = process.argv.slice(2).filter((a) => a !== "--jobs");
const now = () => performance.now();
const out = [];
for (const w of files.length ? files.map(world) : [world(null)]) {
  const fill = w.fill;
  const meta = JSON.parse(fill.split("\n", 1)[0] ?? "{}") as { seed?: number; pack?: string; mode?: Mode };
  const seed = meta.seed ?? 7;
  const pack = w.pack ?? meta.pack;
  const mode = w.mode ?? meta.mode;
  const placed = placeFill(fill, seed, { pack, mode });
  const b = placed.bundle;
  const start = now();
  const receipt = await prove(R, b, { engine: ENGINE_HASH, host: "device", playtest: true });
  const ms = Math.round(now() - start);
  let parts: Record<string, unknown> = {};
  if (timeJobs) {
    // a shard's set-up: place the world, its win chain, its navmesh
    const s = now();
    const again = placeFill(fill, seed, { pack, mode }).bundle;
    const s0 = t0(again, "red");
    const nav = buildNav(again);
    const setupMs = now() - s;
    const jobs = dealOrder(witnesses(b, s0.chain, 12, "red", SKILL_RUNS));
    const played = new Map<string, unknown>();
    const jobMs = jobs.map((j) => {
      const q = now();
      for (const [k, v] of playWitnesses(R, again, nav, s0.chain, s0.openers, [j])) played.set(k, v);
      return { key: witnessKey(j), ms: Math.round(now() - q) };
    });
    nav.destroy();
    // the Worker's own part: the ladder with every shard job already played
    const c = now();
    await prove(R, b, { engine: ENGINE_HASH, host: "edge", playtest: true, played });
    parts = { setupMs: Math.round(setupMs), coordinatorMs: Math.round(now() - c), jobs: jobMs };
  }
  out.push({ input: { v: 1, fill, seed, ...(pack ? { pack } : {}), ...(mode ? { mode } : {}), engine: ENGINE_HASH, spec: await specHash(ENGINE_HASH, b), version: PROOF_VERSION }, receipt, ms, ...parts });
}
process.stdout.write(JSON.stringify(out));
