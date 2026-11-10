// The four newer packs, each through a hand-written world the app opens as ?fixture=<name>: it is
// placed on its own pack, and the receipt comes back clean: every check verified, 12 of 12 AI
// runners winning (or, for a place, the AI visitor touring every thing in it).
import { beforeAll, describe, expect, it } from "vitest";
import { pinLayout, splitObjects } from "@ghostrun/ir";
import { loadNavNode } from "@ghostrun/nav/node";
import { prove } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { pickLook } from "../src/render/pick";
import { ENGINE_HASH, FIXTURES, worldFromFill } from "../src/pipeline";
import { layoutPatch, mergeEdit } from "../src/structure";

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

const seedOf = (fill: string) => (JSON.parse(splitObjects(fill.split("\n", 1)[0]!)[0]!) as { seed: number }).seed;

describe("the newer packs' fixtures", () => {
  it.each([
    ["cafe", "service_venue", "play", "home", true],
    ["escape", "puzzle_rooms", "play", "gallery", true],
    ["concert", "stage", "wander", "gallery", true],
    ["solar", "orrery", "play", "space", false],
  ] as const)("%s: placed on %s, a clean receipt", async (name, pack, mode, look, indoor) => {
    const fill = FIXTURES[name]!;
    const w = worldFromFill(fill, seedOf(fill));
    expect([w.bundle.pack.id, w.bundle.mode]).toEqual([pack, mode]);
    expect(w.notes.filter((n) => /not in|not available/.test(n))).toEqual([]);
    const pick = pickLook(w.cue);
    expect([pick.id, pick.indoor]).toEqual([look, indoor]);
    const r = await prove(R, w.bundle, { engine: ENGINE_HASH, runs: 12 });
    expect(r.chips.filter((c) => c.status === "counterexample").map((c) => `${c.id}: ${c.cx?.text ?? c.text}`)).toEqual([]);
    expect(["verified", "played"]).toContain(r.headline?.status);
    if (mode === "play") expect(r.chips.find((c) => c.id === "T3:win")).toMatchObject({ k: 12, n: 12 });
    else expect(r.chips.find((c) => c.id === "T3:tour")).toMatchObject({ status: "played" });
  }, 120_000);

  it("a structural edit on a new pack: two more puzzle rooms, then a bigger café, said in the edit's words and placed again", () => {
    const escape = worldFromFill(FIXTURES.escape!, seedOf(FIXTURES.escape!));
    const more = mergeEdit(pinLayout(escape.fill), '{"op":"layout","params":{"rooms":6}}', escape.seed);
    expect(more.layout!.summary.slice(0, 2)).toEqual(["rooms 4 → 6", "2 rooms added"]);
    const rebuilt = worldFromFill(more.text, escape.seed);
    expect(rebuilt.bundle.statics.length).toBeGreaterThan(escape.bundle.statics.length);
    expect(layoutPatch(FIXTURES.cafe!, { scale: 1.25 })).toBe('{"op":"layout","params":{"width":30,"depth":23}}') // (the merge steps it onto the schema);
  });

  it("the orrery says its distances are scaled, in its notes and on the sign by the entrance", () => {
    const w = worldFromFill(FIXTURES.solar!, seedOf(FIXTURES.solar!));
    expect(w.notes[0]).toMatch(/^orrery: distances scaled \(√AU × 6 m: Earth 6 m from the Sun, Neptune 32\.9 m; true to scale it would be 180\.42 m\), planet sizes not to scale$/);
    expect(w.bundle.entities.find((e) => e.id === "scale_sign")).toBeDefined();
  });
});
