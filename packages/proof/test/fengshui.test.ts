// The Form School's principles, one rule at a time, on small worlds built by hand on the floor plan
// (seed 9: the front door and the doorway into the hall line up, so the hall's back wall is in view).
import { describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { asksFengShui, elementsOf, FENG_SHUI_RULES, fengShui, isCommanding, isMirror, placeWorld, type FengShuiRuleId } from "@ghostrun/layout";
import { arena } from "@ghostrun/pack-arena";
import { floorPlan } from "@ghostrun/pack-floor-plan";
import type { PackLayout } from "@ghostrun/plugin-api";
import { fengShuiFix, fengShuiHead, fengShuiWhy } from "../src";

const head = (look = "a gallery") => [
  JSON.stringify({ op: "meta", mode: "wander", lang: "en", pack: "floor_plan", sub: [], seed: 9, look }),
  '{"op":"zone","id":"z_yard","slot":"yard","tag":"outside","name":"Yard"}',
  '{"op":"zone","id":"z_foyer","slot":"entrance","tag":"entrance","name":"Foyer"}',
  '{"op":"zone","id":"z_hall","slot":"main_room","tag":"hall","name":"Hall"}',
  '{"op":"zone","id":"z_ne","slot":"room_ne","tag":"room","name":"North-east room"}',
  '{"op":"spawn","id":"sp_red","zone":"z_yard","anchor":"spawn_pad","team":"red"}',
];
const ent = (id: string, noun: string, zone: string, anchor: string, size: [number, number, number] = [0.6, 1, 0.6]) => JSON.stringify({ op: "ent", id, kind: "prop", noun, hyper: "thing", zone, anchor, body: "fixed", shape: "box", size });

function world(lines: string[], look?: string, tail: string[] = []): { bundle: WorldBundle; layout: PackLayout; notes: string[] } {
  const fill = parseFill([...head(look), ...lines, '{"op":"end","layer":"gameplay"}', ...tail, '{"op":"end","layer":"cosmetic"}'].join("\n"), { seed: 9 });
  const layout = floorPlan.generate({ seed: 9, params: floorPlan.defaults, sub: [], laws: fill.draft.laws, harder: false });
  const placed = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
  return { bundle: placed.bundle, layout, notes: placed.notes };
}
const finding = (w: { bundle: WorldBundle; layout: PackLayout }, rule: FengShuiRuleId) => fengShui(w.bundle, w.layout.zones).findings.find((f) => f.rule === rule)!;
const at = (w: { bundle: WorldBundle }, id: string, pos: [number, number, number]) => void (w.bundle.entities.find((e) => e.id === id)!.pos = pos);

describe("the rules table", () => {
  it("names one school and gives every principle a check and at least one published source", () => {
    expect(FENG_SHUI_RULES.map((r) => r.id)).toEqual(["command", "straight", "mirror", "entry", "clutter", "elements"]);
    for (const r of FENG_SHUI_RULES) {
      expect(r.principle.length, r.id).toBeGreaterThan(20);
      expect(r.check.length, r.id).toBeGreaterThan(20);
      expect(r.sources.length, r.id).toBeGreaterThan(0);
      for (const s of r.sources) expect(s.url, r.id).toMatch(/^https:\/\//), expect(s.says.length).toBeGreaterThan(20), expect(s.by && s.title && s.date).toBeTruthy();
    }
  });

  it("reads Feng Shui asked for in several languages, and nothing else", () => {
    expect(["A Feng Shui handbag gallery", "galerie kabelek podle feng-šuej", "Ein Feng-Shui-Wohnzimmer", "风水客厅"].map(asksFengShui)).toEqual([true, true, true, true]);
    expect(asksFengShui("a fun shoe gallery")).toBe(false);
  });
});

describe("command position: the bed, desk, counter or sofa across the room from its door, back to a wall, door in view", () => {
  it("knows the pieces by their head noun, in several languages", () => {
    expect(["walnut reception desk", "king-size bed", "Psací stůl", "Schreibtisch aus Eiche", "low sofa", "bunk beds"].map(isCommanding)).toEqual([true, true, true, true, true, true]);
    expect(["desk lamp", "flower bed", "coffee table", "bedside table"].map(isCommanding)).toEqual([false, false, false, false]);
  });

  it("holds in the corner across the foyer from the front door, its back to the wall", () => {
    const f = finding(world([ent("desk", "oak desk", "z_foyer", "corner_ne", [1.6, 0.8, 0.7])]), "command");
    expect(f).toMatchObject({ verdict: "holds", why: "command_ok", vars: { thing: "oak desk", room: "Foyer", facing: false } });
    expect(fengShuiWhy(f)).toBe("the oak desk sits across Foyer from its door, its back to a wall and the door in view; which way it faces isn't recorded");
  });

  it("fails in line with the door, on the door's side, out in the open, or with the door hidden from it", () => {
    expect(finding(world([ent("desk", "oak desk", "z_foyer", "center")]), "command")).toMatchObject({ verdict: "fails", why: "command_in_line" });
    expect(finding(world([ent("desk", "oak desk", "z_foyer", "corner_se")]), "command")).toMatchObject({ verdict: "fails", why: "command_near" });
    const open = world([ent("desk", "oak desk", "z_foyer", "corner_ne")]);
    at(open, "desk", [3, 0.5, -1.5]);
    expect(finding(open, "command")).toMatchObject({ verdict: "fails", why: "command_no_wall" });
    const hidden = world([ent("desk", "oak desk", "z_foyer", "corner_ne"), ent("shelf", "tall bookcase", "z_foyer", "", [1.2, 2, 0.4])]);
    at(hidden, "shelf", [2.2, 1, -4.9]);
    expect(finding(hidden, "command")).toMatchObject({ verdict: "fails", why: "command_hidden", vars: { by: "tall bookcase" } });
  });

  it("offers the free corner where it would hold, as a change the edit path takes", () => {
    const f = finding(world([ent("desk", "oak desk", "z_foyer", "center")]), "command");
    expect(f.fix).toMatchObject({ key: "move_command", vars: { thing: "oak desk", to: "corner_ne" } });
    expect(f.fix!.change).toBe("Move desk (the oak desk) to anchor corner_ne of zone z_foyer: across the room from its door, its back to the wall, facing the door.");
    expect(fengShuiFix(f.fix!)).toBe("move the oak desk to the north-east corner of Foyer, its back to the wall");
  });

  it("can't be checked with nothing to place", () => {
    expect(finding(world([ent("vase", "vase", "z_foyer", "corner_ne")]), "command")).toMatchObject({ verdict: "not_checkable", why: "command_none" });
  });
});

describe("no straight line through: the front door doesn't look straight out through a window or a back door", () => {
  it("fails on a window in line through the doorways, and offers a curtain or a plant", () => {
    const f = finding(world([ent("win", "tall arched window", "z_hall", "wall_n", [1.6, 1.2, 0.1])]), "straight");
    expect(f).toMatchObject({ verdict: "fails", why: "straight_window", vars: { thing: "tall arched window", room: "Hall" } });
    expect(f.fix?.change).toContain("Hang a curtain over win");
  });

  it("holds when the window is curtained, or something tall stands in the line", () => {
    expect(finding(world([ent("win", "curtained window", "z_hall", "wall_n", [1.6, 1.2, 0.1])]), "straight")).toMatchObject({ verdict: "holds", why: "straight_wall", vars: { room: "Hall" } });
    const screened = finding(world([ent("win", "tall arched window", "z_hall", "wall_n", [1.6, 1.2, 0.1]), ent("screen", "folding screen", "z_hall", "center", [1.6, 1.8, 0.3])]), "straight");
    expect(screened).toMatchObject({ verdict: "holds", why: "straight_blocked", vars: { thing: "folding screen" } });
  });
});

describe("no mirror facing the front door", () => {
  it("fails on a mirror on the wall the front door looks at, and moves it to a side wall", () => {
    const f = finding(world([ent("mir", "gilded mirror", "z_hall", "wall_n", [0.9, 0.9, 0.1])]), "mirror");
    expect(f).toMatchObject({ verdict: "fails", why: "mirror_faces", vars: { thing: "gilded mirror" } });
    expect(f.fix?.change).toMatch(/^Move mir \(the gilded mirror\) to anchor wall_[ew] of zone z_hall/);
  });

  it("holds with none, or one out of the front door's sight; can't tell for a free-standing one with no facing", () => {
    expect(finding(world([]), "mirror")).toMatchObject({ verdict: "holds", why: "mirror_none" });
    expect(finding(world([ent("mir", "round mirror", "z_ne", "wall_e", [0.9, 0.9, 0.1])]), "mirror")).toMatchObject({ verdict: "holds", why: "mirror_aside" });
    expect(finding(world([ent("mir", "standing mirror", "z_foyer", "center", [0.6, 1.8, 0.1])]), "mirror")).toMatchObject({ verdict: "not_checkable", why: "mirror_unknown" });
  });

  it("checks a decoration too, but offers no edit for it (edits don't change decorations)", () => {
    const f = finding(world([], undefined, ['{"op":"dress","id":"d_mirror","noun":"wall mirror","zone":"z_hall","anchor":"wall_n"}']), "mirror");
    expect(f).toMatchObject({ verdict: "fails", why: "mirror_faces", fix: null });
    expect(["zrcadlo v předsíni", "Spiegel", "mirror ball"].map(isMirror)).toEqual([true, true, false]);
  });
});

describe("a clear way in", () => {
  it("fails on something on the doorstep or just inside, and says how far from the door", () => {
    expect(finding(world([ent("burner", "bronze incense burner", "z_yard", "gate")]), "entry")).toMatchObject({ verdict: "fails", why: "entry_blocked", vars: { m: -1.2 } });
    const inside = world([ent("crate", "crate", "z_foyer", "corner_sw")]);
    at(inside, "crate", [-0.36, 0.5, -8.5]);
    const f = finding(inside, "entry");
    expect(fengShuiWhy(f)).toBe("the crate stands in the way in, 1.5 m inside the front door");
  });

  it("holds when the doorstep and the first metres inside are clear", () => {
    expect(finding(world([ent("vase", "vase", "z_foyer", "corner_ne")]), "entry")).toMatchObject({ verdict: "holds", why: "entry_clear", vars: { room: "Foyer" } });
  });
});

describe("uncluttered rooms", () => {
  it("fails on something between a room's door and its middle (its centrepiece aside)", () => {
    const w = world([ent("cab", "tall cabinet", "z_ne", "corner_nw", [0.8, 1.8, 0.8]), ent("statue", "statue", "z_ne", "center")]);
    at(w, "cab", [7.5, 0.9, 5.3]);
    expect(finding(w, "clutter")).toMatchObject({ verdict: "fails", why: "clutter_path", vars: { thing: "tall cabinet", room: "North-east room" } });
  });

  it("fails when solid things cover more than a third of a floor", () => {
    const crates = ["corner_ne", "corner_nw", "corner_se", "corner_sw", "center"].map((a, i) => ent(`crate_${i}`, "crate", "z_ne", a, [2.4, 1, 2.4]));
    const f = finding(world(crates), "clutter");
    expect(f).toMatchObject({ verdict: "fails", why: "clutter_full", vars: { room: "North-east room" } });
    expect(f.vars.share).toBeGreaterThan(1 / 3);
  });

  it("holds in a sparse world", () => {
    expect(finding(world([ent("vase", "vase", "z_ne", "corner_ne")]), "clutter")).toMatchObject({ verdict: "holds", why: "clutter_ok", vars: { rooms: 6 } });
  });
});

describe("five elements in balance", () => {
  it("reads materials and colours in several languages", () => {
    expect(elementsOf("bamboo-handle green leather tote")).toEqual(["wood"]);
    expect(elementsOf("červená hedvábná kabelka")).toEqual(["fire"]);
    expect(elementsOf("kamenná fontána")).toEqual(["earth", "water"]);
    expect(elementsOf("zlaté zrcadlo")).toEqual(["metal", "water"]);
    expect(elementsOf("grüne Vase")).toEqual(["wood"]);
    expect(elementsOf("market stall")).toEqual([]);
  });

  it("holds with three or more, fails with fewer and offers the missing ones, can't tell with no materials named", () => {
    const five = world([ent("a", "bamboo plant", "z_foyer", "corner_ne"), ent("b", "red lantern", "z_hall", "corner_ne"), ent("c", "stone bench", "z_hall", "corner_nw"), ent("d", "brass bowl", "z_ne", "corner_ne"), ent("e", "small fountain", "z_ne", "corner_nw")]);
    expect(finding(five, "elements")).toMatchObject({ verdict: "holds", vars: { have: 5 } });
    const two = finding(world([ent("a", "white marble statue", "z_hall", "corner_ne"), ent("b", "grey stone bench", "z_hall", "corner_nw")]), "elements");
    expect(two).toMatchObject({ verdict: "fails", why: "elements_few", vars: { have: 2, missing: ["wood", "fire", "water"] } });
    expect(fengShuiFix(two.fix!)).toBe("add wood (a bamboo plant), fire (a red paper lantern), water (a small fountain)");
    expect(finding(world([ent("a", "statue", "z_hall", "corner_ne"), ent("b", "bench", "z_hall", "corner_nw")]), "elements")).toMatchObject({ verdict: "not_checkable", why: "elements_unnamed" });
  });
});

describe("the section", () => {
  it("counts k of n checked principles and says how many couldn't be checked", () => {
    const s = fengShui(world([ent("burner", "bronze incense burner", "z_yard", "gate"), ent("b", "red lantern", "z_hall", "corner_ne"), ent("c", "stone bench", "z_hall", "corner_nw"), ent("d", "brass bowl", "z_ne", "corner_ne")]).bundle, floorPlan.generate({ seed: 9, params: floorPlan.defaults, sub: [], laws: {} as never, harder: false }).zones);
    expect(s).toMatchObject({ school: "Form School", holds: 4, checked: 5 });
    expect(fengShuiHead(s)).toBe("Feng Shui (Form School): 4 of 5 principles hold · 1 not checkable");
  });

  it("outside an interior, only the elements can be checked", () => {
    const fill = parseFill(['{"op":"meta","mode":"wander","pack":"arena","seed":3,"look":"a zen garden"}', '{"op":"zone","id":"z_mid","slot":"midfield","tag":"center","name":"Garden"}', '{"op":"spawn","id":"sp_red","zone":"z_mid","anchor":"","team":"red"}', ent("a", "bamboo grove", "z_mid", ""), ent("b", "stone lantern", "z_mid", ""), ent("c", "koi pond", "z_mid", ""), '{"op":"end","layer":"gameplay"}'].join("\n"), { seed: 3 });
    const layout = arena.generate({ seed: 3, params: arena.defaults, sub: [], laws: fill.draft.laws, harder: false });
    const s = fengShui(placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout).bundle, layout.zones);
    expect(s.findings.filter((f) => f.verdict === "not_checkable").map((f) => f.why)).toEqual(["not_interior", "not_interior", "not_interior", "not_interior", "not_interior"]);
    expect(s.findings.at(-1)).toMatchObject({ rule: "elements", verdict: "holds" });
  });
});

describe("the placer's repairs, for a world that says it is Feng Shui", () => {
  const lines = [ent("desk", "oak desk", "z_foyer", "center", [1.6, 0.8, 0.7]), ent("mir", "gilded mirror", "z_hall", "wall_n", [0.9, 0.9, 0.1])];

  it("moves a mirror facing the front door to a side wall, and the desk to the command position facing its door, each logged", () => {
    const w = world(lines, "Feng Shui gallery");
    expect(w.notes.filter((n) => n.includes("Feng Shui"))).toEqual([
      expect.stringMatching(/^mir: moved from 'wall_n' to 'wall_[ew]' \(Feng Shui: no mirror faces the front door\)$/),
      "desk: moved from 'center' to 'corner_ne' (Feng Shui: the command position, across the room from its door with its back to a wall)",
      "desk: turned to face its door (Feng Shui: the command position)",
    ]);
    const desk = w.bundle.entities.find((e) => e.id === "desk")!;
    expect(desk.rotY).toBe(Math.PI); // facing the front door's wall, its back to the wall across from it
    expect(finding(w, "command")).toMatchObject({ verdict: "holds", vars: { facing: true } });
    expect(finding(w, "mirror")).toMatchObject({ verdict: "holds", why: "mirror_aside" });
  });

  it("leaves any other world exactly as it was placed", () => {
    const w = world(lines);
    expect(w.notes.some((n) => n.includes("Feng Shui"))).toBe(false);
    expect(w.bundle.entities.find((e) => e.id === "desk")).toMatchObject({ anchor: "center", rotY: 0 });
    expect(w.bundle.entities.find((e) => e.id === "mir")).toMatchObject({ anchor: "wall_n" });
  });

  it("never moves something a rule names", () => {
    const w = world([...lines, '{"op":"rule","id":"r_desk","when":{"t":"touch","a":"player","b":"desk"},"then":[{"e":"emit","target":"desk","fx":"sparkle"}]}'], "Feng Shui gallery");
    expect(w.bundle.entities.find((e) => e.id === "desk")).toMatchObject({ anchor: "center", rotY: 0 });
  });
});
