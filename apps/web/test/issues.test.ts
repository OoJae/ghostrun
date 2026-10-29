// What the repair loop sends for fights the second live bench lost (tools/bench/worlds/fights-r2):
// each recorded world taken back to the kind of failure it had, and the issue says what to change,
// with the world's own numbers.
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { splitObjects } from "@ghostrun/ir";
import { loadNavNode } from "@ghostrun/nav/node";
import { badness, better, issuesOf, prove, type Receipt } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { ENGINE_HASH, worldFromFill } from "../src/pipeline";

const DIR = new URL("../../../tools/bench/worlds/fights-r2/", import.meta.url);
const file = (prefix: string, ext: string) => new URL(readdirSync(DIR).find((x) => x.startsWith(prefix) && x.endsWith(ext))!, DIR);
type Line = Record<string, unknown>;
/** A recorded fill with some of its lines changed (`edit` maps each line to the lines it becomes). */
const world = (prefix: string, edit: (o: Line) => Line[] = (o) => [o]) => {
  const text = readFileSync(file(prefix, ".fill.jsonl"), "utf8").split("\n").flatMap(splitObjects).filter((l) => l.trim()).flatMap((l) => edit(JSON.parse(l) as Line).map((o) => JSON.stringify(o))).join("\n");
  const { intent } = JSON.parse(readFileSync(file(prefix, ".receipt.json"), "utf8")) as { intent: { pack: string; mode: "play" | "wander" } };
  return worldFromFill(text, (JSON.parse(text.split("\n", 1)[0]!) as { seed: number }).seed, undefined, intent.pack, intent.mode);
};
const id = (o: Line) => String(o.id ?? "");
const proved = async (w: ReturnType<typeof world>) => {
  const r = await prove(R, w.bundle, { engine: ENGINE_HASH, runs: 12 });
  const issues = issuesOf(r, w.bundle, w.fillNotes);
  if (process.env.GR_SHOW) console.log(issues.map((i) => `? ${i}`).join("\n"));
  return { r, issues };
};

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

describe("repair issues for fights", () => {
  it("too easy: the one the win knocks out, how far from the spawn, in range from the start, and in how many hits", async () => {
    // the dojo without its dummies: beating the sensei is all there is
    const { issues } = await proved(world("a-ninja-dojo", (o) => (id(o).startsWith("r_dummy") ? [] : [o])));
    expect(issues).toEqual([expect.stringMatching(/^AI runners win in 1\.\d s without engaging the world: the win is knocking out sensei, 7 m from the spawn, in your weapon's 12 m range from the start, down in 2 hits of 80\. Make it a fight: move sensei out of range/)]);
  });

  it("no chain: rules dropped for a name that is nothing, said once, and the win waiting for points nothing scores, with the shape of a tag", async () => {
    // laser tag whose 'opponent' comes without the team that says who it is
    const { issues } = await proved(world("laser-tag", (o) => (id(o).startsWith("r_tag") ? [{ ...o, if: [] }] : [o])));
    expect(issues[0]).toBe(`rules r_tag_red, r_tag_blue were dropped: they name 'opponent', which nothing in the world is. Use an id that exists, "player", or "team:red"/"team:blue" (anyone on that team).`);
    expect(issues[1]).toContain('r_win_red waits for red to score 10, but no rule scores for red (a hit on a rival scoring for red is {"t":"hit","a":"team:blue","b":""} → {"e":"score","target":"team:red","n":1})');
    expect(issues).toHaveLength(2); // ("no winnable objective" would only say it again)
  });

  it("lost fights: who knocked the runners out and how soon, the rivals' fire against your hit points, and what to change", async () => {
    // the castle's archers as rivals that shoot back hard, with 400 HP each
    const { r, issues } = await proved(world("a-castle-siege", (o) => {
      if (id(o).startsWith("archer_")) return [{ op: "npc", id: o.id, role: "rival", zone: o.zone, anchor: o.anchor, team: "blue", menu: ["rival.defend"] }];
      if (id(o).startsWith("vb_archer_shoot")) return [{ ...o, params: { range: 30, speed: 40, damage: 40, cooldown: 0.4, at: "" } }];
      if (id(o).startsWith("vb_archer_health")) return [{ ...o, params: { hp: 400, respawn: false } }];
      return id(o).startsWith("r_lose") ? [] : [o];
    }));
    expect(r.chips.find((c) => c.id === "T3:win")?.cx?.text).toMatch(/^12 lost \(knocked out by archer_(west|east) ×\d+.*, after \d+(\.\d)?(–\d+(\.\d)?)? s\)$/);
    expect(issues[0]).toMatch(/Runs are lost to the rivals' fire: archer_\w+(, archer_\w+)? deals? 40 every 0\.4 s \(\d+ HP\/s( together)?\) against your 100 HP \(down in about \d(\.\d)? s\), while knocking (it|them) out takes \d+ of your hits \(30 every 0\.5 s\)\. Make the fight winnable: give the player more hp/);
  });

  it("a target that can't be worn down: its hit points against your weapon's damage", async () => {
    // the space station's drones at 1000 HP, the rifle doing 1
    const { issues } = await proved(world("a-space-station", (o) => (id(o) === "vb_shoot" ? [{ ...o, params: { ...(o.params as Line), damage: 1 } }] : id(o).startsWith("vb_drone") ? [{ ...o, params: { hp: 1000, respawn: false } }] : [o])));
    expect(issues[0]).toContain("Runners got stuck shooting drone_1: it has 1000 HP and your weapon does 1 every 0.5 s (1000 hits). Lower its hp (combat_sport.health) or raise the damage of your combat_sport.shoot.");
  }, 300_000); // (twelve runs firing for their whole two minutes)

  it("a forced rule whose trigger happened but not its conditions says which, with what it found", async () => {
    const { issues } = await proved(world("a-castle-siege", (o) => (id(o) === "r_win" ? [{ ...o, if: [{ l: "archer_west.hp", op: "lt", r: -1 }] }] : [o])));
    expect(issues).toContain("Rule r_win never fired when forced: its trigger happened, but not archer_west.hp lt -1 (it is 0). Fix its trigger, conditions or the verb that should cause it. Hit points and scores are numbers (\"r\":0, never \"0\").");
  });

  it("rejected lines: hit points written as an ent are a verb on whoever has them", async () => {
    // defend the crystal without its timer: no way to win, and the two hp lines it lost say why
    const { issues } = await proved(world("defend-the-crystal", (o) => (id(o) === "r_win_timer" ? [] : [o])));
    expect(issues[0]).toBe(`ents crystal_hp, player_hp were rejected: "health" is not a kind. Hit points are a verb on whoever has them, e.g. {"op":"verb","id":"vb_hp_crystal","verb":"combat_sport.health","on":"crystal","params":{"hp":100}}.`);
    expect(issues).toContain(`No chain of rules lets the player win (no rule ever wins the game): no rule wins the game. Add one for beating the rivals, e.g. {"op":"rule","id":"r_win","when":{"t":"health_lte","a":"monster_template","n":0},"then":[{"e":"win","target":"player"}],"once":true}.`);
  });

  it("a patch that breaks the win chain is never kept over a world runners at least played", async () => {
    // (the castle's first repair round: its banner line lost its kind, the win went, and fewer
    // checks were left to fail, so it was kept)
    const played = (JSON.parse(readFileSync(file("a-castle-siege", ".receipt.json"), "utf8")) as { receipt: Receipt }).receipt;
    const { r: broken } = await proved(world("laser-tag", (o) => (id(o).startsWith("r_tag") ? [{ ...o, if: [] }] : [o])));
    expect(played.chips.find((c) => c.id === "T3:win")?.k).toBe(0);
    expect(badness(broken)).toBeGreaterThan(badness(played));
    expect(better(broken, played)).toBe(false);
  });
});
