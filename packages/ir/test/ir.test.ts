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
    expect(stats).toEqual({ replaced: 1, added: 1, deleted: 1, ignored: 1 });
    const ops = text.trim().split("\n").map((l) => JSON.parse(l) as { op: string; id?: string });
    expect(ops.map((o) => o.id ?? o.op)).toEqual(["meta", "z_a", "gem", "vb_carry", "r_win", "end"]);
    expect(text).toContain('"a":"gem"');
  });
});
