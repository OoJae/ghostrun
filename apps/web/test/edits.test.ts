import { beforeAll, describe, expect, it } from "vitest";
import { mergeFill, pinLayout } from "@ghostrun/ir";
import { loadNavNode } from "@ghostrun/nav/node";
import { prove } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import type { Band, Chip, Receipt } from "@ghostrun/proof";
import { changeSummary, editedPrompt, HARDER, intentFor, pickHarder, receiptDelta, screenRace, screenScore, type Screened } from "../src/edits";
import type { Model } from "@ghostrun/proof";
import { buildWorld, ENGINE_HASH, worldFromFill } from "../src/pipeline";

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

const edit = (fill: string, patch: string[]) => mergeFill(fill, patch.join("\n"), { edit: true });

describe("edits", () => {
  it("break it: 'super high jumps' keeps the promise, and the proof catches a single jump reaching the roof", async () => {
    const world = buildWorld("", "ctf");
    // the model also tries to quietly drop the rooftop promise: the merge keeps it
    const { text, stats } = edit(pinLayout(world.fill), ['{"op":"law","player":{"jumpsMax":2,"jumpH":3.4}}', '{"op":"del","id":"x_roof"}', '{"op":"meta","fit":{"jumpH":3.4}}']);
    expect(stats.locked).toBe(1);
    const w2 = worldFromFill(text, world.seed, undefined, world.bundle.pack.id, world.bundle.mode);
    expect(w2.bundle.expects.map((x) => x.id)).toEqual(world.bundle.expects.map((x) => x.id));
    expect(w2.bundle.statics).toEqual(world.bundle.statics); // same city, higher jumps
    // a pinned fill rebuilds the same world anywhere (share links, the proof worker)
    expect(worldFromFill(w2.fill, world.seed).bundle.statics).toEqual(w2.bundle.statics);
    expect(changeSummary(world.bundle, w2.bundle)[0]).toBe("jump height 1.6 → 3.4 m");
    const [a, b] = await Promise.all([prove(R, world.bundle, { engine: ENGINE_HASH, runs: 4 }), prove(R, w2.bundle, { engine: ENGINE_HASH, runs: 4 })]);
    expect(a.headline?.status).toBe("verified");
    expect(b.headline?.status).toBe("counterexample");
    const d = receiptDelta(a, b);
    expect(d[0]).toEqual({ label: "Headline", from: "verified", to: "counterexample", sign: -1 });
    expect(d.find((x) => x.label === "Counterexamples")?.sign).toBe(-1);
  }, 180_000);

  it("names what changed: things added and removed by noun, laws, rules, time of day and weather", () => {
    const world = buildWorld("", "ctf");
    const { text } = edit(world.fill, [
      '{"op":"meta","timeOfDay":12,"weather":"clear","pack":"maze"}',
      '{"op":"ent","id":"coin_1","kind":"pickup","noun":"gold coin","zone":"z_plaza","anchor":"wall_s"}',
      '{"op":"ent","id":"coin_2","kind":"pickup","noun":"gold coin","zone":"z_plaza","anchor":"wall_e"}',
      '{"op":"del","id":"sign_hot"}',
      '{"op":"law","player":{"jumpsMax":2,"jumpH":2.2,"speed":8}}',
    ]);
    const w2 = worldFromFill(text, world.seed, undefined, world.bundle.pack.id, world.bundle.mode);
    expect(w2.bundle.pack.id).toBe("city_block"); // an edit restyles, it never swaps the pack
    expect(changeSummary(world.bundle, w2.bundle)).toEqual(["jump height 1.6 → 2.2 m", "speed 6 → 8 m/s", "+2 gold coins", "−1 neon billboard", "now day", "skies clear"]);
    expect(changeSummary(world.bundle, world.bundle)).toEqual([]);
  });

  it("recorded worlds get an intent the edit route accepts; edited prompts keep their history", () => {
    const world = buildWorld("", "ctf");
    const i = intentFor(world, "capture the flag");
    expect(i).toMatchObject({ mode: "play", pack: "city_block", sub: ["rooftop"], safety: "ok", headline: "Rooftop lane needs double jump", nouns: [] });
    expect(editedPrompt("a heist", ["only one jump", "make it night"])).toBe("a heist\nThen: only one jump\nThen: make it night");
  });
});

describe("harder but fair: the race's judge", () => {
  const receipt = (k: number, par: number | null, head: Chip["status"] = "verified"): Receipt => ({
    v: 1, spec: "", engine: "", host: "device", ms: 0,
    headline: { expect: "x", text: "x", status: head, method: "" },
    chips: [{ id: "T3:win", tier: "T3", subject: { kind: "world", id: "" }, status: k ? "played" : "counterexample", method: "", n: 12, k, text: "", cx: null, src: "", ms: 0 }],
    par: par === null ? null : { goldS: par, runs: 12, won: k },
  });
  it("keeps the hardest candidate that is still fair, and says why each one lost", () => {
    const before = receipt(12, 20);
    const { best, verdicts } = pickHarder(before, [receipt(2, 50), receipt(11, 31), receipt(12, 20.5), null, receipt(12, 40, "counterexample")]);
    expect(best).toBe(1);
    expect(verdicts).toEqual([
      "A: too hard or broken (par 20 → 50 s, 2 of 12 runners won)",
      "B: harder and fair (par 20 → 31 s, 11 of 12 runners won)",
      "C: not harder (par 20 → 20.5 s, 12 of 12 runners won)",
      "D: the model's patch didn't arrive",
      "E: too hard or broken (par 20 → 40 s, 12 of 12 runners won, headline counterexample)",
    ]);
    expect(pickHarder(before, [receipt(3, 60)]).best).toBeNull();
    // harder, but a choice the cast's minds can make now stops every runner: not fair
    const envelope = receipt(12, 30);
    envelope.chips.push({ ...envelope.chips[0]!, id: "T3:envelope", status: "counterexample" });
    expect(pickHarder(before, [envelope]).verdicts).toEqual(["A: too hard or broken (par 20 → 30 s, 12 of 12 runners won, fails T3:envelope)"]);
    expect(HARDER.test("make it harder but fair")).toBe(true);
    expect(HARDER.test("make it night")).toBe(false);
  });

  it("with the playtest's bands, prefers the one a band harder that the experts still win 10 of 12", () => {
    const banded = (k: number, par: number, band: Band): Receipt => ({ ...receipt(k, par), playtest: { levels: [], band, trails: [], steps: [], ms: 0 } });
    const before = banded(12, 20, "Normal");
    // B is slower but two bands up; C is one band up with 11 of 12 experts; D one band up with 9 of 12
    const { best, verdicts } = pickHarder(before, [banded(12, 20.4, "Normal"), banded(12, 32, "Expert only"), banded(11, 24, "Hard"), banded(9, 30, "Hard")]);
    expect(best).toBe(2);
    expect(verdicts).toEqual([
      "A: not harder (par 20 → 20.4 s, 12 of 12 runners won, Normal → Normal)",
      "B: harder and fair (par 20 → 32 s, 12 of 12 runners won, Normal → Expert only)",
      "C: harder and fair (par 20 → 24 s, 11 of 12 runners won, Normal → Hard)",
      "D: harder and fair (par 20 → 30 s, 9 of 12 runners won, Normal → Hard)",
    ]);
    // the same par and win rate, only the band moved: that is harder too
    expect(pickHarder(before, [banded(12, 20.4, "Hard")]).best).toBe(0);
    // no band for the world itself (its playtest hadn't landed): the numbers decide, as before
    expect(pickHarder(receipt(12, 20), [banded(12, 32, "Expert only"), banded(11, 24, "Hard")]).best).toBe(0);
  });
});

describe("harder but fair, screened on T4 first", () => {
  // the world's own route model: novices 80%, average 95%, experts 100% (each ± its bench error), median 0:30
  const base: Model = {
    runs: 1200,
    levels: [
      { level: "novice", p: 0.8, err: 0.24, physics: { runs: 6, won: 5 } },
      { level: "average", p: 0.95, err: 0.15, physics: { runs: 6, won: 6 } },
      { level: "expert", p: 1, err: 0.04, physics: { runs: 12, won: 12 } },
    ],
    times: { median: 30, lo: 24, hi: 40, err: 0.11, physics: 30 },
    heat: [],
    heatErr: 0.1,
    heatGap: 0,
    teams: null,
    anchor: { scale: 1, risk: 1 },
    ms: 5,
  };
  const s = (novice: number, average: number, expert: number, median = 30): Screened => ({ levels: { novice, average, expert }, median });

  it("calls a candidate fair while modelled experts still win half the time, harder as novices and average players win less", () => {
    expect(screenScore(base, s(0.5, 0.8, 0.95)).fair).toBe(true);
    expect(screenScore(base, s(0.1, 0.2, 0.4)).fair).toBe(false);
    expect(screenScore(base, s(0.5, 0.8, 0.95)).score).toBeGreaterThan(screenScore(base, s(0.7, 0.9, 1)).score);
    expect(screenScore(base, s(0.5, 0.8, 0.95, 45)).score).toBeGreaterThan(screenScore(base, s(0.5, 0.8, 0.95, 30)).score);
    expect(screenScore(base, s(0.5, 0.8, 0.95)).line).toBe("modelled: novices 80% → 50% ±24, average 95% → 80% ±15, experts 100% → 95% ±4");
    expect(screenScore(base, null)).toMatchObject({ fair: false, line: "no route to model" });
  });

  it("halves the field each round with four times the modelled runs, and hands physics the pick first, the rest in screened order", async () => {
    const asked: [number, number][] = [];
    const reads = [s(0.75, 0.9, 1), s(0.4, 0.7, 0.9), s(0.1, 0.1, 0.3), s(0.6, 0.85, 1)];
    const { order, notes } = await screenRace(base, [0, 1, 2, 3], async (i, n) => (asked.push([i, n]), reads[i]!));
    // round 1: all four at 150 runs (C unfair, out); round 2: the better two (B, D) at 600; then B alone
    expect(asked).toEqual([[0, 150], [1, 150], [2, 150], [3, 150], [1, 600], [3, 600]]);
    expect(order).toEqual([1, 3, 0, 2]);
    expect(notes.get(2)).toMatch(/^screened out on T4 \(unfair\) with 150 modelled runs at each level, modelled: /);
    expect(notes.get(1)).toMatch(/^screened on T4 with 600 modelled runs at each level/);
    // nothing fair on the model: physics proves them all, as before
    expect((await screenRace(base, [0, 1], async () => s(0, 0, 0.2))).order).toEqual([0, 1]);
  });
});
