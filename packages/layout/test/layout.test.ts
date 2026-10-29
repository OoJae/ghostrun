import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFill, specHash } from "@ghostrun/ir";
import { cityBlock, roofLedgeHeight } from "@ghostrun/pack-city-block";
import { placeWorld } from "../src";

const ctf = readFileSync(new URL("../../ir/fixtures/ctf-neon.jsonl", import.meta.url), "utf8");

function ctfWorld(seed = 7) {
  const fill = parseFill(ctf, { seed });
  const layout = cityBlock.generate({ seed, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  return placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
}

describe("city_block + placer", () => {
  it("places the CTF brief: every fill zone bound, every entity on its anchor", () => {
    const { bundle, notes } = ctfWorld();
    expect(notes.filter((n) => n.includes("not in"))).toEqual([]);
    const at = (id: string) => bundle.entities.find((e) => e.id === id)!.pos;
    expect(at("orb")[0]).toBe(0); // plinth at plaza centre
    expect(at("goal_red")[0]).toBeLessThan(-20); // red goal in the west base
    expect(at("goal_blue")[0]).toBeGreaterThan(20);
    expect(at("rival_1")).not.toEqual(at("rival_2")); // fanned out on the shared spawn pad
    expect(bundle.statics.length).toBeGreaterThan(10);
    expect(bundle.zones.every((z) => z.pack === "city_block")).toBe(true);
  });

  it("keeps the first steps from every spawn toward the centre free of bodies", () => {
    const { bundle } = ctfWorld();
    for (const sp of bundle.entities.filter((e) => e.kind === "spawn")) {
      const len = Math.hypot(sp.pos[0], sp.pos[2]);
      const [dx, dz] = [-sp.pos[0] / len, -sp.pos[2] / len];
      for (const e of bundle.entities) {
        if (e === sp || e.body === "sensor" || e.body === "none") continue;
        const rx = e.pos[0] - sp.pos[0];
        const rz = e.pos[2] - sp.pos[2];
        const ahead = rx * dx + rz * dz;
        const side = Math.abs(rx * dz - rz * dx);
        if (ahead > 0 && ahead < 4) expect(side, `${e.id} blocks ${sp.id}`).toBeGreaterThan(0.35 + e.size[0] / 2);
      }
    }
  });

  it("puts the rooftop lane on a ledge one jump can't reach and two can", () => {
    const { bundle } = ctfWorld();
    const ledge = roofLedgeHeight(bundle.laws.jumpH);
    expect(ledge).toBeGreaterThan(bundle.laws.jumpH);
    expect(ledge).toBeLessThanOrEqual(2 * bundle.laws.jumpH);
    const lane = bundle.statics.filter((s) => s.surf === "ledge");
    expect(lane).toHaveLength(3);
    for (const s of lane) expect(s.pos[1] + s.size[1] / 2).toBeCloseTo(ledge);
  });

  it("is deterministic per seed and differs across seeds", async () => {
    const a = await specHash("e".repeat(64), ctfWorld(7).bundle);
    const b = await specHash("e".repeat(64), ctfWorld(7).bundle);
    const c = await specHash("e".repeat(64), ctfWorld(8).bundle);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("kit repairs", () => {
  it("a rule waiting on a touch or pickup nothing could produce gets the verb that produces it", () => {
    const extra = [
      '{"op":"ent","id":"coin_9","kind":"pickup","noun":"golden coin","zone":"z_plaza","anchor":"wall_s"}',
      '{"op":"ent","id":"statue_1","kind":"prop","noun":"bronze statue","zone":"z_plaza","anchor":"wall_e"}',
      '{"op":"ent","id":"key_1","kind":"pickup","noun":"brass key","zone":"z_plaza","anchor":"wall_w"}',
      '{"op":"rule","id":"r_coin","when":{"t":"touch","a":"player","b":"coin_9"},"then":[{"e":"score","target":"team:red","n":1}]}',
      '{"op":"rule","id":"r_statue","when":{"t":"touch","a":"player","b":"statue_1"},"then":[{"e":"emit","target":"statue_1","fx":"glow"}]}',
      '{"op":"rule","id":"r_key","when":{"t":"pickup","a":"key_1","b":"player"},"then":[{"e":"emit","target":"key_1","fx":"sparkle"}]}',
    ];
    const lines = ctf.split("\n");
    const at = lines.findIndex((l) => l.includes('"op":"verb"'));
    lines.splice(at, 0, ...extra.slice(0, 3));
    const rAt = lines.findIndex((l) => l.includes('"op":"npc"'));
    lines.splice(rAt, 0, ...extra.slice(3));
    const fill = parseFill(lines.join("\n"), { seed: 7 });
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    const { bundle, notes } = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
    const on = (id: string) => bundle.verbs.filter((v) => v.on === id).map((v) => v.verb);
    expect(on("coin_9")).toEqual(["puzzle.collect"]);
    expect(on("statue_1")).toEqual(["social.inspect"]);
    expect(on("key_1")).toEqual(["physics_props.carry"]);
    expect(notes).toContain("coin_9: added puzzle.collect (rule r_coin waits on a touch nothing could produce)");
  });
});

describe("win repairs", () => {
  it("the rival team reaching its score makes you lose, even when the fill says win", () => {
    const fill = parseFill(ctf.replace('"then":[{"e":"lose","target":"player"}]', '"then":[{"e":"win","target":"player"}]'), { seed: 7 });
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    const { bundle, notes } = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
    expect(bundle.rules.find((r) => r.id === "r_lose")!.then.map((e) => e.e)).toEqual(["lose"]);
    expect(bundle.rules.find((r) => r.id === "r_win")!.then.map((e) => e.e)).toEqual(["win"]);
    expect(notes).toContain("rule r_lose: blue reaching 3 made you win → you lose (you play red)");
  });
});

describe("placement repairs for live fills", () => {
  const place = (lines: string[], edit: (s: string) => string = (s) => s) => {
    const fill = parseFill(edit(ctf.split("\n").map((l) => l).join("\n")).replace('{"op":"end","layer":"gameplay"}', `${lines.join("\n")}\n{"op":"end","layer":"gameplay"}`), { seed: 7 });
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    return placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
  };
  it("a sparse play world gets secrets that never touch the win; a touch-anything rule gets none", () => {
    const { bundle, notes } = ctfWorld();
    const secrets = bundle.entities.filter((e) => e.tags.includes("bonus"));
    expect(secrets.length).toBe(5); // the CTF has 5 things to use: up to 10
    expect(new Set(secrets.map((e) => e.noun))).toEqual(new Set(["neon shard"]));
    for (const e of secrets) {
      const r = bundle.rules.find((x) => x.when.b === e.id)!;
      expect(r.then.map((x) => x.e)).toEqual(["emit"]);
      expect(bundle.verbs.some((v) => v.on === e.id && v.verb === "puzzle.collect")).toBe(true);
    }
    expect(notes.some((n) => n.startsWith("added 5 secret neon shards"))).toBe(true);
    const any = place([], (s) => s.replace('{"op":"rule","id":"r_pickup"', '{"op":"rule","id":"r_any","when":{"t":"touch","a":"player","b":""},"then":[{"e":"emit","target":"orb","fx":"x"}]}\n{"op":"rule","id":"r_pickup"'));
    expect(any.bundle.entities.filter((e) => e.tags.includes("bonus"))).toEqual([]);
  });
});

describe("zone areas", () => {
  it("a rule that enters a zone itself gets an invisible sensor covering the zone, and points at it", () => {
    const fill = parseFill(ctf.replace('{"op":"rule","id":"r_pickup"', '{"op":"rule","id":"r_roof","when":{"t":"enter","a":"player","b":"z_roof"},"then":[{"e":"emit","target":"player","fx":"cheer"}]}\n{"op":"rule","id":"r_pickup"'), { seed: 7 });
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    const { bundle, notes } = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
    const area = bundle.entities.find((e) => e.tags.includes("area"))!;
    expect(area).toMatchObject({ id: "area_roof", body: "sensor", zone: "z_roof" });
    expect(bundle.rules.find((r) => r.id === "r_roof")!.when.b).toBe("area_roof");
    expect(notes.some((n) => n.startsWith("z_roof: a rule enters or leaves the zone itself"))).toBe(true);
  });
});

describe("small repairs found by the third unseen set", () => {
  it("one key for two locks is kept; a 0.5 m place you walk into grows to a stride", () => {
    const fill = parseFill(
      ctf
        .replace('{"op":"verb","id":"vb_jump"', [
          '{"op":"ent","id":"key_1","kind":"pickup","noun":"silver key","zone":"z_plaza","anchor":"wall_s"}',
          '{"op":"ent","id":"door_a","kind":"door","noun":"door","zone":"z_red_base","anchor":"doorway_n"}',
          '{"op":"ent","id":"door_b","kind":"door","noun":"door","zone":"z_blue_base","anchor":"doorway_n"}',
          '{"op":"ent","id":"tiny","kind":"goal","noun":"spot","zone":"z_plaza","anchor":"wall_e","size":[0.5,0.5,0.5]}',
          '{"op":"verb","id":"vb_jump"',
        ].join("\n"))
        .replace('{"op":"law"', '{"op":"verb","id":"vb_la","verb":"puzzle.lock","on":"door_a","params":{"key":"key_1"}}\n{"op":"verb","id":"vb_lb","verb":"puzzle.lock","on":"door_b","params":{"key":"key_1"}}\n{"op":"law"')
        .replace('{"op":"rule","id":"r_pickup"', '{"op":"rule","id":"r_tiny","when":{"t":"enter","a":"player","b":"tiny"},"then":[{"e":"emit","target":"tiny","fx":"x"}]}\n{"op":"rule","id":"r_pickup"'),
      { seed: 7 },
    );
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    const { bundle, notes } = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
    expect(bundle.verbs.filter((v) => v.verb === "puzzle.lock").map((v) => v.params.keep)).toEqual([true, true]);
    expect(notes).toContain("key_1: opens 2 locks, so it is kept, not used up");
    expect(bundle.entities.find((e) => e.id === "tiny")!.size).toEqual([1.6, 1.2, 1.6]);
  });
});

describe("names that aren't in the world (the fourth unseen set)", () => {
  it("a lock's missing key becomes the one key-like pickup, or the door opens with USE", () => {
    const withLock = (key: string, ents: string[]) =>
      parseFill(
        ctf
          .replace('{"op":"verb","id":"vb_jump"', [...ents, '{"op":"ent","id":"door_a","kind":"door","noun":"door","zone":"z_red_base","anchor":"doorway_n"}', '{"op":"verb","id":"vb_jump"'].join("\n"))
          .replace('{"op":"law"', `{"op":"verb","id":"vb_la","verb":"puzzle.lock","on":"door_a","params":{"key":"${key}"}}\n{"op":"law"`),
        { seed: 7 },
      );
    const place = (fill: ReturnType<typeof parseFill>) => placeWorld({ ...fill.draft, engine: "e".repeat(64) }, cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false }));
    const a = place(withLock("principal_key", ['{"op":"ent","id":"office_key","kind":"pickup","noun":"brass key","zone":"z_plaza","anchor":"wall_s"}']));
    expect(a.bundle.verbs.find((v) => v.id === "vb_la")!.params.key).toBe("office_key");
    expect(a.notes).toContain('door_a: its key "principal_key" isn\'t in the world; office_key opens it');
    const b = place(withLock("principal_key", []));
    // "when the puppies reach home": each puppy
    const pups = parseFill(
      ctf
        .replace('{"op":"verb","id":"vb_jump"', ['{"op":"ent","id":"pup_1","kind":"pickup","noun":"puppy","zone":"z_plaza","anchor":"wall_s"}', '{"op":"ent","id":"pup_2","kind":"pickup","noun":"puppy","zone":"z_plaza","anchor":"wall_e"}', '{"op":"verb","id":"vb_jump"'].join("\n"))
        .replace('{"op":"rule","id":"r_pickup"', '{"op":"rule","id":"r_pups","when":{"t":"enter","a":"puppies","b":"goal_red"},"then":[{"e":"score","target":"team:red","n":1}]}\n{"op":"rule","id":"r_pickup"'),
      { seed: 7 },
    );
    const c = place(pups);
    expect(c.bundle.rules.filter((r) => r.id.startsWith("r_pups")).map((r) => r.when.a)).toEqual(["pup_1", "pup_2"]);
    expect(c.notes).toContain("rule r_pups: 'puppies' isn't one thing; it means each of pup_1, pup_2 (2 rules)");
    expect(b.bundle.verbs.find((v) => v.id === "vb_la")!.params.key).toBe("");
    expect(b.notes).toContain('door_a: its key "principal_key" isn\'t in the world, so it opens with USE');
  });
});

describe("rules the fourth unseen set wrote", () => {
  it("'carrier.id eq null' is 'not carried'; a zone condition the trigger already meets goes; an exit's 'open' means the door beside it; one win per ingredient means all of them", () => {
    const fill = parseFill(
      ctf
        .replace('{"op":"verb","id":"vb_jump"', [
          '{"op":"ent","id":"root","kind":"pickup","noun":"elf root","zone":"z_plaza","anchor":"wall_s"}',
          '{"op":"ent","id":"scale","kind":"pickup","noun":"dragon scale","zone":"z_plaza","anchor":"wall_e"}',
          '{"op":"ent","id":"pot","kind":"goal","noun":"cauldron","zone":"z_plaza","anchor":"wall_n"}',
          '{"op":"ent","id":"gate","kind":"door","noun":"gate","zone":"z_red_base","anchor":"doorway_n"}',
          '{"op":"ent","id":"exit","kind":"goal","noun":"exit","zone":"z_red_base","anchor":"wall_e"}',
          '{"op":"ent","id":"gkey","kind":"pickup","noun":"key","zone":"z_plaza","anchor":"wall_w"}',
          '{"op":"verb","id":"vb_jump"',
        ].join("\n"))
        .replace('{"op":"law"', ['{"op":"verb","id":"vb_root","verb":"physics_props.carry","on":"root","params":{}}', '{"op":"verb","id":"vb_scale","verb":"physics_props.carry","on":"scale","params":{}}', '{"op":"verb","id":"vb_gkey","verb":"physics_props.carry","on":"gkey","params":{}}', '{"op":"verb","id":"vb_gate","verb":"puzzle.lock","on":"gate","params":{"key":"gkey"}}', '{"op":"law"'].join("\n"))
        .replace('{"op":"rule","id":"r_pickup"', [
          '{"op":"rule","id":"r_w1","when":{"t":"enter","a":"root","b":"pot"},"if":[{"l":"scale.carrier.id","op":"eq","r":"null"}],"then":[{"e":"win","target":"player"}],"once":true}',
          '{"op":"rule","id":"r_w2","when":{"t":"enter","a":"scale","b":"pot"},"if":[{"l":"root.carrier.id","op":"eq","r":"null"}],"then":[{"e":"win","target":"player"}],"once":true}',
          '{"op":"rule","id":"r_out","when":{"t":"enter","a":"player","b":"exit"},"if":[{"l":"exit.state","op":"eq","r":"open"},{"l":"player.zone","op":"eq","r":"z_red_base"}],"then":[{"e":"emit","target":"exit","fx":"x"}]}',
          '{"op":"rule","id":"r_pickup"',
        ].join("\n")),
      { seed: 7 },
    );
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    const { bundle, notes } = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
    const rule = (id: string) => bundle.rules.find((r) => r.id === id)!;
    expect(rule("r_w1").if).toEqual([{ l: "scale.carrier", op: "eq", r: "", forS: 0 }]);
    expect(rule("r_w1").then.map((e) => e.e)).toEqual(["set_state", "destroy"]);
    expect(rule("r_w1_all")).toMatchObject({ when: { t: "enter", a: "root", b: "pot" }, if: [{ l: "scale.state", op: "eq", r: "in" }], then: [{ e: "win" }] });
    expect(rule("r_out").if).toEqual([{ l: "gate.state", op: "eq", r: "open", forS: 0 }]);
    expect(notes).toContain("rule r_out: nothing can make exit 'open'; it means gate beside it");
    expect(notes).toContain("rule r_out: dropped 'player.zone is z_red_base' (exit stands in z_red_base, so reaching it is being there)");
    expect(notes).toContain("pot: 2 rules each won when a different thing was brought in (root, scale); it takes all of them, so each one goes in and the last one wins");
  });
});

describe("ring and throwing games", () => {
  it("in a ring you lose by leaving, rivals shove back with a force sized to the ring; a hit by a ball blue threw scores for blue", () => {
    const fill = parseFill(
      ctf
        .replace('{"op":"verb","id":"vb_jump"', [
          '{"op":"ent","id":"mat","kind":"prop","noun":"sumo ring","zone":"z_plaza","anchor":"wall_s","body":"fixed","size":[5,0.1,5]}',
          '{"op":"ent","id":"oob","kind":"goal","noun":"out of bounds","zone":"z_plaza","anchor":"wall_e"}',
          '{"op":"ent","id":"wrestler","kind":"npc","noun":"rival","zone":"z_plaza","anchor":"wall_n","team":"blue"}',
          '{"op":"ent","id":"ball","kind":"pickup","noun":"ball","zone":"z_plaza","anchor":"wall_w"}',
          '{"op":"verb","id":"vb_jump"',
        ].join("\n"))
        .replace('{"op":"law"', '{"op":"verb","id":"vb_ball","verb":"combat_sport.throw","on":"ball","params":{}}\n{"op":"law"')
        .replace('{"op":"rule","id":"r_pickup"', [
          '{"op":"rule","id":"r_me_out","when":{"t":"enter","a":"player","b":"oob"},"then":[{"e":"lose","target":"player"}],"once":true}',
          '{"op":"rule","id":"r_him_out","when":{"t":"enter","a":"wrestler","b":"oob"},"then":[{"e":"win","target":"player"}],"once":true}',
          '{"op":"rule","id":"r_hit","when":{"t":"hit","a":"player","b":"ball"},"if":[{"l":"ball.carrier.team","op":"eq","r":"blue"}],"then":[{"e":"score","target":"team:red","n":1}]}',
          '{"op":"rule","id":"r_pickup"',
        ].join("\n")),
      { seed: 7 },
    );
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    const { bundle, notes } = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
    const rule = (id: string) => bundle.rules.find((r) => r.id === id)!;
    expect(rule("r_me_out").when).toMatchObject({ t: "exit", a: "player", b: "area_ring" });
    expect(rule("r_him_out").when).toMatchObject({ t: "exit", a: "wrestler", b: "area_ring" });
    expect(bundle.entities.some((e) => e.id === "oob")).toBe(false);
    expect(bundle.verbs.filter((v) => v.verb === "combat_sport.shove").map((v) => [v.on, v.params.force])).toEqual([["wrestler", 6], ["player", 6]]);
    expect(rule("r_hit").then[0]!.target).toBe("team:blue");
    expect(notes).toContain("player: the rivals can shove you too (you lose leaving the ring)");
  });
});

describe("conditions nothing can satisfy", () => {
  it("'IF the gate is open' with nothing to open it means holding the unused key; 'IF the timer is running' on a prop goes", () => {
    const fill = parseFill(
      ctf
        .replace('{"op":"verb","id":"vb_jump"', '{"op":"ent","id":"brass_key","kind":"pickup","noun":"brass key","zone":"z_plaza","anchor":"wall_s"}\n{"op":"ent","id":"clock","kind":"prop","noun":"departure timer","zone":"z_plaza","anchor":"wall_e"}\n{"op":"verb","id":"vb_jump"')
        .replace('{"op":"law"', '{"op":"verb","id":"vb_ck","verb":"physics_props.carry","on":"brass_key","params":{}}\n{"op":"verb","id":"vb_t","verb":"puzzle.timer","on":"player","params":{"seconds":60}}\n{"op":"law"')
        .replace('{"op":"rule","id":"r_pickup"', '{"op":"rule","id":"r_gate","when":{"t":"enter","a":"player","b":"goal_red"},"if":[{"l":"goal_red.state","op":"eq","r":"open"},{"l":"clock.state","op":"eq","r":"running"}],"then":[{"e":"emit","target":"player","fx":"x"}]}\n{"op":"rule","id":"r_pickup"'),
      { seed: 7 },
    );
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    const { bundle, notes } = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
    expect(bundle.rules.find((r) => r.id === "r_gate")!.if).toEqual([{ l: "brass_key.carrier.team", op: "eq", r: "red", forS: 0 }]);
    expect(notes.some((n) => n.includes("with the brass key lying unused, it means holding it"))).toBe(true);
    expect(notes.some((n) => n.includes("the countdown already ends the game"))).toBe(true);
  });
});

describe("fights", () => {
  const place = (text: string) => {
    const fill = parseFill(text, { seed: 7 });
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    return placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
  };
  const hpOf = (b: ReturnType<typeof place>["bundle"]) => b.verbs.filter((v) => v.verb === "combat_sport.health").map((v) => [v.on, v.params.hp ?? 100]);

  it("weapons on a team are one each; whatever a rule wears down has hit points; 'the player hits rival_1' is a shot; down for good loses", () => {
    const { bundle, notes } = place(
      ctf
        .replace('{"op":"verb","id":"vb_jump"', [
          '{"op":"ent","id":"wand","kind":"pickup","noun":"oak wand","zone":"z_plaza","anchor":"wall_w"}',
          '{"op":"ent","id":"golem","kind":"npc","noun":"stone golem","zone":"z_plaza","anchor":"wall_n","team":"blue","props":{"hp":250}}',
          '{"op":"ent","id":"core","kind":"prop","noun":"reactor core","zone":"z_plaza","anchor":"wall_e","body":"fixed","props":{"hp":150}}',
          '{"op":"verb","id":"vb_jump"',
        ].join("\n"))
        .replace('{"op":"law"', [
          '{"op":"verb","id":"vb_wand","verb":"combat_sport.shoot","on":"wand","params":{"damage":20}}',
          '{"op":"verb","id":"vb_wand_coin","verb":"puzzle.collect","on":"wand"}',
          '{"op":"verb","id":"vb_hp","verb":"combat_sport.health","on":"player","params":{"respawn":false}}',
          '{"op":"verb","id":"vb_fists","verb":"combat_sport.shoot","on":"team:blue","params":{"range":2}}',
          '{"op":"law"',
        ].join("\n"))
        .replace('{"op":"rule","id":"r_pickup"', [
          '{"op":"rule","id":"r_zap","when":{"t":"hit","a":"player","b":"mate_1"},"then":[{"e":"emit","target":"mate_1","fx":"spark"}]}',
          '{"op":"rule","id":"r_ko","when":{"t":"health_lte","a":"rival_2","n":0},"then":[{"e":"score","target":"team:red","n":1}]}',
          '{"op":"rule","id":"r_quake","when":{"t":"every","n":30},"then":[{"e":"damage","target":"team:blue","n":5}]}',
          '{"op":"rule","id":"r_boom","when":{"t":"health_lte","a":"core","n":0},"then":[{"e":"emit","target":"core","fx":"boom"}]}',
          '{"op":"rule","id":"r_pickup"',
        ].join("\n")),
    );
    // one weapon each for the blue team; the wand is held, never collected
    expect(bundle.verbs.filter((v) => v.verb === "combat_sport.shoot").map((v) => v.on).sort()).toEqual(["golem", "rival_1", "rival_2", "wand"]);
    expect(bundle.verbs.some((v) => v.on === "wand" && v.verb === "puzzle.collect")).toBe(false);
    // the golem's own 250, the core's own 150; the rest of blue 100 because a rule wears them down
    expect(hpOf(bundle).sort()).toEqual([["core", 150], ["golem", 250], ["player", 100], ["rival_1", 100], ["rival_2", 100]]);
    // a core the rules want worn down is something the wand aims at
    expect(bundle.verbs.find((v) => v.id === "vb_wand")!.params.at).toBe("core");
    // mate_1 has no weapon of its own and you have a wand: it is hit by your shot
    expect(bundle.rules.find((r) => r.id === "r_zap")!.when).toMatchObject({ t: "hit", a: "mate_1", b: "" });
    expect(bundle.rules.find((r) => r.id === "r_knocked_out")).toMatchObject({ when: { t: "health_lte", a: "player", n: 0 }, then: [{ e: "lose" }] });
    expect(notes).toContain("vb_fists: combat_sport.shoot on 'team:blue' means each of golem, rival_1, rival_2");
  });

  it("a shooting game with no one to shoot gets two armed rivals with hit points", () => {
    const { bundle, notes } = place(
      ctf
        .split("\n")
        .filter((l) => !l.includes('"op":"npc"'))
        .join("\n")
        .replace('{"op":"law"', '{"op":"verb","id":"vb_laser","verb":"combat_sport.shoot","on":"player","params":{"damage":30,"cooldown":0.4}}\n{"op":"law"'),
    );
    expect(notes.some((n) => n.startsWith("added rival_1 and rival_2 on the blue side: a shooting game needs someone to shoot"))).toBe(true);
    expect(bundle.verbs.find((v) => v.verb === "combat_sport.shoot" && v.on === "rival_1")!.params).toMatchObject({ damage: 15, cooldown: 1.2 });
    expect(hpOf(bundle).map(([on]) => on)).toEqual(["rival_1", "rival_2"]);
  });

  it("an armed character written with no menu is a sentry whose shot takes at most a quarter of your hit points", () => {
    const { bundle, notes } = place(
      ctf.replace('{"op":"verb","id":"vb_jump"', [
        '{"op":"ent","id":"bandit","kind":"npc","noun":"bandit","zone":"z_plaza","anchor":"wall_n","team":"blue"}',
        '{"op":"verb","id":"vb_colt","verb":"combat_sport.shoot","on":"bandit","params":{"damage":100}}',
        '{"op":"verb","id":"vb_hp","verb":"combat_sport.health","on":"player","params":{"hp":100}}',
        '{"op":"verb","id":"vb_jump"',
      ].join("\n")),
    );
    expect(bundle.verbs.find((v) => v.id === "vb_colt")!.params.damage).toBe(25);
    expect(notes).toContain("bandit: a sentry (armed, no menu), its shot capped at 25 of your 100 hit points");
    // the rivals with menus keep theirs
    expect(bundle.cast.some((c) => c.npc === "bandit")).toBe(false);
  });

  it("what you need never starts where you lose; a win for blue is your loss; your gun 'hitting you' is your shot; blue scoring for blue hit means red hit", () => {
    const { bundle, notes } = place(
      ctf
        .replace('{"op":"verb","id":"vb_jump"', '{"op":"ent","id":"pit","kind":"hazard","noun":"pit","zone":"z_plaza","anchor":"plinth","body":"sensor","size":[4,1,4]}\n{"op":"verb","id":"vb_jump"')
        .replace('{"op":"law"', '{"op":"verb","id":"vb_gun","verb":"combat_sport.shoot","on":"player"}\n{"op":"law"')
        .replace('"then":[{"e":"lose","target":"player"}],"once":true}', '"then":[{"e":"win","target":"rival_1"}],"once":true}')
        .replace('{"op":"rule","id":"r_pickup"', [
          '{"op":"rule","id":"r_fall","when":{"t":"enter","a":"player","b":"pit"},"then":[{"e":"lose","target":"player"}],"once":true}',
          '{"op":"rule","id":"r_mine","when":{"t":"hit","a":"player","b":"player"},"then":[{"e":"score","target":"team:red","n":1}]}',
          '{"op":"rule","id":"r_theirs","when":{"t":"hit","a":"team:blue"},"then":[{"e":"score","target":"team:blue","n":1}]}',
          '{"op":"rule","id":"r_pickup"',
        ].join("\n")),
    );
    const orb = bundle.entities.find((e) => e.id === "orb")!;
    const pit = bundle.entities.find((e) => e.id === "pit")!;
    expect(Math.abs(orb.pos[0] - pit.pos[0]) > 2 || Math.abs(orb.pos[2] - pit.pos[2]) > 2).toBe(true);
    expect(notes.some((n) => n.startsWith("orb: started inside pit, where you lose: moved to"))).toBe(true);
    const rule = (id: string) => bundle.rules.find((r) => r.id === id)!;
    expect(rule("r_lose").then[0]).toMatchObject({ e: "lose", target: "player" });
    expect(rule("r_mine").when).toMatchObject({ t: "hit", a: "team:blue", b: "" });
    expect(rule("r_theirs").when).toMatchObject({ t: "hit", a: "team:red", b: "" });
  });

  it("an archer 'hitting the player' is its shot, a loss as written (and then no knock-out rule); a team where the weapon goes is who was hit; knock-outs that lead nowhere make the win need them all; your gun never aims at what you lose by", () => {
    const { bundle, notes } = place(
      ctf
        .replace('{"op":"verb","id":"vb_jump"', '{"op":"ent","id":"my_ship","kind":"prop","noun":"your ship","zone":"z_plaza","anchor":"wall_w","props":{"hp":100}}\n{"op":"verb","id":"vb_jump"')
        .replace('{"op":"law"', [
          '{"op":"verb","id":"vb_gun","verb":"combat_sport.shoot","on":"player"}',
          '{"op":"verb","id":"vb_bow","verb":"combat_sport.shoot","on":"rival_1","params":{"range":20}}',
          '{"op":"verb","id":"vb_hp","verb":"combat_sport.health","on":"player","params":{"respawn":false}}',
          '{"op":"law"',
        ].join("\n"))
        .replace('{"op":"rule","id":"r_pickup"', [
          '{"op":"rule","id":"r_shot","when":{"t":"hit","a":"player","b":"rival_1"},"then":[{"e":"lose","target":"player"}]}',
          '{"op":"rule","id":"r_tag","when":{"t":"hit","a":"player","b":"team:red"},"then":[{"e":"score","target":"team:blue","n":1}]}',
          '{"op":"rule","id":"r_down","when":{"t":"health_lte","a":"rival_1","n":0},"then":[{"e":"destroy","target":"rival_1"}],"once":true}',
          '{"op":"rule","id":"r_boss","when":{"t":"health_lte","a":"rival_2","n":0},"then":[{"e":"win","target":"player"}],"once":true}',
          '{"op":"rule","id":"r_sunk","when":{"t":"health_lte","a":"my_ship","n":0},"then":[{"e":"lose","target":"player"}],"once":true}',
          '{"op":"rule","id":"r_pickup"',
        ].join("\n")),
    );
    const rule = (id: string) => bundle.rules.find((r) => r.id === id)!;
    expect(bundle.verbs.find((v) => v.id === "vb_gun")!.params.at ?? "").not.toContain("my_ship");
    expect(rule("r_shot").when).toMatchObject({ t: "hit", a: "player", b: "rival_1" });
    expect(bundle.rules.some((r) => r.id === "r_knocked_out")).toBe(false); // (the first hit already loses)
    expect(rule("r_tag").when).toMatchObject({ t: "hit", a: "team:red", b: "" }); // blue scores: one of yours was hit
    // whoever goes down last wins it: one win per member, each needing the other down
    expect(rule("r_boss").if).toEqual([{ l: "rival_1.hp", op: "lte", r: 0, forS: 0 }]);
    expect(rule("r_boss_rival_1")).toMatchObject({ when: { t: "health_lte", a: "rival_1" }, if: [{ l: "rival_2.hp", op: "lte", r: 0 }], then: [{ e: "win" }] });
    expect(notes).toContain("rule r_boss: knocking out rival_1 leads nowhere, so the win is for knocking out all of rival_2, rival_1, whoever goes down last (2 rules)");
  });
});

describe("races", () => {
  it("'win after 2 laps' with only a car gets a line, gates round the street loop, two rivals at the wheel, a way to lose, and the grid with the player on pole", () => {
    const fill = parseFill([
      '{"op":"meta","mode":"play","pack":"city_block","seed":7}',
      '{"op":"zone","id":"z_plaza","slot":"center","tag":"plaza"}',
      '{"op":"spawn","id":"sp_red","zone":"z_plaza","team":"red"}',
      '{"op":"ent","id":"my_car","kind":"car","noun":"red sports car","zone":"z_plaza"}',
      '{"op":"rule","id":"r_win","when":{"t":"lap_done","a":"player","n":2},"then":[{"e":"win","target":"player"}]}',
    ].join("\n"), { seed: 7 });
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: [], laws: fill.draft.laws, harder: false });
    expect(layout.track?.points.length).toBeGreaterThanOrEqual(4);
    const { bundle, notes } = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
    const track = bundle.verbs.find((v) => v.verb === "racing.track")!;
    expect(track).toMatchObject({ on: "finish_line", params: { laps: 2 } });
    expect(String(track.params.gates).split(",")).toHaveLength(Math.min(4, layout.track!.points.length - 1));
    const drives = bundle.verbs.filter((v) => v.verb === "vehicle.drive").map((v) => [v.on, v.params.driver, v.params.kind]);
    expect(drives).toEqual([["my_car", "player", "car"], ["racer_1_ride", "racer_1", "car"], ["racer_2_ride", "racer_2", "car"]]);
    expect(bundle.rules.find((r) => r.id === "r_lose_laps")).toMatchObject({ when: { t: "lap_done", a: "team:blue", n: 2 }, then: [{ e: "lose" }] });
    expect(notes).toContain("added racer_1 and racer_2: a race needs someone to race");
    expect(notes).toContain("race: the grid behind finish_line: player in my_car, racer_1 in racer_1_ride, racer_2 in racer_2_ride");
    // pole: the player's car nearest the line, the spawn under it
    const at = (id: string) => bundle.entities.find((e) => e.id === id)!.pos;
    const d = (id: string) => Math.hypot(at(id)[0] - at("finish_line")[0], at(id)[2] - at("finish_line")[2]);
    expect(d("my_car")).toBeLessThan(Math.min(d("racer_1_ride"), d("racer_2_ride")));
    expect([at("sp_red")[0], at("sp_red")[2]]).toEqual([at("my_car")[0], at("my_car")[2]]);
  });

  it("a rival's car driven by 'npc' gets a rival racer at its wheel, a copy of yours tops out a tenth slower, a rule about your car is about you, and an oil slick on the road moves off it", () => {
    const fill = parseFill([
      '{"op":"meta","mode":"play","pack":"city_block","seed":7}',
      '{"op":"zone","id":"z_plaza","slot":"center","tag":"plaza"}',
      '{"op":"spawn","id":"sp_red","zone":"z_plaza","team":"red"}',
      '{"op":"ent","id":"my_car","kind":"car","noun":"red car","zone":"z_plaza"}',
      '{"op":"ent","id":"their_car","kind":"car","noun":"blue car","zone":"z_plaza"}',
      '{"op":"ent","id":"oil","kind":"hazard","noun":"oil slick","zone":"z_plaza","body":"sensor","size":[2,0.1,2]}',
      '{"op":"verb","id":"vb_mine","verb":"vehicle.drive","on":"my_car","params":{"kind":"car","speed":20,"driver":"player"}}',
      '{"op":"verb","id":"vb_theirs","verb":"vehicle.drive","on":"their_car","params":{"kind":"car","speed":18,"driver":"npc"}}',
      '{"op":"rule","id":"r_win","when":{"t":"lap_done","a":"player","n":2},"then":[{"e":"win","target":"player"}]}',
      '{"op":"rule","id":"r_spin","when":{"t":"hit","a":"my_car","b":"oil"},"then":[{"e":"emit","target":"oil","fx":"spin"}]}',
    ].join("\n"), { seed: 7 });
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: [], laws: fill.draft.laws, harder: false });
    const { bundle, notes } = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
    const drives = bundle.verbs.filter((v) => v.verb === "vehicle.drive").map((v) => [v.on, v.params.driver, v.params.speed]);
    expect(drives).toEqual([["my_car", "player", 20], ["their_car", "racer_1", 18], ["racer_2_ride", "racer_2", 18]]);
    expect(notes).toContain("their_car: 'npc' is nobody in this world, so a rival racer drives it");
    expect(bundle.rules.find((r) => r.id === "r_spin")!.when).toMatchObject({ t: "hit", a: "player", b: "oil" });
    expect(notes.some((n) => n.startsWith("race: ") && n.includes("oil") && n.endsWith("moved off the road"))).toBe(true);
  });
});
