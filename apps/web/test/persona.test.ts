// Persona sliders: which traits each minded character gets, the patch a slider writes (only what
// the envelope covers: an option on its menu, a price the world's coins can pay, a range in the
// perception envelope), and that persona prose never moves the spec hash while gameplay does.
import { describe, expect, it } from "vitest";
import { buildWorld, hashWorld, worldFromFill } from "../src/pipeline";
import { mergeEdit } from "../src/structure";
import { pinLayout } from "@ghostrun/ir";
import { chattiness, charactersOf, personaEdit, PERCEPTION, replaceLine, withTalk } from "../src/persona";

const slider = (w: ReturnType<typeof buildWorld>, npc: string, trait: string) => charactersOf(w.bundle).find((c) => c.npc === npc)!.sliders.find((s) => s.trait === trait)!;
const edited = (w: ReturnType<typeof buildWorld>, patch: string) => worldFromFill(mergeEdit(pinLayout(w.fill), patch, w.seed).text, w.seed, undefined, w.bundle.pack.id, w.bundle.mode);

describe("persona sliders", () => {
  it("the museum guard: cautious ↔ bold over its menu, quiet ↔ chatty, greedy ↔ honest up to the coins the world holds, sleepy ↔ alert in the envelope", () => {
    const w = buildWorld("", "museum");
    const [guard] = charactersOf(w.bundle);
    expect(guard!.npc).toBe("guard");
    expect(guard!.name).toBe("night guard");
    expect(guard!.sliders.map((s) => s.trait)).toEqual(["bold", "chatty", "greedy", "alert"]);
    // looking away is what the bribe earns: never an option it starts on
    expect(slider(w, "guard", "bold")).toMatchObject({ options: ["guard.watch", "guard.patrol"], value: 0 });
    expect(slider(w, "guard", "greedy")).toMatchObject({ min: 5, max: 60, value: 20, rule: "r_bribe", word: "coins" });
    expect(slider(w, "guard", "alert")).toMatchObject({ min: PERCEPTION.min, max: PERCEPTION.max, value: 9 });
    expect(slider(w, "guard", "chatty").value).toBe(2);
  });

  it("the CTF cast: the mate and the rivals, bold ↔ cautious over their menus; nobody watches, nobody takes a bribe", () => {
    const cs = charactersOf(buildWorld("", "ctf").bundle);
    expect(cs.map((c) => c.npc)).toEqual(["mate_1", "rival_1", "rival_2"]);
    expect(cs[0]!.sliders.map((s) => s.trait)).toEqual(["bold", "chatty"]);
    expect(cs[0]!.sliders[0]).toMatchObject({ options: ["teammate.defend", "teammate.follow", "teammate.attack"], value: 0 });
  });

  it("sleepy: the guard sees less far, a gameplay edit with its numbers, and the spec moves", async () => {
    const w = buildWorld("", "museum");
    const e = personaEdit(w.fill, w.bundle, slider(w, "guard", "alert"), 6, "night guard")!;
    expect(e).toMatchObject({ gameplay: true, change: "the night guard: sleepy (sees 6 m, was 9 m)", summary: ["night guard sees 9 m → 6 m"] });
    const w2 = edited(w, e.patch);
    expect(w2.bundle.cast.find((c) => c.npc === "guard")!.rangeM).toBe(6);
    expect(await hashWorld(w2.bundle)).not.toBe(await hashWorld(w.bundle));
    // out of the envelope is clamped into it
    expect(JSON.parse(personaEdit(w.fill, w.bundle, slider(w, "guard", "alert"), 99, "night guard")!.patch).rangeM).toBe(PERCEPTION.max);
    expect(personaEdit(w.fill, w.bundle, slider(w, "guard", "alert"), 9, "night guard")).toBeNull();
  });

  it("honest: the bribe costs more, in the trigger, the purse check and what it takes", () => {
    const w = buildWorld("", "museum");
    const e = personaEdit(w.fill, w.bundle, slider(w, "guard", "greedy"), 35, "night guard")!;
    expect(e.summary).toEqual(["night guard takes 20 → 35 coins"]);
    const r = edited(w, e.patch).bundle.rules.find((x) => x.id === "r_bribe")!;
    expect(r.when.n).toBe(35);
    expect(r.if.find((c) => c.l === "player.coins")).toMatchObject({ op: "gte", r: 35 });
    expect(r.then.find((x) => x.e === "take")).toMatchObject({ n: 35, v: "coins" });
    expect(r.then.find((x) => x.e === "set_state")).toMatchObject({ v: "look_away", n: 20 }); // how long it looks away is not the price
  });

  it("bold: the option it starts on, from its own menu", () => {
    const w = buildWorld("", "ctf");
    const e = personaEdit(w.fill, w.bundle, slider(w, "mate_1", "bold"), 2, "mate 1")!;
    expect(e.summary).toEqual(["mate 1 starts on defend → attack"]);
    expect(edited(w, e.patch).bundle.cast.find((c) => c.npc === "mate_1")!.dflt).toBe("teammate.attack");
  });

  it("quiet ↔ chatty is persona prose: the reply style changes, the spec hash doesn't", async () => {
    const w = buildWorld("", "museum");
    const e = personaEdit(w.fill, w.bundle, slider(w, "guard", "chatty"), 4, "night guard")!;
    expect(e.gameplay).toBe(false);
    const w2 = worldFromFill(replaceLine(w.fill, e.patch), w.seed, undefined, w.bundle.pack.id, w.bundle.mode);
    const p = w2.bundle.cast.find((c) => c.npc === "guard")!.persona;
    expect(p.replyStyle).toBe("short and gruff; never stops talking");
    expect(chattiness(p)).toBe(4);
    expect(await hashWorld(w2.bundle)).toBe(await hashWorld(w.bundle));
    expect(withTalk("short and gruff; never stops talking", 0)).toBe("short and gruff; says nothing unless spoken to");
    expect(withTalk("short and gruff; chatty", 2)).toBe("short and gruff");
    expect(withTalk("", 3)).toBe("chatty");
  });
});
