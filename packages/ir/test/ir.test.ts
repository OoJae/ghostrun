import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FillParser, JsonStore, PatchError, clampLaws, DEFAULT_LAWS, isZeroG, jcs, parseFill, specHash, stripCosmetic,
  type WorldBundle,
} from "../src";

const ctf = readFileSync(new URL("../fixtures/ctf-neon.jsonl", import.meta.url), "utf8");
const ENGINE = "e".repeat(64);

function ctfBundle(): WorldBundle {
  const p = parseFill(ctf, { seed: 7 });
  return { ...p.draft, engine: ENGINE };
}

describe("fill parser", () => {
  it("accepts every line of the organizer's CTF brief", () => {
    const p = parseFill(ctf, { seed: 7 });
    expect(p.notes).toEqual([]);
    expect(p.stats.invalid).toBe(0);
    expect(p.draft.zones.map((z) => z.id)).toEqual(["z_plaza", "z_red_base", "z_blue_base", "z_roof"]);
    expect(p.draft.entities).toHaveLength(10); // 2 spawns, 2 goals, orb, platform, sign, 3 NPCs
    expect(p.draft.laws.jumpsMax).toBe(2);
    expect(p.draft.cast.map((c) => c.npc)).toEqual(["mate_1", "rival_1", "rival_2"]);
    expect(p.draft.rules.map((r) => r.id)).toContain("r_score_red");
    expect(p.draft.expects.find((x) => x.headline)?.id).toBe("x_roof");
    expect(p.draft.cosmetic.weather).toBe("rain");
    expect(p.gameplayDone).toBe(true);
  });

  it("streams: odd chunk boundaries give the same world as one-shot parsing", () => {
    const p = new FillParser({ seed: 7 });
    let firstEntityAt = -1;
    for (let i = 0; i < ctf.length; i += 17) {
      const evs = p.push(ctf.slice(i, i + 17));
      if (firstEntityAt < 0 && evs.some((e) => e.op === "spawn")) firstEntityAt = i;
    }
    p.end();
    expect(firstEntityAt).toBeGreaterThan(0);
    expect(firstEntityAt).toBeLessThan(ctf.length / 2);
    expect(p.draft).toEqual(parseFill(ctf, { seed: 7 }).draft);
  });

  it("drops unknown keys, repairs near-miss types, rejects junk", () => {
    const lines = [
      '{"op":"zone","id":"z_a","slot":"s","tag":"t","name":"A","colour":"red"}',
      '{"op":"ent","id":"crate","kind":"Prop","zone":"z_a","noun":"crate","size":["1","1","1"]}',
      "not json",
      `{"op":"zone","id":"z_b","name":"${"x".repeat(1100)}"}`,
      '{"op":"ent","id":"Bad-Id","kind":"prop","zone":"z_a"}',
    ].join("\n");
    const p = parseFill(lines, { seed: 1 });
    expect(p.draft.zones[0]).not.toHaveProperty("colour");
    expect(p.draft.entities.find((e) => e.id === "crate")?.kind).toBe("prop");
    expect(p.draft.entities.find((e) => e.id === "crate")?.size).toEqual([1, 1, 1]);
    expect(p.stats.repaired).toBeGreaterThan(0);
    expect(p.stats.invalid).toBe(3);
  });

  it("holds forward references until they resolve, drops the unresolved at gameplay end", () => {
    const lines = [
      '{"op":"zone","id":"z_a"}',
      '{"op":"rule","id":"r_early","when":{"t":"enter","a":"later","b":"z_a"},"then":[{"e":"win","target":"player"}]}',
      '{"op":"rule","id":"r_never","when":{"t":"enter","a":"ghost","b":"z_a"},"then":[{"e":"win","target":"player"}]}',
      '{"op":"ent","id":"later","kind":"pickup","zone":"z_a"}',
      '{"op":"end","layer":"gameplay"}',
    ].join("\n");
    const p = parseFill(lines, { seed: 1 });
    expect(p.draft.rules.map((r) => r.id)).toEqual(["r_early"]);
    expect(p.notes.some((n) => n.kind === "unresolved" && n.line === 3)).toBe(true);
  });

  it("enforces budgets and the single-source signature mechanic", () => {
    const zones = Array.from({ length: 10 }, (_, i) => `{"op":"zone","id":"z_${i}"}`);
    const sigs = ['{"op":"sig","verb":"combat_sport.reflect","on":"player"}', '{"op":"sig","verb":"locomotion.glide","on":"player"}'];
    const p = parseFill([...zones, ...sigs].join("\n"), { seed: 1 });
    expect(p.draft.zones).toHaveLength(8);
    expect(p.draft.verbs.filter((x) => x.signature)).toHaveLength(1);
  });
});


describe("laws", () => {
  it("clamps instead of rejecting", () => {
    const l = clampLaws({ ...DEFAULT_LAWS, jumpH: 100, speed: -5, jumpsMax: 2.6, gravityScale: Number.NaN });
    expect(l.jumpH).toBe(4);
    expect(l.speed).toBe(1);
    expect(l.jumpsMax).toBe(3);
    expect(l.gravityScale).toBe(1);
  });
  it("switches to the zero-g thrust law below 0.05 g", () => {
    const l = clampLaws({ ...DEFAULT_LAWS, gravityScale: 0.0499 });
    expect(isZeroG(l)).toBe(true);
    expect(l.gravityScale).toBe(0);
    expect(l.thrust).toBeGreaterThan(0);
  });
});

describe("spec hash", () => {
  it("canonicalises like RFC 8785", () => {
    expect(jcs({ b: 1, a: [true, null, -0, 1.5e-7], c: "é" })).toBe('{"a":[true,null,0,1.5e-7],"b":1,"c":"é"}');
  });

  it("ignores array order and the cosmetic layer, but not gameplay", async () => {
    const a = ctfBundle();
    const h = await specHash(ENGINE, a);
    expect(h).toMatch(/^[0-9a-f]{64}$/);

    const shuffled = { ...a, entities: [...a.entities].reverse(), rules: [...a.rules].reverse() };
    expect(await specHash(ENGINE, shuffled)).toBe(h);

    const cosmetic = structuredClone(a);
    cosmetic.cosmetic.weather = "snow";
    cosmetic.zones[0]!.name = "Renamed plaza";
    cosmetic.cast[0]!.persona.personality = "grumpy";
    cosmetic.expects[0]!.text = "different words";
    expect(await specHash(ENGINE, cosmetic)).toBe(h);

    const gameplay = structuredClone(a);
    gameplay.rules.find((r) => r.id === "r_win")!.when.n = 5;
    expect(await specHash(ENGINE, gameplay)).not.toBe(h);
    expect(await specHash("f".repeat(64), a)).not.toBe(h);
  });

  it("strips persona prose and display text", () => {
    const s = stripCosmetic(ctfBundle());
    expect(JSON.stringify(s)).not.toContain("Rooftop lane needs double jump");
    expect(s).not.toHaveProperty("cosmetic");
  });
});

describe("JsonStore patches", () => {
  it("addresses records by id and validates atomically", () => {
    const st = new JsonStore(ctfBundle());
    st.apply([{ op: "replace", path: "/rules/r_win/when/n", value: 5 }], "user");
    expect(st.get("/rules/r_win/when/n")).toBe(5);

    // the CTF tile edit: "lose after 10 s" → 5 s is one replace on an id path
    st.apply([{ op: "replace", path: "/laws/jumpsMax", value: 9 }], "user");
    expect(st.get("/laws/jumpsMax")).toBe(3); // clamped, not rejected

    const before = st.compile();
    expect(() =>
      st.apply(
        [
          { op: "replace", path: "/entities/orb/size", value: [1, 1, 1] },
          { op: "replace", path: "/entities/orb/kind", value: "dragon" },
        ],
        "user",
      ),
    ).toThrow(PatchError);
    expect(st.compile()).toEqual(before); // nothing applied
  });

  it("adds and removes whole records; tracks touched ids per origin", () => {
    const st = new JsonStore(ctfBundle());
    const orb = st.get("/entities/orb") as WorldBundle["entities"][number];
    st.apply([{ op: "add", path: "/entities/orb_2", value: { ...orb, id: "orb_2" } }], "ai-fill");
    st.apply([{ op: "remove", path: "/entities/sign_hot" }], "user");
    const ids = st.compile().entities.map((e) => e.id);
    expect(ids).toContain("orb_2");
    expect(ids).not.toContain("sign_hot");
    expect([...st.touched("ai-fill")]).toEqual(["orb_2"]);
    expect(() => st.apply([{ op: "add", path: "/entities/orb", value: orb }], "user")).toThrow(/already exists/);
  });

  it("forbids AI origins from writing expectations", () => {
    const st = new JsonStore(ctfBundle());
    expect(() => st.apply([{ op: "replace", path: "/expects/x_win/lo", value: 0 }], "sonnet")).toThrow(/may not write/);
    st.apply([{ op: "replace", path: "/expects/x_win/lo", value: 0 }], "user");
  });
});

describe("fill repairs from the S2 bench", () => {
  it("maps the synonyms LLMs reach for onto the real enums", () => {
    const lines = [
      '{"op":"zone","id":"z_a"}',
      '{"op":"ent","id":"wall_1","kind":"prop","zone":"z_a","body":"static","shape":"cylinder","team":"none"}',
      '{"op":"expect","id":"x_1","prop":"lose_reachable","a":"wall_1","b":"z_a"}',
    ].join("\n");
    const p = parseFill(lines, { seed: 1 });
    expect(p.stats.invalid).toBe(0);
    const e = p.draft.entities[0]!;
    expect([e.body, e.shape, e.team]).toEqual(["fixed", "capsule", ""]);
    expect(p.draft.expects[0]!.prop).toBe("reachable");
  });
});

describe("fill repairs from the fourth unseen set", () => {
  it("operators and weather in the spellings models use; a rule about a plural of placed things is kept", () => {
    const lines = [
      '{"op":"meta","mode":"play","pack":"arena","seed":3,"weather":"foggy"}',
      '{"op":"zone","id":"z_a","slot":"midfield","tag":"center"}',
      '{"op":"spawn","id":"sp","zone":"z_a","team":"red"}',
      '{"op":"goal","id":"home","zone":"z_a"}',
      '{"op":"ent","id":"pup_1","kind":"pickup","noun":"puppy","zone":"z_a"}',
      '{"op":"ent","id":"pup_2","kind":"pickup","noun":"puppy","zone":"z_a"}',
      '{"op":"rule","id":"r_ne","when":{"t":"enter","a":"player","b":"home"},"if":[{"l":"pup_1.carrier","op":"neq","r":""},{"l":"team:red.score","op":">=","r":1}],"then":[{"e":"win","target":"player"}]}',
      '{"op":"rule","id":"r_pups","when":{"t":"enter","a":"puppies","b":"home"},"then":[{"e":"score","target":"team:red","n":1}]}',
      '{"op":"rule","id":"r_ghost","when":{"t":"enter","a":"ghosts","b":"home"},"then":[{"e":"lose","target":"player"}]}',
    ].join("\n");
    const p = parseFill(lines, { seed: 3 });
    expect(p.draft.cosmetic.weather).toBe("fog");
    expect(p.draft.rules.find((r) => r.id === "r_ne")!.if.map((c) => c.op)).toEqual(["ne", "gte"]);
    expect(p.draft.rules.map((r) => r.id)).toEqual(["r_ne", "r_pups"]); // "ghosts" names nothing placed
    const teams = parseFill(['{"op":"meta","mode":"play","pack":"arena","seed":3}', '{"op":"zone","id":"z_a"}', '{"op":"ent","id":"ball","kind":"pickup","zone":"z_a"}', '{"op":"rule","id":"r_hit","when":{"t":"hit","a":"blue","b":"ball"},"then":[{"e":"score","target":"team:red","n":1}]}'].join("\n"), { seed: 3 });
    expect(teams.draft.rules.map((r) => r.when.a)).toEqual(["team:blue"]);
  });
});

describe("a trigger's subject under another key", () => {
  it("score_gte with 'target' team:red, and enter with 'who' the player, read as a", () => {
    const p = parseFill([
      '{"op":"meta","mode":"play","pack":"arena","seed":3}',
      '{"op":"zone","id":"z_a","slot":"midfield","tag":"center"}',
      '{"op":"ent","id":"pad","kind":"goal","zone":"z_a"}',
      '{"op":"rule","id":"r_win","when":{"t":"score_gte","target":"team:red","n":15},"then":[{"e":"win","target":"player"}]}',
      '{"op":"rule","id":"r_in","when":{"t":"enter","who":"player","b":"pad"},"then":[{"e":"score","target":"team:red","n":1}]}',
    ].join("\n"), { seed: 3 });
    expect(p.draft.rules.map((r) => [r.id, r.when.a])).toEqual([["r_win", "team:red"], ["r_in", "player"]]);
  });
});

describe("fill repairs for races", () => {
  it("go-karts, jetskis and sleds are vehicles that drive as their kind, a circuit is the track, and a lap is lap_done", () => {
    const lines = [
      '{"op":"meta","mode":"play","pack":"arena","seed":3}',
      '{"op":"zone","id":"z_a","slot":"midfield","tag":"center"}',
      '{"op":"spawn","id":"sp","zone":"z_a","team":"red"}',
      '{"op":"ent","id":"kart","kind":"go_kart","zone":"z_a"}',
      '{"op":"ent","id":"ski","kind":"jetski","zone":"z_a"}',
      '{"op":"ent","id":"sled","kind":"snowmobile","zone":"z_a"}',
      '{"op":"ent","id":"line","kind":"checkpoint","zone":"z_a"}',
      '{"op":"verb","id":"vb_kart","verb":"racing.go_kart","on":"kart","params":{"driver":"player"}}',
      '{"op":"verb","id":"vb_ski","verb":"vehicles.jetski","on":"ski"}',
      '{"op":"verb","id":"vb_sled","verb":"locomotion.ride","on":"sled","params":{"kind":"snowmobile"}}',
      '{"op":"verb","id":"vb_track","verb":"racing.circuit","on":"line","params":{"laps":2}}',
      '{"op":"verb","id":"vb_clock","verb":"puzzle.timer","on":"line"}',
      '{"op":"rule","id":"r_win","when":{"t":"laps","a":"player","n":2},"then":[{"e":"win","target":"player"}]}',
      '{"op":"rule","id":"r_lose","when":{"t":"race_finished","a":"blue","n":2},"then":[{"e":"lose","target":"player"}]}',
    ].join("\n");
    const p = parseFill(lines, { seed: 3 });
    expect(p.stats.invalid).toBe(0);
    expect(["kart", "ski", "sled"].map((id) => p.draft.entities.find((e) => e.id === id)?.kind)).toEqual(["vehicle", "vehicle", "vehicle"]);
    expect(p.draft.verbs.map((v) => [v.id, v.verb, v.params])).toEqual([
      ["vb_kart", "vehicle.drive", { kind: "kart", driver: "player" }],
      ["vb_ski", "vehicle.drive", { kind: "boat" }],
      ["vb_sled", "vehicle.drive", { kind: "snowmobile" }],
      ["vb_track", "racing.track", { laps: 2 }],
      ["vb_clock", "puzzle.timer", {}], // a timer stays a timer
    ]);
    expect(p.draft.rules.map((r) => [r.when.t, r.when.a, r.when.n])).toEqual([
      ["lap_done", "player", 2],
      ["lap_done", "team:blue", 2],
    ]);
  });
});

describe("fill repairs for fights", () => {
  it("spells, fireballs, blasters and bows are the shoot verb, claws reach two metres, knock-outs are health_lte", () => {
    const lines = [
      '{"op":"meta","mode":"play","pack":"arena","seed":3}',
      '{"op":"zone","id":"z_a","slot":"midfield","tag":"center"}',
      '{"op":"spawn","id":"sp","zone":"z_a","team":"red"}',
      '{"op":"ent","id":"wand","kind":"wand","noun":"oak wand","zone":"z_a"}',
      '{"op":"npc","id":"rival","role":"rival","zone":"z_a","team":"blue","menu":["rival.attack"]}',
      '{"op":"verb","id":"vb_fire","verb":"magic.fireball","on":"player","params":{"damage":20}}',
      '{"op":"verb","id":"vb_wand","verb":"wand","on":"wand"}',
      '{"op":"verb","id":"vb_bow","verb":"combat_sport.bow","on":"player"}',
      '{"op":"verb","id":"vb_claws","verb":"zombie.claws","on":"rival","params":{"damage":10}}',
      '{"op":"verb","id":"vb_hp","verb":"stats.hit_points","on":"rival","params":{"hp":80}}',
      '{"op":"verb","id":"vb_grid","verb":"motion_hazards.laser","on":"wand"}',
      '{"op":"rule","id":"r_ko","when":{"t":"knockout","a":"rival"},"then":[{"e":"win","target":"player"}]}',
      '{"op":"rule","id":"r_burn","when":{"t":"shot","a":"player","b":"rival"},"then":[{"e":"hurt","target":"player","n":5},{"e":"restore","target":"rival","n":5}]}',
    ].join("\n");
    const p = parseFill(lines, { seed: 3 });
    expect(p.stats.invalid).toBe(0);
    expect(p.draft.entities.find((e) => e.id === "wand")!.kind).toBe("pickup");
    expect(p.draft.verbs.map((v) => [v.id, v.verb, v.params])).toEqual([
      ["vb_fire", "combat_sport.shoot", { damage: 20 }],
      ["vb_wand", "combat_sport.shoot", {}],
      ["vb_bow", "combat_sport.shoot", {}],
      ["vb_claws", "combat_sport.shoot", { range: 2, damage: 10 }],
      ["vb_hp", "combat_sport.health", { hp: 80 }],
      ["vb_grid", "motion_hazards.laser", {}], // the laser grid hazard keeps its own kit
    ]);
    expect(p.draft.rules.map((r) => [r.when.t, r.when.n, r.then.map((e) => e.e)])).toEqual([
      ["health_lte", 0, ["win"]],
      ["hit", 0, ["damage", "heal"]],
    ]);
  });

  it("'player_red' in a rule is the player (on red), 'player_blue' anyone on blue; 'player_blue.team is blue' goes", () => {
    const lines = [
      '{"op":"meta","mode":"play","pack":"arena","seed":3}',
      '{"op":"zone","id":"z_a","slot":"midfield","tag":"center"}',
      '{"op":"spawn","id":"sp_red","zone":"z_a","team":"red"}',
      '{"op":"ent","id":"tagger","kind":"pickup","zone":"z_a"}',
      '{"op":"rule","id":"r_red","when":{"t":"hit","a":"player_blue","b":"tagger"},"if":[{"l":"player_blue.team","op":"eq","r":"blue"}],"then":[{"e":"score","target":"team:red","n":1}]}',
      '{"op":"rule","id":"r_win","when":{"t":"score_gte","a":"team:red","n":10},"then":[{"e":"win","target":"player_red"}]}',
      '{"op":"rule","id":"r_theirs","when":{"t":"score_gte","a":"team:blue","n":10},"then":[{"e":"win","target":"blue_players"}]}',
    ].join("\n");
    const p = parseFill(lines, { seed: 3 });
    expect(p.notes.filter((n) => n.kind === "unresolved")).toEqual([]);
    const r = (id: string) => p.draft.rules.find((x) => x.id === id)!;
    expect([r("r_red").when.a, r("r_red").if]).toEqual(["team:blue", []]);
    expect(r("r_win").then[0]!.target).toBe("player");
    expect(r("r_theirs").then[0]!.target).toBe("team:blue"); // (the placer makes a win for blue your loss)
  });
});

describe("fill repairs from the second fights bench", () => {
  it("an ent with no kind takes the one its words or body say; 'opponent' with its team given is that team; hit points compared to \"0\" compare numbers; dress and poster lines in the shapes models write are kept", () => {
    const lines = [
      '{"op":"meta","mode":"play","pack":"arena","seed":3}',
      '{"op":"zone","id":"z_a","slot":"midfield","tag":"center"}',
      '{"op":"spawn","id":"sp","zone":"z_a","team":"red"}',
      '{"op":"ent","id":"guard_1","zone":"z_a"}',
      '{"op":"ent","id":"banner","noun":"banner","zone":"z_a","body":"sensor"}',
      '{"op":"ent","id":"crate","noun":"wooden box","zone":"z_a"}',
      '{"op":"verb","id":"vb_hp","verb":"combat_sport.health","on":"guard_1"}',
      '{"op":"rule","id":"r_tag","when":{"t":"hit","a":"player","b":"opponent"},"if":[{"l":"opponent.team","op":"eq","r":"blue"}],"then":[{"e":"score","target":"team:red","n":1}]}',
      '{"op":"rule","id":"r_win","when":{"t":"enter","a":"player","b":"banner"},"if":[{"l":"guard_1.hp","op":"eq","r":"0"},{"l":"team:red.score","op":"gte","r":"3"}],"then":[{"e":"win","target":"player"}]}',
      '{"op":"rule","id":"r_ghost","when":{"t":"hit","a":"player","b":"phantom"},"then":[{"e":"lose","target":"player"}]}',
      '{"op":"end","layer":"gameplay"}',
      '{"op":"dress","id":"d_neon","type":"lighting","params":{"color":"#ff00ff"}}',
      '{"op":"poster","id":"p_rules","slot":0,"text":"First to 10 tags wins"}',
      '{"op":"end","layer":"cosmetic"}',
    ].join("\n");
    const p = parseFill(lines, { seed: 3 });
    expect(p.stats.invalid).toBe(0);
    expect(p.draft.entities.map((e) => [e.id, e.kind])).toEqual([["sp", "spawn"], ["guard_1", "npc"], ["banner", "goal"], ["crate", "prop"]]);
    const r = (id: string) => p.draft.rules.find((x) => x.id === id)!;
    expect([r("r_tag").when.b, r("r_tag").if]).toEqual(["team:blue", []]); // (the placer reads who was hit)
    expect(r("r_win").if.map((c) => c.r)).toEqual([0, 3]);
    // what never arrived is named, on a note that says which line it was
    expect(p.notes.filter((n) => n.kind === "unresolved")).toEqual([{ line: 10, kind: "unresolved", text: "'rule' references 'phantom', which never arrived", op: "rule", id: "r_ghost" }]);
    expect(p.draft.cosmetic.dress).toMatchObject([{ id: "d_neon", noun: "lighting", zone: "z_a" }]);
    expect(p.draft.cosmetic.posters).toMatchObject([{ id: "p_rules", prompt: "First to 10 tags wins", zone: "z_a" }]);
  });

  it("hit points written as an ent of their own ('crystal_hp', kind health) are a health verb on whose they are, and rules about them are about it", () => {
    const lines = [
      '{"op":"meta","mode":"play","pack":"arena","seed":3}',
      '{"op":"zone","id":"z_a","slot":"midfield","tag":"center"}',
      '{"op":"spawn","id":"sp","zone":"z_a","team":"red"}',
      '{"op":"goal","id":"crystal","zone":"z_a","noun":"sacred crystal"}',
      '{"op":"ent","id":"crystal_hp","kind":"health","noun":"crystal durability","zone":"z_a","hp":200}',
      '{"op":"ent","id":"player_hp","kind":"health","zone":"z_a","hp":150}',
      '{"op":"ent","id":"mana","kind":"health","zone":"z_a","hp":50}',
      '{"op":"rule","id":"r_lose_crystal","when":{"t":"health_lte","a":"crystal_hp","n":0},"then":[{"e":"lose","target":"player"}]}',
      '{"op":"rule","id":"r_lose_player","when":{"t":"health_lte","a":"player_hp","n":0},"then":[{"e":"lose","target":"player"}]}',
    ].join("\n");
    const p = parseFill(lines, { seed: 3 });
    expect(p.draft.verbs.map((x) => [x.id, x.verb, x.on, x.params])).toEqual([["crystal_hp", "combat_sport.health", "crystal", { hp: 200 }], ["player_hp", "combat_sport.health", "player", { hp: 150 }]]);
    expect(p.draft.rules.map((r) => r.when.a)).toEqual(["crystal", "player"]);
    expect(p.notes.filter((n) => n.kind === "invalid").map((n) => n.id)).toEqual(["mana"]); // (whose? nobody says)
  });
});

describe("glued objects", () => {
  it("a whole world on one line (no newlines) parses like one object per line; strings with braces stay whole", async () => {
    const { parseFill, splitObjects } = await import("../src");
    const lines = [
      '{"op":"meta","mode":"play","pack":"arena","seed":3}',
      '{"op":"zone","id":"z_a","slot":"midfield","tag":"center","name":"The {middle}"}',
      '{"op":"spawn","id":"sp","zone":"z_a","team":"red"}',
      '{"op":"end","layer":"gameplay"}',
    ];
    expect(splitObjects(lines.join(""))).toEqual(lines);
    expect(splitObjects("not json")).toEqual(["not json"]);
    expect(splitObjects(`${lines[0]}{"op":"zone","id":"z_b"`)).toEqual([lines[0], '{"op":"zone","id":"z_b"']); // a cut-off tail stays apart
    const glued = parseFill(lines.join(""), { seed: 3 });
    expect(glued.notes.filter((n) => n.kind === "invalid")).toEqual([]);
    expect(glued.draft.zones.map((z) => z.name)).toEqual(["The {middle}"]);
    expect(glued.gameplayDone).toBe(true);
  });
});

describe("references", () => {
  it("rule conditions on special refs with a path (player.team, team:red.score) are kept", async () => {
    const { parseFill } = await import("../src");
    const fill = [
      '{"op":"meta","mode":"play","pack":"arena","seed":3}',
      '{"op":"zone","id":"z_a","slot":"midfield","tag":"center"}',
      '{"op":"spawn","id":"sp","zone":"z_a","team":"red"}',
      '{"op":"goal","id":"cap","zone":"z_a"}',
      '{"op":"rule","id":"r_cap","when":{"t":"enter","a":"player","b":"cap"},"if":[{"l":"player.team","op":"eq","r":"red"},{"l":"team:red.score","op":"lt","r":3}],"then":[{"e":"score","target":"team:red","n":1}]}',
      '{"op":"end","layer":"gameplay"}',
    ].join("\n");
    const p = parseFill(fill, { seed: 3 });
    expect(p.notes.filter((n) => n.kind === "unresolved")).toEqual([]);
    expect(p.draft.rules.map((r) => r.id)).toEqual(["r_cap"]);
  });
});

describe("laws nobody wrote", () => {
  it("a fresh fill with no law line has unwritten laws; a law line, an edit's pinned fit or a merged patch means someone decided", async () => {
    const { lawsUnwritten, mergeFill, pinLayout } = await import("../src");
    const fresh = ['{"op":"meta","mode":"play","pack":"arena","seed":3}', '{"op":"zone","id":"z_a","slot":"midfield"}'].join("\n");
    expect(lawsUnwritten(fresh)).toBe(true);
    expect(lawsUnwritten(`${fresh}\n{"op":"law","player":{"jumpsMax":1}}`)).toBe(false);
    expect(lawsUnwritten(pinLayout(fresh))).toBe(false);
    expect(lawsUnwritten(mergeFill(fresh, '{"op":"zone","id":"z_b","slot":"west_half"}').text)).toBe(false);
  });
});

describe("mergeFill (repair patches)", () => {
  const base = [
    '{"op":"meta","mode":"play","pack":"arena","seed":3}',
    '{"op":"zone","id":"z_a","slot":"midfield","tag":"center"}',
    '{"op":"ent","id":"gem","kind":"pickup","zone":"z_a","anchor":"center"}',
    '{"op":"rule","id":"r_win","when":{"t":"enter","a":"player","b":"goal"},"then":[{"e":"win","target":"player"}]}',
    '{"op":"expect","id":"x_win","prop":"win_reachable","a":"sp","b":"z_a","headline":true}',
    '{"op":"end","layer":"gameplay"}',
  ].join("\n");
  it("replaces by id in place, deletes, and inserts new lines with their op group", async () => {
    const { mergeFill } = await import("../src");
    const patch = [
      '{"op":"rule","id":"r_win","when":{"t":"enter","a":"gem","b":"goal"},"then":[{"e":"win","target":"player"}]}',
      '{"op":"verb","id":"vb_carry","verb":"physics_props.carry","on":"gem","params":{}}',
      '{"op":"del","id":"x_win"}',
      '{"op":"meta","mode":"wander"}',
    ].join("\n");
    const { text, stats } = mergeFill(base, patch);
    expect(stats).toEqual({ replaced: 1, added: 1, deleted: 1, ignored: 1, locked: 0 });
    const ops = text.trim().split("\n").map((l) => JSON.parse(l) as { op: string; id?: string });
    expect(ops.map((o) => o.id ?? o.op)).toEqual(["meta", "z_a", "gem", "vb_carry", "r_win", "end"]);
    expect(text).toContain('"a":"gem"');
  });
  it("a goal a patch rewrites as an ent line with no kind (or zone) keeps them", async () => {
    const { mergeFill } = await import("../src");
    const goal = base.replace('{"op":"rule"', '{"op":"goal","id":"exit","zone":"z_a","anchor":"center"}\n{"op":"rule"');
    const { text } = mergeFill(goal, '{"op":"ent","id":"exit","anchor":"deck_center","noun":"banner","body":"sensor","size":[2,3,0.2]}');
    const exit = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).find((o) => o.id === "exit")!;
    expect(exit).toMatchObject({ op: "ent", kind: "goal", zone: "z_a", anchor: "deck_center" });
  });
  it("edits restyle through meta but never change the world's promises", async () => {
    const { mergeFill } = await import("../src");
    const patch = [
      '{"op":"meta","mode":"wander","pack":"maze","seed":9,"timeOfDay":22,"weather":"rain"}',
      '{"op":"law","player":{"jumpsMax":1}}',
      '{"op":"expect","id":"x_win","prop":"unreachable","a":"sp","b":"z_a"}',
      '{"op":"del","id":"x_win"}',
      '{"op":"dress","id":"d_1","noun":"lamp","zone":"z_a"}',
    ].join("\n");
    const { text, stats } = mergeFill(base, patch, { edit: true });
    expect(stats).toEqual({ replaced: 1, added: 1, deleted: 0, ignored: 1, locked: 2 });
    const ops = text.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ops[0]).toEqual({ op: "meta", mode: "play", pack: "arena", seed: 3, timeOfDay: 22, weather: "rain", patched: true });
    expect(ops.map((o) => o.id ?? o.op)).toEqual(["meta", "z_a", "gem", "law", "r_win", "x_win", "end"]);
    expect(text).toContain('"prop":"win_reachable"');
  });
});
