// The only producer of strings a receipt shows. Every number carries its method, and no
// percentage is printed for fewer than 30 trials (honest labels are a never-cut item). Each label
// is worded from English templates through `Words`: English by default (proof output, the CLI and
// the tests read exactly that), and the web client passes its own to show them in the player's
// language. Nothing here formats for a locale: the client does (no Intl on the simulation path).
import type { Parting } from "./redgreen";
import type { Element, FengShuiFinding, FengShuiFix, FengShuiSection } from "@ghostrun/layout";
import type { FailSpot, Revealed } from "./revealed";
import type { Chip, FailRun, Level, Model, Playtest, Receipt } from "./types";

export type WordVars = Readonly<Record<string, string | number>>;
/** How a label is worded: a template with {placeholders}, and a count with its singular and plural. */
export interface Words {
  (template: string, vars?: WordVars): string;
  n(count: number, one: string, other: string, vars?: WordVars): string;
}
const fillIn = (s: string, vars?: WordVars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);
/** The receipt's own words. */
export const english: Words = Object.assign((s: string, vars?: WordVars) => fillIn(s, vars), {
  n: (count: number, one: string, other: string, vars?: WordVars) => fillIn(count === 1 ? one : other, { ...vars, n: count }),
});

export function fraction(k: number, n: number, w: Words = english): string {
  if (n < 30) return w("{k} of {n}", { k, n });
  return w("{pct}% (n={n})", { pct: Math.round((k / n) * 100), n });
}

export const chipLine = (c: Chip): string => chipLineIn(c, english);

/** A chip in words with its method and where it was proved: "(physics, 12 AI runners, in the cloud)". */
export const chipLineAt = (c: Chip, host: Receipt["host"], w: Words = english, text?: (s: string) => string): string => chipLineIn(c, w, text, host);

/** A chip's line in other words: `text` words what the tiers wrote (its text, counterexample and method). */
export function chipLineIn(c: Chip, w: Words, text: (s: string) => string = (s) => s, where?: Receipt["host"]): string {
  const mark = { verified: "✓", played: "✓", modelled: "~", not_checkable: "–", counterexample: "✗" }[c.status];
  const count = c.n > 0 ? ` · ${fraction(c.k, c.n, w)}` : "";
  const cx = c.cx ? ` — ${text(c.cx.text)}` : "";
  const src = c.src === "ai" ? w(", AI-written rule") : c.src === "template" ? w(", template rule") : "";
  return `${mark} [${c.tier}] ${text(c.text)}${count}${cx}  (${text(c.method)}${src}${where ? `, ${whereWord(where, w)}` : ""})`;
}

/** Where a proof ran, as a receipt says it. */
export function whereWord(host: Receipt["host"], w: Words = english): string {
  return { device: w("on your device"), edge: w("in the cloud"), node: w("in Node") }[host];
}

/** One world proved in the cloud and on this device at once: where each proof stands. */
export interface CrossCheck {
  /** Where the receipt on show was proved. */
  shown: Receipt["host"];
  /** The cloud's proof: not asked (offline, or switched off), under way, failed, or in and compared. */
  cloud: "off" | "asked" | "failed" | "same" | "different";
  device: "proving" | "done" | "failed";
  /** Both receipts' hashes (timings left out: see receiptHash), once both are in. */
  hashes?: { device: string; cloud: string };
}

/** The receipt's trust line: where it was proved, and whether the other proof got the same. */
export function crossLine(c: CrossCheck, w: Words = english): string {
  if (c.cloud === "same") return w("proved in the cloud · same result on this device");
  if (c.cloud === "different") return w("the cloud and this device got different results (cloud {cloud}, device {device}): showing this device's", { cloud: c.hashes?.cloud.slice(0, 8) ?? "?", device: c.hashes?.device.slice(0, 8) ?? "?" });
  if (c.shown === "edge") return c.device === "failed" ? w("proved in the cloud · this device couldn't check it") : w("proved in the cloud · this device is checking it…");
  if (c.cloud === "asked") return w("proved on your device · the cloud is proving it too");
  return w("proved {where}", { where: whereWord(c.shown, w) });
}

/** The word for a status, exactly as the receipt means it (a played claim is not "verified"). */
export function statusWord(s: Chip["status"], w: Words = english): string {
  return { verified: w("verified"), played: w("played"), modelled: w("modelled"), not_checkable: w("not checkable yet"), counterexample: w("counterexample") }[s];
}

// ---- the playtest: the difficulty band and what the runners revealed ----------------------------

/** A share of the positions sampled (thousands of them, so a percentage is fair): "28%". */
export const share = (x: number) => `${Math.round(x * 100)}%`;

/** Seconds on a clock: 0:07, 1:42. */
export function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  const m = Math.floor(t / 60);
  return `${m}:${String(t - m * 60).padStart(2, "0")}`;
}

const levelWord = (l: Level, w: Words) => ({ novice: w("novices"), average: w("average"), expert: w("experts") })[l];
const bandWord = (b: Playtest["band"], w: Words) => ({ "Very easy": w("Very easy"), Easy: w("Easy"), Normal: w("Normal"), Hard: w("Hard"), "Expert only": w("Expert only"), Unbeaten: w("Unbeaten") })[b];

/** "Normal: novices 2 of 6 · average 5 of 6 · experts 12 of 12" (a too-easy win says so). */
export function bandSaid(p: Playtest, r?: Receipt, w: Words = english): string {
  const easy = r?.chips.find((c) => c.id === "T3:too_easy");
  const why = p.band === "Unbeaten" ? w(" (no expert runner won, so the lower levels weren't sent)") : easy ? ` (${easy.text})` : "";
  return `${bandWord(p.band, w)}${why}: ${p.levels.map((l) => `${levelWord(l.level, w)} ${fraction(l.won, l.runs, w)}`).join(" · ")}`;
}

/** How the band was found. */
export function bandMethod(p: Playtest, w: Words = english): string {
  return w("physics, {runs} AI runners at {levels}", { runs: p.levels.reduce((a, l) => a + l.runs, 0), levels: w.n(p.levels.length, "{n} skill level", "{n} skill levels") });
}

export const bandLine = (p: Playtest, r?: Receipt, w: Words = english) => `${bandSaid(p, r, w)}  (${bandMethod(p, w)})`;

/** "Clear times: median 0:31, 0:22 to 0:58 (19 winning runs) · experts 0:24 · average 0:33". */
export function timesLine(t: NonNullable<Revealed["times"]>, w: Words = english): string {
  const range = clock(t.lo) !== clock(t.hi) ? w(", {lo} to {hi}", { lo: clock(t.lo), hi: clock(t.hi) }) : "";
  const by = t.by.length > 1 ? ` · ${t.by.map((x) => `${levelWord(x.level, w)} ${clock(x.median)}`).join(" · ")}` : "";
  return `${w("Clear times: median {t}", { t: clock(t.median) })}${range} (${w.n(t.n, "{n} winning run", "{n} winning runs")})${by}`;
}

/** "orb at 0:12 · goal ring at 0:31 (19 of 24 runs) · won at 0:45 (19 of 24)": median first times. */
export function paceLine(pace: Revealed["pace"], runs: number, w: Words = english): string {
  return pace.map((p) => `${w("{step} at {t}", { step: p.step === "won" ? w("won") : p.step, t: clock(p.s) })}${p.k < runs ? ` (${fraction(p.k, runs, w)})` : ""}`).join(" · ");
}

const nearWords = (near: string, w: Words) => (near ? w("near the {thing}", { thing: near }) : w("in the open"));

/** "near the lava pit: hit the lava ×4 (4 of 24 runs)". */
export function failLine(f: FailSpot, runs: number, w: Words = english): string {
  return `${nearWords(f.near, w)}: ${f.why.map(([why, n]) => `${why} ×${n}`).join(", ")} (${w("{k} runs", { k: fraction(f.runs, runs, w) })})`;
}

/** "near the gate: 22 hits, 4 knock-outs". */
export const fightLine = (f: { hits: number; kos: number; near?: string }): string => fightLineIn(f, english);
export function fightLineIn(f: { hits: number; kos: number; near?: string }, w: Words): string {
  const what = [f.hits ? w.n(f.hits, "{n} hit", "{n} hits") : "", f.kos ? w.n(f.kos, "{n} knock-out", "{n} knock-outs") : ""].filter(Boolean).join(", ");
  return f.near === undefined ? what : `${nearWords(f.near, w)}: ${what}`;
}

// ---- T4, the route model: every number modelled, with its ± ------------------------------------

/** A modelled share with its calibration error: "41% ±20" (modelled runs are many; the ± is what to trust). */
const modelPct = (p: number, err: number) => `${Math.round(p * 100)}% ±${Math.round(err * 100)}`;

/** How T4's numbers were made. */
export function modelMethod(m: Model, w: Words = english): string {
  return w("route model, {n} modelled runs, anchored on this world's expert runs; ± is the calibration error on the bench", { n: m.runs });
}

/**
 * The route model's lines, each marked modelled (never played): win rates by level beside this
 * world's physics runs, clear times, where the time goes, and red against blue on a team map.
 */
export function modelLines(m: Model, w: Words = english): string[] {
  const out: string[] = [];
  out.push(`${w("Win rate, modelled:")} ${m.levels.map((l) => `${levelWord(l.level, w)} ${modelPct(l.p, l.err)} (${w("physics {k}", { k: fraction(l.physics.won, l.physics.runs, w) })})`).join(" · ")}`);
  if (m.times) {
    const range = clock(m.times.lo) !== clock(m.times.hi) ? w(", {lo} to {hi}", { lo: clock(m.times.lo), hi: clock(m.times.hi) }) : "";
    out.push(`${w("Clear times, modelled: median {t} ±{e}%", { t: clock(m.times.median), e: Math.round(m.times.err * 100) })}${range} (${w("physics median {t}", { t: clock(m.times.physics) })})`);
  }
  if (m.heat.length) out.push(`${w("Most time, modelled:")} ${m.heat.map((h) => w("near the {thing} ({pct})", { thing: h.near, pct: modelPct(h.share, m.heatErr) })).join(", ")}`);
  if (m.teams) out.push(w("Red vs blue from the spawns, modelled: red wins {pct} of {n} modelled matches", { pct: modelPct(m.teams.red, m.teams.err), n: m.teams.matches }));
  return out;
}

/** T4 for the CLI and the tests: each line marked "~ [T4]", the method after. */
export const modelBlock = (m: Model, w: Words = english): string[] => [...modelLines(m, w).map((l) => `~ [T4] ${l}`), `  (${modelMethod(m, w)})`];

// ---- Feng Shui: one named school's principles, checked on the placed world ----------------------

const anchorWords = (a: string, w: Words) =>
  ({
    corner_ne: w("north-east corner"), corner_nw: w("north-west corner"), corner_se: w("south-east corner"), corner_sw: w("south-west corner"),
    wall_n: w("north wall"), wall_s: w("south wall"), wall_e: w("east wall"), wall_w: w("west wall"), center: w("middle"),
  })[a] ?? a.replace(/_/g, " ");
const elementWord = (el: Element, w: Words) => ({ wood: w("wood"), fire: w("fire"), earth: w("earth"), metal: w("metal"), water: w("water") })[el];
const elementExample = (el: Element, w: Words) =>
  ({ wood: w("wood (a bamboo plant)"), fire: w("fire (a red paper lantern)"), earth: w("earth (a stone bench)"), metal: w("metal (a brass bowl)"), water: w("water (a small fountain)") })[el];
const countsSaid = (c: Record<Element, number> | undefined, w: Words) => (c ? (Object.keys(c) as Element[]).map((el) => `${elementWord(el, w)} ${c[el]}`).join(" · ") : "");

/** "Feng Shui (Form School): 4 of 5 principles hold · 1 not checkable" (k of n, never a percentage). */
export function fengShuiHead(s: FengShuiSection, w: Words = english): string {
  const nc = s.findings.length - s.checked;
  const school = w(s.school);
  if (!s.checked) return w("Feng Shui ({school}): not checkable here", { school });
  return `${w("Feng Shui ({school}): {k} of {n} principles hold", { school, k: s.holds, n: s.checked })}${nc ? ` · ${w("{n} not checkable", { n: nc })}` : ""}`;
}

/** Why a principle holds, fails or can't be checked, in the world's own nouns and room names. */
export function fengShuiWhy(f: FengShuiFinding, w: Words = english): string {
  const { thing = "", room = "", by = "", m = 0, share = 0, rooms = 0, have = 0, more = 0 } = f.vars;
  const pct = Math.round(share * 100);
  const andMore = more ? w(" (and {n} more)", { n: more }) : "";
  const v = { thing, room, by };
  switch (f.why) {
    case "command_ok": return `${w("the {thing} sits across {room} from its door, its back to a wall and the door in view", v)}${andMore}${f.vars.facing ? "" : w("; which way it faces isn't recorded")}`;
    case "command_in_line": return w("the {thing} stands in line with the door of {room}", v);
    case "command_near": return w("the {thing} is on the door's side of {room}, not across from it", v);
    case "command_no_wall": return w("the {thing} in {room} has no solid wall behind it", v);
    case "command_hidden": return w("the {by} hides the door of {room} from the {thing}", v);
    case "command_away": return w("the {thing} faces away from the door of {room}", v);
    case "command_none": return w("there is no bed, desk, counter or sofa here to place");
    case "not_interior": return w("not an interior: no rooms with doorways to check");
    case "no_front_door": return w("no front door to the outside found");
    case "straight_wall": return w("the view in from the front door ends at a solid wall ({room})", v);
    case "straight_blocked": return w("the {thing} breaks the line in from the front door", v);
    case "straight_window": return room ? w("from the front door you look straight through to the {thing} in {room}", v) : w("from the front door you look straight through to the {thing}", v);
    case "straight_out": return room ? w("from the front door you look straight out of the building, through {room}", v) : w("from the front door you look straight out of the building");
    case "mirror_none": return w("there is no mirror");
    case "mirror_aside": return `${w("the {thing} hangs out of the front door's line", v)}${andMore}`;
    case "mirror_faces": return room ? w("the {thing} in {room} faces the front door", v) : w("the {thing} faces the front door", v);
    case "mirror_unknown": return w("the {thing} stands in view of the front door, and which way it faces isn't recorded", v);
    case "entry_clear": return w("nothing stands in the way in from the front door to {room}", v);
    case "entry_blocked": return m < 0 ? w("the {thing} stands in the way in, {m} m outside the front door", { ...v, m: Math.abs(m) }) : w("the {thing} stands in the way in, {m} m inside the front door", { ...v, m });
    case "clutter_ok": {
      const all = rooms === 1 ? w("the room has a clear way from the door to the middle") : w("all {n} rooms have a clear way from the door to the middle", { n: rooms });
      return `${all}; ${pct < 1 ? w("solid things cover under 1% of a floor") : w("solid things cover at most {pct}% of a floor", { pct })}`;
    }
    case "clutter_path": return w("the {thing} blocks the way from the door of {room} to its middle", v);
    case "clutter_full": return w("solid things cover {pct}% of the floor of {room} (at most a third)", { room, pct });
    case "elements_ok": return w("{have} of 5 elements present: {counts}", { have, counts: countsSaid(f.vars.counts, w) });
    case "elements_few": return w("{have} of 5 elements present ({counts}): no {missing}", { have, counts: countsSaid(f.vars.counts, w), missing: (f.vars.missing ?? []).map((el) => elementWord(el, w)).join(w(" or ")) });
    case "elements_unnamed": return w("too few things are named with a material or colour to tell");
    default: return f.why.replace(/_/g, " ");
  }
}

/** The fix for a failed principle, as the receipt offers it (the edit path takes `fix.change`). */
export function fengShuiFix(x: FengShuiFix, w: Words = english): string {
  const { thing = "", room = "", to = "" } = x.vars;
  const v = { thing, room, to: to ? anchorWords(to, w) : "" };
  switch (x.key) {
    case "move_command": return to ? w("move the {thing} to the {to} of {room}, its back to the wall", v) : w("move the {thing} across {room} from its door, its back to a wall", v);
    case "cover_window": return w("hang a curtain over the {thing}, or stand a tall plant between it and the front door", v);
    case "screen_out": return room ? w("stand a screen or a tall plant in line with the front door in {room}", v) : w("stand a screen or a tall plant in line with the front door");
    case "move_mirror": return to ? (room ? w("move the {thing} to the {to} of {room}", v) : w("move the {thing} to the {to}", v)) : w("move the {thing} to a side wall", v);
    case "clear_entry": return w("move the {thing} out of the way in", v);
    case "clear_path": return w("move the {thing} off the way from the door of {room} to its middle", v);
    case "fewer_things": return w("take a few solid things out of {room}", v);
    case "add_elements": return w("add {what}", { what: (x.vars.missing ?? []).map((el) => elementExample(el, w)).join(", ") });
    default: return x.change;
  }
}

/** One finding as a receipt line: "✗ Command position: the oak desk stands in line with the door of the study — fix: …". */
export function fengShuiLine(f: FengShuiFinding, name: string, w: Words = english): string {
  const mark = { holds: "✓", fails: "✗", not_checkable: "–" }[f.verdict];
  return `${mark} ${w(name)}: ${fengShuiWhy(f, w)}${f.fix ? ` — ${w("fix: {fix}", { fix: fengShuiFix(f.fix, w) })}` : ""}`;
}

// ---- red/green: the same runner before and after a change -------------------------------------

/** What a red/green pair is, plainly: "Green: before the change · red: after it · the same runner, the same seed". */
export function pairLine(green: "before" | "after", w: Words = english): string {
  return green === "before" ? w("Green: before the change · red: after it · the same AI runner, the same seed") : w("Red: before the repair · green: after it · the same AI runner, the same seed");
}

/** The failing run a receipt kept, on its own: "Red: AI runner 3 of 12, where it fails (got stuck on the way to the orb, at 1:02)". */
export function failRunLine(f: FailRun, runs: number, w: Words = english): string {
  return w("Red: AI runner {k} of {n}, where it fails ({why}, at {t})", { k: f.run + 1, n: runs, why: f.end.why || w("it stopped"), t: clock(f.ghost.ticks / 60) });
}

/**
 * Where they part, from the runs themselves: "They part here: the second jump (green rises 2.9 m,
 * red 1.4 m)", "They part here: the red run ends (got stuck on the way to the glowing orb)",
 * "They part here: their ways split, near the Neon plaza". `red` is which of the parting's two runs is red.
 */
export function partLine(p: Parting, red: 0 | 1, near = "", why = "", w: Words = english): string {
  const where = near ? w(", near the {thing}", { thing: near }) : "";
  const m = (x: number) => `${Math.max(0, Math.round(x * 10) / 10)} m`;
  if (p.how === "jump") {
    const rise = { where, green: m(p.rise[1 - red]!), red: m(p.rise[red]!) };
    return p.midair ? w("They part here: the second jump{where} (green rises {green}, red {red})", rise) : w("They part here: the jump{where} (green rises {green}, red {red})", rise);
  }
  if (p.how === "end" && p.ended !== null) {
    const which = p.ended === red ? w("They part here: the red run ends") : w("They part here: the green run ends");
    return `${which}${why ? ` (${why})` : ""}${where}`;
  }
  return w("They part here: their ways split{where}", { where });
}
