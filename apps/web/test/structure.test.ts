// Structural edits: the layout op is validated and clamped like laws, a world's geometry is
// regenerated from the same seed and the new numbers (deterministically), whatever stood on an
// anchor the new layout lacks is re-anchored (logged, and written into the fill so the fill alone
// rebuilds it), the diff line names the change, and a promise the new geometry breaks shows.
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LAWS, mergeFill, pinLayout, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { prove } from "@ghostrun/proof";
import { clampLayout, layoutOf, PACKS, packFor, settleLayout } from "@ghostrun/registry";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { buildWorld, ENGINE_HASH, hashWorld, worldFromFill } from "../src/pipeline";
import { layoutOptions, layoutPatch, mergeEdit } from "../src/structure";

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

const meta = (fill: string) => JSON.parse(fill.split("\n", 1)[0]!) as Record<string, unknown>;
const lineOf = (fill: string, id: string) => JSON.parse(fill.split("\n").find((l) => l.includes(`"id":"${id}"`))!) as Record<string, unknown>;
const rebuild = (fill: string, seed: number, pack: string) => worldFromFill(fill, seed, undefined, pack, "play");

describe("the layout op", () => {
  it("is validated and clamped like laws: out of range clamps, a number as text is read, unknown keys and sub-zones go", () => {
    const vault = buildWorld("", "vault");
    const fill0 = pinLayout(vault.fill);
    const { text, stats } = mergeFill(fill0, '{"op":"layout","params":{"floors":9,"width":"31","bogus":3,"depth":null},"sub":["rooftop"]}', { edit: true });
    expect(stats.layout).toBe(1);
    const settled = settleLayout(packFor("floor_plan"), [], text);
    expect(meta(settled).layout).toEqual({ floors: 2, width: 32 }); // 31 onto the 2 m step, 9 floors to 2
    expect(meta(settled).sub).toEqual([]); // a floor plan has no rooftop
    expect(clampLayout(packFor("city_block"), { length: 1e9, depth: -5 })).toEqual({ length: 120, depth: 40 });
    expect(clampLayout(packFor("maze"), { cols: "twelve", rows: Number.NaN })).toEqual({ cols: 9, rows: 9 });
    // only an edit reshapes a world: a repair's layout line is ignored
    const repair = mergeFill(fill0, '{"op":"layout","params":{"floors":2}}');
    expect(repair.stats).toMatchObject({ ignored: 1, replaced: 0 });
    expect(repair.stats.layout).toBeUndefined();
  });

  it("old fills carry no layout and build on the defaults; a layout back at the defaults is the original world", async () => {
    for (const k of ["ctf", "vault", "coin-rush", "forest", "parkour"]) {
      const w = buildWorld("", k);
      expect(layoutOf(packFor(w.bundle.pack.id), w.fill).custom).toBeNull();
      expect(w.bundle.pack.params).toEqual({});
    }
    const ctf = buildWorld("", "ctf");
    const bigger = mergeEdit(pinLayout(ctf.fill), '{"op":"layout","params":{"length":120}}', ctf.seed);
    expect(bigger.layout!.summary[0]).toBe("map 80 → 120 m");
    const back = mergeEdit(bigger.text, '{"op":"layout","params":{"length":80}}', ctf.seed);
    expect(meta(back.text).layout).toBeUndefined();
    const original = rebuild(pinLayout(ctf.fill), ctf.seed, "city_block");
    expect(await hashWorld(rebuild(back.text, ctf.seed, "city_block").bundle)).toBe(await hashWorld(original.bundle));
  });

  it("is deterministic: the same numbers and seed give the same layout, the same fill the same world", () => {
    for (const p of PACKS) {
      const schema = p.impl.schema ?? {};
      for (const end of ["min", "max"] as const) {
        const params = { ...p.impl.defaults, ...Object.fromEntries(Object.entries(schema).map(([k, sp]) => [k, sp[end]])) };
        const gen = () => p.impl.generate({ seed: 13, params, sub: p.subs, laws: DEFAULT_LAWS, harder: false });
        expect(gen(), `${p.id} at its ${end}`).toEqual(gen());
      }
    }
    const vault = buildWorld("", "vault");
    const a = mergeEdit(pinLayout(vault.fill), '{"op":"layout","params":{"floors":2}}', vault.seed);
    const b = mergeEdit(pinLayout(vault.fill), '{"op":"layout","params":{"floors":2}}', vault.seed);
    expect(a.text).toBe(b.text);
    expect(rebuild(a.text, vault.seed, "floor_plan").bundle).toEqual(rebuild(b.text, vault.seed, "floor_plan").bundle);
  });

  it("each pack stays walkable at the ends of its schema: every ground anchor reachable from the spawn pad (5 seeds)", () => {
    const shell = (pack: string, seed: number, slots: string[]): WorldBundle => ({
      v: 1, engine: "e", seed, mode: "play", lang: "en", pack: { id: pack, version: "0", seed, params: {}, sub: [] }, laws: DEFAULT_LAWS,
      zones: slots.map((s) => ({ id: `z_${s}`, src: "ai", layer: "gameplay", pack, slot: s, tag: "", name: s, parent: "" })),
      statics: [], entities: [], verbs: [], rules: [], states: [], cast: [], expects: [],
      cosmetic: { look: "default", mood: [0, 0, 0], timeOfDay: 12, weather: "clear", dress: [], posters: [] },
    });
    for (const id of ["city_block", "floor_plan", "arena", "maze"]) {
      const p = PACKS.find((x) => x.id === id)!;
      for (const end of ["min", "max"] as const) {
        const params = { ...p.impl.defaults, ...Object.fromEntries(Object.entries(p.impl.schema!).map(([k, sp]) => [k, sp[end]])) };
        for (const seed of [1, 2, 3, 4, 5]) {
          const layout = p.impl.generate({ seed, params, sub: [], laws: DEFAULT_LAWS, harder: false });
          const { bundle } = placeWorld(shell(id, seed, layout.zones.map((z) => z.slot)), layout);
          const nav = buildNav(bundle);
          const spawn = layout.zones.find((z) => z.anchors.spawn_pad)!.anchors.spawn_pad!;
          for (const z of layout.zones) {
            for (const [name, a] of Object.entries(z.anchors)) {
              if (a[1] > 0.5 && a[1] - z.floorY > 0.5) continue; // walls, hoops, scoreboards
              if (z.tag === "platform") continue; // the arena's decks need a double jump
              expect(nav.path(spawn, a), `${id} ${end} seed ${seed}: ${z.slot}.${name}`).not.toBeNull();
            }
          }
          nav.destroy();
        }
      }
    }
  }, 120_000);
});

describe("re-anchoring", () => {
  it("a floor added to the museum: the laser on the hall's corner the staircase takes moves to the nearest free anchor, logged, and the fill alone rebuilds it", () => {
    const vault = buildWorld("", "vault");
    const fill0 = pinLayout(vault.fill);
    const r = mergeEdit(fill0, '{"op":"layout","params":{"floors":2}}', vault.seed);
    expect(r.layout!.summary).toEqual(["floors 1 → 2", "2 rooms added", "1 thing re-anchored"]);
    expect(r.layout!.notes).toHaveLength(1);
    expect(r.layout!.notes[0]).toMatch(/^laser: anchor 'corner_ne' is gone from 'main_room' in the new layout, re-anchored to 'corner_(nw|se)' \(the nearest free anchor\)$/);
    const laser = lineOf(r.text, "laser");
    expect(laser.zone).toBe("z_hall");
    expect(laser.anchor).not.toBe("center"); // the landscape painting stands there
    // the same museum below, an upper floor behind it: the old statics are all still there
    const w2 = rebuild(r.text, vault.seed, "floor_plan");
    expect(w2.bundle.statics.length).toBeGreaterThan(vault.bundle.statics.length);
    expect(w2.bundle.pack.params).toEqual({ floors: 2 });
    expect(rebuild(w2.fill, vault.seed, "floor_plan").bundle).toEqual(w2.bundle);
    expect(w2.notes.some((n) => /laser: anchor 'corner_ne' not in slot/.test(n))).toBe(false); // nothing left for the placer to guess
  });

  it("the proof plays the new geometry: with the gem moved upstairs, the AI runners climb the staircase and still steal it", async () => {
    const vault = buildWorld("", "vault");
    const patch = ['{"op":"layout","params":{"floors":2}}', '{"op":"zone","id":"z_upper","slot":"upper_hall","tag":"hall","name":"Upper gallery"}', '{"op":"ent","id":"gem","kind":"pickup","noun":"star sapphire","hyper":"gem","zone":"z_upper","anchor":"corner_ne","body":"dynamic","shape":"sphere","size":[0.4,0.4,0.4]}'];
    const r = mergeEdit(pinLayout(vault.fill), patch.join("\n"), vault.seed);
    const w2 = rebuild(r.text, vault.seed, "floor_plan");
    const gem = w2.bundle.entities.find((e) => e.id === "gem")!;
    expect(gem.pos[1]).toBeGreaterThan(2.9); // up a storey
    const receipt = await prove(R, w2.bundle, { engine: ENGINE_HASH, runs: 6 });
    expect(receipt.headline?.status).not.toBe("counterexample");
    const win = receipt.chips.find((c) => c.id === "T3:win")!;
    expect(win.k).toBeGreaterThanOrEqual(5);
  }, 180_000);

  it("the rooftop lane removed from the CTF brief: what stood on it goes to the nearest free anchor anywhere, and the headline's broken promise shows", async () => {
    const ctf = buildWorld("", "ctf");
    const r = mergeEdit(pinLayout(ctf.fill), '{"op":"layout","sub":[]}', ctf.seed);
    expect(r.layout!.summary[0]).toBe("rooftop lane removed");
    expect(r.layout!.summary.at(-1)).toMatch(/^\d+ things? re-anchored$/);
    expect(r.layout!.notes.every((n) => /in z_|re-anchored to/.test(n))).toBe(true);
    const w2 = rebuild(r.text, ctf.seed, "city_block");
    expect(w2.bundle.expects.find((x) => x.headline)?.text).toBe("Rooftop lane needs double jump"); // the promise is kept
    const after = await prove(R, w2.bundle, { engine: ENGINE_HASH, runs: 4 });
    expect(after.headline?.status).toBe("counterexample"); // and broken, so it shows
  }, 180_000);

  it("the card's one-click layout changes write the op an edit would: bigger, smaller, a floor, a sub-zone", () => {
    const ctf = buildWorld("", "ctf");
    expect(layoutOptions(ctf.fill)).toEqual({ bigger: true, smaller: true, floors: null, subs: [{ id: "rooftop", on: true }] });
    expect(JSON.parse(layoutPatch(ctf.fill, { scale: 1.25 })!)).toEqual({ op: "layout", params: { length: 100, depth: 50 } });
    expect(JSON.parse(layoutPatch(ctf.fill, { sub: [] })!)).toEqual({ op: "layout", sub: [] });
    const vault = buildWorld("", "vault");
    expect(layoutOptions(vault.fill).floors).toBe(1);
    expect(JSON.parse(layoutPatch(vault.fill, { set: { floors: 2 } })!)).toEqual({ op: "layout", params: { floors: 2 } });
    const maze = mergeEdit(pinLayout(buildWorld("", "ctf").fill.replace('"pack":"city_block"', '"pack":"maze"')), layoutPatch(buildWorld("", "ctf").fill.replace('"pack":"city_block"', '"pack":"maze"'), { scale: 1.25 })!, 7);
    expect(maze.layout!.summary[0]).toBe("maze 9×9 → 10×10 cells");
    expect(layoutPatch(buildWorld("", "forest").fill, { scale: 1.25 })).toBeNull(); // the outdoor map has one size
  });
});
