// Wins a fill wrote that can't happen as written, and what the placer makes of them (arena layouts).
import { describe, expect, it } from "vitest";
import { mergeFill, parseFill, pinLayout } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { packFor } from "@ghostrun/registry";
import { worldFromFill } from "../src/pipeline";

const arena = packFor("arena");

describe("wins that can't happen as written", () => {
  const head = ['{"op":"meta","mode":"play","pack":"arena","seed":7}', '{"op":"zone","id":"z_mid","slot":"midfield","tag":"center"}', '{"op":"zone","id":"z_n","slot":"north_deck","tag":"platform"}', '{"op":"spawn","id":"sp_red","zone":"z_mid","team":"red"}'];
  // (a fresh fill nobody wrote laws for may be allowed a jump the win needs; one with a law line never)
  const arenaFill = (lines: string[], laws = "") => {
    const fill = parseFill([...head, ...lines, laws].filter(Boolean).join("\n"), { seed: 7 });
    const layout = arena.generate({ seed: 7, params: arena.defaults, sub: [], laws: fill.draft.laws, harder: false });
    return placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout, { reach: !laws });
  };
  const cans = [
    '{"op":"ent","id":"can_1","kind":"pickup","zone":"z_mid","anchor":"center_n"}',
    '{"op":"ent","id":"can_2","kind":"pickup","zone":"z_n","anchor":"deck_center"}',
    '{"op":"verb","id":"vb_1","verb":"puzzle.collect","on":"can_1"}',
    '{"op":"verb","id":"vb_2","verb":"puzzle.collect","on":"can_2"}',
  ];

  it("cans to collect and no rule that wins: collecting them all wins, and one up on a deck two jumps high allows two jumps", () => {
    const { bundle, notes } = arenaFill(cans);
    expect(bundle.rules.find((r) => r.id === "r_win_all")).toMatchObject({ when: { t: "score_gte", a: "team:red", n: 2 }, then: [{ e: "win" }] });
    expect(bundle.rules.filter((r) => r.when.t === "touch" && r.when.b.startsWith("can_")).map((r) => [r.when.b, r.then[0]!.e])).toEqual([["can_1", "score"], ["can_2", "score"]]);
    expect(bundle.laws.jumpsMax).toBe(2);
    expect(notes.some((n) => n.startsWith("laws: can_2 stands 2.6 m up"))).toBe(true);
  });

  it("laws someone wrote are kept: one jump written, or an edit to one jump on a two-jump world, stays one jump (the broken promise shows)", () => {
    expect(arenaFill(cans, '{"op":"law","player":{"jumpsMax":1}}').bundle.laws.jumpsMax).toBe(1);
    const two = worldFromFill([...head, ...cans, '{"op":"law","player":{"jumpsMax":2}}', '{"op":"end","layer":"gameplay"}'].join("\n"), 7);
    expect(two.bundle.laws.jumpsMax).toBe(2);
    const edited = mergeFill(pinLayout(two.fill), '{"op":"law","player":{"jumpsMax":1}}', { edit: true }).text;
    const one = worldFromFill(edited, 7, undefined, "arena", "play");
    expect(one.bundle.laws.jumpsMax).toBe(1);
    expect(one.notes.some((n) => n.startsWith("laws:"))).toBe(false);
  });

  it("a goal of 15 points from four drones knocked out for good, a point each, is 4", () => {
    const { bundle, notes } = arenaFill([
      ...[1, 2, 3, 4].flatMap((i) => [
        `{"op":"ent","id":"drone_${i}","kind":"npc","zone":"z_mid","team":"blue"}`,
        `{"op":"verb","id":"vb_hp_${i}","verb":"combat_sport.health","on":"drone_${i}","params":{"hp":20,"respawn":false}}`,
        `{"op":"rule","id":"r_ko_${i}","when":{"t":"health_lte","a":"drone_${i}","n":0},"then":[{"e":"score","target":"team:red","n":1}]}`,
      ]),
      '{"op":"verb","id":"vb_gun","verb":"combat_sport.shoot","on":"player"}',
      '{"op":"rule","id":"r_win","when":{"t":"score_gte","a":"team:red","n":15},"then":[{"e":"win","target":"player"}]}',
    ]);
    expect(bundle.rules.find((r) => r.id === "r_win")!.when.n).toBe(4);
    expect(notes).toContain("rule r_win: team:red can score at most 4, so its goal of 15 is 4");
  });
});
