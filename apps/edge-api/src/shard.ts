// The cloud proof in pieces. T3's runs and jump attempts, and the playtest's runs, are independent
// fresh simulations (witnesses() in @ghostrun/proof), so the Worker deals them out to ProofShard
// Durable Objects, each on a thread of its own: one job per request and the next as each answers,
// so a long run never holds the rest up. A shard keeps the world it was sent (placed, its navmesh
// built) while it is asked for more. The results go back to prove() by witness key, and prove()
// plays whatever is missing itself: a shard that fails or is slow costs time, never the answer.
import type { WorldBundle } from "@ghostrun/ir";
import { buildNav, type NavWorld } from "@ghostrun/nav";
import { playWitnesses, t0, type PlanStep, type Played, type WinChain, type Witness } from "@ghostrun/proof";
import { PROOF_VERSION } from "@ghostrun/world";
import type { DoNamespace } from "./cf";
import { engine } from "./engine";
import { placeFill } from "./world";

/** The world as the client sent it: a shard places it again (the same pipeline, so the same world). */
export interface ShardWorld {
  fill: string;
  seed: number;
  pack?: string;
  mode?: "play" | "wander";
  spec: string;
}

interface ShardJob {
  version: string;
  world: ShardWorld;
  jobs: Witness[];
}

/** A shard frees its navmesh this long after its last job (its wasm memory isn't the isolate's to drop). */
const IDLE_MS = 20_000;

interface Held {
  spec: string;
  b: WorldBundle;
  nav: NavWorld;
  chain: WinChain | null;
  openers: ReadonlyMap<string, PlanStep[]>;
}

export class ProofShardDO {
  private held: Held | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;

  async fetch(req: Request): Promise<Response> {
    try {
      const job = (await req.json()) as ShardJob;
      // a shard on other code (mid-deploy) would prove another proof: the Worker plays these itself
      if (job.version !== PROOF_VERSION) return Response.json({ error: "proof version differs" }, { status: 409 });
      const rapier = engine();
      if (!rapier) return Response.json({ error: "no engine" }, { status: 503 });
      const R = await rapier;
      const w = await this.world(job.world);
      if (!w) return Response.json({ error: "spec differs" }, { status: 409 });
      const results = playWitnesses(R, w.b, w.nav, w.chain, w.openers, job.jobs);
      clearTimeout(this.idle);
      this.idle = setTimeout(() => this.drop(), IDLE_MS);
      return Response.json({ results });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message.slice(0, 200) : "shard failed" }, { status: 500 });
    }
  }

  private async world(sent: ShardWorld): Promise<Held | null> {
    if (this.held?.spec === sent.spec) return this.held;
    this.drop();
    const { bundle: b, spec } = await placeFill(sent.fill, sent.seed, { pack: sent.pack, mode: sent.mode });
    if (spec !== sent.spec) return null;
    const s0 = t0(b, "red");
    this.held = { spec: sent.spec, b, nav: buildNav(b), chain: s0.chain, openers: s0.openers };
    return this.held;
  }

  private drop() {
    this.held?.nav.destroy();
    this.held = null;
  }
}

/**
 * The likeliest long runs first (novices lose most, and a lost run plays out the clock), the short
 * jump attempts last, to fill in round the long ones.
 */
export function dealOrder(jobs: readonly Witness[]): Witness[] {
  const rank = (w: Witness) => (w.kind === "jump" ? 4 : w.kind === "human" ? 1 : w.level === "novice" ? 0 : w.level === "average" ? 1 : w.schedule?.length ? 2 : 3);
  return [...jobs].map((w, i) => ({ w, i })).sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i).map((x) => x.w);
}

/**
 * Play a proof's jobs on up to `width` shards at once: the receipt's first, then the playtest's.
 * `receipt` resolves once every receipt job is in (so the receipt can go out while the playtest
 * plays on), `all` once every job is. Each shard is named by the world, the proof version and its
 * lane, so two people proving one world at once share them (and the world each holds). A lane that
 * fails stops, leaving its job and the rest to the other lanes and, last, to prove() itself.
 */
export function playOnShards(ns: DoNamespace, world: ShardWorld, jobs: { receipt: readonly Witness[]; playtest: readonly Witness[] }, opts: { width: number; timeoutMs: number }): { receipt: Promise<Played>; all: Promise<Played> } {
  const out = new Map<string, unknown>();
  const queue = [...dealOrder(jobs.receipt).map((w) => ({ w, first: true })), ...dealOrder(jobs.playtest).map((w) => ({ w, first: false }))];
  let left = jobs.receipt.length;
  let firstIn = () => {};
  const receipt = new Promise<Played>((r) => (firstIn = () => r(out)));
  if (!left) firstIn();
  const lane = async (i: number) => {
    const stub = ns.get(ns.idFromName(`${world.spec}:${PROOF_VERSION}:${i}`));
    for (let job = queue.shift(); job; job = queue.shift()) {
      let ok = false;
      try {
        const res = await stub.fetch("https://shard/play", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: PROOF_VERSION, world, jobs: [job.w] } satisfies ShardJob), signal: AbortSignal.timeout(opts.timeoutMs) });
        if (res.ok) for (const [k, v] of ((await res.json()) as { results: [string, unknown][] }).results) out.set(k, v);
        ok = res.ok;
      } catch {
        ok = false;
      }
      if (job.first && --left === 0) firstIn();
      if (!ok) return;
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(opts.width, queue.length) }, (_, i) => lane(i))).then(() => (firstIn(), out));
  return { receipt, all };
}
