import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { cityBlock } from "@ghostrun/pack-city-block";
import { placeWorld } from "@ghostrun/layout";
import { loadNavNode } from "@ghostrun/nav/node";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { chipLine, prove } from "../src";

const ctf = readFileSync(new URL("../../ir/fixtures/ctf-neon.jsonl", import.meta.url), "utf8");
const ENGINE = "e".repeat(64);
let R: Rapier;
let world: WorldBundle;

beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
  const fill = parseFill(ctf, { seed: 7 });
  const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  world = placeWorld({ ...fill.draft, engine: ENGINE }, layout).bundle;
});

describe("proof ladder on the organizer's CTF brief", () => {
  it("verifies the headline, force-tests every rule, and AI runners win in physics", async () => {
    const receipt = await prove(R, world, { engine: ENGINE, runs: 12 });
    const lines = receipt.chips.map(chipLine);
    console.log(["", `spec ${receipt.spec.slice(0, 8)} · ${receipt.ms} ms`, ...lines, `par: ${JSON.stringify(receipt.par)}`].join("\n"));
    expect(receipt.headline).toMatchObject({ expect: "x_roof", text: "Rooftop lane needs double jump", status: "verified" });
    const t2 = receipt.chips.filter((c) => c.tier === "T2");
    expect(t2).toHaveLength(world.rules.length);
    expect(t2.every((c) => c.status === "verified")).toBe(true);
    expect(receipt.chips.find((c) => c.id === "T0:win_chain")?.status).toBe("verified");
    const win = receipt.chips.find((c) => c.id === "T3:win")!;
    expect(win.status).toBe("played");
    expect(win.k).toBeGreaterThanOrEqual(10); // ≥10 of 12 runners win
    expect(receipt.chips.find((c) => c.id === "T3:x_roof")?.status).toBe("played");
    expect(receipt.par!.goldS).toBeGreaterThan(5);
  }, 60_000);

  it("catches a broken level: a 4 m ledge is a counterexample with the missing height", async () => {
    const broken = structuredClone(world);
    for (const s of broken.statics.filter((x) => x.surf === "ledge")) {
      s.size = [s.size[0], 4, s.size[2]];
      s.pos = [s.pos[0], 2, s.pos[2]];
    }
    const receipt = await prove(R, broken, { engine: ENGINE, runs: 2 });
    const t1 = receipt.chips.find((c) => c.id === "T1:x_roof")!;
    expect(t1.status).toBe("counterexample");
    expect(t1.cx?.text).toMatch(/^apex 3(\.\d+)? m < ledge 4 m$/);
    expect(receipt.headline?.status).toBe("counterexample");
  }, 60_000);
});

describe("proof ladder on kit verbs (coin rush: collect, timer, hazard, switch, jump pad)", () => {
  it("regresses the win to collecting coins, forces every kit trigger, and runners collect all five", async () => {
    const { arena } = await import("@ghostrun/pack-arena");
    const text = readFileSync(new URL("../../ir/fixtures/coin-rush.jsonl", import.meta.url), "utf8");
    const fill = parseFill(text, { seed: 11 });
    expect(fill.notes.filter((n) => n.kind === "invalid" || n.kind === "unresolved")).toEqual([]);
    const layout = arena.generate({ seed: 11, params: arena.defaults, sub: [], laws: fill.draft.laws, harder: false });
    const placed = placeWorld({ ...fill.draft, engine: ENGINE }, layout);
    const receipt = await prove(R, placed.bundle, { engine: ENGINE, runs: 6 });
    console.log(["", `coin rush · ${receipt.ms} ms`, ...receipt.chips.map(chipLine), `par: ${JSON.stringify(receipt.par)}`, ...placed.notes].join("\n"));
    expect(receipt.chips.find((c) => c.id === "T0:win_chain")).toMatchObject({ status: "verified" });
    expect(receipt.chips.find((c) => c.id === "T0:win_chain")!.text).toContain("touch any of 5");
    const t2 = receipt.chips.filter((c) => c.tier === "T2");
    expect(t2.map((c) => [c.subject.id, c.status])).toEqual(placed.bundle.rules.map((r) => [r.id, "verified"]).sort());
    const win = receipt.chips.find((c) => c.id === "T3:win")!;
    expect(win.k).toBeGreaterThanOrEqual(5); // ≥5 of 6 runners collect all five in time
    expect(receipt.headline).toMatchObject({ expect: "x_win", status: "verified" });
  }, 120_000);
});

describe("a recorded live fill (museum heist, gpt-oss-120b)", () => {
  it("repairs what the model got wrong, keeps a headline, and flags the too-easy win honestly", async () => {
    const { floorPlan } = await import("@ghostrun/pack-floor-plan");
    const text = readFileSync(new URL("../../ir/fixtures/heist-live-1.jsonl", import.meta.url), "utf8");
    const fill = parseFill(text, { seed: 56112 });
    // kind "timer" and the "use" triggers are repaired, not dropped; "headline" becomes win_reachable
    expect(fill.notes.filter((n) => n.kind === "invalid")).toEqual([]);
    expect(fill.draft.rules.find((r) => r.id === "r_use_key")!.when).toMatchObject({ t: "touch", a: "player", b: "vault_door" });
    const layout = floorPlan.generate({ seed: 56112, params: floorPlan.defaults, sub: [], laws: fill.draft.laws, harder: false });
    const placed = placeWorld({ ...fill.draft, engine: ENGINE }, layout);
    const receipt = await prove(R, placed.bundle, { engine: ENGINE, runs: 4 });
    expect(receipt.headline?.expect).toBe("x_headline");
    // the model's win rule needs nothing: runners win in under a second, and the receipt says so
    expect(receipt.chips.find((c) => c.id === "T3:too_easy")?.status).toBe("counterexample");
    expect(receipt.headline?.status).toBe("counterexample");
    expect(receipt.chips.find((c) => c.id === "T1:x_timer")?.status).toBe("not_checkable");
  }, 120_000);
});

describe("doors on the win path (vault heist: key → locked door → gem → exit)", () => {
  it("runners find the blocking door, fetch the key, unlock it and escape with the gem", async () => {
    const { floorPlan } = await import("@ghostrun/pack-floor-plan");
    const text = readFileSync(new URL("../../ir/fixtures/vault-heist.jsonl", import.meta.url), "utf8");
    const fill = parseFill(text, { seed: 5 });
    expect(fill.notes.filter((n) => n.kind === "invalid" || n.kind === "unresolved")).toEqual([]);
    const layout = floorPlan.generate({ seed: 5, params: floorPlan.defaults, sub: [], laws: fill.draft.laws, harder: false });
    const placed = placeWorld({ ...fill.draft, engine: ENGINE }, layout);
    expect(placed.notes.filter((n) => n.includes("not in slot"))).toEqual([]);
    const receipt = await prove(R, placed.bundle, { engine: ENGINE, runs: 6 });
    console.log(["", `vault heist · ${receipt.ms} ms`, ...receipt.chips.map(chipLine), `par: ${JSON.stringify(receipt.par)}`].join("\n"));
    expect(receipt.chips.find((c) => c.id === "T0:win_chain")?.status).toBe("verified");
    const win = receipt.chips.find((c) => c.id === "T3:win")!;
    expect(win.k).toBeGreaterThanOrEqual(5);
    expect(receipt.par!.goldS).toBeGreaterThan(8); // the detour for the key is real
    expect(receipt.headline?.status).toBe("verified");
  }, 120_000);
});

describe("T0 references", () => {
  it("conditions on special refs with a path (player.team, team:red.score) are not unknown references", async () => {
    const { t0 } = await import("../src/t0");
    const fill = parseFill(ctf.replace('"if":[{"l":"orb.carrier.team","op":"eq","r":"red"}]', '"if":[{"l":"orb.carrier.team","op":"eq","r":"red"},{"l":"player.team","op":"eq","r":"red"},{"l":"team:red.score","op":"lt","r":3}]'), { seed: 7 });
    expect(fill.draft.rules.find((r) => r.id === "r_score_red")!.if).toHaveLength(3);
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    const { bundle } = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout);
    expect(t0(bundle).chips.filter((c) => c.id.startsWith("T0:refs") && c.status === "counterexample")).toEqual([]);
  });
});

describe("score comparisons (a timed match: win if red is ahead when the clock runs out)", () => {
  it("the sim compares two scores, T0 plans the lead before the clock, T2 forces the scores the rule needs", async () => {
    const { t0 } = await import("../src/t0");
    const { t2 } = await import("../src/t2");
    const timed = ctf
      .replace('{"op":"rule","id":"r_win","when":{"t":"score_gte","a":"team:red","n":3},"then":[{"e":"win","target":"player"}],"once":true}', '{"op":"rule","id":"r_win","when":{"t":"timer_end","a":"player"},"if":[{"l":"team:red.score","op":"gt","r":"team:blue.score"}],"then":[{"e":"win","target":"player"}],"once":true}')
      .replace('{"op":"law"', '{"op":"verb","id":"vb_clock","verb":"puzzle.timer","on":"player","params":{"seconds":30}}\n{"op":"law"');
    const fill = parseFill(timed, { seed: 7 });
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    const b = placeWorld({ ...fill.draft, engine: ENGINE }, layout).bundle;
    const chain = t0(b).chain!;
    expect(chain.explain).toContain("[after red scores 2]");
    expect(chain.steps.map((s) => s.do)).toEqual(["pickup", "deliver", "wait"]);
    expect(t2(R, b).find((c) => c.id === "T2:r_win")).toMatchObject({ status: "verified" });
  }, 60_000);
});
