import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { castBrain } from "@ghostrun/bots";
import { splitObjects, type Vec3 } from "@ghostrun/ir";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import type { Chip, Receipt } from "@ghostrun/proof";
import { SimWorld, type Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { facts } from "../src/host";
import { buildWorld, worldFromFill } from "../src/pipeline";
import { flyTarget, stoodStill, tourChips, tourFacts, whyChips, whyFacts } from "../src/why";

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

/** A CTF run where the player stands still until blue wins, with its trail (every 30 ticks, as RapierSim keeps it). */
function standStill() {
  const { bundle } = buildWorld("", "ctf");
  const sim = new SimWorld(R, bundle, { brain: castBrain(buildNav(bundle), bundle) });
  const trail: Vec3[] = [];
  for (let t = 0; t < 60 * 180 && !sim.result; t++) {
    sim.step(null);
    if (sim.tick % 30 === 0) trail.push(sim.pos("player"));
  }
  return { bundle, sim, trail };
}

const win: Chip = { id: "T3:win", tier: "T3", subject: { kind: "property", id: "win_reachable" }, status: "played", method: "physics, 12 AI runners", n: 12, k: 12, text: "", cx: null, src: "", ms: 0 };

describe("the Host's facts have places, and the why chips their own facts", () => {
  it("a cited moment says where it happened: the goal ring the orb went into, the orb where it waited", () => {
    const { bundle, sim, trail } = standStill();
    const f = facts(bundle, sim.log, trail);
    const goal = bundle.entities.find((e) => e.id === "goal_blue")!.pos;
    expect(f.find((x) => x.text.includes("carried the glowing orb into the neon goal ring"))?.at).toEqual(goal);
    const picked = f.find((x) => x.text.endsWith("Rival 1 picked up the glowing orb"));
    expect(picked?.tick).not.toBeNull();
    // the camera flies to the first cited fact with a place and a time
    expect(flyTarget([f[0]!, f.find((x) => x.text.includes("carried"))!], true)?.at).toEqual(goal);
    expect(flyTarget([f[0]!], true)).toBeNull();
  }, 60_000);

  it("where you wasted time, and what the AI par runner did: from your run and the receipt", () => {
    const { bundle, sim, trail } = standStill();
    expect(stoodStill(trail)).toMatchObject({ from: 0, at: trail[0] });
    // the par runner's run, as the receipt keeps it (its route every 20 ticks, its step times)
    const xyz = [-36, 0, 0, -20, 0, 0, 0, 0, 0, -20, 0, 0, -26, 0, 0];
    const r: Receipt = { v: 1, spec: "s", engine: "e", host: "node", headline: null, chips: [win], par: { goldS: 41.4, runs: 12, won: 12 }, ms: 0, trails: [{ won: true, xyz, ticks: 2600, at: [-1, -1] }, { won: true, xyz, ticks: 2484, at: [420, 2484] }], ghost: { every: 4, ticks: 2484, xyz: [], dir: [], prog: [] }, playtest: { levels: [], band: "Normal", trails: [], steps: ["glowing orb", "neon goal ring"], ms: 0 } };
    const w = whyFacts(bundle, sim.log, trail, r);
    expect(w[0]!.text).toMatch(/^0:00 You stood still for \d+ s in the [\w ]+ \(0:00–\d:\d\d\), the longest you stood still$/);
    expect(w[0]!.at).toEqual(trail[0]);
    expect(w).toContainEqual({ text: "The AI par runner won in 41.4 s, the fastest of 12 AI runners (12 of 12 won, the slowest in 43.3 s)", tick: null });
    expect(w.find((x) => x.text.startsWith("The AI par runner reached"))?.text).toMatch(/^The AI par runner reached the glowing orb at 0:07, then the neon goal ring at 0:41, and spent \d+% of its run in the [\w ]+$/);
    expect(w.length).toBeLessThanOrEqual(4);
    expect(whyChips("lose")).toEqual(["Why did I lose?", "Where did I waste time?", "What did the AI do differently?"]);
  }, 60_000);

  it("a place to explore: what is in each room and where each exhibit is, for the Host to fly to", () => {
    const g = JSON.parse(readFileSync(new URL("../src/gallery/worlds/a-japanese-tea-house-in-the-rain.json", import.meta.url), "utf8")) as { intent: { genre: string; setting: string; goal: string; fail: string; role: string; pack: string; mode: "play" | "wander" }; fill: string };
    const seed = (JSON.parse(splitObjects(g.fill.split("\n", 1)[0] ?? "{}")[0] ?? "{}") as { seed?: number }).seed ?? 7;
    const i = g.intent;
    const b = worldFromFill(g.fill, seed, { genre: i.genre, setting: i.setting, goal: i.goal, fail: i.fail, role: i.role }, i.pack, i.mode).bundle;
    expect(b.mode).toBe("wander");
    const f = tourFacts(b, null);
    const shown = b.verbs.filter((v) => v.verb === "social.inspect" && b.entities.some((e) => e.id === v.on));
    const exhibits = f.filter((x) => /^The .+ is in the |^The [^:]+: “/.test(x.text));
    expect(exhibits.length).toBe(shown.length);
    expect(exhibits.every((x) => x.at && x.tick === null)).toBe(true);
    expect(f.some((x) => / has: the /.test(x.text) && x.at)).toBe(true);
    expect(f.length).toBeLessThanOrEqual(40);
    expect(flyTarget(exhibits, false)?.at).toEqual(exhibits[0]!.at);
    expect(tourChips(b)[2]).toMatch(/^Where is the .+\?$/);
  });
});
