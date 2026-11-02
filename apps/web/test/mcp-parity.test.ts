// The edge's copy of the world pipeline (apps/edge-api/src/world.ts, which the MCP tools build and
// share with) against the web's own: the same stored fill and spec hash for every gallery world, as
// opened and as its share link rebuilds it, so a link an agent made opens as an exact world here;
// and the same words for what an edit changed, what /v1/edit is told, and how a receipt moved.
import { describe, expect, it } from "vitest";
import { staticReceipt, type Chip, type Receipt } from "@ghostrun/proof/static";
import { changeSummary as edgeSummary, editIntent, ENGINE_HASH as EDGE_ENGINE, fillPack, fillSeed, GALLERY, galleryWorld, newFailures as edgeFailures, placeFill, receiptDelta as edgeDelta } from "../../edge-api/src/world";
import { changeSummary, intentFor, newFailures, receiptDelta } from "../src/edits";
import { ENGINE_HASH, hashWorld, worldFromFill } from "../src/pipeline";

const worlds = GALLERY.map((e) => ({ e, g: galleryWorld(e.slug)! }));

describe("the edge's world pipeline matches the web's", () => {
  it("binds the same engine", () => expect(EDGE_ENGINE).toBe(ENGINE_HASH));

  it("every gallery world: the same stored fill and spec, opened and rebuilt from its share", async () => {
    expect(worlds.length).toBeGreaterThan(50);
    for (const { e, g } of worlds) {
      const i = g.intent;
      const seed = fillSeed(g.fill);
      const web = worldFromFill(g.fill, seed, { genre: i.genre, setting: i.setting, goal: i.goal, fail: i.fail, role: i.role }, i.pack, i.mode);
      const edge = await placeFill(g.fill, seed, { pack: i.pack, mode: i.mode, setting: i.setting });
      expect([e.slug, edge.fill]).toEqual([e.slug, web.fill]);
      expect([e.slug, edge.spec]).toEqual([e.slug, await hashWorld(web.bundle)]);
      // a ?s= link: the stored fill rebuilt into the pack it names, with no intent
      const back = worldFromFill(edge.fill, seed, undefined, fillPack(edge.fill));
      expect([e.slug, await hashWorld(back.bundle)]).toEqual([e.slug, edge.spec]);
      expect([e.slug, (await placeFill(edge.fill, seed, { pack: fillPack(edge.fill) })).spec]).toEqual([e.slug, edge.spec]);
    }
  }, 120_000);

  it("says what an edit changed, and what /v1/edit is told about a world, in the same words", async () => {
    for (let k = 0; k + 1 < worlds.length; k += 6) {
      const [a, b] = [worlds[k]!.g, worlds[k + 1]!.g];
      const wa = worldFromFill(a.fill, fillSeed(a.fill), undefined, a.intent.pack, a.intent.mode);
      const wb = worldFromFill(b.fill, fillSeed(b.fill), undefined, b.intent.pack, b.intent.mode);
      expect(edgeSummary(wa.bundle, wb.bundle)).toEqual(changeSummary(wa.bundle, wb.bundle));
      // a shared world has no live intent: both read one off the world itself
      expect(editIntent(wa.bundle, "a shared world")).toEqual(intentFor(wa, "a shared world"));
      // a gallery world keeps its own
      expect(editIntent(wa.bundle, a.prompt, a.intent)).toEqual(intentFor({ ...wa, source: { prompt: a.prompt, intent: a.intent, fill: wa.fill, seed: wa.seed, pack: wa.bundle.pack.id } }, a.prompt));
    }
  });

  it("says how a receipt moved, and what newly fails, in the same words", async () => {
    const [a, b] = await Promise.all(worlds.slice(0, 2).map(async ({ g }) => staticReceipt((await placeFill(g.fill, fillSeed(g.fill), { pack: g.intent.pack, mode: g.intent.mode })).bundle, { engine: ENGINE_HASH })));
    const chip = (id: string, status: Chip["status"], k: number, n: number, tier: Chip["tier"] = "T3"): Chip => ({ id, tier, subject: { kind: tier === "T2" ? "rule" : "world", id }, status, method: "m", n, k, text: `${id}: why`, cx: status === "counterexample" ? { where: null, have: 1, need: 2, unit: "m", text: "apex 1.6 m < ledge 2.6 m" } : null, src: "", ms: 0 });
    const ra: Receipt = { ...a!, chips: [...a!.chips, chip("T3:win", "played", 12, 12), chip("T2:r1", "verified", 1, 1, "T2")], par: { goldS: 30, runs: 12, won: 12 } };
    const rb: Receipt = { ...b!, chips: [...b!.chips, chip("T3:win", "played", 5, 12), chip("T2:r1", "counterexample", 0, 1, "T2")], par: null };
    for (const [x, y] of [[ra, rb], [rb, ra], [ra, ra]] as const) {
      expect(edgeDelta(x, y)).toEqual(receiptDelta(x, y));
      expect(edgeFailures(x, y)).toEqual(newFailures(x, y));
    }
  });
});
