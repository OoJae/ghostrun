// A toggle switch starts off, and the AI wrote "when the switch is off, close the gate": forcing
// "off" from "off" is no change, so the test first presses it on, as a player's second press would.
// Before, this read as "never fired when forced", a counterexample the world didn't have.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { loadNavNode } from "@ghostrun/nav/node";
import { cityBlock } from "@ghostrun/pack-city-block";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { t2 } from "../src/t2";

const fillText = readFileSync(new URL("./fixtures/ctf-toggle-gate.fill.jsonl", import.meta.url), "utf8");
let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

describe("T2 on a toggle switch's 'off' rule", () => {
  it("forces the change to off and sees the gate close, once", () => {
    const fill = parseFill(fillText, { seed: 82028 });
    fill.draft.pack = { ...fill.draft.pack, id: "city_block" };
    const layout = cityBlock.generate({ seed: 82028, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    const b = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout).bundle;
    const chips = t2(R, b);
    expect(chips.find((c) => c.id.endsWith("r_gate_close"))).toMatchObject({ status: "verified", k: 1, n: 1 });
    expect(chips.find((c) => c.id.endsWith("r_gate_open"))).toMatchObject({ status: "verified", k: 1, n: 1 });
  });
});
