// The proof ladder on worlds you talk your way through: a museum guard you bribe to look away
// while you carry the star sapphire past it, and a villa whose estate agent books a viewing.
// No mind in the proof: a runner says the act the way the world's rule wants it said, and the rule
// decides.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { loadNavNode } from "@ghostrun/nav/node";
import { floorPlan } from "@ghostrun/pack-floor-plan";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { caught, chipLine, plants, prove, t0 } from "../src";

const ENGINE = "e".repeat(64);
let R: Rapier;

function place(name: string): WorldBundle {
  const text = readFileSync(new URL(`../../ir/fixtures/${name}.jsonl`, import.meta.url), "utf8");
  const fill = parseFill(text, { seed: 1 });
  expect(fill.notes.filter((n) => n.kind === "invalid" || n.kind === "unresolved")).toEqual([]);
  const layout = floorPlan.generate({ seed: fill.draft.seed, params: floorPlan.defaults, sub: [], laws: fill.draft.laws, harder: false });
  return placeWorld({ ...fill.draft, engine: ENGINE }, layout).bundle;
}

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

describe("the museum guard you can bribe", () => {
  it("regresses the win through the bribe, forces it, and runners collect coins, pay the guard and carry the sapphire past it, whatever it chooses", async () => {
    const world = place("museum-bribe");
    const receipt = await prove(R, world, { engine: ENGINE, runs: 12 });
    console.log(["", ...receipt.chips.map(chipLine)].join("\n"));
    const chip = (id: string) => receipt.chips.find((c) => c.id === id)!;
    expect(chip("T0:win_chain").status).toBe("verified");
    expect(chip("T0:win_chain").text).toMatch(/pick up gem \[past r_caught ← r_bribe \(offer guard 20 coins\) \[after 20 coins\]\]$/);
    expect(chip("T0:afford:r_bribe")).toMatchObject({ status: "verified", text: "r_bribe can be paid: 20 coins needed, 60 to be had" });
    const t2 = receipt.chips.filter((c) => c.tier === "T2");
    expect(t2).toHaveLength(world.rules.length);
    expect(t2.filter((c) => c.status !== "verified").map((c) => c.text)).toEqual([]);
    expect(chip("T2:r_bribe").status).toBe("verified");
    expect(chip("T2:r_caught").status).toBe("verified");
    expect(chip("T3:win").k).toBeGreaterThanOrEqual(10);
    // the guard locked to each option on its menu in turn (watch, patrol, look away)
    expect(chip("T3:envelope")).toMatchObject({ status: "played", n: 9, text: "holds for every choice the guard can make (3 schedules)" });
    expect(chip("T3:envelope").k).toBeGreaterThanOrEqual(8);
    expect(receipt.headline?.status).toBe("verified");
  }, 120_000);

  it("without the bribe, the guard catches every runner carrying the sapphire out", async () => {
    const world = place("museum-bribe");
    world.rules = world.rules.filter((r) => r.id !== "r_bribe");
    const receipt = await prove(R, world, { engine: ENGINE, runs: 4 });
    const win = receipt.chips.find((c) => c.id === "T3:win")!;
    expect(win.status).toBe("counterexample");
    expect(win.cx?.text).toMatch(/caught by the night guard ×4/);
  }, 120_000);

  it("a bribe that can never be afforded is a plant the static check catches", async () => {
    const world = place("museum-bribe");
    const plant = plants(world, 14).find((p) => p.id === "bribe_unaffordable")!;
    expect(plant.text).toBe("the night guard wants 70 coins, and the world holds 60");
    const { chips } = t0(plant.bundle);
    expect(chips.find((c) => c.id === "T0:afford:r_bribe")).toMatchObject({ status: "counterexample", text: "r_bribe can never be paid: it needs 70 coins, and the world gives 60" });
    const after = await prove(R, plant.bundle, { engine: ENGINE, runs: 2 });
    const got = caught(after);
    expect(got.caught).toBe(true);
    expect(got.by).toMatchObject({ id: "T0:win_chain", text: "the night guard catches you holding the star sapphire, and nothing it accepts can be done: it wants 70 coins, and 60 can be had" });
  }, 120_000);
});

describe("the villa whose agent books a viewing", () => {
  it("forces the booking and the tour books one: every room walked, the act said, the slot recorded", async () => {
    const world = place("villa-viewing");
    const receipt = await prove(R, world, { engine: ENGINE, runs: 12 });
    console.log(["", ...receipt.chips.map(chipLine)].join("\n"));
    expect(receipt.chips.find((c) => c.id === "T2:r_book")?.status).toBe("verified");
    const tour = receipt.chips.find((c) => c.id === "T3:tour")!;
    expect(tour).toMatchObject({ status: "played", n: 7, k: 7 });
    expect(tour.text).toBe("walked to and inspected 6 of 6 things, and 1 of 1 speech acts came off (book with guide)");
    expect(receipt.headline).toMatchObject({ status: "played" });
  }, 120_000);

  it("a booking the agent can never take is the tour's counterexample", async () => {
    const world = place("villa-viewing");
    const r = world.rules.find((x) => x.id === "r_book")!;
    r.if = [{ l: "guide.state", op: "eq", r: "never", forS: 0 }];
    const receipt = await prove(R, world, { engine: ENGINE, runs: 2 });
    const tour = receipt.chips.find((c) => c.id === "T3:tour")!;
    expect(tour).toMatchObject({ status: "counterexample", n: 7, k: 6 });
    expect(tour.cx?.text).toBe("couldn't book with guide");
  }, 120_000);
});
