import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { homage, homageIntent, homageNote, TRADEMARKS } from "../src/homage";
import { INTENT_WORDS, intentMessages } from "../src/prompts";

const bench = resolve(dirname(fileURLToPath(import.meta.url)), "../../../tools/bench");
const lines = (file: string) =>
  readFileSync(resolve(bench, file), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"));
const IP = lines("prompts-ip.txt").map((l) => {
  const [prompt, names] = l.split(" || ");
  return { prompt: prompt!.trim(), names: names!.split(";").map((n) => n.trim()) };
});
const CLEAN = lines("prompts-ip-clean.txt");
const PACKS = [{ id: "arena", blurb: "an arena" }];

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
/** Any table name in the text, as a whole word (any case), or anywhere for a CJK name. */
function survivors(text: string): string[] {
  return TRADEMARKS.filter(({ name, cased }) => {
    if (CJK.test(name)) return text.includes(name);
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // a name that is also a word ("temple run") counts only written as the brand writes it
    return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, cased ? "u" : "iu").test(text);
  }).map((t) => t.name);
}

describe("trademarks to homages", () => {
  it("knows about two hundred trademarks, and no homage names one (so a rewrite is stable)", () => {
    expect(TRADEMARKS.length).toBeGreaterThanOrEqual(200);
    for (const ip of IP) {
      const once = homage(ip.prompt);
      expect(homage(once.text)).toEqual({ text: once.text, homages: [] });
    }
  });

  it("50 IP-laden prompts: no trademark name survives into what the models are sent", () => {
    expect(IP).toHaveLength(50);
    for (const ip of IP) {
      const h = homage(ip.prompt);
      expect(h.homages.length, ip.prompt).toBeGreaterThan(0);
      const sent = intentMessages(h.text, PACKS).find((m) => m.role === "user")!.content;
      expect(sent).toBe(h.text);
      // the names the line lists (as substrings, any case: stricter than whole words), then every name the table knows
      for (const name of ip.names) expect(sent.toLowerCase(), `${ip.prompt} → ${sent}`).not.toContain(name.toLowerCase());
      expect(survivors(sent), `${ip.prompt} → ${sent}`).toEqual([]);
    }
  });

  it("50 ordinary prompts (brand names inside words, brand words used plainly) come back exactly as written", () => {
    expect(CLEAN).toHaveLength(50);
    for (const p of CLEAN) expect(homage(p), p).toEqual({ text: p, homages: [] });
  });

  it("every prompt in the bench sets and the recorded worlds is left alone (none of them names a brand)", () => {
    const all = readdirSync(bench).filter((f) => f.endsWith(".txt") && !f.startsWith("prompts-ip")).flatMap(lines);
    expect(all.length).toBeGreaterThan(250);
    expect(all.filter((p) => homage(p).homages.length)).toEqual([]);
  });

  it("whole words, any case; the longest name wins; an article takes the homage's place; a sentence start is capitalised", () => {
    expect(homage("Build a Mario Kart race")).toEqual({ text: "Build a kart race with a plumber hero race", homages: [{ from: "Mario Kart", to: "a kart race with a plumber hero" }] });
    expect(homage("mario jumps over a marionette in a scenario").text).toBe("A plumber hero jumps over a marionette in a scenario");
    expect(homage("Race a Ferrari against an Xbox").text).toBe("Race a red sports car against a game console");
    expect(homage("the Death Star and a lightsaber").text).toBe("the moon-sized battle station and a laser sword");
    expect(homage("Pac-Man, pacman and Pac Man").homages.map((h) => h.from)).toEqual(["Pac-Man", "pacman", "Pac Man"]);
    expect(homage("Una carrera de Pokemon").text).toBe("Una carrera de pocket-monster");
    expect(homage("Mario's castle").text).toBe("A plumber hero's castle");
    expect(homage("A race through an LEGO city").text).toBe("A race through a toy-brick city");
  });

  it("a brand that is also a word: only capitalised and mid-sentence", () => {
    expect(homage("A sonic boom").homages).toEqual([]);
    expect(homage("Sonic booms echo").homages).toEqual([]); // the start of a sentence
    expect(homage("A Sonic level with loops").text).toBe("A speedy blue hedgehog level with loops");
    expect(homage("Walk through the portal. A Portal test chamber").text).toBe("Walk through the portal. A test-chamber puzzle with a portal gun test chamber");
    expect(homage("A traitor among us").homages).toEqual([]);
    expect(homage("An Among Us ship").text).toBe("A spaceship crew with an impostor ship");
  });

  it("other languages: inflected Czech and Polish forms, and Japanese and Chinese names inside words", () => {
    expect(homage("Závod v Bradavicích").text).toBe("Závod v a wizard school castle");
    expect(homage("Wyścig w Hogwarcie").text).toBe("Wyścig w a wizard school castle");
    expect(homage("マリオのレース").homages).toEqual([{ from: "マリオ", to: "a plumber hero" }]);
    expect(homage("在乐高城市里驾驶法拉利").homages.map((h) => h.from)).toEqual(["乐高", "法拉利"]);
  });

  it("a brand the intent model names by itself is rewritten too (a live run answered a Metropolis flight with 'a Superman-style homage')", () => {
    const said = { lang: "en", mode: "play" as const, genre: "superhero flight", setting: "rooftops above a gleaming metropolis", role: "caped flying strongman", goal: "catch the satellite", fail: "", mood: "heroic", pack: "city_block", sub: [], safety: "ok" as const, headline: "Fly like Superman over Metropolis", nouns: [{ noun: "Metropolis rooftops", hyper: "a Superman-style homage" }], moodVec: { valence: 0, arousal: 0, tension: 0 } };
    const out = homageIntent(said, INTENT_WORDS);
    expect(out.headline).toBe("Fly like a caped flying strongman over a gleaming skyscraper city");
    expect(out.setting).toBe(said.setting); // the ordinary word stays
    expect(out.nouns).toEqual([{ noun: "A gleaming skyscraper city rooftops", hyper: "a caped flying strongman-style homage" }]);
    expect(survivors(JSON.stringify(out))).toEqual([]);
  });

  it("the Intent card's note", () => {
    expect(homageNote(homage("A Mario Kart race at Hogwarts").homages)).toBe("Homage: 'Mario Kart' → 'a kart race with a plumber hero', 'Hogwarts' → 'a wizard school castle'; we don't use trademarked names");
    expect(homageNote([])).toBeNull();
  });
});
