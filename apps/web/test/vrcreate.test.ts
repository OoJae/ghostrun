// Making worlds from inside the headset, the parts that need no headset: the move op the diorama's
// hand writes (merged by id, placed by the placer, re-proved like any edit), the free anchors it can
// drop a thing on, what it may pick up, the model's fit on the table, what a ray picks out, the
// panel's honest words for the ways in, and an edit's state as the watch says it.
import { beforeAll, describe, expect, it } from "vitest";
import { mergeFill, pinLayout } from "@ghostrun/ir";
import { freeAnchors } from "@ghostrun/layout";
import { prove } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { loadNavNode } from "@ghostrun/nav/node";
import { setLocale } from "../src/i18n";
import { buildWorld, ENGINE_HASH, hashWorld, worldFromFill } from "../src/pipeline";
import { mergeEdit } from "../src/structure";
import { aimed, dioramaFit, editWaysLine, keyboardHere, TABLE_M, toPlay, toWorld, waysLine } from "../src/xr/create";
import { makeOf, vrEdit } from "../src/xr/model";

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

const lineOf = (fill: string, id: string) => JSON.parse(fill.split("\n").find((l) => l.includes(`"id":"${id}"`))!) as Record<string, unknown>;
const near = (a: readonly number[], b: readonly number[], eps = 1e-9) => a.every((x, i) => Math.abs(x - b[i]!) < eps);

describe("the move op", () => {
  const vault = buildWorld("", "vault");
  const fill0 = pinLayout(vault.fill);

  it("puts a thing on another anchor of a zone the fill has, as an edit only, and changes nothing else", () => {
    const { text, stats } = mergeFill(fill0, '{"op":"move","id":"key","zone":"z_hall","anchor":"corner_nw"}', { edit: true });
    expect(stats).toEqual({ replaced: 1, added: 0, deleted: 0, ignored: 0, locked: 0, moved: 1 });
    expect(lineOf(text, "key")).toMatchObject({ op: "ent", kind: "pickup", noun: "brass key", zone: "z_hall", anchor: "corner_nw" });
    const rest = (f: string) => f.split("\n").filter((l) => !l.includes('"id":"key"') && !l.includes('"op":"meta"'));
    expect(rest(text)).toEqual(rest(fill0));
    // a repair never moves things about
    expect(mergeFill(fill0, '{"op":"move","id":"key","zone":"z_hall","anchor":"corner_nw"}').stats).toMatchObject({ replaced: 0, ignored: 1 });
  });

  it("turns down a spawn or a goal, a zone the fill doesn't have, an anchor that isn't a name, and a move to where it already is", () => {
    for (const p of [
      '{"op":"move","id":"sp_red","zone":"z_hall","anchor":"center"}',
      '{"op":"move","id":"exit","zone":"z_hall","anchor":"corner_nw"}',
      '{"op":"move","id":"key","zone":"z_nowhere","anchor":"corner_nw"}',
      '{"op":"move","id":"key","zone":"z_hall","anchor":"../../x"}',
      '{"op":"move","id":"key","zone":"z_west","anchor":"corner_sw"}',
      '{"op":"move","id":"ghost","zone":"z_hall","anchor":"corner_nw"}',
    ]) {
      const { text, stats } = mergeFill(fill0, p, { edit: true });
      expect(stats, p).toEqual({ replaced: 0, added: 0, deleted: 0, ignored: 1, locked: 0 });
      expect(text.trim(), p).toBe(fill0.trim());
    }
  });

  it("is placed where the anchor is, re-proved, and its fill alone rebuilds the same world", async () => {
    const spot = freeAnchors(vault.fill, vault.layout!).find((a) => a.zone === "z_hall" && !a.high)!;
    const { text } = mergeEdit(fill0, JSON.stringify({ op: "move", id: "key", zone: spot.zone, anchor: spot.anchor }), vault.seed);
    const w2 = worldFromFill(text, vault.seed, undefined, "floor_plan", "play");
    const key = w2.bundle.entities.find((e) => e.id === "key")!;
    expect(key.zone).toBe("z_hall");
    expect(Math.hypot(key.pos[0] - spot.at[0], key.pos[2] - spot.at[2])).toBeLessThan(2);
    expect(await hashWorld(w2.bundle)).not.toBe(await hashWorld(vault.bundle));
    expect(await hashWorld(worldFromFill(w2.fill, vault.seed, undefined, "floor_plan", "play").bundle)).toBe(await hashWorld(w2.bundle));
    const receipt = await prove(R, w2.bundle, { engine: ENGINE_HASH, runs: 4 });
    expect(receipt.headline?.text).toBe("The gem can be stolen before the alarm"); // the promise is kept, and checked again
    expect(receipt.chips.find((c) => c.id === "T3:win")).toBeDefined();
  }, 180_000);
});

describe("what the diorama can move, and where to", () => {
  const vault = buildWorld("", "vault");

  it("free anchors: none taken, never a doorway, spawn pad or goal spot, in a stable order", () => {
    const free = freeAnchors(vault.fill, vault.layout!);
    expect(free.length).toBeGreaterThan(10);
    const taken = new Set(["z_yard/spawn_pad", "z_yard/corner_w", "z_west/corner_sw", "z_vault/center", "z_vault/doorway_w", "z_west/center", "z_hall/center", "z_hall/corner_ne"]);
    for (const a of free) {
      expect(taken.has(`${a.zone}/${a.anchor}`), `${a.zone}/${a.anchor}`).toBe(false);
      expect(a.anchor).not.toMatch(/^(doorway|spawn|goal)/);
    }
    expect(freeAnchors(vault.fill, vault.layout!)).toEqual(free);
    expect(new Set(free.map((a) => a.zone))).toEqual(new Set(["z_yard", "z_lobby", "z_west", "z_hall", "z_vault"]));
  });

  it("picks up the fill's pickups and props, never a door, a hazard, a spawn or a goal; drops on free anchors named by their zone", () => {
    const m = makeOf(vault);
    expect(m.movable.map((x) => x.id).sort()).toEqual(["gem", "key", "painting_1", "painting_2"]);
    expect(m.movable.find((x) => x.id === "key")).toEqual({ id: "key", label: "brass key", high: false });
    expect(m.spots.some((s) => s.zone === "z_hall" && s.label === "Great hall")).toBe(true);
    expect(m.spots.length).toBe(freeAnchors(vault.fill, vault.layout!).length);
    expect(m.bounds!.max[0]).toBeGreaterThan(m.bounds!.min[0]);
  });
});

describe("the diorama's fit and the god hand's ray", () => {
  const bounds = { min: [-40, 0, -20] as const, max: [40, 12, 20] as const };
  const head = [0.1, 1.6, 0.2] as const;

  it("stands the whole world on a table in front of you, about a metre across, its floor at table height", () => {
    const d = dioramaFit(bounds, 0, head, 0, 0.7);
    expect(d.scale).toBeCloseTo(80 / TABLE_M, 6);
    // the table, half a metre ahead and under your eyes, is the world's middle on its floor
    expect(near(toWorld(d, d.table), [0, 0, 0], 1e-6)).toBe(true);
    expect(d.table[2]).toBeLessThan(head[2]);
    expect(d.table[1]).toBeLessThan(head[1]);
    // the world's far corners are about half the table away from its middle
    const corner = toPlay(d, [40, 0, 20]);
    expect(Math.hypot(corner[0] - d.table[0], corner[2] - d.table[2])).toBeCloseTo(Math.hypot(40, 20) / d.scale, 6);
    // and the play space round trip is exact
    const p = [0.3, 0.9, -0.4] as const;
    expect(near(toPlay(d, toWorld(d, p)), p, 1e-9)).toBe(true);
  });

  it("faces the way you look, and keeps its table when a new world (of another size) is fitted on it", () => {
    const d = dioramaFit(bounds, 0, head, Math.PI / 2, 0); // looking down −x
    expect(d.table[0]).toBeLessThan(head[0] - 0.4);
    const d2 = dioramaFit({ min: [-10, 0, -10], max: [10, 4, 10] }, 2, head, 0, 0, d.table);
    expect(d2.table).toEqual(d.table);
    expect(d2.scale).toBeCloseTo(20 / TABLE_M, 6);
    expect(near(toWorld(d2, d2.table), [0, 2, 0], 1e-6)).toBe(true);
    // a small arena is still a model, not life size
    expect(dioramaFit({ min: [-1, 0, -1], max: [1, 1, 1] }, 0, head, 0, 0).scale).toBe(4);
  });

  it("a ray picks out what it points at most nearly, within a few degrees and ahead of it", () => {
    const o = [0, 1, 0] as const;
    const d = [0, 0, -1] as const;
    const pts = [
      { key: "a", at: [0.02, 1, -1] as const },
      { key: "b", at: [0, 1.01, -2] as const },
      { key: "c", at: [0, 1, 1] as const }, // behind
      { key: "d", at: [0.5, 1, -1] as const }, // 27° off
    ];
    expect(aimed(o, d, pts)).toBe("b");
    expect(aimed(o, d, pts.filter((p) => p.key !== "b"))).toBe("a");
    expect(aimed(o, d, pts.filter((p) => p.key === "c" || p.key === "d"))).toBeNull();
    // angles don't change with scale: the same pick in world metres as on the table
    expect(aimed([0, 80, 0], d, pts.map((p) => ({ key: p.key, at: [p.at[0] * 80, p.at[1] * 80, p.at[2] * 80] as const })))).toBe("b");
  });
});

describe("the panels' words", () => {
  it("say which ways in this browser has, and nothing it hasn't", () => {
    expect(waysLine({ speech: false, keyboard: false }, true)).toBe("This browser can't listen. Pick one:");
    expect(waysLine({ speech: true, keyboard: false }, true)).toBe("Hold the left grip and say it, or pick one:");
    expect(waysLine({ speech: true, keyboard: false }, false)).toBe("Say it, or pick one:");
    expect(waysLine({ speech: false, keyboard: true }, false)).toContain("if it opens");
    expect(editWaysLine({ speech: true, keyboard: false }, false)).toContain("need the live AI");
    expect(editWaysLine({ speech: false, keyboard: false }, true)).toBe("Pick one (this browser can't listen).");
    expect(keyboardHere("Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/33.0.0.x.x.x Chrome/126.0.6478.122 VR Safari/537.36")).toBe(true);
    expect(keyboardHere("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36")).toBe(false);
    setLocale("cs");
    expect(waysLine({ speech: false, keyboard: false }, true)).toBe("Tento prohlížeč neumí poslouchat. Vyberte:");
    setLocale("en");
  });

  it("say an edit's state as the edit box does: under way, re-proving with what changed, done with how the receipt moved", () => {
    expect(vrEdit({ status: "idle" })).toBeNull();
    expect(vrEdit({ status: "editing", change: "super high jumps" })).toEqual({ status: "working", line: "Changing it: super high jumps…", summary: "", receipt: "" });
    expect(vrEdit({ status: "proving", change: "super high jumps", summary: ["jump height 1.6 → 3.4 m"], locked: 0 })).toEqual({ status: "proving", line: "AI runners re-proving: super high jumps…", summary: "jump height 1.6 → 3.4 m", receipt: "" });
    const done = vrEdit({ status: "done", change: "super high jumps", summary: ["jump height 1.6 → 3.4 m"], locked: 0, delta: [{ label: "Headline", from: "verified", to: "counterexample", sign: -1 }], failures: [] })!;
    expect(done).toEqual({ status: "done", line: "Re-proved: super high jumps", summary: "jump height 1.6 → 3.4 m", receipt: "Headline: verified → counterexample" });
    expect(vrEdit({ status: "done", change: "x", summary: ["brass key moved to the Great hall"], locked: 0, delta: [], failures: [] })).toMatchObject({ summary: "brass key moved to the Great hall", receipt: "Receipt unchanged: every check came out the same." });
    expect(vrEdit({ status: "failed", change: "x", message: "Nothing in the world changed." })).toEqual({ status: "failed", line: "Nothing in the world changed.", summary: "", receipt: "" });
  });
});
