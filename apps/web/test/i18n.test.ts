// The HUD's translations: every string the HUD can show is in every locale, no placeholder is lost
// or invented, each plural has the forms its language needs, and English reads exactly as before.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { chipLine, fraction, type Chip } from "@ghostrun/proof/light";
import { LOCALES, pickLocale, setLocale, t, TABLES, tn, type Forms } from "../src/i18n";
import { DYNAMIC, NAMED } from "../src/i18n/dynamic";
import { chipLineT, proofText, words } from "../src/i18n/words";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const LABELS = fileURLToPath(new URL("../../../packages/proof/src/labels.ts", import.meta.url));
const STR = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`;
const ONE = new RegExp(String.raw`(?<![\w.])(?:t|k|w)\(\s*` + STR, "g");
const PLURAL = new RegExp(String.raw`(?<![\w.])(?:tn|w\.n)\(\s*[^,()]+(?:\([^()]*\))?[^,()]*,\s*` + STR + String.raw`\s*,\s*` + STR, "g");
const unq = (s: string) => s.slice(1, -1).replace(/\\(.)/g, "$1");

function* sources(dir: string): Generator<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.tsx?$/.test(f) && (!p.includes("/i18n/") || /\/(words|dynamic)\.ts$/.test(p))) yield p;
  }
}
const singular = new Set<string>();
const plurals = new Map<string, string>(); // English "other" → English "one"
for (const f of [...sources(SRC), LABELS]) {
  const s = readFileSync(f, "utf8");
  for (const m of s.matchAll(ONE)) singular.add(unq(m[1]!));
  for (const m of s.matchAll(PLURAL)) plurals.set(unq(m[2]!), unq(m[1]!));
}
for (const p of plurals.keys()) singular.delete(p);
const holes = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();

afterEach(() => setLocale("en"));

describe("the HUD's string tables", () => {
  it("finds the HUD's strings where they are written", () => {
    expect(singular.size).toBeGreaterThan(400);
    expect(singular).toContain("Receipt");
    expect(plurals.get("{n} counterexamples")).toBe("{n} counterexample");
    for (const name of NAMED) expect(DYNAMIC, name).toContain(name);
  });

  it.each(LOCALES.filter((l) => l !== "en"))("%s has every key, nothing stale, and every placeholder", (l) => {
    const table = TABLES[l as Exclude<typeof l, "en">];
    const missing = [...singular, ...plurals.keys()].filter((k) => !(k in table));
    expect(missing).toEqual([]);
    expect(Object.keys(table).filter((k) => !singular.has(k) && !plurals.has(k))).toEqual([]);
    for (const k of singular) {
      const v = table[k];
      expect(typeof v, k).toBe("string");
      expect(holes(v as string), `${l}: ${k}`).toEqual(holes(k));
    }
    const categories = new Intl.PluralRules(l).resolvedOptions().pluralCategories;
    // the forms a count in the HUD needs: other always, one where the language has it, few in Czech
    // and Polish, many in Polish (5 kontroli); the rest fall back to other
    const need = ["other", ...categories.filter((c) => c === "one" || c === "few" || (c === "many" && l === "pl"))];
    for (const [other, one] of plurals) {
      const forms = table[other] as Forms;
      expect(typeof forms, other).toBe("object");
      for (const c of need) expect(forms[c as keyof Forms], `${l}: ${other} (${c})`).toBeTruthy();
      for (const [c, v] of Object.entries(forms)) expect(holes(v), `${l}: ${other} (${c})`).toEqual(holes(c === "one" ? one : other));
    }
  });

  it("keeps k of n a count in every language, never a percentage", () => {
    for (const l of LOCALES.filter((x) => x !== "en")) {
      const v = TABLES[l as Exclude<typeof l, "en">]["{k} of {n}"] as string;
      expect(v, l).not.toContain("%");
      setLocale(l);
      expect(fraction(3, 12, words), l).not.toContain("%");
    }
    setLocale("cs");
    expect(fraction(3, 12, words)).toBe("3 z 12");
    expect(fraction(30, 40, words)).toBe("75 % (n=40)"); // 30 trials or more: a percentage is fair
  });
});

describe("t() and tn()", () => {
  it("fill placeholders, write numbers the locale's way, and fall back to English", () => {
    setLocale("cs");
    expect(t("Galerie: {n} recorded worlds", { n: 3 })).toBe("Galerie: 3 recorded worlds"); // unknown key: as written
    expect(t("Gallery: {n} recorded worlds", { n: 62 })).toBe("Galerie: 62 nahraných světů");
    expect(t("AI par {s} s · {k} of {n} runners won", { s: 1.5, k: 12, n: 12 })).toBe("AI par 1,5 s · vyhrálo 12 z 12 běžců");
    expect([1, 3, 5].map((n) => tn(n, "{n} counterexample", "{n} counterexamples"))).toEqual(["1 protipříklad", "3 protipříklady", "5 protipříkladů"]);
    setLocale("pl");
    expect([1, 3, 5, 22].map((n) => tn(n, "{n} rule", "{n} rules"))).toEqual(["1 reguła", "3 reguły", "5 reguł", "22 reguły"]);
    setLocale("en");
    expect([1, 2].map((n) => tn(n, "{n} rule", "{n} rules"))).toEqual(["1 rule", "2 rules"]);
    expect(t("AI par {s} s · {k} of {n} runners won", { s: 1234.5, k: 1, n: 2 })).toBe("AI par 1234.5 s · 1 of 2 runners won");
  });

  it("pick the world's language when the HUD speaks it, else the browser's, else English", () => {
    expect(pickLocale("cs", ["en-US"])).toBe("cs");
    expect(pickLocale("hu", ["de-AT", "en"])).toBe("de");
    expect(pickLocale(undefined, ["zh-CN"])).toBe("zh");
    expect(pickLocale("hu", ["hu-HU"])).toBe("en");
  });
});

describe("the receipt in other words", () => {
  const chip: Chip = { id: "T3:tour", tier: "T3", subject: { kind: "property", id: "tour" }, status: "counterexample", method: "physics, an AI visitor walks to and uses each", n: 6, k: 5, text: "walked to and inspected 5 of 6 things", cx: { where: null, have: 5, need: 6, unit: "things", text: "couldn't reach plant_se" }, src: "", ms: 0 };

  it("reads exactly as the proof wrote it in English", () => {
    expect(chipLineT(chip)).toBe(chipLine(chip));
  });

  it("words the tiers' sentences it knows in Czech, and leaves the rest in the proof's English", () => {
    setLocale("cs");
    expect(chipLineT(chip)).toBe("✗ [T3] došel ke 5 z 6 věcí a prohlédl si je · 5 z 6 — nedošel k: plant_se  (fyzika, návštěvník AI dojde ke každé věci a použije ji)");
    expect(proofText("a sentence no shape knows")).toBe("a sentence no shape knows");
  });
});
