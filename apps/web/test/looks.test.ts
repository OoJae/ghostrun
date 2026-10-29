// Looks match the prompt: every recorded gallery world and fixture picks a look from what the AI
// wrote (the look word, the setting, the names), the table of choices is kept as a snapshot, and a
// share link (the fill alone) rebuilds the same look. Looks are cosmetic: the spec hash never moves.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitObjects } from "@ghostrun/ir";
import { buildWorld, FIXTURE_PROMPTS, FIXTURES, hashWorld, worldFromFill, type World } from "../src/pipeline";
import { pickLook, type Pick } from "../src/render/pick";
import { signText } from "../src/render/sign";

interface Recorded {
  prompt: string;
  intent: { genre: string; setting: string; goal: string; fail: string; role: string; pack: string; mode: "play" | "wander" };
  fill: string;
}

const DIR = new URL("../src/gallery/worlds/", import.meta.url);
const gallery = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => {
    const g = JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as Recorded;
    const seed = (JSON.parse(splitObjects(g.fill.split("\n", 1)[0] ?? "{}")[0] ?? "{}") as { seed?: number }).seed ?? 7;
    const i = g.intent;
    // as the app opens it: the live intent alongside the recorded fill
    const world = worldFromFill(g.fill, seed, { genre: i.genre, setting: i.setting, goal: i.goal, fail: i.fail, role: i.role }, i.pack, i.mode);
    return { slug: f.replace(/\.json$/, ""), prompt: g.prompt, fill: g.fill, seed, pack: i.pack, mode: i.mode, world };
  });
const fixtures = Object.keys(FIXTURES).map((k) => ({ slug: `fixture:${k}`, prompt: FIXTURE_PROMPTS[k] ?? k, world: buildWorld("", k) }));

const label = (p: Pick) => `${p.id}${p.variant ? `/${p.variant}` : ""}`;
const sky = (p: Pick) => [p.phase, ...(["rain", "storm", "snow", "fog", "dust", "overcast"] as const).filter((k) => p[k])].join(" ");
const pickOf = (w: World) => pickLook(w.cue);
const byPrompt = (re: RegExp) => {
  const g = [...gallery, ...fixtures].find((x) => re.test(x.prompt));
  if (!g) throw new Error(`no recorded world matches ${re}`);
  return pickOf(g.world);
};

describe("looks match the prompt", () => {
  it("prints the table of every recorded prompt and the look it gets", async () => {
    const rows = [...fixtures, ...gallery].map((g) => {
      const p = pickOf(g.world);
      const prompt = g.prompt.length > 74 ? `${g.prompt.slice(0, 73)}…` : g.prompt;
      return `| ${prompt.replace(/\|/g, "/")} | ${g.world.cue.look.replace(/\|/g, "/")} | ${g.world.bundle.pack.id} | **${label(p)}** | ${sky(p)} |`;
    });
    const table = ["| prompt | look word | pack | look | sky |", "|---|---|---|---|---|", ...rows].join("\n");
    console.log(table);
    await expect(`${table}\n`).toMatchFileSnapshot("./__snapshots__/looks.table.md");
  });

  it("names the place: desert, space, haunted, magic, candy, ice, home and the rest", () => {
    expect(label(byPrompt(/desert canyon/))).toBe("desert");
    expect(byPrompt(/desert canyon/).dust).toBe(true); // the meta line's "sandstorm"
    expect(label(byPrompt(/desert temple/))).toBe("desert");
    expect(label(byPrompt(/sunny beach/))).toBe("desert/beach");
    expect(label(byPrompt(/desert island/))).toBe("desert/beach");
    expect(label(byPrompt(/^A space station: flip/))).toBe("space");
    expect(label(byPrompt(/gravity is low/))).toBe("space");
    expect(label(byPrompt(/zero-g basketball/))).toBe("space");
    expect(label(byPrompt(/moon base/))).toBe("space/moon");
    expect(label(byPrompt(/sci-fi lab/))).toBe("space");
    expect(label(byPrompt(/haunted mansion/))).toBe("haunted");
    expect(label(byPrompt(/haunted library/))).toBe("haunted/library");
    expect(label(byPrompt(/zombie school/))).toBe("haunted");
    expect(label(byPrompt(/bludiště s duchy/))).toBe("haunted");
    expect(label(byPrompt(/wizard school/))).toBe("medieval/magic");
    expect(label(byPrompt(/medieval castle siege/))).toBe("medieval");
    expect(label(byPrompt(/Uteč z hradu/))).toBe("medieval");
    expect(label(byPrompt(/candy factory/))).toBe("candy");
    expect(label(byPrompt(/circus big top/))).toBe("candy");
    expect(label(byPrompt(/Eishöhle/))).toBe("snow/cave");
    expect(label(byPrompt(/snowy mountain race/))).toBe("snow");
    expect(label(byPrompt(/frozen lake/))).toBe("snow");
    expect(label(byPrompt(/penguins/))).toBe("snow");
    expect(label(byPrompt(/Japanese tea house/))).toBe("home/japanese");
    expect(label(byPrompt(/ninja dojo/))).toBe("home/japanese");
    expect(label(byPrompt(/coffee shop/))).toBe("home");
    expect(label(byPrompt(/old library/))).toBe("home/library");
    expect(label(byPrompt(/pressure-plate puzzle temple/))).toBe("jungle");
    expect(label(byPrompt(/bioluminescent forest/))).toBe("grove");
    expect(label(byPrompt(/hedge maze/))).toBe("grove");
    expect(label(byPrompt(/floating islands/))).toBe("grove");
    expect(label(byPrompt(/tennis court/))).toBe("grove");
    expect(label(byPrompt(/Archery range/))).toBe("grove");
    expect(label(byPrompt(/Domino run/))).toBe("candy");
    expect(label(byPrompt(/Basketball/))).toBe("gallery");
    expect(label(byPrompt(/pirate ship/))).toBe("desert/beach");
    expect(label(byPrompt(/lighthouse/))).toBe("medieval");
    expect(label(byPrompt(/rooftop at sunset/))).toBe("neon");
    expect(label(byPrompt(/museum heist at night/))).toBe("gallery");
    expect(label(byPrompt(/aquarium tunnel/))).toBe("gallery/underwater");
    expect(label(byPrompt(/capture-the-flag game in a neon city/))).toBe("neon");
    expect(label(byPrompt(/neon arcade/))).toBe("neon");
  });

  it("honours the weather and the time of day it asks for", () => {
    const tea = byPrompt(/Japanese tea house/);
    expect(tea.rain && tea.indoor).toBe(true); // rain outside the cut-away walls
    expect(byPrompt(/snowball fight/).snow).toBe(true);
    expect(byPrompt(/stormy cliff/).storm).toBe(true);
    expect(byPrompt(/stormy cliff/).phase).toBe("night");
    expect(byPrompt(/haunted mansion/).fog).toBe(true);
    expect(byPrompt(/rooftop at sunset/).phase).toBe("dusk");
    expect(byPrompt(/last train/).phase).toBe("dusk");
    expect(byPrompt(/medieval castle siege/).overcast).toBe(true);
    expect(byPrompt(/floating islands/).phase).toBe("day"); // "glowing islands" in the setting is not night
  });

  it("signs say what the world is: its own words or its zones, the noodle bar only in the organizer's CTF city", () => {
    const say = (w: World) => w.bundle.entities.filter((e) => e.kind === "sign").map((e) => signText(w.bundle, e, pickOf(w).id));
    expect(say(fixtures.find((f) => f.slug === "fixture:ctf")!.world)).toEqual([["NOODLES", "OPEN 24H  ·  CTF FINALS"]]);
    const lines = gallery.flatMap((g) => say(g.world));
    expect(lines.length).toBeGreaterThan(4);
    for (const [title, sub] of lines) {
      expect(title).not.toBe("NOODLES");
      expect(title.length).toBeGreaterThan(2);
      expect(sub).not.toContain("CTF");
    }
    const aquarium = say(gallery.find((g) => /aquarium/.test(g.prompt))!.world);
    expect(aquarium.map(([t]) => t)).toContain("OBSERVATION BAY"); // "observation bay sign": the sign's own words
    expect(aquarium[0]![1]).toMatch(/^→ /); // and the way to the other zones
  });

  it("a share link (the fill alone) rebuilds the same look as the live world", () => {
    for (const g of gallery) {
      const shared = worldFromFill(g.world.fill, g.seed, undefined, g.world.bundle.pack.id);
      expect(label(pickOf(shared)), g.prompt).toBe(label(pickOf(g.world)));
      expect(pickOf(shared).phase, g.prompt).toBe(pickOf(g.world).phase);
    }
  });

  it("never moves the spec hash: the stamped setting and the kept cosmetic words are cosmetic", async () => {
    for (const g of gallery) {
      const i = JSON.parse(readFileSync(new URL(`${g.slug}.json`, DIR), "utf8")) as Recorded;
      const plain = worldFromFill(g.fill, g.seed, undefined, i.intent.pack, i.intent.mode);
      const again = worldFromFill(g.world.fill, g.seed, undefined, i.intent.pack, i.intent.mode);
      const h = await hashWorld(g.world.bundle);
      expect(await hashWorld(plain.bundle), g.prompt).toBe(h);
      expect(await hashWorld(again.bundle), g.prompt).toBe(h);
      expect(await hashWorld({ ...g.world.bundle, cosmetic: { look: "default", mood: [0, 0, 0], timeOfDay: 12, weather: "clear", dress: [], posters: [] } }), g.prompt).toBe(h);
    }
  });
});
