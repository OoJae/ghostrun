import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { cityBlock } from "@ghostrun/pack-city-block";
import { placeWorld } from "@ghostrun/layout";
import { loadNavNode } from "@ghostrun/nav/node";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { chipLine, prove } from "../src";

const ctf = readFileSync(new URL("../../ir/fixtures/ctf-neon.jsonl", import.meta.url), "utf8");
const ENGINE = "e".repeat(64);
let R: Rapier;
let world: WorldBundle;

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
  const fill = parseFill(ctf, { seed: 7 });
  const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  world = placeWorld({ ...fill.draft, engine: ENGINE }, layout).bundle;
});

describe("proof ladder on the organizer's CTF brief", () => {
  it("verifies the headline, force-tests every rule, and AI runners win in physics", async () => {
    const receipt = await prove(R, world, { engine: ENGINE, runs: 12 });
    const lines = receipt.chips.map(chipLine);
    console.log(["", `spec ${receipt.spec.slice(0, 8)} · ${receipt.ms} ms`, ...lines, `par: ${JSON.stringify(receipt.par)}`].join("\n"));
    expect(receipt.headline).toMatchObject({ expect: "x_roof", text: "Rooftop lane needs double jump", status: "verified" });
    const t2 = receipt.chips.filter((c) => c.tier === "T2");
    expect(t2).toHaveLength(world.rules.length);
    expect(t2.every((c) => c.status === "verified")).toBe(true);
    expect(receipt.chips.find((c) => c.id === "T0:win_chain")?.status).toBe("verified");
    const win = receipt.chips.find((c) => c.id === "T3:win")!;
    expect(win.status).toBe("played");
    expect(win.k).toBeGreaterThanOrEqual(10); // ≥10 of 12 runners win
    expect(receipt.chips.find((c) => c.id === "T3:x_roof")?.status).toBe("played");
    expect(receipt.par!.goldS).toBeGreaterThan(5);
  }, 60_000);

  it("catches a broken level: a 4 m ledge is a counterexample with the missing height", async () => {
    const broken = structuredClone(world);
    for (const s of broken.statics.filter((x) => x.surf === "ledge")) {
      s.size = [s.size[0], 4, s.size[2]];
      s.pos = [s.pos[0], 2, s.pos[2]];
    }
    const receipt = await prove(R, broken, { engine: ENGINE, runs: 2 });
    const t1 = receipt.chips.find((c) => c.id === "T1:x_roof")!;
    expect(t1.status).toBe("counterexample");
    expect(t1.cx?.text).toMatch(/^apex 3(\.\d+)? m < ledge 4 m$/);
    expect(receipt.headline?.status).toBe("counterexample");
  }, 60_000);
});
