// The HUD's words in the player's language. English is the source: a key is the English string
// itself, with {name} placeholders, so a string nobody translated reads as it was written. Plural
// forms come from Intl.PluralRules and numbers are written the locale's way, here in the client
// only (the simulation path never sees Intl: the determinism lint bans it there). Every locale but
// English is machine-translated and says so.
import { cs } from "./cs";
import { de } from "./de";
import { es } from "./es";
import { fr } from "./fr";
import { it } from "./it";
import { ja } from "./ja";
import { pl } from "./pl";
import { pt } from "./pt";
import { zh } from "./zh";

export const LOCALES = ["en", "cs", "de", "es", "fr", "pl", "it", "pt", "ja", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

/** Each language in its own words, for the language chip. */
export const LANGUAGE_NAMES: Record<Locale, string> = { en: "English", cs: "Čeština", de: "Deutsch", es: "Español", fr: "Français", pl: "Polski", it: "Italiano", pt: "Português", ja: "日本語", zh: "简体中文" };

/** A plural's forms by the locale's plural category (one, few, many, other…). */
export type Forms = Partial<Record<Intl.LDMLPluralRule, string>>;
/** A locale's strings: English key → its words, or its plural forms (keyed by the English "other" form). */
export type Table = Readonly<Record<string, string | Forms>>;

export const TABLES: Readonly<Record<Exclude<Locale, "en">, Table>> = { cs, de, es, fr, pl, it, pt, ja, zh };

export type Vars = Readonly<Record<string, string | number>>;

let current: Locale = "en";
let plural = new Intl.PluralRules("en");
let number = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });

export function setLocale(l: Locale) {
  if (l === current) return;
  current = l;
  plural = new Intl.PluralRules(l);
  number = new Intl.NumberFormat(l, { maximumFractionDigits: 2 });
  if (typeof document !== "undefined") document.documentElement.lang = l === "zh" ? "zh-Hans" : l;
}
export const locale = (): Locale => current;

/** A number the locale's way: 1.5 → "1,5" in Czech (English keeps the digits as the source wrote them). */
export const num = (n: number): string => (current === "en" ? String(n) : number.format(n));

const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? (typeof vars[k] === "number" ? num(vars[k] as number) : String(vars[k])) : m)) : s);

/** Marks a string as a key where it is written, to be put through t() where it is shown. */
export const k = (s: string): string => s;

/** The words for an English string in the current locale, its {placeholders} filled in. */
export function t(key: string, vars?: Vars): string {
  const got = current === "en" ? undefined : TABLES[current][key];
  return fill(typeof got === "string" ? got : key, vars);
}

/**
 * A count with its noun: tn(3, "{n} check", "{n} checks") is "3 checks", "3 kontroly" in Czech. The
 * locale's table keys its forms by the English plural; {n} is the count, the locale's way.
 */
export function tn(n: number, one: string, other: string, vars?: Vars): string {
  const all = { ...vars, n };
  const got = current === "en" ? undefined : TABLES[current][other];
  if (got && typeof got === "object") return fill(got[plural.select(n)] ?? got.other ?? other, all);
  return fill(new Intl.PluralRules("en").select(n) === "one" ? one : other, all);
}

/** The world's language if the HUD speaks it, else the first of the browser's that it does, else English. */
export function pickLocale(worldLang: string | undefined, browser: readonly string[]): Locale {
  const of = (tag: string | undefined) => LOCALES.find((l) => tag?.toLowerCase().split(/[-_]/)[0] === l);
  return of(worldLang) ?? browser.map(of).find(Boolean) ?? "en";
}

const KEY = "ghostrun.lang";
/** The language the player chose with the chip, if any (a private window may have no storage). */
export function chosenLocale(): Locale | null {
  try {
    const v = localStorage.getItem(KEY);
    return LOCALES.find((l) => l === v) ?? null;
  } catch {
    return null;
  }
}
export function chooseLocale(l: Locale) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // remembered for this page only
  }
}
