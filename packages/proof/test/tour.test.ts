// The tour's visitor through a doorway whose two corners sit closer together than its turn: passing
// both early aimed it across the jamb, and it stood against the foyer's east wall for the whole run.
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { floorPlan } from "@ghostrun/pack-floor-plan";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { tour } from "../src/t3";

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

const placeWith = (anchor: string) => {
  const lines = [
    JSON.stringify({ op: "meta", mode: "wander", lang: "en", pack: "floor_plan", sub: [], seed: 9, look: "a gallery" }),
    '{"op":"zone","id":"z_yard","slot":"yard","tag":"outside","name":"Yard"}',
    '{"op":"zone","id":"z_foyer","slot":"entrance","tag":"entrance","name":"Foyer"}',
    '{"op":"zone","id":"z_se","slot":"room_se","tag":"room","name":"South-east room"}',
    '{"op":"spawn","id":"sp_red","zone":"z_yard","anchor":"spawn_pad","team":"red"}',
    JSON.stringify({ op: "ent", id: "bag", kind: "prop", noun: "red bag", hyper: "thing", zone: "z_se", anchor, body: "fixed", shape: "box", size: [0.6, 1, 0.6] }),
    '{"op":"verb","id":"v_bag","verb":"social.inspect","on":"bag","params":{"text":"a red silk clutch"}}',
    '{"op":"end","layer":"gameplay"}',
    '{"op":"end","layer":"cosmetic"}',
  ];
  const fill = parseFill(lines.join("\n"), { seed: 9 });
  const layout = floorPlan.generate({ seed: 9, params: floorPlan.defaults, sub: [], laws: fill.draft.laws, harder: false });
  return placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout).bundle;
};

describe("the tour through a doorway", () => {
  it("walks through the foyer's east doorway to a thing at the centre of the south-east room, not into the jamb", () => {
    const b = placeWith("center");
    const chip = tour(R, b, buildNav(b))!;
    expect(chip).toMatchObject({ status: "played", k: 1, n: 1 });
  });
});
