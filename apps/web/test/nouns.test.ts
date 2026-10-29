// What nouns look like: propFor and characterFor on the words fills use, and their coverage over
// every entity in the 62 gallery worlds and the recorded fixtures (the table is a committed
// snapshot, so a change in what any of them draws as shows up in review).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { splitObjects, type Entity } from "@ghostrun/ir";
import { FIXTURES, worldFromFill } from "../src/pipeline";
import { characterFor, normNoun, PROP_IDS, propFor, stem } from "../src/render/nouns";

describe("propFor", () => {
  it("names the prop by the head noun, in any case and with accents", () => {
    expect(propFor("rusty key", "pickup")).toBe("key");
    expect(propFor("Klíč k východu", "pickup")).toBe("key");
    expect(propFor("železný klíč", "pickup")).toBe("key");
    expect(propFor("Schlüssel", "pickup")).toBe("key");
    expect(propFor("treasure chest", "pickup")).toBe("chest");
    expect(propFor("gold coins", "pickup")).toBe("coin");
    expect(propFor("vault loot", "pickup")).toBe("coins");
    expect(propFor("star sapphire", "pickup")).toBe("gem");
    expect(propFor("Kristall", "pickup")).toBe("gem");
    expect(propFor("glowing stone", "pickup")).toBe("gem"); // a stone you pick up is precious
    expect(propFor("large rock", "prop")).toBe("rock");
    expect(propFor("healing potion", "pickup")).toBe("potion");
    expect(propFor("cursed books", "pickup")).toBe("book");
    expect(propFor("latte cup", "pickup")).toBe("mug");
    expect(propFor("battle banner", "prop")).toBe("banner");
    expect(propFor("potted plant", "prop")).toBe("bush");
    expect(propFor("bookshelf", "prop")).toBe("bookcase");
  });

  it("keeps the renderer's own shape where the noun isn't the prop", () => {
    expect(propFor("glowing orb", "pickup")).toBeNull();
    expect(propFor("soccer ball", "pickup")).toBeNull();
    expect(propFor("keycard", "pickup")).toBeNull();
    expect(propFor("key card", "pickup")).toBeNull();
    expect(propFor("vault door", "door")).toBeNull();
    expect(propFor("sliding shoji door", "door")).toBeNull();
    expect(propFor("art piece", "prop")).toBeNull();
    expect(propFor("bowling ball", "pickup")).toBeNull();
  });

  it("asks the kind too: doors are doors or gates, switches are things used in place, goals stay goals", () => {
    expect(propFor("wooden door", "door")).toBe("door");
    expect(propFor("iron gate", "door")).toBe("gate");
    expect(propFor("treasure chest", "door")).toBeNull();
    expect(propFor("candle", "switch")).toBe("candle");
    expect(propFor("lever", "switch")).toBeNull();
    expect(propFor("golden trophy", "goal")).toBeNull();
    expect(propFor("spike trap", "hazard")).toBeNull();
    expect(propFor("rusty key", "npc")).toBeNull();
  });

  it("stems plurals simply and normalises text", () => {
    expect(stem("candies")).toBe("candy");
    expect(stem("boxes")).toBe("box");
    expect(stem("keys")).toBe("key");
    expect(stem("glass")).toBe("glass");
    expect(normNoun("Principal's Key!")).toBe("principal key");
  });
});

describe("characterFor", () => {
  it("dresses roles in the body they read as, and anyone else as a person", () => {
    expect(characterFor("shambling zombie")).toBe("skeleton");
    expect(characterFor("duch")).toBe("skeleton");
    expect(characterFor("rival wizard")).toBe("mage");
    expect(characterFor("librarian")).toBe("mage");
    expect(characterFor("security guard")).toBe("knight");
    expect(characterFor("strážník")).toBe("knight");
    expect(characterFor("minotaur")).toBe("barbarian");
    expect(characterFor("enemy boarding party")).toBe("barbarian");
    expect(characterFor("museum guide")).toBe("rogue");
    expect(characterFor("blue racer")).toBe("rogue");
    expect(characterFor("someone")).toBe("rogue");
  });

  it("keeps the capsule for robots, animals and wisps, whatever else the noun says", () => {
    expect(characterFor("security robot")).toBeNull();
    expect(characterFor("great white shark")).toBeNull();
    expect(characterFor("zombie dog")).toBeNull();
    expect(characterFor("will-o'-wisp")).toBeNull();
  });

  it("gives the player the body its role names, else the knight", () => {
    expect(characterFor("", true)).toBe("knight");
    expect(characterFor("A young wizard apprentice", true)).toBe("mage");
    expect(characterFor("A robot courier", true)).toBe("knight");
    expect(characterFor("A night archivist sent to uncurse the collection", true)).toBe("knight");
  });
});

// ---- coverage over the worlds the product ships --------------------------------------------------

const GALLERY = new URL("../src/gallery/worlds/", import.meta.url);
const seedOf = (fill: string) => (JSON.parse(splitObjects(fill.split("\n", 1)[0] ?? "{}")[0] ?? "{}") as { seed?: number }).seed ?? 7;

function worlds(): { name: string; entities: readonly Entity[] }[] {
  const out: { name: string; entities: readonly Entity[] }[] = [];
  for (const f of readdirSync(GALLERY).filter((x) => x.endsWith(".json")).sort()) {
    const g = JSON.parse(readFileSync(new URL(f, GALLERY), "utf8")) as { fill: string; intent: { pack: string; mode: "play" | "wander"; genre: string; setting: string; goal: string; fail: string; role: string } };
    const i = g.intent;
    const w = worldFromFill(g.fill, seedOf(g.fill), { genre: i.genre, setting: i.setting, goal: i.goal, fail: i.fail, role: i.role }, i.pack, i.mode);
    out.push({ name: f.replace(/\.json$/, ""), entities: w.bundle.entities });
  }
  for (const [k, fill] of Object.entries(FIXTURES)) out.push({ name: `fixture:${k}`, entities: worldFromFill(fill, seedOf(fill)).bundle.entities });
  return out;
}

describe("coverage over the gallery and the fixtures", () => {
  it("maps the nouns worlds use, and the table is the committed snapshot", async () => {
    const all = worlds();
    expect(all.filter((w) => !w.name.startsWith("fixture:"))).toHaveLength(62);
    const things = new Map<string, { kind: string; noun: string; prop: string | null; n: number }>();
    const people = new Map<string, { noun: string; body: string | null; n: number }>();
    for (const w of all) {
      for (const e of w.entities) {
        if (e.tags.includes("area")) continue;
        if (e.kind === "npc") {
          const key = normNoun(e.noun || e.id);
          const p = people.get(key) ?? { noun: key, body: characterFor(e.noun || e.id), n: 0 };
          p.n++;
          people.set(key, p);
        } else if (["pickup", "prop", "switch", "door"].includes(e.kind)) {
          const key = `${e.kind}|${normNoun(e.noun)}`;
          const t = things.get(key) ?? { kind: e.kind, noun: normNoun(e.noun), prop: propFor(e.noun, e.kind), n: 0 };
          t.n++;
          things.set(key, t);
        }
      }
    }
    const rows = [...things.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.noun.localeCompare(b.noun));
    const cast = [...people.values()].sort((a, b) => a.noun.localeCompare(b.noun));
    const count = (xs: { n: number }[]) => xs.reduce((s, x) => s + x.n, 0);
    const propped = rows.filter((r) => r.prop);
    const bodied = cast.filter((c) => c.body);
    const used = new Set(propped.map((r) => r.prop));
    const summary = [
      `things (pickup, prop, switch, door): ${propped.length} of ${rows.length} distinct nouns drawn as a prop, ${count(propped)} of ${count(rows)} entities`,
      `characters (npc): ${bodied.length} of ${cast.length} distinct nouns given a body, ${count(bodied)} of ${count(cast)} entities`,
      `props used: ${used.size} of ${PROP_IDS.length} (${PROP_IDS.filter((p) => !used.has(p)).join(", ")} unused here)`,
    ];
    console.log(`[nouns] ${summary.join("\n[nouns] ")}`);
    const table = [
      ...summary,
      "",
      "kind     n  noun → prop",
      ...rows.map((r) => `${r.kind.padEnd(7)} ${String(r.n).padStart(2)}  ${r.noun} → ${r.prop ?? "-"}`),
      "",
      "npc      n  noun → body",
      ...cast.map((c) => `npc     ${String(c.n).padStart(2)}  ${c.noun} → ${c.body ?? "capsule"}`),
      "",
    ].join("\n");
    await expect(table).toMatchFileSnapshot("./__snapshots__/nouns-coverage.txt");
    // most of what the shipped worlds hold, and nearly all of their people, look like what they are
    expect(count(propped) / count(rows)).toBeGreaterThan(0.45);
    expect(count(bodied) / count(cast)).toBeGreaterThan(0.8);
  });
});
