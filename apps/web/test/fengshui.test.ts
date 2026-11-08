// The receipt's Feng Shui section on recorded worlds, built through the app's own pipeline and
// proved as the app proves them: the fixture gallery (green, toured), its variant with two
// mistakes, and the Feng Shui worlds the live lane built for the eval sets and the gallery.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { splitObjects } from "@ghostrun/ir";
import { FENG_SHUI_RULES } from "@ghostrun/layout";
import { loadNavNode } from "@ghostrun/nav/node";
import { chipLine, fengShuiHead, fengShuiLine, prove } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { fengShuiFor, fengShuiNotes } from "../src/fengshui";
import { ENGINE_HASH, FIXTURE_PROMPTS, FIXTURES, worldFromFill, type World } from "../src/pipeline";

const NAMES = new Map(FENG_SHUI_RULES.map((r) => [r.id, r.name]));
let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

const seedOf = (fill: string) => (JSON.parse(splitObjects(fill.split("\n", 1)[0]!)[0]!) as { seed: number }).seed;
const bench = (set: string, slug: string) => {
  const dir = new URL(`../../../tools/bench/worlds/${set}/`, import.meta.url);
  const fill = readFileSync(new URL(`${slug}.fill.jsonl`, dir), "utf8");
  const { prompt, intent } = JSON.parse(readFileSync(new URL(`${slug}.receipt.json`, dir), "utf8")) as { prompt: string; intent: { pack: string; mode: "play" | "wander" } };
  return { prompt, world: worldFromFill(fill, seedOf(fill), undefined, intent.pack, intent.mode) };
};

/** The receipt as the app shows it for this world: its tour, and the Feng Shui section. */
async function receiptOf(w: World, prompt: string) {
  const r = await prove(R, w.bundle, { engine: ENGINE_HASH, runs: 12 });
  const view = fengShuiFor(w, prompt)!;
  const tour = r.chips.find((c) => c.id === "T3:tour")!;
  return { tour, view, text: [`PROMPT: ${prompt}`, chipLine(tour), fengShuiHead(view.section), ...view.section.findings.map((f) => `  ${fengShuiLine(f, NAMES.get(f.rule)!)}`), ...w.notes.filter((n) => n.includes("Feng Shui")).map((n) => `  · ${n}`)].join("\n") };
}

describe("the Feng Shui section on recorded worlds", () => {
  it("the fixture gallery: every bag toured and every principle holds", async () => {
    const prompt = FIXTURE_PROMPTS.fengshui!;
    const { tour, view, text } = await receiptOf(worldFromFill(FIXTURES.fengshui!, seedOf(FIXTURES.fengshui!)), prompt);
    expect(tour.status).toBe("played");
    expect(tour.k).toBe(tour.n);
    expect(view.asked).toBe(true);
    expect(view.section).toMatchObject({ holds: 6, checked: 6 });
    expect(fengShuiNotes(view.section)).toEqual([]);
    await expect(text).toMatchFileSnapshot("__snapshots__/fengshui.gallery.txt");
  }, 120_000);

  it("its variant with two mistakes: toured, 4 of 6 hold, and the two fixes are changes the edit path can apply", async () => {
    const prompt = FIXTURE_PROMPTS["fengshui-broken"]!;
    const { tour, view, text } = await receiptOf(worldFromFill(FIXTURES["fengshui-broken"]!, seedOf(FIXTURES["fengshui-broken"]!)), prompt);
    expect(tour.status).toBe("played");
    expect(view.section).toMatchObject({ holds: 4, checked: 6 });
    expect(view.section.findings.filter((f) => f.verdict === "fails").map((f) => f.rule)).toEqual(["straight", "entry"]);
    expect(fengShuiNotes(view.section)).toEqual([
      { id: "fengshui:straight", text: "Feng Shui: hang a curtain over the tall arched window, or stand a tall plant between it and the front door", change: "Hang a curtain over hall_window (the tall arched window), or stand a tall plant between it and the front door." },
      { id: "fengshui:entry", text: "Feng Shui: move the bronze incense burner out of the way in", change: "Move incense_burner (the bronze incense burner) out of the way in from the front door, to a corner anchor of its zone." },
    ]);
    await expect(text).toMatchFileSnapshot("__snapshots__/fengshui.gallery-broken.txt");
  }, 120_000);

  it("the worlds the live lane built for Feng Shui prompts, read as they were recorded", async () => {
    const judges = bench("judges", "a-feng-shui-handbag-gallery-where-each-b");
    const living = bench("fresh10", "a-feng-shui-living-room-where-each-objec");
    const g = JSON.parse(readFileSync(new URL("../src/gallery/worlds/a-feng-shui-handbag-gallery-where-each-b.json", import.meta.url), "utf8")) as { prompt: string; fill: string; intent: { pack: string; mode: "play" | "wander" } };
    const gallery = { prompt: g.prompt, world: worldFromFill(g.fill, seedOf(g.fill), undefined, g.intent.pack, g.intent.mode) };
    const out: string[] = [];
    for (const x of [judges, living, gallery]) {
      const { tour, text } = await receiptOf(x.world, x.prompt);
      expect(tour.status, x.prompt).toBe("played");
      out.push(text);
    }
    await expect(out.join("\n\n")).toMatchFileSnapshot("__snapshots__/fengshui.recorded.txt");
  }, 180_000);

  it("is offered for any interior, opened for a Feng Shui prompt, and absent outdoors", () => {
    const heist = worldFromFill(FIXTURES.heist!, seedOf(FIXTURES.heist!));
    expect(fengShuiFor(heist, FIXTURE_PROMPTS.heist!)).toMatchObject({ asked: false });
    expect(fengShuiFor(heist, "a Feng Shui heist")).toMatchObject({ asked: true });
    expect(fengShuiFor(worldFromFill(FIXTURES.ctf!, seedOf(FIXTURES.ctf!)), FIXTURE_PROMPTS.ctf!)).toBeNull();
  });
});
