// A proof in pieces: the runs and jump attempts witnesses() lists, played in shards (out of order,
// each shard with its own navmesh, the results through JSON as they cross the wire), handed to
// prove() give the very receipt the one-piece proof gives, playtest and all, playing nothing more.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { arena } from "@ghostrun/pack-arena";
import { cityBlock } from "@ghostrun/pack-city-block";
import { floorPlan } from "@ghostrun/pack-floor-plan";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { comparable, playWitnesses, prove, receiptHash, SKILL_RUNS, t0, witnesses, witnessKey, type Witness } from "../src";

const ENGINE = "e".repeat(64);
let R: Rapier;

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

function world(file: string, pack: "city" | "arena" | "floor"): WorldBundle {
  const text = readFileSync(new URL(`../../ir/fixtures/${file}.jsonl`, import.meta.url), "utf8");
  const seed = (JSON.parse(text.split("\n", 1)[0]!) as { seed?: number }).seed ?? 7;
  const fill = parseFill(text, { seed });
  const at = { seed, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false };
  const layout = pack === "city" ? cityBlock.generate({ ...at, params: cityBlock.defaults }) : pack === "floor" ? floorPlan.generate({ ...at, params: floorPlan.defaults }) : arena.generate({ ...at, params: arena.defaults });
  return placeWorld({ ...fill.draft, engine: ENGINE }, layout).bundle;
}

/** A shard: its own copy of the world's navmesh and win chain, as a ProofShard DO builds them. */
function shard(b: WorldBundle, ws: Witness[]): [string, unknown][] {
  const s0 = t0(b, "red");
  const nav = buildNav(b);
  try {
    return JSON.parse(JSON.stringify(playWitnesses(R, b, nav, s0.chain, s0.openers, ws))) as [string, unknown][];
  } finally {
    nav.destroy();
  }
}

/** Played results that count what prove() had to play itself. */
class Counting extends Map<string, unknown> {
  misses = 0;
  override get(k: string) {
    const v = super.get(k);
    if (v === undefined) this.misses++;
    return v;
  }
}

describe("a proof played in shards", () => {
  // the CTF brief, zombies, a race, a guard talked round with a bribe (act runs, the guard's options in the envelope), a villa toured with a viewing booked
  for (const [file, pack] of [["ctf-neon", "city"], ["zombie-survival", "arena"], ["kart-race", "arena"], ["museum-bribe", "floor"], ["villa-viewing", "floor"]] as const) {
    it(`gives the one-piece receipt for ${file}, chip for chip`, async () => {
      const b = world(file, pack);
      const whole = await prove(R, b, { engine: ENGINE, host: "device", playtest: true });
      const ws = witnesses(b, t0(b, "red").chain, 12, "red", SKILL_RUNS);
      expect(new Set(ws.map(witnessKey)).size).toBe(ws.length);
      // three shards, dealt round-robin from the back (no shard plays them in the ladder's order)
      const back = [...ws].reverse();
      const parts = [0, 1, 2].map((s) => shard(b, back.filter((_, i) => i % 3 === s)));
      const played = new Counting(parts.flat());
      const pieces = await prove(R, b, { engine: ENGINE, host: "edge", playtest: true, played: Promise.resolve(played) });
      expect(played.misses).toBe(0);
      expect(pieces.host).toBe("edge");
      expect(comparable(pieces)).toEqual(comparable(whole));
      expect(await receiptHash(pieces)).toBe(await receiptHash(whole));
      expect(pieces.playtest?.levels).toEqual(whole.playtest?.levels);
    }, 300_000);
  }

  it("keeps the same failing run when nobody wins (the CTF brief with red's goal 40 m up)", async () => {
    const b = structuredClone(world("ctf-neon", "city"));
    const goal = b.entities.find((e) => e.id === "goal_red")!;
    goal.pos = [goal.pos[0], goal.pos[1] + 40, goal.pos[2]];
    const whole = await prove(R, b, { engine: ENGINE, runs: 4 });
    expect(whole.failRun).toBeDefined();
    const ws = witnesses(b, t0(b, "red").chain, 4, "red");
    const played = new Counting([...shard(b, ws.filter((_, i) => i % 2 === 1)), ...shard(b, ws.filter((_, i) => i % 2 === 0))]);
    const pieces = await prove(R, b, { engine: ENGINE, runs: 4, played });
    expect(played.misses).toBe(0);
    // (through JSON, as a receipt always travels: a shard's results came that way, so a -0 in the ghost is a 0)
    expect(JSON.stringify(pieces.failRun)).toBe(JSON.stringify(whole.failRun));
    expect(comparable(pieces)).toEqual(comparable(whole));
  }, 300_000);

  it("plays what a shard didn't send back", async () => {
    const b = world("zombie-survival", "arena");
    const whole = await prove(R, b, { engine: ENGINE, runs: 6 });
    const ws = witnesses(b, t0(b, "red").chain, 6, "red");
    const played = new Counting(shard(b, ws.filter((_, i) => i % 2 === 0)));
    const pieces = await prove(R, b, { engine: ENGINE, runs: 6, played });
    expect(played.misses).toBe(Math.floor(ws.length / 2));
    expect(comparable(pieces)).toEqual(comparable(whole));
  }, 300_000);

  it("compares receipts without their timings or where they ran", async () => {
    const b = world("zombie-survival", "arena");
    const r = await prove(R, b, { engine: ENGINE, runs: 3 });
    const elsewhere = { ...r, host: "edge" as const, ms: r.ms + 999, chips: r.chips.map((c) => ({ ...c, ms: c.ms + 1 })) };
    expect(await receiptHash(elsewhere)).toBe(await receiptHash(r));
    const off = { ...r, par: r.par ? { ...r.par, goldS: r.par.goldS + 0.1 } : { goldS: 1, runs: 3, won: 1 } };
    expect(await receiptHash(off)).not.toBe(await receiptHash(r));
  }, 120_000);
});
