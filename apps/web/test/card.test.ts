// The Intent card's corrections: a look, an hour or a weather pinned in the meta line wins over the
// AI's words and never moves the spec hash (and the fill alone rebuilds it, as a share link does);
// a law change writes the whole law line from the laws the world plays by; "did you mean" comes
// from a small table over the prompt's own words; a rebuild says what it was rebuilt as.
import { describe, expect, it } from "vitest";
import { mergeFill, pinLayout } from "@ghostrun/ir";
import { ambiguity, controlsFor, lawChange, layoutChangeOf, rebuiltLine, restyled, type CardActions } from "../src/card";
import { buildWorld, hashWorld, worldFromFill, type World } from "../src/pipeline";
import { pickLook, rawMeta } from "../src/render/pick";

const again = (w: World, fill: string) => worldFromFill(fill, w.seed, w.intent.live, w.bundle.pack.id, w.bundle.mode);
const none: CardActions = { onLook: () => {}, onPhase: () => {}, onWeather: () => {}, onLaws: () => {}, onLayout: () => {}, onShape: () => {} };

describe("the card's looks", () => {
  it("a picked look and sub-style wins over the words, keeps the spec hash, and the fill alone rebuilds it", async () => {
    const ctf = buildWorld("", "ctf");
    expect(pickLook(ctf.cue)).toMatchObject({ id: "neon", phase: "night" });
    const w2 = again(ctf, restyled(ctf.fill, { look: "snow/cave" }));
    expect(pickLook(w2.cue)).toMatchObject({ id: "snow", variant: "cave" });
    expect(await hashWorld(w2.bundle)).toBe(await hashWorld(ctf.bundle));
    expect(pickLook(again(ctf, w2.fill).cue)).toMatchObject({ id: "snow", variant: "cave" }); // a share link
  });

  it("a picked hour and weather are the whole sky: daytime in the neon city, a clear sky over a rainy setting", async () => {
    const ctf = buildWorld("", "ctf");
    const day = again(ctf, restyled(ctf.fill, { phase: "day" }));
    expect(pickLook(day.cue).phase).toBe("day"); // the city's words alone would keep it night
    expect(day.bundle.cosmetic.timeOfDay).toBe(12);
    const rainy = { ...ctf.cue, setting: "a rain-soaked neon alley in a thunderstorm" };
    expect(pickLook(rainy)).toMatchObject({ rain: true, storm: true });
    expect(pickLook({ ...rainy, pin: { weather: "clear" } })).toMatchObject({ rain: false, storm: false, snow: false, fog: false });
    expect(pickLook({ ...ctf.cue, pin: { weather: "snow" } })).toMatchObject({ snow: true, rain: false });
    const both = again(ctf, restyled(restyled(ctf.fill, { weather: "fog" }), { phase: "dusk" }));
    expect(pickLook(both.cue)).toMatchObject({ fog: true, phase: "dusk" });
    expect(await hashWorld(both.bundle)).toBe(await hashWorld(ctf.bundle));
  });

  it("a pin it can't wear is ignored: a home on streets (no rooms), a look or weather that isn't one", () => {
    const ctf = buildWorld("", "ctf");
    expect(pickLook(again(ctf, restyled(ctf.fill, { look: "home/japanese" })).cue).id).toBe("neon");
    const vault = buildWorld("", "vault");
    expect(pickLook(again(vault, restyled(vault.fill, { look: "home/japanese" })).cue)).toMatchObject({ id: "home", variant: "japanese" });
    const bad = ctf.fill.replace(/^\{"op":"meta",/, '{"op":"meta","pin":{"look":"lava world","weather":"hail","phase":"noon"},');
    expect(rawMeta(bad)?.pin).toBeUndefined();
  });
});

describe("the card's moves and layout", () => {
  it("a law change writes the whole law line from the laws played now: only that number moves", () => {
    const ctf = buildWorld("", "ctf");
    const { change, patch } = lawChange(ctf.bundle.laws, { gravity: "moon" });
    expect(change).toBe("moon gravity");
    const w2 = again(ctf, mergeFill(pinLayout(ctf.fill), patch, { edit: true }).text);
    expect(w2.bundle.laws).toEqual({ ...ctf.bundle.laws, gravityScale: 0.17 });
    expect(w2.bundle.statics).toEqual(ctf.bundle.statics); // the same city: laws never move geometry
    expect(lawChange(ctf.bundle.laws, { jumpsMax: 1 }).change).toBe("only one jump");
    expect(JSON.parse(lawChange(ctf.bundle.laws, { speed: "fast" }).patch).player.speed).toBe(9);
  });

  it("the card's fields read the world as it is, and its layout buttons are this pack's", () => {
    const ctf = buildWorld("", "ctf");
    const k = controlsFor(ctf, { live: true, busy: false, prompt: ctf.fill, act: none });
    expect(k).toMatchObject({ look: { value: "neon", label: "Neon city" }, phase: "night", jumps: 2, gravity: "normal", speed: "normal", layout: { subs: [{ id: "rooftop", on: true }] } });
    expect(k.looks.some((l) => l.value.startsWith("home"))).toBe(false);
    expect(layoutChangeOf(ctf.fill, { sub: { id: "rooftop", on: true } })).toEqual({ change: "remove the rooftop lane", patch: '{"op":"layout","sub":[]}' });
    const vault = buildWorld("", "vault");
    expect(layoutChangeOf(vault.fill, { floors: 2 })).toEqual({ change: "add a floor", patch: '{"op":"layout","params":{"floors":2}}' });
    expect(layoutChangeOf(buildWorld("", "forest").fill, { scale: 1.25 })).toBeNull();
  });
});

describe("did you mean", () => {
  const i = (pack: string, mode = "play", genre = "game") => ({ pack, mode, genre });
  it("offers the other pack or genre the prompt's own words name, once, and nothing when the choice was clear", () => {
    expect(ambiguity("A race through the neon city streets", i("city_block", "play", "ctf"))).toMatchObject({ ask: "Did you mean a race?", pin: { genre: "race" } });
    expect(ambiguity("A race through the neon city streets", i("course", "play", "race"))).toMatchObject({ pin: { pack: "city_block" } });
    expect(ambiguity("A museum heist in the city at night", i("city_block"))).toMatchObject({ ask: "Did you mean indoors?", label: "Build it as rooms", pin: { pack: "floor_plan" } });
    expect(ambiguity("Bludiště s duchy: najdi klíč", i("floor_plan"))).toMatchObject({ pin: { pack: "maze" } });
    expect(ambiguity("Create a capture-the-flag game in a neon city. Add double jump.", i("city_block", "play", "ctf"))).toBeNull();
    expect(ambiguity("Find the key and escape the maze", i("maze"))).toBeNull();
  });

  it("offers the other mode when the words say so: a tour built as a game, a game built as a place", () => {
    expect(ambiguity("Tour a minimalist white gallery and look around", i("floor_plan", "play"))).toMatchObject({ ask: "Just explore it?", pin: { mode: "wander" } });
    expect(ambiguity("A gallery where you steal the gem and escape", i("floor_plan", "wander"))).toMatchObject({ ask: "Did you mean a game?", pin: { mode: "play" } });
  });

  it("a rebuild says what it was rebuilt as", () => {
    expect(rebuiltLine({ pack: "maze" })).toBe("rebuilt as a maze at your request");
    expect(rebuiltLine({ mode: "wander" })).toBe("rebuilt as a place to explore at your request");
    expect(rebuiltLine({ genre: "race" })).toBe("rebuilt as a race at your request");
    expect(rebuiltLine({ pack: "outdoor" })).toBe("rebuilt as the outdoors at your request");
  });
});
