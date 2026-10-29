// Worlds the live lane built for prompts nobody tuned on (the committed eval sets), re-proved as
// recorded: each one stands for a class of failure the placer or the runners now handle.
import { readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { splitObjects } from "@ghostrun/ir";
import { loadNavNode } from "@ghostrun/nav/node";
import { prove } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { ENGINE_HASH, worldFromFill } from "../src/pipeline";

const WORLDS = new URL("../../../tools/bench/worlds/", import.meta.url);
const recorded = (set: string, prefix: string) => {
  const dir = new URL(`${set}/`, WORLDS);
  const f = readdirSync(dir).find((x) => x.startsWith(prefix) && x.endsWith(".fill.jsonl"))!;
  const text = readFileSync(new URL(f, dir), "utf8");
  const { intent } = JSON.parse(readFileSync(new URL(f.replace(".fill.jsonl", ".receipt.json"), dir), "utf8")) as { intent: { pack: string; mode: "play" | "wander" } };
  const seed = (JSON.parse(splitObjects(text.split("\n", 1)[0]!)[0]!) as { seed: number }).seed;
  return worldFromFill(text, seed, undefined, intent.pack, intent.mode);
};

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

describe("recorded unseen worlds", () => {
  it.each([
    ["fresh4", "smuggle-the-diamond", "a laser grid in a doorway stands inside the vault, and runners jump it both ways"],
    ["fresh4", "a-wizard-school", "three rules each winning on one ingredient mean all three go in the cauldron"],
    ["fresh4", "a-treehouse-village", "'IF the player is in z_finish' on reaching the bell is dropped as already true"],
    ["fresh3", "a-spy-mission", "a runner holding the kept key puts it down to pick up the documents"],
    ["fresh4", "a-zombie-school", "zombies you lose by touching are walked around, and the exit nothing opens means the locked gym door"],
    ["combat", "a-snowball-fight", "rivals leave balls they can't throw alone, and a ball under a deck is fetched from the floor"],
    ["combat", "a-sumo-ring", "'pushed into out of bounds' means out of the ring"],
    ["combat", "bumper-cars-arena", "a shove lands from behind the car, toward where it must go"],
    ["combat", "dodgeball-arena", "'when blue is hit' means anyone on team blue"],
    ["fresh", "dodgeball-arena", "a hit by a ball red threw scores for red, whatever the rule said"],
    ["fresh3", "a-jungle-temple", "a jump pad a fill put on the lane is landed beside, not on"],
    ["fresh3", "build-up-speed", "a portal on the lane is walked around; putting the key down frees the hands for the trophy at once"],
    ["judges", "a-temple-run", "boulders on the lane are landed clear of and walked round; 'carry_count is 4' counts the idols collected"],
    ["fresh3", "a-night-at-the-observatory", "a runner arriving mid-hop lands before it reaches for the telescope"],
    ["fresh3", "herd-the-escaped-chickens", "'reach the coop holding all three chickens' means bringing each one in"],
    ["fresh5", "a-lighthouse", "a crosswind faster than you walk is eased, runners lean into it, and climb back up from the fall floor"],
    ["fresh5", "escape-the-flooding", "a corner beside deadly water is turned on the spot, not cut"],
    ["fresh5", "capture-all-four-flags", "a score zone hanging half in the wall moves off it"],
    ["fresh5", "penalty-shootout", "a miss box with no ring is not a ring game"],
    ["fresh5", "defend-the-crystal", "a sunrise nobody started becomes a countdown"],
    ["fresh5", "paintball", "'the player hits blue_1' means tagging them"],
    ["fresh6", "a-neon-arcade", "a token hung on the wall over the floor is jumped for from below, not stared at from the wall top"],
    ["fresh6", "bowling-alley", "'the ball touches pin_3' means throwing it at pin_3; no rivals are added to a game with pins"],
    ["fresh6", "a-secret-agent", "'the terminal enters the server room' means you reaching it"],
    ["fresh6", "a-tiny-town-fire", "'when fire1 is destroyed' fires when it is"],
    ["fresh6", "a-medieval-tournament", "the bridge you mustn't leave isn't a hazard, you start on it, and so does the knight"],
    ["fresh6", "climb-the-beanstalk", "a switch named as a lock's key isn't carried, and a carried thing never takes USE"],
    ["fresh7", "king-of-the-hill", "a win waiting for a countdown's 'done' waits for it"],
    ["fresh7", "a-frozen-lake", "thin ice covering a lane platform lies below the walkway instead"],
    ["fresh7", "a-space-dock", "'fuel cell 3 enters the ship while all three are carried' means bringing each in"],
    ["fresh8", "defuse-the-bomb", "a door nothing opens opens with USE; wires a win wants off start on, and USE cuts them"],
    ["fresh8", "a-robot-factory", "slots made doors stay put; a used-up part and an already-done step don't stall the run"],
    ["fresh8", "golden-snitch", "'the snitch is carried' is the moment it's picked up"],
    ["judges", "a-feng-shui-handbag", "a place: no jitter into a doorway's jamb, so the visitor reaches every bag"],
    ["judges", "a-minimalist-white-museum", "a place: the visitor steps toward the sculpture its guide stands beside"],
    ["kits", "a-real-estate-tour-of-a-modern", "a place: a door with only a line to inspect opens with USE, and the tour opens it"],
    ["fresh6", "a-japanese-tea-house", "a place: a window above head height is in reach to look at"],
    ["fresh7", "a-bookshop", "a place: the window you face, not the cushion beside you"],
    ["fresh9", "a-wine-cellar", "a place: a guide standing in the doorway steps aside"],
    ["fresh9", "a-rooftop-greenhouse", "a place: a pane above a shelf is looked at from the floor in front"],
    ["fresh7", "a-wild-west-town", "horses the game is about don't step aside like bystanders"],
    ["fresh9", "light-the-four-torches", "runners walk round the gate the torches open until it opens"],
    ["fresh7", "open-the-vault", "a waist-high vault door is hopped, plates are big enough to stand on, shut doors are walked round"],
    ["fresh10", "an-arena-with-three-capture", "'win if all zones are red when time runs out; lose when it runs out': the exception goes first"],
    ["fresh10", "a-water-temple", "two doors in one doorway are one door, opened by whichever lever is on this side"],
    ["fresh10", "a-lab-where", "a beaker with stages 0, 1, 2 and no starting state starts at 0"],
    ["fresh10", "a-snowy-mountain", "'if player.path is left', which nothing sets, is dropped"],
    ["fights", "a-wizard-duel-on-a-floating-island", "the only fireball, lying in the fall zone you lose by entering, moves out of it"],
    ["fights", "a-castle-siege-with-bows", "'IF each archer's hp is 0' is planned: shoot each one down, then take the banner"],
    ["fights", "a-ninja-dojo", "throwing stars hurt what has hit points, and the sensei the win wears down is something to throw them at"],
    ["fights", "paintball-in-a-forest", "'most hits when the clock runs out': your hits with either gun, theirs on you, and runners fire back while they wait"],
    ["fights", "laser-tag-in-a-neon-warehouse", "'player_red' is you, 'player_blue' is blue, blue scoring when blue is hit means red hit, and a blue win is your loss"],
    ["fights-r2", "a-castle-siege-with-bows", "'IF archer_west.hp is \"0\"' compares numbers, and an archer 'hitting the player' is its shot, not a tag"],
    ["fights-r2", "a-space-station-shooter", "a drone on a platform across the pit is reached by the course's hops, not chased into the pit"],
    ["fights-r2", "laser-tag-in-a-neon-warehouse", "'hits an opponent, if opponent.team is blue' means blue hit, for red's tag"],
    ["fights-r2", "a-ninja-dojo", "three dummy knock-outs that lead nowhere make the win need them all, so it's no longer won in 1.2 s"],
    ["fights-r2", "a-cowboy-showdown", "'outdraw three bandits' with a win for the third alone needs all three, whoever goes down last"],
  ])("%s %s: %s", async (set, prefix) => {
    const w = recorded(set, prefix);
    const r = await prove(R, w.bundle, { engine: ENGINE_HASH, runs: 12 });
    // a game: AI runners win it; a place: the AI visitor reaches and uses everything in it
    if (w.bundle.mode === "wander") expect(r.chips.find((c) => c.id === "T3:tour")?.status).toBe("played");
    else expect(r.chips.find((c) => c.id === "T3:win")?.k ?? 0).toBeGreaterThanOrEqual(10);
    // (laser tag was won in 0.2 s by walking into your own base; the second dojo in 1.2 s by the sensei alone)
    if (set.startsWith("fights")) expect(r.chips.find((c) => c.id === "T3:too_easy")).toBeUndefined();
    if (set === "fights-r2") expect(r.chips.filter((c) => c.status === "counterexample").map((c) => c.id)).toEqual([]);
  }, 180_000);
});
