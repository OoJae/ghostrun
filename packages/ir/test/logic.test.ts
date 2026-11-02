import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { logicOf, parseFill, ruleText, ruleTiles, thingLabel, type Rule } from "../src";

const ctf = parseFill(readFileSync(new URL("../fixtures/ctf-neon.jsonl", import.meta.url), "utf8"), { seed: 7 }).draft;
const rule = (id: string) => ctf.rules.find((r) => r.id === id)!;

describe("the Logic X-ray's sentences", () => {
  it("says each rule as WHEN / IF / THEN, naming things by their nouns", () => {
    expect(ruleText(rule("r_score_red"), ctf)).toBe("WHEN glowing orb enters neon goal ring IF glowing orb carrier team = red THEN +1 red team, reset glowing orb");
    expect(ruleText(rule("r_pickup"), ctf)).toBe("WHEN glowing orb is picked up by player THEN glowing orb becomes carried, ✨ sparkle");
    expect(ruleText(rule("r_win"), ctf)).toBe("WHEN red team reaches 3 THEN you win (once)");
  });

  it("builds the tiles the X-ray draws: things by id, words and values as said", () => {
    const s = ruleTiles(rule("r_score_red"));
    expect(s.when).toEqual([{ kind: "thing", id: "orb" }, { kind: "word", id: "enters" }, { kind: "thing", id: "goal_red" }]);
    expect(s.conds).toEqual([[{ kind: "thing", id: "orb" }, { kind: "word", id: "carrier team =" }, { kind: "value", id: "red" }]]);
    expect(s.effects[0]).toEqual([{ kind: "word", id: "+1" }, { kind: "thing", id: "team:red" }]);
    expect([thingLabel("player", ctf), thingLabel("team:blue", ctf), thingLabel("nobody", ctf)]).toEqual(["player", "blue team", "nobody"]);
  });

  it("says the triggers and effects without a thing as words", () => {
    const base = { ...rule("r_win"), if: [], once: false } as Rule;
    const say = (when: Partial<Rule["when"]>, then: Partial<Rule["then"][number]>[] = [{ e: "win" }]) =>
      ruleText({ ...base, when: { ...base.when, a: "", b: "", ...when }, then: then.map((e) => ({ ...base.then[0]!, ...e })) }, ctf);
    expect(say({ t: "every", n: 5 }, [{ e: "damage", target: "player", n: 10 }])).toBe("WHEN every 5 s THEN −10 HP player");
    expect(say({ t: "timer_end" }, [{ e: "lose" }])).toBe("WHEN the timer runs out THEN you lose");
    expect(say({ t: "health_lte", a: "", n: 0, b: "orb" })).toBe("WHEN anyone is knocked out by glowing orb THEN you win");
    expect(say({ t: "touch", a: "player" }, [{ e: "teleport", target: "player", v: "goal_red" }])).toBe("WHEN player touches anything THEN send player to neon goal ring");
  });

  it("puts the rules that win or lose last and tells the secrets apart", () => {
    // the placer hides the secrets (bonus pickups, each with its sparkle rule): two here, by hand
    const orb = ctf.entities.find((e) => e.id === "orb")!;
    const shards = ["s1", "s2"].map((id) => ({ ...orb, id, noun: "neon shard", tags: ["bonus"] }));
    const sparkles = shards.map((s) => ({ ...rule("r_pickup"), id: `r_${s.id}`, when: { ...rule("r_pickup").when, t: "touch" as const, a: "player", b: s.id } }));
    const b = { ...ctf, entities: [...ctf.entities, ...shards], rules: [...sparkles, ...ctf.rules] };
    const l = logicOf(b);
    expect(l.rules.map((r) => r.id)).toEqual(["r_pickup", "r_score_red", "r_score_blue", "r_win", "r_lose"]);
    expect(l.secrets.map((r) => r.id)).toEqual(["r_s1", "r_s2"]);
    expect(l.secretNoun).toBe("neon shard");
    expect(logicOf(ctf).secretNoun).toBe("gem");
    expect(l.verbs.map((v) => v.verb)).not.toContain("locomotion.jump"); // the player's own verbs aren't listed
  });
});
