import { describe, expect, it } from "vitest";
import { buildWorld } from "../src/pipeline";
import { designNotes, failChanges, unusedChanges } from "../src/notes";

const ctf = () => buildWorld("", "ctf").bundle;
const at = (why: string, near = "Neon plaza") => ({ near, why: [[why, 3]] as [string, number][] });

describe("design notes as changes", () => {
  it("nobody went near the hover platform: a reason to go there (one of the world's own secrets), or take it out", () => {
    expect(unusedChanges(ctf(), "pad_mid")).toEqual(["put a neon shard on the hover platform", "take out the hover platform"]);
    // something that isn't a platform gets it beside it
    expect(unusedChanges(ctf(), "sign_hot")).toEqual(["put a neon shard by the neon billboard", "take out the neon billboard"]);
    expect(unusedChanges(ctf(), "nothing_here")).toEqual([]);
  });

  it("a world without secrets offers what it has you collect, else a coin", () => {
    const b = ctf();
    b.entities = b.entities.filter((e) => !e.tags.includes("bonus"));
    b.verbs = b.verbs.filter((v) => v.verb !== "puzzle.collect");
    expect(unusedChanges(b, "pad_mid")[0]).toBe("put a coin on the hover platform");
  });

  it("where runs went wrong, by its commonest reason", () => {
    const b = ctf();
    expect(failChanges(b, at("hit the lava pool"))).toEqual(["make the lava pool jump fairer: a wider ledge", "move the lava pool off the main path"]);
    expect(failChanges(b, at("into the lava"))[0]).toBe("make the lava jump fairer: a wider ledge");
    expect(failChanges(b, at("knocked out by the zombie"))).toEqual(["make the zombie hit less hard", "give the player more hit points"]);
    expect(failChanges(b, at("knocked out"))[0]).toBe("make the enemies hit less hard");
    expect(failChanges(b, at("got stuck on the way to the glowing orb"))).toEqual(["make the way to the glowing orb easier: a ramp or a lower step", "move the glowing orb somewhere easier to reach"]);
    expect(failChanges(b, at("got stuck", "rooftop"))[0]).toBe("make the way to the rooftop easier: a ramp or a lower step");
    expect(failChanges(b, at("no win by 2:00"))).toEqual(["make the way to the neon goal ring shorter"]);
    expect(failChanges(b, at("blue reached 3"))).toEqual(["make the rivals a little slower", "give the rivals a longer way to their goal"]);
    // a reason no simple change answers gets no Apply
    expect(failChanges(b, at("drone down"))).toEqual([]);
  });

  it("a timer world can have more time on the clock", () => {
    const b = buildWorld("", "coin-rush").bundle;
    expect(failChanges(b, at("the timer ran out"))).toContain("put more time on the clock");
  });

  it("the receipt's notes, in its own order, each with its key", () => {
    const b = ctf();
    const notes = designNotes(b, { unused: [{ id: "pad_mid", noun: "hover platform" }], hot: [], samples: 10 }, { runs: 24, samples: 10, heat: { cell: 1.5, cells: [] }, fails: [{ x: 19, z: -2.5, near: "Neon plaza", n: 7, runs: 7, why: [["blue reached 3", 5], ["no win by 2:00", 2]] }, { x: 0, z: 0, near: "", n: 1, runs: 1, why: [["drone down", 1]] }], fights: null, pace: [], times: null });
    expect(notes.map((n) => n.key)).toEqual(["unused:pad_mid", "fail:0"]);
    expect(notes[1]!.changes[0]).toBe("make the rivals a little slower");
  });
});
