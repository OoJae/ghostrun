import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { cityBlock } from "@ghostrun/pack-city-block";
import { placeWorld } from "@ghostrun/layout";
import { loadNavNode } from "@ghostrun/nav/node";
import { SimWorld, type InputFrame, type Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { GHOST_EVERY, prove, replayRun, type Receipt } from "../src";

const ctf = readFileSync(new URL("../../ir/fixtures/ctf-neon.jsonl", import.meta.url), "utf8");
const ENGINE = "e".repeat(64);
let R: Rapier;
let world: WorldBundle;
let receipt: Receipt;
/** Every simulation the proof stepped, with the inputs it was given and its state hash at the end. */
const stepped = new Map<SimWorld, InputFrame[]>();
const hashes = new Map<SimWorld, string>();

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
  const fill = parseFill(ctf, { seed: 7 });
  const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  world = placeWorld({ ...fill.draft, engine: ENGINE }, layout).bundle;
  // listen in on every step (the runners' own wrapper binds to this, so it sees theirs too)
  const { step, free } = SimWorld.prototype;
  SimWorld.prototype.step = function (this: SimWorld, input: InputFrame | null) {
    if (input) (stepped.get(this) ?? stepped.set(this, []).get(this)!).push(input);
    return step.call(this, input);
  } as typeof step;
  SimWorld.prototype.free = function (this: SimWorld) {
    hashes.set(this, this.stateHash());
    free.call(this);
  };
  try {
    receipt = await prove(R, world, { engine: ENGINE, runs: 12 });
  } finally {
    Object.assign(SimWorld.prototype, { step, free });
  }
}, 120_000);

describe("the par runner's ghost", () => {
  it("is the fastest winning run, sampled every few ticks from the spawn to the winning moment", () => {
    const g = receipt.ghost!;
    expect(g).toBeDefined();
    expect(Math.round((g.ticks / 60) * 10) / 10).toBe(receipt.par!.goldS);
    const samples = Math.floor(g.ticks / GHOST_EVERY) + 1 + (g.ticks % GHOST_EVERY ? 1 : 0);
    expect(g.prog).toHaveLength(samples);
    expect(g.xyz).toHaveLength(samples * 3);
    expect(g.dir).toHaveLength(samples * 2);
    const spawn = world.entities.find((e) => e.kind === "spawn" && e.team === "red")!;
    expect(Math.hypot(g.xyz[0]! - spawn.pos[0], g.xyz[2]! - spawn.pos[2])).toBeLessThan(0.5);
    // three orbs home: the last sample's progress is the team's third point
    expect(g.prog.at(-1)).toBe(3 * 512);
    expect(g.dir.every((d) => Number.isInteger(d) && d >= -127 && d <= 127)).toBe(true);
    expect(JSON.stringify(g).length).toBeLessThan(24_000); // small enough to keep with the receipt
  });

  it("replays headless from its inputs to the same tick, the same ghost and the same state", () => {
    const g = receipt.ghost!;
    // the main runs come first; the one that won on the par tick is the par runner
    const [sim, inputs] = [...stepped].find(([s]) => s.result === "win" && s.tick === g.ticks)!;
    const r = replayRun(R, world, inputs);
    expect(r.result).toBe("win");
    expect(r.winTick).toBe(g.ticks);
    expect(r.ghost).toEqual(g);
    expect(r.hash).toBe(hashes.get(sim));
  });

  it("a replay that stops short of the win has no ghost and no win tick", () => {
    const g = receipt.ghost!;
    const [, inputs] = [...stepped].find(([s]) => s.result === "win" && s.tick === g.ticks)!;
    const r = replayRun(R, world, inputs.filter((f) => f.tick < g.ticks - 120));
    expect(r.result).toBeNull();
    expect(r.winTick).toBeNull();
    expect(r.ghost).toBeNull();
    expect(r.ticks).toBe(inputs.filter((f) => f.tick < g.ticks - 120).at(-1)!.tick);
  });
});
