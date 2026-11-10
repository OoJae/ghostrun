// Team AI on the client: the four orders, said or typed, and the command acts they queue (one per
// teammate whose menu takes the order), as the choice log carries them.
import { afterEach, describe, expect, it } from "vitest";
import { encodeAct } from "@ghostrun/sim";
import { applyHealthFlags, flagOn, readUrlFlags, resetFlags } from "../src/flags";
import { setLocale } from "../src/i18n";
import { buildWorld } from "../src/pipeline";
import { commandActs, commandOf, matchCommand, objectiveOf, teammates } from "../src/team";

afterEach(() => {
  setLocale("en");
  resetFlags();
});

describe("orders for your teammates", () => {
  it("reads the four orders from what you say", () => {
    expect(matchCommand("Follow me!", "glowing orb")).toBe("follow");
    expect(matchCommand("come with me", "glowing orb")).toBe("follow");
    expect(matchCommand("defend the base", "glowing orb")).toBe("defend");
    expect(matchCommand("fall back", "glowing orb")).toBe("defend");
    expect(matchCommand("get the orb", "glowing orb")).toBe("get");
    expect(matchCommand("the orb!", "glowing orb")).toBe("get");
    expect(matchCommand("attack!", "glowing orb")).toBe("attack");
    expect(matchCommand("go after them", "glowing orb")).toBe("attack");
    expect(matchCommand("nice weather today", "glowing orb")).toBeNull();
    expect(matchCommand("", "glowing orb")).toBeNull();
  });

  it("hears the wheel's own words in the player's language", () => {
    setLocale("cs");
    expect(matchCommand("Následuj mě", "orb")).toBe("follow");
    setLocale("de");
    expect(matchCommand("Verteidige die Basis!", "orb")).toBe("defend");
  });

  it("the CTF mate takes all four; each order is one logged command act", () => {
    const w = buildWorld("", "ctf");
    const mates = teammates(w.bundle, "red");
    expect(mates.map((m) => m.npc)).toEqual(["mate_1"]);
    expect(objectiveOf(w.bundle)).toBe("glowing orb");
    const acts = commandActs(mates, "follow");
    expect(acts).toEqual([{ to: "mate_1", act: "command", what: "teammate.follow", n: 0, slot: "" }]);
    expect(encodeAct(acts[0]!)).toBe("act:command:teammate.follow:0");
    expect(commandActs(mates, "get")[0]!.what).toBe("teammate.attack");
    expect(commandOf(mates[0]!, "teammate.attack")).toBe("get");
    expect(commandOf(mates[0]!, "teammate.defend")).toBe("defend");
    // a world with no team of yours has nobody to order about
    expect(teammates(buildWorld("", "museum").bundle, "red")).toEqual([]);
  });
});

describe("the living world's flags", () => {
  it("ship dark: off unless the edge says on, and the page can pin one", () => {
    expect(flagOn("team_ai")).toBe(false);
    applyHealthFlags({ team_ai: true, persona_sliders: false });
    expect(flagOn("team_ai")).toBe(true);
    expect(flagOn("persona_sliders")).toBe(false);
    resetFlags();
    readUrlFlags("?ff=-wander_life,team_ai");
    applyHealthFlags({ wander_life: true, team_ai: false });
    expect(flagOn("wander_life")).toBe(false);
    expect(flagOn("team_ai")).toBe(true);
    applyHealthFlags(null);
    expect(flagOn("persona_sliders")).toBe(false);
  });
});
