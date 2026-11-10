// Persona sliders: each minded character's AI Hub persona, tuned with a slider per trait that
// changes what it does within what the world already allows.
//   cautious ↔ bold     the option it starts on, from its own typed menu (gameplay: re-proved)
//   quiet ↔ chatty      how often it thinks aloud, in its persona's reply style (prose: not hashed)
//   greedy ↔ honest     the price of a bribe, within what the world's coins can pay (gameplay: re-proved)
//   sleepy ↔ alert      how far it sees, within the perception envelope (gameplay: re-proved)
// A gameplay slider is an edit like any other: a patch on the fill by stable ids, re-proved, shown with
// its numbers and Undo. Persona prose is never hashed, so the quiet ↔ chatty slider leaves the spec
// and the receipt as they were.
import { splitObjects, type Cast, type Persona, type Rule, type WorldBundle } from "@ghostrun/ir";
import { behaviourOf, type Behaviour } from "@ghostrun/bots";
import { acceptsOf } from "./acts";
import { k } from "./i18n";

export type Trait = "bold" | "chatty" | "greedy" | "alert";

export interface Slider {
  npc: string;
  trait: Trait;
  /** The words at each end, left (the lowest value) then right. */
  ends: readonly [string, string];
  min: number;
  max: number;
  step: number;
  value: number;
  /** Changes gameplay (hashed, re-proved); false: persona prose only. */
  gameplay: boolean;
  /** Bold ↔ cautious: the options it can start on, cautious first (the value is an index). */
  options?: readonly string[];
  /** Greedy ↔ honest: the rule that sets the price, and what it is paid in. */
  rule?: string;
  word?: string;
}

export interface Character {
  npc: string;
  name: string;
  role: Cast["role"];
  sliders: Slider[];
}

export const ENDS: Record<Trait, readonly [string, string]> = {
  bold: [k("cautious"), k("bold")],
  chatty: [k("quiet"), k("chatty")],
  greedy: [k("greedy"), k("honest")],
  alert: [k("sleepy"), k("alert")],
};

/** How far a watcher may see (m), whatever its persona says: the perception envelope. */
export const PERCEPTION = { min: 4, max: 20 } as const;
/** The cheapest a bribe may get (or the price as written, if lower). */
const CHEAPEST = 5;

// how bold an option is: going for it, then covering ground, then holding back
const BOLDNESS: Partial<Record<Behaviour, number>> = { attack: 4, race: 4, intercept: 3, patrol: 2, follow: 1, defend: 0, idle: 0 };

/** Reply styles, quiet to chatty: the persona's own style keeps its words, with this after it. */
export const TALK = ["says nothing unless spoken to", "a person of few words", "", "chatty", "never stops talking"] as const;
/** How much more (or less) often it thinks aloud on its own, by level: quiet ones only answer. */
export const THINK_EVERY = [Infinity, 2, 1, 0.6, 0.35] as const;
const TALK_MARK = /;\s*(says nothing unless spoken to|a person of few words|chatty|never stops talking)$/;

/** How chatty a persona is, 0 (quiet) to 4: the level its reply style carries, 2 as written. */
export function chattiness(p: Pick<Persona, "replyStyle">): number {
  const m = TALK_MARK.exec(p.replyStyle);
  return m ? TALK.indexOf(m[1] as (typeof TALK)[number]) : 2;
}

/** A reply style at a chattiness level, its own words kept. */
export function withTalk(style: string, level: number): string {
  const base = style.replace(TALK_MARK, "").trim();
  const word = TALK[Math.max(0, Math.min(4, Math.round(level)))] ?? "";
  return word ? (base ? `${base}; ${word}` : `; ${word}`.slice(2)) : base;
}

/** What the world gives of a counted thing, as the proof's T0 counts it (Infinity: more can be earned). */
export function purseSupply(b: WorldBundle, word: string): number {
  let n = 0;
  for (const r of b.rules) {
    const got = r.then.filter((e) => e.e === "give" && e.target === "player" && String(e.v) === word).reduce((s, e) => s + (e.n || 1), 0);
    if (!got) continue;
    const once = r.once || (r.when.t === "touch" && b.verbs.some((v) => v.verb === "puzzle.collect" && v.on === r.when.b));
    if (!once) return Infinity;
    n += got;
  }
  return n;
}

/** A spoken rule's price: what the purse must hold (its condition), or the act's count. */
export function priceOf(r: Rule): { word: string; n: number } | null {
  if (r.when.t !== "spoken" || !["offer", "pay", "buy"].includes(r.when.act)) return null;
  const c = r.if.find((x) => /^player\.[a-z][a-z0-9_]*$/.test(x.l) && (x.op === "gte" || x.op === "gt") && Number.isFinite(Number(x.r)));
  const word = c ? c.l.slice(7) : r.when.b;
  const n = c ? Number(c.r) + (c.op === "gt" ? 1 : 0) : r.when.n;
  return word && n > 0 ? { word, n } : null;
}

/** Does this character watch for the player (a seen_by rule names it, or any guard when one names nobody)? */
const watches = (b: WorldBundle, c: Cast) => b.rules.some((r) => r.when.t === "seen_by" && (r.when.b === c.npc || (!r.when.b && c.role === "guard")));

/** The minded characters of a world and the sliders each one has (a slider only where its trait changes something). */
export function charactersOf(b: WorldBundle): Character[] {
  const out: Character[] = [];
  for (const c of [...b.cast].sort((x, y) => (x.npc < y.npc ? -1 : 1))) {
    const e = b.entities.find((x) => x.id === c.npc);
    const spoken = b.rules.some((r) => r.when.t === "spoken" && r.when.a === c.npc);
    if (!e || !(c.minded || c.menu.length > 1 || spoken)) continue;
    const sliders: Slider[] = [];
    // bold ↔ cautious: the options it can start on (never one only an act earns, nor looking away)
    const earned = new Set(acceptsOf(b, c.npc).map((a) => a.gives).filter(Boolean));
    const starts = c.menu.filter((o) => !earned.has(o) && behaviourOf(o) !== "look_away" && BOLDNESS[behaviourOf(o)] !== undefined);
    const ranked = [...starts].sort((x, y) => BOLDNESS[behaviourOf(x)]! - BOLDNESS[behaviourOf(y)]! || (x < y ? -1 : 1));
    if (new Set(ranked.map((o) => BOLDNESS[behaviourOf(o)])).size > 1 && ranked.includes(c.dflt)) {
      sliders.push({ npc: c.npc, trait: "bold", ends: ENDS.bold, min: 0, max: ranked.length - 1, step: 1, value: ranked.indexOf(c.dflt), gameplay: true, options: ranked });
    }
    // quiet ↔ chatty: anyone with a mind talks
    sliders.push({ npc: c.npc, trait: "chatty", ends: ENDS.chatty, min: 0, max: 4, step: 1, value: chattiness(c.persona), gameplay: false });
    // greedy ↔ honest: a bribe it takes, priced within what the world's coins can pay
    for (const r of [...b.rules].sort((x, y) => (x.id < y.id ? -1 : 1))) {
      if (r.when.a !== c.npc) continue;
      const p = priceOf(r);
      if (!p) continue;
      const most = Math.min(99, purseSupply(b, p.word));
      const least = Math.min(CHEAPEST, p.n);
      if (most > least && p.n <= most) sliders.push({ npc: c.npc, trait: "greedy", ends: ENDS.greedy, min: least, max: most, step: 1, value: p.n, gameplay: true, rule: r.id, word: p.word });
      break;
    }
    // sleepy ↔ alert: how far it sees, if it watches
    if (watches(b, c)) {
      const range = Math.min(40, Math.max(1, c.rangeM));
      sliders.push({ npc: c.npc, trait: "alert", ends: ENDS.alert, min: Math.min(PERCEPTION.min, range), max: Math.max(PERCEPTION.max, range), step: 1, value: range, gameplay: true });
    }
    out.push({ npc: c.npc, name: e.noun || c.npc.replace(/_/g, " "), role: c.role, sliders });
  }
  return out;
}

/** The fill line that writes an op with this id (its JSON), with where it is. */
function lineOf(fill: string, op: string, id: string): Record<string, unknown> | null {
  for (const line of fill.split("\n")) {
    for (const raw of splitObjects(line)) {
      try {
        const o = JSON.parse(raw) as Record<string, unknown>;
        if (o.op === op && o.id === id) return o;
      } catch {
        // not a line we can read
      }
    }
  }
  return null;
}

/** The fill with one line swapped for the patch's (the same op and id): a prose change needs no merge. */
export function replaceLine(fill: string, patch: string): string {
  const p = JSON.parse(patch) as { op?: unknown; id?: unknown };
  return fill
    .split("\n")
    .map((line) => {
      try {
        const o = JSON.parse(line) as { op?: unknown; id?: unknown };
        return o.op === p.op && o.id === p.id ? patch : line;
      } catch {
        return line;
      }
    })
    .join("\n");
}

export interface PersonaEdit {
  /** The patch: the changed line, whole (merged by its id like any edit). */
  patch: string;
  /** The change in words, as the edit box and the world's edit history show it. */
  change: string;
  /** What changed, with its numbers ("night guard sees 9 m → 6 m"). */
  summary: string[];
  gameplay: boolean;
}

const verbWord = (option: string) => option.slice(option.lastIndexOf(".") + 1).replace(/_/g, " ");

/** A slider moved to `to`: the patch on the fill that says it, or null when nothing would change. */
export function personaEdit(fill: string, b: WorldBundle, s: Slider, to: number, name: string): PersonaEdit | null {
  const v = Math.max(s.min, Math.min(s.max, Math.round(to)));
  if (v === s.value) return null;
  const end = (x: number) => (x > s.value ? s.ends[1] : s.ends[0]);
  if (s.trait === "greedy") {
    const r = lineOf(fill, "rule", s.rule ?? "");
    const was = s.value;
    if (!r) return null;
    const when = { ...(r.when as Record<string, unknown>) };
    if (Number(when.n) === was) when.n = v;
    const conds = ((r.if as Record<string, unknown>[] | undefined) ?? []).map((c) => (c.l === `player.${s.word}` && (c.op === "gte" || c.op === "gt") ? { ...c, r: c.op === "gt" ? v - 1 : v } : c));
    const then = ((r.then as Record<string, unknown>[] | undefined) ?? []).map((e) => (e.e === "take" && e.target === "player" && String(e.v) === s.word && Number(e.n) === was ? { ...e, n: v } : e));
    const patch = JSON.stringify({ ...r, when, if: conds, then });
    return { patch, change: `the ${name}: ${end(v)} (a bribe of ${v} ${s.word}, was ${was})`, summary: [`${name} takes ${was} → ${v} ${s.word}`], gameplay: true };
  }
  const n = lineOf(fill, "npc", s.npc);
  if (!n) return null;
  if (s.trait === "alert") {
    const was = s.value;
    return { patch: JSON.stringify({ ...n, rangeM: v }), change: `the ${name}: ${end(v)} (sees ${v} m, was ${was} m)`, summary: [`${name} sees ${was} m → ${v} m`], gameplay: true };
  }
  if (s.trait === "bold") {
    const from = s.options?.[s.value] ?? "";
    const opt = s.options?.[v] ?? "";
    if (!opt) return null;
    return { patch: JSON.stringify({ ...n, dflt: opt }), change: `the ${name}: ${end(v)} (starts on ${verbWord(opt)}, was ${verbWord(from)})`, summary: [`${name} starts on ${verbWord(from)} → ${verbWord(opt)}`], gameplay: true };
  }
  // chatty: prose, the persona's reply style
  const persona = { identity: "", personality: "", knowledge: "", replyStyle: "", tools: [], safety: "", ...((n.persona as Record<string, unknown> | undefined) ?? {}) };
  const style = withTalk(String(persona.replyStyle ?? ""), v);
  return { patch: JSON.stringify({ ...n, persona: { ...persona, replyStyle: style } }), change: `the ${name}: ${end(v)} (${TALK[v] || "as written"})`, summary: [`${name} talks ${TALK[s.value] || "as written"} → ${TALK[v] || "as written"}`], gameplay: false };
}

/** A slider's value in words, with its number: "sees 9 m", "takes 20 coins", "starts on patrol", "chatty". */
export function valueWords(s: Slider, v = s.value): { template: string; vars: Record<string, string | number> } {
  if (s.trait === "alert") return { template: k("sees {n} m"), vars: { n: v } };
  if (s.trait === "greedy") return { template: k("takes {n} {what}"), vars: { n: v, what: s.word ?? "" } };
  if (s.trait === "bold") return { template: k("starts on {what}"), vars: { what: verbWord(s.options?.[v] ?? "") } };
  return { template: [k("says nothing unless spoken to"), k("a person of few words"), k("talks as written"), k("chatty"), k("never stops talking")][v] ?? k("talks as written"), vars: {} };
}
