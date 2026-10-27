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
