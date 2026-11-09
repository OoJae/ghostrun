// The Intent card corrects with one click, three ways. How it looks (the look, the time of day, the
// weather) is cosmetic: a new meta line, the scene redrawn round the running game, the same spec and
// the same receipt. How it plays (jumps, gravity, speed) is a law edit, re-proved like a typed one,
// with its numbers and Undo; the map's size, a floor, a sub-zone is a structural edit (structure.ts).
// What it is (the pack, play or wander, the genre) needs a new fill: a rebuild with those pinned.
import type { Laws, WorldBundle } from "@ghostrun/ir";
import { PACKS } from "@ghostrun/registry";
import type { CardControls } from "./hud/IntentCard";
import type { World } from "./pipeline";
import { LOOK_CHOICES, norm, pickLook, ROOM_PACKS, type LookPin, type Pick as LookPick } from "./render/pick";
import { k, locale, t } from "./i18n";
import { layoutOptions, layoutPatch } from "./structure";

/** What the card can pin on a rebuild (the edge checks it against the intent schema: llm/pin.ts). */
export interface ShapePin {
  pack?: string;
  mode?: "play" | "wander";
  genre?: string;
}

export const PHASE_HOUR: Record<LookPick["phase"], number> = { day: 12, dusk: 18, night: 22 };
export const WEATHERS = ["clear", "rain", "snow", "fog", "storm"] as const satisfies readonly WorldBundle["cosmetic"]["weather"][];

/** The looks this pack can wear (a home's furniture needs rooms). */
export const looksFor = (pack: string) => LOOK_CHOICES.filter((c) => !c.rooms || ROOM_PACKS.has(pack));
/** A look's name on the card ("snow/cave" → "Ice cave"). */
export const lookName = (id: string, variant: string) => LOOK_CHOICES.find((c) => c.value === (variant ? `${id}/${variant}` : id))?.label ?? LOOK_CHOICES.find((c) => c.value === id)?.label ?? id;
/** A weather as a change is said: "make it rain", "make it foggy". */
export const WEATHER_WORD: Readonly<Record<string, string>> = { rain: "rain", snow: "snow", fog: "foggy", storm: "stormy" };
/** The weather a pick shows ("storm" over "rain"). */
export const weatherOf = (p: LookPick): (typeof WEATHERS)[number] => (p.storm ? "storm" : p.snow ? "snow" : p.rain ? "rain" : p.fog ? "fog" : "clear");

/**
 * A fill with the card's cosmetic choice in its meta line: the pin the look picker obeys, and the
 * hour or weather the cosmetic layer carries. Nothing the proof reads changes, so the spec hash can't.
 */
export function restyled(fill: string, change: LookPin): string {
  const lines = fill.split("\n");
  try {
    const m = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    if (m.op !== "meta") return fill;
    const pin = { ...(m.pin && typeof m.pin === "object" ? m.pin : {}), ...change };
    lines[0] = JSON.stringify({ ...m, pin, ...(change.phase ? { timeOfDay: PHASE_HOUR[change.phase] } : {}), ...(change.weather ? { weather: change.weather } : {}) });
    return lines.join("\n");
  } catch {
    return fill;
  }
}

/** The card's moves: jumps, gravity and speed, as words and their law values. */
export const JUMPS = [1, 2, 3] as const;
export const GRAVITY = [
  { label: "normal", scale: 1 },
  { label: "moon", scale: 0.17 },
] as const;
export const SPEED = [
  { label: "slow", speed: 4 },
  { label: "normal", speed: 6 },
  { label: "fast", speed: 9 },
] as const;
export const gravityName = (g: number) => (g < 0.05 ? "zero-g" : g < 0.5 ? "moon" : "normal");
export const speedName = (s: number) => (s <= 4.5 ? "slow" : s >= 8 ? "fast" : "normal");

/**
 * A law edit as the edit model would write it: the whole law line (a law line replaces the one the
 * world had), from the laws the world plays by now, with the card's change on top.
 */
export function lawPatch(laws: Laws, change: Partial<Pick<Laws, "jumpsMax" | "gravityScale" | "speed">>): string {
  const { gravityScale, jumpH, speed, jumpsMax, airControl, coyoteMs, bufferMs, thrust } = { ...laws, ...change };
  return JSON.stringify({ op: "law", player: { gravityScale, jumpH, speed, jumpsMax, airControl, coyoteMs, bufferMs, thrust } });
}

/** How a rebuild reads on the world it made: "rebuilt as a maze at your request". */
export function rebuiltLine(pin: ShapePin): string {
  // (in the HUD's language; a genre keeps its English article only in English)
  const genre = (g: string) => (locale() === "en" ? article(g) : t(g));
  const parts = [pin.pack ? t("as {what}", { what: t(PACK_NAME[pin.pack] ?? pin.pack) }) : "", pin.mode ? (pin.mode === "wander" ? t("as a place to explore") : t("as a game")) : "", pin.genre ? t("as {what}", { what: genre(pin.genre) }) : ""].filter(Boolean);
  return t("rebuilt {how} at your request", { how: parts.join(", ") || t("as you asked") });
}

const article = (w: string) => `${/^[aeiou]/i.test(w) ? "an" : "a"} ${w}`;
/** Each pack as a person would say it. */
export const PACK_NAME: Record<string, string> = { city_block: k("a city block"), floor_plan: k("rooms"), arena: k("an arena"), maze: k("a maze"), outdoor: k("the outdoors"), course: k("an obstacle course"), service_venue: k("a café or shop"), puzzle_rooms: k("puzzle rooms"), stage: k("a stage"), orrery: k("the solar system") };
export const PACK_IDS = PACKS.map((p) => p.id);

/** One "did you mean" the card can offer: the words that suggest it, its question, its button, what it pins. */
interface Alt {
  words: RegExp;
  ask: string;
  label: string;
  pin: ShapePin;
  /** Already so: the world is this. */
  is: (i: { pack: string; mode: string; genre: string }) => boolean;
}

// Matched on the prompt, lowercased with accents stripped. A world built on another pack than these
// words name, or as a place when they name a game (or a game when they name a place), was a close call.
const ALTS: readonly Alt[] = [
  { words: /\brac(e|es|ing)\b|grand prix|\bkarts?\b|go-?kart|\brally\b|\blaps?\b|zavod|carrera|course de/, ask: k("Did you mean a race?"), label: k("Make it a race"), pin: { genre: "race" }, is: (i) => /rac/.test(i.genre) },
  { words: /\bmaze|labyrinth|bludist|laberint|labirynt|irrgarten/, ask: k("Did you mean a maze?"), label: k("Make it a maze"), pin: { pack: "maze" }, is: (i) => i.pack === "maze" },
  { words: /parkour|obstacle|\bobby\b|platformer|time trial|\bjump(ing)? course/, ask: k("Did you mean an obstacle course?"), label: k("Make it a course"), pin: { pack: "course" }, is: (i) => i.pack === "course" },
  { words: /museum|galler|mansion|\bhouse\b|\bhome\b|\bvilla|apartment|office|\bhotel|\bschool|library|\bshop\b|\bstore\b|interior|indoors?|\brooms?\b|castle hall/, ask: k("Did you mean indoors?"), label: k("Build it as rooms"), pin: { pack: "floor_plan" }, is: (i) => i.pack === "floor_plan" },
  { words: /forest|\bwoods?\b|\bpark\b|garden|island|beach|meadow|\bcamp|jungle|countryside|outdoors?|\blake\b|mountain/, ask: k("Did you mean outdoors?"), label: k("Make it outdoors"), pin: { pack: "outdoor" }, is: (i) => i.pack === "outdoor" },
  { words: /\barena|stadium|\bduel|\bsumo|dodgeball|football|soccer|basketball|colosseum|\bring\b/, ask: k("Did you mean an arena?"), label: k("Make it an arena"), pin: { pack: "arena" }, is: (i) => i.pack === "arena" },
  { words: /\bcity\b|street|rooftop|downtown|\balley|neon/, ask: k("Did you mean city streets?"), label: k("Make it a city"), pin: { pack: "city_block" }, is: (i) => i.pack === "city_block" },
  { words: /\bcafes?\b|coffee|restaurant|\bdiner\b|bakery|sushi|pizzeria|\bbank\b|\bcounter\b|\btill\b|barista|waiter|waitress|take (the )?orders?/, ask: k("Did you mean a café or shop?"), label: k("Make it a café or shop"), pin: { pack: "service_venue" }, is: (i) => i.pack === "service_venue" },
  { words: /escape room|puzzle|riddle|\blevers?\b|pressure plates?|locked doors?/, ask: k("Did you mean puzzle rooms?"), label: k("Make it puzzle rooms"), pin: { pack: "puzzle_rooms" }, is: (i) => i.pack === "puzzle_rooms" },
  { words: /\bconcert|\bgig\b|\bstage\b|theat(re|er)|magic show|ballet|\bopera\b|musical|talent show/, ask: k("Did you mean a stage?"), label: k("Put it on a stage"), pin: { pack: "stage" }, is: (i) => i.pack === "stage" },
  { words: /solar system|planetarium|orrery|\bplanets\b/, ask: k("Did you mean the solar system?"), label: k("Make it the solar system"), pin: { pack: "orrery" }, is: (i) => i.pack === "orrery" },
];
const PLACE = /\b(tour|explore|exploring|visit|stroll|wander|walk around|look around|sightsee|showroom)\b/;
const GAME = /\b(win|score|race|collect|escape|steal|catch|capture|defeat|beat|survive|reach|find)\b/;

/**
 * The card's "did you mean": when the prompt's own words name another pack than the one the world
 * was built on (as often as the built one's, or more), or another mode, one chip offers it. Null
 * when the choice wasn't close. A small table, so it runs on every world, recorded ones included.
 */
export function ambiguity(prompt: string, i: { pack: string; mode: string; genre: string }): { ask: string; label: string; pin: ShapePin } | null {
  const p = norm(prompt);
  const hits = (a: Alt) => (p.match(new RegExp(a.words.source, "g")) ?? []).length;
  const own = ALTS.find((a) => a.pin.pack === i.pack);
  const ownHits = own ? hits(own) : 0;
  const best = ALTS.filter((a) => !a.is(i) && hits(a) > 0 && (a.pin.pack === undefined || hits(a) >= ownHits)).sort((a, b) => hits(b) - hits(a))[0];
  if (best) return { ask: best.ask, label: best.label, pin: best.pin };
  if (i.mode === "play" && PLACE.test(p) && !GAME.test(p)) return { ask: k("Just explore it?"), label: k("Make it a place to wander"), pin: { mode: "wander" } };
  if (i.mode === "wander" && GAME.test(p)) return { ask: k("Did you mean a game?"), label: k("Make it a game"), pin: { mode: "play" } };
  return null;
}

/** Genres the card offers to pin (the intent model's own word for the world comes first). */
export const GENRES = ["capture the flag", "race", "heist", "escape", "collect", "duel", "parkour", "tour", "hide and seek", "survival"] as const;

/** What the App does for each kind of correction. */
export interface CardActions {
  onLook(v: string): void;
  onPhase(p: LookPick["phase"]): void;
  onWeather(w: string): void;
  onLaws(c: { jumpsMax?: number; gravity?: string; speed?: string }): void;
  onLayout(c: { scale?: number; floors?: number; sub?: { id: string; on: boolean } }): void;
  onShape(pin: ShapePin): void;
}

/** The card's fields for a world as it is now: its look as the picker chose it, its laws, its layout. */
export function controlsFor(w: World, o: { live: boolean; busy: boolean; prompt: string; act: CardActions }): CardControls {
  const p = pickLook(w.cue);
  const genre = w.intent.live?.genre ?? "";
  const alt = ambiguity(o.prompt, { pack: w.bundle.pack.id, mode: w.bundle.mode, genre });
  return {
    look: { value: p.variant ? `${p.id}/${p.variant}` : p.id, label: lookName(p.id, p.variant) },
    looks: looksFor(w.bundle.pack.id),
    phase: p.phase,
    weather: weatherOf(p),
    jumps: w.bundle.laws.jumpsMax,
    gravity: gravityName(w.bundle.laws.gravityScale),
    speed: speedName(w.bundle.laws.speed),
    genre,
    genres: GENRES,
    packs: PACK_IDS.map((id) => ({ value: id, label: id })),
    layout: layoutOptions(w.fill),
    chip: alt && { ask: alt.ask, label: alt.label },
    live: o.live,
    busy: o.busy,
    ...o.act,
    onChip: () => alt && o.act.onShape(alt.pin),
  };
}

/** A law change from the card, as the edit's words (its lineage) and the law line it writes. */
export function lawChange(laws: Laws, c: { jumpsMax?: number; gravity?: string; speed?: string }): { change: string; patch: string } {
  if (c.jumpsMax !== undefined) return { change: c.jumpsMax === 1 ? "only one jump" : c.jumpsMax === 2 ? "double jump" : "triple jump", patch: lawPatch(laws, { jumpsMax: c.jumpsMax }) };
  if (c.gravity !== undefined) {
    const g = GRAVITY.find((x) => x.label === c.gravity) ?? GRAVITY[0];
    return { change: `${g.label} gravity`, patch: lawPatch(laws, { gravityScale: g.scale }) };
  }
  const s = SPEED.find((x) => x.label === c.speed) ?? SPEED[1];
  return { change: s.label === "normal" ? "normal speed" : `${s.label} running`, patch: lawPatch(laws, { speed: s.speed }) };
}

/** A layout change from the card, as the edit's words and its layout op (null: this pack can't). */
export function layoutChangeOf(fill: string, c: { scale?: number; floors?: number; sub?: { id: string; on: boolean } }): { change: string; patch: string } | null {
  const wrap = (change: string, patch: string | null) => (patch ? { change, patch } : null);
  if (c.scale) return wrap(c.scale > 1 ? "make the map bigger" : "make the map smaller", layoutPatch(fill, { scale: c.scale }));
  if (c.floors !== undefined) return wrap(c.floors > 1 ? "add a floor" : "take the upper floor away", layoutPatch(fill, { set: { floors: c.floors } }));
  if (c.sub) {
    const sub = c.sub;
    const subs = layoutOptions(fill).subs.filter((s) => (s.id === sub.id ? !sub.on : s.on)).map((s) => s.id);
    return wrap(`${sub.on ? "remove" : "add"} the ${sub.id === "rooftop" ? "rooftop lane" : sub.id}`, layoutPatch(fill, { sub: subs }));
  }
  return null;
}
