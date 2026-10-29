// Edits: the person's own change to the world they're playing ("only one jump", "add three more
// coins", "make it night"). The model answers with a patch; the world swaps in place and is
// re-proved, and the change comes back with its numbers: what changed in the world, and how the
// receipt moved (headline, AI runners, par, counterexamples, force-tested rules).
import type { Entity, WorldBundle } from "@ghostrun/ir";
import { badness, BANDS, fraction, insights, statusWord, type Chip, type Receipt } from "@ghostrun/proof/light";
import type { LiveIntent } from "./live";
import type { World } from "./pipeline";

/** What /v1/edit needs to know about the world: the live intent, or one read off a recorded world. */
export function intentFor(world: World, prompt: string): LiveIntent & { nouns: { noun: string; hyper: string }[]; moodVec: { valence: number; arousal: number; tension: number } } {
  const src = world.source?.intent as (LiveIntent & { nouns?: unknown; moodVec?: unknown }) | undefined;
  if (src && Array.isArray(src.nouns) && src.moodVec) return src as ReturnType<typeof intentFor>;
  const i = world.intent;
  return {
    lang: "en",
    mode: i.mode,
    genre: i.live?.genre ?? "",
    setting: i.live?.setting ?? prompt.slice(0, 200),
    role: i.live?.role ?? "",
    goal: i.live?.goal ?? "",
    fail: i.live?.fail ?? "",
    mood: "",
    pack: i.pack,
    sub: i.sub,
    safety: "ok",
    headline: i.headline,
    nouns: [],
    moodVec: { valence: 0, arousal: 0, tension: 0 },
  };
}

const noun = (e: Pick<Entity, "noun" | "kind">) => e.noun || e.kind;
const counted = (names: string[], sign: string) => {
  const by = new Map<string, number>();
  for (const n of names) by.set(n, (by.get(n) ?? 0) + 1);
  return [...by].map(([n, k]) => `${sign}${k} ${n}${k > 1 && !n.endsWith("s") ? "s" : ""}`);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const num = (x: number) => String(Math.round(x * 100) / 100);
const night = (h: number) => h >= 19 || h < 6;

/** What the edit changed in the world, in a few short phrases (most telling first). */
export function changeSummary(a: WorldBundle, b: WorldBundle): string[] {
  const out: string[] = [];
  const la = a.laws;
  const lb = b.laws;
  if (la.jumpsMax !== lb.jumpsMax) out.push(`jumps ${la.jumpsMax} → ${lb.jumpsMax}`);
  if (la.jumpH !== lb.jumpH) out.push(`jump height ${num(la.jumpH)} → ${num(lb.jumpH)} m`);
  if (la.speed !== lb.speed) out.push(`speed ${num(la.speed)} → ${num(lb.speed)} m/s`);
  if (la.gravityScale !== lb.gravityScale) out.push(`gravity ×${num(la.gravityScale)} → ×${num(lb.gravityScale)}`);
  const ea = new Map(a.entities.map((e) => [e.id, e]));
  const eb = new Map(b.entities.map((e) => [e.id, e]));
  out.push(...counted(b.entities.filter((e) => !ea.has(e.id)).map(noun), "+"));
  out.push(...counted(a.entities.filter((e) => !eb.has(e.id)).map(noun), "−"));
  const moved = b.entities.filter((e) => {
    const o = ea.get(e.id);
    return o && !same([o.kind, o.noun, o.zone, o.team, o.states, o.init, o.body, o.size], [e.kind, e.noun, e.zone, e.team, e.states, e.init, e.body, e.size]);
  }).length;
  if (moved) out.push(`${moved} thing${moved > 1 ? "s" : ""} changed`);
  const ra = new Map(a.rules.map((r) => [r.id, r]));
  const rb = new Map(b.rules.map((r) => [r.id, r]));
  const rNew = b.rules.filter((r) => !ra.has(r.id)).length;
  const rGone = a.rules.filter((r) => !rb.has(r.id)).length;
  const rChanged = b.rules.filter((r) => ra.has(r.id) && !same(ra.get(r.id), r)).length;
  if (rNew) out.push(`+${rNew} rule${rNew > 1 ? "s" : ""}`);
  if (rGone) out.push(`−${rGone} rule${rGone > 1 ? "s" : ""}`);
  if (rChanged) out.push(`${rChanged} rule${rChanged > 1 ? "s" : ""} rewired`);
  const vNew = b.verbs.filter((v) => !a.verbs.some((x) => x.id === v.id)).length;
  const vChanged = b.verbs.filter((v) => a.verbs.some((x) => x.id === v.id && !same(x, v))).length;
  if (vNew && !out.some((x) => x.startsWith("+"))) out.push(`+${vNew} verb${vNew > 1 ? "s" : ""}`);
  if (vChanged) out.push(`${vChanged} verb${vChanged > 1 ? "s" : ""} retuned`);
  const ca = new Map(a.cast.map((c) => [c.npc, c]));
  const cChanged = b.cast.filter((c) => ca.has(c.npc) && !same(ca.get(c.npc), c)).length;
  if (cChanged) out.push(`${cChanged} NPC${cChanged > 1 ? "s" : ""} rethought`);
  const ka = a.cosmetic;
  const kb = b.cosmetic;
  if (night(ka.timeOfDay) !== night(kb.timeOfDay)) out.push(night(kb.timeOfDay) ? "now night" : "now day");
  if (ka.weather !== kb.weather) out.push(kb.weather === "clear" ? "skies clear" : `now ${kb.weather}`);
  if (ka.look !== kb.look) out.push(`look: ${kb.look}`);
  return out;
}

export interface Delta {
  label: string;
  from: string;
  to: string;
  /** -1 the change made it worse, 1 better, 0 neither (a longer par is harder, not worse). */
  sign: -1 | 0 | 1;
}

const RANK: Record<Chip["status"], number> = { counterexample: 0, not_checkable: 1, modelled: 2, played: 3, verified: 4 };
const cmp = (a: number, b: number): -1 | 0 | 1 => (b > a ? 1 : b < a ? -1 : 0);

/** How the receipt moved: only the numbers that changed (all of them labelled as the receipt does). */
export function receiptDelta(a: Receipt, b: Receipt): Delta[] {
  const out: Delta[] = [];
  if (a.headline || b.headline) {
    const from = a.headline ? statusWord(a.headline.status) : "none";
    const to = b.headline ? statusWord(b.headline.status) : "none";
    if (from !== to) out.push({ label: "Headline", from, to, sign: cmp(a.headline ? RANK[a.headline.status] : -1, b.headline ? RANK[b.headline.status] : -1) });
  }
  const wa = a.chips.find((c) => c.id === "T3:win");
  const wb = b.chips.find((c) => c.id === "T3:win");
  if (wa && wb && (wa.k !== wb.k || wa.n !== wb.n)) out.push({ label: "AI runners won", from: fraction(wa.k, wa.n), to: fraction(wb.k, wb.n), sign: cmp(wa.k / Math.max(1, wa.n), wb.k / Math.max(1, wb.n)) });
  if (a.par && b.par && a.par.goldS !== b.par.goldS) out.push({ label: "AI par", from: `${a.par.goldS} s`, to: `${b.par.goldS} s`, sign: 0 });
  else if (a.par && !b.par) out.push({ label: "AI par", from: `${a.par.goldS} s`, to: "no runner won", sign: -1 });
  else if (!a.par && b.par) out.push({ label: "AI par", from: "no runner won", to: `${b.par.goldS} s`, sign: 1 });
  const cx = (r: Receipt) => r.chips.filter((c) => c.status === "counterexample").length;
  if (cx(a) !== cx(b)) out.push({ label: "Counterexamples", from: String(cx(a)), to: String(cx(b)), sign: cmp(cx(b), cx(a)) });
  const forced = (r: Receipt) => {
    const t2 = r.chips.filter((c) => c.tier === "T2" && c.subject.kind === "rule");
    return { k: t2.filter((c) => c.status === "verified").length, n: t2.length };
  };
  const fa = forced(a);
  const fb = forced(b);
  if (fa.k !== fb.k || fa.n !== fb.n) out.push({ label: "Rules force-tested", from: fraction(fa.k, fa.n), to: fraction(fb.k, fb.n), sign: cmp(fa.k / Math.max(1, fa.n), fb.k / Math.max(1, fb.n)) });
  return out;
}

/** Counterexamples the edit introduced, each with the proof's reason (at most three). */
export function newFailures(a: Receipt, b: Receipt): string[] {
  const was = new Set(a.chips.filter((c) => c.status === "counterexample").map((c) => c.id));
  return b.chips
    .filter((c) => c.status === "counterexample" && !was.has(c.id))
    .slice(0, 3)
    .map((c) => `${c.text.split(":")[0]}${c.cx ? ` — ${c.cx.text}` : ""}`);
}

/**
 * Does a Director's cut still play at least as well? No worse a receipt than before, and a world
 * the AI runners won is still won by most of them. Only then is it offered; it never applies itself.
 */
export function cutHolds(before: Receipt, after: Receipt): boolean {
  if (badness(after) > badness(before)) return false;
  const a = before.chips.find((c) => c.id === "T3:win");
  const b = after.chips.find((c) => c.id === "T3:win");
  return !a || (b !== undefined && b.k >= Math.min(a.k, 10));
}

/** What the playtest found, for the Director: the headline, how the runners did, what nobody went near. */
export function cutNotes(b: WorldBundle, r: Receipt): string[] {
  const win = r.chips.find((c) => c.id === "T3:win");
  const seen = r.trails?.length ? insights(b, r.trails) : null;
  const tour = r.chips.find((c) => c.id === "T3:tour");
  return [
    r.headline ? `headline "${r.headline.text}": ${r.headline.status}` : "",
    win ? `AI runners won ${win.k} of ${win.n}${r.par ? `, par ${r.par.goldS} s` : ""}` : "",
    tour ? `tour: ${tour.text}` : "",
    seen?.unused.length ? `nobody went near: ${seen.unused.map((u) => u.noun).slice(0, 5).join(", ")}` : "",
  ].filter(Boolean);
}

/** The prompt a repair of an edited world should keep in mind: the original, then each change. */
export const editedPrompt = (prompt: string, edits: readonly string[]) => [prompt, ...edits.map((e) => `Then: ${e}`)].join("\n");

/** Three changes worth trying on this world: one that should break its headline, two that shouldn't. */
export function suggestionsFor(b: WorldBundle): string[] {
  const out: string[] = [];
  const head = b.expects.find((x) => x.headline);
  if (head?.prop === "requires" && head.need.some((n) => n.startsWith("jumps"))) out.push("super high jumps");
  else if (b.laws.jumpsMax < 2) out.push("add a double jump");
  else out.push("only one jump");
  const coins = b.entities.filter((e) => e.kind === "pickup" && /coin|gem|crystal|star|orb/.test(e.noun)).length;
  if (b.mode === "play" && b.verbs.some((v) => v.verb === "puzzle.collect")) out.push("add three more coins");
  else if (b.mode === "play" && coins === 0) out.push("add a key that opens a shortcut");
  out.push(b.cosmetic.timeOfDay >= 19 || b.cosmetic.timeOfDay < 6 ? "make it daytime" : "make it night");
  if (b.mode === "play" && out.length < 3) out.push("make it harder but fair");
  return out.slice(0, 3);
}

/** "Surprise me" asks for the Director's cut (Claude Sonnet's version of the world, re-proved first). */
export const SURPRISE = /^\s*surprise me\b/i;

/** "Make it harder" is raced: one candidate per angle, each proved, the hardest fair one kept. */
export const HARDER = /\b(harder|tougher|more (difficult|challenging)|challenge me|too easy)\b/i;
export const ANGLES = [
  "add obstacles on the way to the objective (hazards to dodge or moving platforms)",
  "add pressure (more or faster rivals or guards, or less time)",
  "lengthen the route (lock the objective behind one more step: a key, a switch or a plate)",
] as const;
const LETTERS = "ABCDEFGH";

/**
 * The race's judge: a candidate is fair if at least half the AI runners still win, its headline is
 * no worse and it fails no check the world passed before (the envelope included: whatever the
 * cast's minds choose); it is harder if the AI par grows by at least 10% (or fewer runners win).
 * When the playtest has banded the world and the candidates, one fair candidate a band harder
 * (Normal → Hard) with the experts still winning at least 10 of 12 is what "harder but fair" means
 * first; otherwise the hardest fair candidate wins. Each gets a one-line verdict with its numbers.
 */
export function pickHarder(before: Receipt, cands: (Receipt | null)[]): { best: number | null; verdicts: string[] } {
  const rate = (r: Receipt) => {
    const w = r.chips.find((c) => c.id === "T3:win");
    return w && w.n ? w.k / w.n : 0;
  };
  const won = (r: Receipt) => {
    const w = r.chips.find((c) => c.id === "T3:win");
    return w ? fraction(w.k, w.n) : "no runs";
  };
  const head = (r: Receipt) => (r.headline ? RANK[r.headline.status] : 5);
  const par0 = before.par?.goldS ?? 0;
  const failed = new Set(before.chips.filter((c) => c.status === "counterexample").map((c) => c.id));
  const broke = (r: Receipt) => r.chips.filter((c) => c.status === "counterexample" && !failed.has(c.id) && c.id !== "T3:win").map((c) => c.id);
  let best: number | null = null;
  let bestScore = 0;
  // a band one step harder (the playtest's novices and average players), experts still ≥ 10 of 12
  const step = (r: Receipt) => (r.playtest ? BANDS.indexOf(r.playtest.band) : -1);
  const oneUp = (r: Receipt) => step(before) >= 0 && step(r) === step(before) + 1 && rate(r) * 12 >= 10;
  let banded: number | null = null;
  let bandedScore = 0;
  const verdicts = cands.map((r, i) => {
    const tag = `${LETTERS[i]}:`;
    if (!r) return `${tag} the model's patch didn't arrive`;
    const fair = rate(r) >= 0.5 && head(r) >= head(before) && !broke(r).length;
    const par = r.par?.goldS ?? 0;
    const harder = par >= par0 * 1.1 || (rate(r) < rate(before) && rate(r) >= 0.5) || (fair && oneUp(r));
    const band = before.playtest && r.playtest ? `, ${before.playtest.band} → ${r.playtest.band}` : "";
    const nums = `par ${par0} → ${par || "–"} s, ${won(r)} runners won${band}`;
    if (!fair) return `${tag} too hard or broken (${nums}${head(r) < head(before) && r.headline ? `, headline ${statusWord(r.headline.status)}` : broke(r).length ? `, fails ${broke(r).join(", ")}` : ""})`;
    if (!harder) return `${tag} not harder (${nums})`;
    const score = par / Math.max(1, par0) + (rate(before) - rate(r));
    if (score > bestScore) ((best = i), (bestScore = score));
    if (oneUp(r) && score > bandedScore) ((banded = i), (bandedScore = score));
    return `${tag} harder and fair (${nums})`;
  });
  return { best: banded ?? best, verdicts };
}
