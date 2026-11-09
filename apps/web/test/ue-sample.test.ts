// docs/UE.md's worked sample: the organizer's CTF brief (packages/ir/fixtures/ctf-neon.jsonl) as the
// export writes its logic.json, proved in Node as the app proves it. The committed file is checked
// against what the exporter writes today, so the document's sample can't drift from the code.
import { beforeAll, describe, expect, it } from "vitest";
import { splitObjects } from "@ghostrun/ir";
import { loadNavNode } from "@ghostrun/nav/node";
import { prove } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { logicJson } from "../src/export";
import { ENGINE_HASH, FIXTURES, hashWorld, worldFromFill } from "../src/pipeline";

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

describe("docs/UE.md's worked sample", () => {
  it("ctf-neon's logic.json is what the export writes", async () => {
    const fill = FIXTURES.ctf!;
    const w = worldFromFill(fill, (JSON.parse(splitObjects(fill.split("\n", 1)[0]!)[0]!) as { seed: number }).seed);
    const receipt = await prove(R, w.bundle, { engine: ENGINE_HASH, runs: 12, host: "node" });
    const logic = logicJson(w.bundle, await hashWorld(w.bundle), receipt);
    expect(logic.rules.map((r) => r.id)).toContain("r_score_red");
    await expect(`${JSON.stringify(logic, null, 2)}\n`).toMatchFileSnapshot("../../../docs/ue/ctf-neon.logic.json");
  }, 120_000);
});
