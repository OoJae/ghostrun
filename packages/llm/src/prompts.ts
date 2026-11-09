// Prompt builders for the fast lane. Wire schemas stay constant across worlds (warm grammar
// cache): flat, every field required, no unions, no field named reasoning/thinking/trace.
import * as v from "valibot";
import { VERBS } from "@ghostrun/kits";
import type { PackLayout } from "@ghostrun/plugin-api";
import type { ChatMessage, ImageIn } from "./wire";

export const IntentOut = v.object({
  lang: v.string(),
  mode: v.picklist(["play", "wander"]),
  genre: v.string(),
  setting: v.string(),
  role: v.string(),
  goal: v.string(),
  fail: v.string(),
  mood: v.string(),
  pack: v.string(),
  sub: v.array(v.string()),
  safety: v.picklist(["ok", "arcade", "block"]),
  headline: v.string(), // the prompt-specific property the receipt should lead with
  nouns: v.array(v.object({ noun: v.string(), hyper: v.string() })),
  moodVec: v.object({ valence: v.number(), arousal: v.number(), tension: v.number() }),
});
export type IntentOut = v.InferOutput<typeof IntentOut>;

// A prompt that opens with something to do (or has one after a colon) is a game, whatever the model
// said: "Find your way out of a dark cave using glowing mushrooms" came back as a place to explore.
const GOAL = /(^|:\s*)(find|escape|get out|collect|catch|reach|rescue|steal|win|beat|race|deliver|defend|survive|climb|cross|knock|shoot|score|light|sneak|bring|carry|grab|put out|save|stop|chase|hunt|dodge|smuggle|break into|herd|capture|tag|return|sort|water|dig up)\b/i;

/** The model's intent with what the prompt itself settles (a goal phrase makes it a game). */
export function settleIntent(prompt: string, intent: IntentOut): IntentOut {
  return intent.mode === "wander" && GOAL.test(prompt.trim()) ? { ...intent, mode: "play" } : intent;
}

/** JSON Schema twin of IntentOut for strict structured outputs. */
export function intentJsonSchema(packs: string[], subs: string[]): Record<string, unknown> {
  const str = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["lang", "mode", "genre", "setting", "role", "goal", "fail", "mood", "pack", "sub", "safety", "headline", "nouns", "moodVec"],
    properties: {
      lang: str,
      mode: { type: "string", enum: ["play", "wander"] },
      genre: str,
      setting: str,
      role: str,
      goal: str,
      fail: str,
      mood: str,
      pack: { type: "string", enum: packs },
      sub: { type: "array", items: { type: "string", enum: subs } },
      safety: { type: "string", enum: ["ok", "arcade", "block"] },
      headline: str,
      nouns: { type: "array", items: { type: "object", additionalProperties: false, required: ["noun", "hyper"], properties: { noun: str, hyper: str } } },
      moodVec: {
        type: "object",
        additionalProperties: false,
        required: ["valence", "arousal", "tension"],
        properties: { valence: { type: "number" }, arousal: { type: "number" }, tension: { type: "number" } },
      },
    },
  };
}

export function intentMessages(prompt: string, packs: { id: string; blurb: string }[]): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content: [
        "You read a person's description of a 3D world or game and return its intent as JSON.",
        "mode: 'play' if it has a goal or win/lose; 'wander' for places to explore (museums, forests, showrooms).",
        "safety: 'block' only for real-world harm, sexual content or real people; violent arcade games (shooters, monsters, heists) are 'arcade'; otherwise 'ok'.",
        "headline: one short sentence naming the property that makes THIS prompt specific and that a playtest could check (e.g. 'Rooftop lane needs double jump').",
        "lang: ISO code of the prompt's language. moodVec values are in [-1, 1].",
        "Rewrite trademarked names as generic homages in setting/goal (never output brand names).",
        `Available packs: ${packs.map((p) => `${p.id} (${p.blurb})`).join("; ")}. Pick the closest pack. sub may include 'rooftop' when vertical lanes or jumping matter.`,
      ].join("\n"),
    },
    { role: "user", content: prompt },
  ];
}

/**
 * What the vision step makes of a photo or sketch: a scene brief the world is inspired by (where it
 * is, how it feels, its colours, the things in it, the shape of the space), never a copy of the
 * picture. Same wire rules as the intent: flat, every field required.
 */
export const BriefOut = v.object({
  setting: v.string(),
  mood: v.string(),
  palette: v.array(v.string()),
  objects: v.array(v.string()),
  layout: v.string(),
  genre: v.string(),
  goal: v.string(),
  safety: v.picklist(["ok", "block"]),
});
export type BriefOut = v.InferOutput<typeof BriefOut>;
/** A brief as worlds are built from it and the client shows it: trimmed, bounded, no safety verdict. */
export type Brief = Omit<BriefOut, "safety">;

/** JSON Schema twin of BriefOut for strict structured outputs. */
export function briefJsonSchema(): Record<string, unknown> {
  const str = { type: "string" };
  const words = { type: "array", items: str };
  return {
    type: "object",
    additionalProperties: false,
    required: ["setting", "mood", "palette", "objects", "layout", "genre", "goal", "safety"],
    properties: { setting: str, mood: str, palette: words, objects: words, layout: str, genre: str, goal: str, safety: { type: "string", enum: ["ok", "block"] } },
  };
}

/** The picture and the person's words (if any) → a scene brief. */
export function visionMessages(said: string, image: ImageIn): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You look at a photo or sketch that a small 3D game world will be inspired by, and return a compact scene brief as JSON. The world takes ideas from the picture; it is never a copy of it.",
        "setting: the kind of place, in a few words ('a rainy neon alley at night', 'a sunlit farmhouse kitchen'). mood: one to three words. palette: 3-5 plain colour words.",
        "objects: 5-10 notable things in the picture as short nouns ('fire escape', 'crate', 'oak tree'). Never people, names, or the words on signs and screens.",
        "layout: the shape of the space if the picture shows one ('a long corridor', 'an open plaza', 'two floors', 'a ring of trees'), else ''.",
        "genre and goal: when the person gave no prompt, a game that fits this place (genre 'heist', goal 'steal the lantern and slip out'); when they did, ''.",
        "If there are people in the picture, never say who they are or describe them: describe the place and the things in it.",
        "safety: 'block' for sexual or nude content, graphic gore or cruelty, hate symbols, or a picture that is mostly a document or screen with personal details (an ID, a bank card, private messages); otherwise 'ok' (toy weapons, game screenshots and spooky places are fine).",
        "Rewrite trademarked names as generic things (never output brand names).",
      ].join("\n"),
    },
    { role: "user", content: said ? `Their prompt: ${said}` : "They gave no prompt: suggest the genre and goal.", image },
  ];
}

/** One short line of the model's words: no control characters, single spaces, at most `max` characters. */
const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();

/** The model's brief, bounded: it is shown as it is and becomes part of a prompt. */
export function settleBrief(b: BriefOut): Brief {
  const words = (xs: string[], n: number, max: number) => [...new Set(xs.map((x) => oneLine(x, max).toLowerCase()).filter(Boolean))].slice(0, n);
  return { setting: oneLine(b.setting, 80) || "a place", mood: oneLine(b.mood, 32), palette: words(b.palette, 5, 16), objects: words(b.objects, 10, 24), layout: oneLine(b.layout, 60), genre: oneLine(b.genre, 24), goal: oneLine(b.goal, 100) };
}

/** The most a brief adds to the person's own words (the build's hold and the fill's input bound count on it). */
export const BRIEF_MAX_CHARS = 480;

/**
 * The prompt a picture's world is written from: the person's words (or, with none, the game the
 * picture suggested), then what the picture showed. The intent and the fill read only this text,
 * so the fast lane writes the world and never sees the image.
 */
export function inspiredPrompt(said: string, b: Brief): string {
  const end = (s: string) => s.trim().replace(/[\s.!?;:,]+$/, "");
  const own = end(said);
  const lead = own || [b.genre.charAt(0).toUpperCase() + b.genre.slice(1), end(b.goal)].filter(Boolean).join(": ");
  const scene = (objects: string[]) =>
    [`Inspired by a picture of ${end(b.setting)}`, b.mood && `mood ${b.mood}`, b.palette.length > 0 && `colours ${b.palette.join(", ")}`, objects.length > 0 && `with ${objects.join(", ")}`, b.layout && `layout: ${end(b.layout)}`].filter(Boolean).join("; ") + ".";
  const text = (objects: string[]) => (lead ? `${lead}. ` : "") + scene(objects);
  // over budget: fewer things named, then a hard cut
  const objects = [...b.objects];
  while (objects.length > 3 && text(objects).length - own.length > BRIEF_MAX_CHARS) objects.pop();
  return text(objects).slice(0, own.length + BRIEF_MAX_CHARS);
}

/** Runtime-supported vocabulary today. The list grows as kits land; the LLM only sees what runs. */
export const SUPPORTED = {
  verbs: VERBS.map((v) => ({ id: v.id, line: v.line })),
  triggers: [
    "enter (a=moving thing or 'player', b=sensor entity like a goal)",
    "exit",
    "pickup (a=item, b='player')",
    "state_is (a=entity, s=state it changes to: a switch 'on', a plate 'down', a door 'open', a checkpoint 'reached')",
    "touch (a='player', b=thing collected or inspected; leave b empty for any)",
    "hit (a='player', b=hazard; or a=the one hit by a thrown item or a shot, b=the item or weapon ('player' for your own spell): red scoring a throw is {\"t\":\"hit\",\"a\":\"\",\"b\":\"ball\"} with if ball.carrier.team eq red)",
    "health_lte (a=character or 'team:blue', n=hit points; n 0 = knocked out)",
    "exit (a=mover, b=the sensor ENTITY it left: a ring is an ent kind goal with body sensor covering the ring, its rivals starting inside it)",
    "timer_end (a=the id the timer verb is bound on, e.g. 'player')",
    "lap_done (a='player' or 'team:blue', b=the track's line, n=laps done; no n = every lap)",
    "score_gte (a='team:red'|'team:blue', n=threshold)",
    "every (n=seconds)",
    "spoken (a=npc, act=offer|pay|buy|book|ask|command, b=coins|item, n=min)",
    "seen_by (a='player', b=npc that sees you)",
  ],
  effects: ["score (target 'team:red'|'team:blue', n=points)", "win (target 'player')", "lose (target 'player')", "reset (target=entity: back to its start)", "set_state (target, v=state, n=seconds, 0=for good)", "emit (target, fx=visual effect name)", "destroy (target)", "open/close (target door)", "teleport (target, v=destination entity id)", "damage/heal (target, n=hit points)", "give/take (target 'player', v=coins|item, n)", "book_slot (target=npc, v='Viewing at <place>')"],
  conditions: "if: [{\"l\":\"orb.carrier.team\",\"op\":\"eq\",\"r\":\"red\"}] — paths: <id>.team, <id>.state, <id>.carrier.team, <id>.hp, team:red.score, player.coins, player.carrying",
};

type Msg = { role: "system" | "user"; content: string };

/** The world language: shared by the fill and the repair calls so both speak exactly the same IR. */
function worldRules(layout: PackLayout): string[] {
  const slots = layout.zones
    .map((z) => `- slot "${z.slot}" (${z.tag})${Object.keys(z.anchors).length ? `: anchors ${Object.keys(z.anchors).join(", ")}` : ": no anchors (omit anchor to scatter)"}`)
    .join("\n");
  return [
        "Order is fixed: meta, zone+, spawn+, goal*, ent*, verb*, law?, state*, rule*, npc*, expect+, {\"op\":\"end\",\"layer\":\"gameplay\"}, dress*, poster{0,2}, {\"op\":\"end\",\"layer\":\"cosmetic\"}.",
        "ids: lower_snake_case, ≤32 chars, unique across the whole world. Every line ≤ 1 KB.",
        `Pack "${layout.packId}" slots (zones must use these slot names; entities name an anchor of their zone):`,
        slots,
        "Use EXACTLY these enum values (anything else is rejected):",
        "- kind: prop | pickup | goal | spawn | checkpoint | door | switch | plate | hazard | platform | vehicle | npc | portal | sign",
        "- body: none | fixed | kinematic | dynamic | sensor   (immovable scenery = fixed, never 'static')",
        "- shape: none | box | capsule | sphere | hull   - team: \"\" | red | blue   (no team = \"\")",
        "- expect prop: win_reachable | reachable | unreachable | requires | fair_teams   (\"headline\" is a boolean field, not a prop)",
        "Goals are sensors; pickups are carried with the carry verb.",
        "The win must depend on the objective, never on just walking somewhere: e.g. bring the gem to the exit (when enter a=gem b=exit), collect N coins (touch + score_gte), or flip all switches (state_is). Doors that guard the objective go on doorway anchors when the pack has them.",
        "Make it interactive: 10-20 things the player can use, collect, step on or dodge (switches, plates, locked doors and keys, coins, hazards, jump pads, portals, exhibits to inspect), each bound to its verb and wired with rules so it matters.",
        "Fights (duels, shooters, zombies, laser tag): combat_sport.shoot on the player and on each npc that fights back (claws or a sword: range 2), combat_sport.health on whoever can be knocked out; win or score on health_lte of the rivals (n 0), lose on health_lte of the player. The player is always 'player' (never player_red); red scoring a tag is {\"t\":\"hit\",\"a\":\"team:blue\",\"b\":\"\"}.",
        "Races (karts, cars, boats, snowmobiles): a vehicle ent with vehicle.drive (\"driver\":\"player\") at the red spawn, checkpoint ents as gates, racing.track on the finish line; win on lap_done a=player n=laps, lose on lap_done a=team:blue n=laps; rival npcs drive themselves with menu [\"racer.race\",\"racer.block\"].",
        `Verbs:\n${SUPPORTED.verbs.map((x) => `- ${x.id}: ${x.line}`).join("\n")}`,
        `Rule triggers: ${SUPPORTED.triggers.join("; ")}.`,
        `Rule effects: ${SUPPORTED.effects.join("; ")}.`,
        `Conditions: ${SUPPORTED.conditions}.`,
        "Laws line for movement: {\"op\":\"law\",\"player\":{\"jumpsMax\":2,\"jumpH\":1.6,\"speed\":6}}.",
        "Play worlds MUST have: a red spawn for the player, a way to win and a way to lose, and an expect line with \"headline\":true stating the prompt-specific property. Usually that is win_reachable with text naming the goal (\"The idol can be grabbed and carried out\"). Use requires with need [\"jumps>=2\"] ONLY when the prompt is about jumping or climbing, and point b at the raised zone that truly needs it.",
        "Expect lines name things by id: a = where the player starts (the spawn id), b = the ZONE id (or goal entity id) the property is about. Example: {\"op\":\"expect\",\"id\":\"x_roof\",\"prop\":\"requires\",\"a\":\"sp_red\",\"b\":\"z_roof\",\"need\":[\"jumps>=2\"],\"headline\":true,\"text\":\"Rooftop lane needs double jump\"}. Never use a verb id or 'player' in a or b.",
        "Budgets: ≤8 zones, ≤40 entities, ≤32 verbs, ≤20 rules, ≤4 minded npcs + 8 plain, ≤6 expects.",
        "NPC line: {\"op\":\"npc\",\"id\":\"guard_1\",\"role\":\"guard|merchant|guide|rival|teammate|creature|citizen\",\"zone\":\"...\",\"anchor\":\"...\",\"team\":\"\",\"menu\":[\"guard.patrol\"],\"dflt\":\"guard.patrol\"}.",
        "A bribe: spoken a=guard_1 act=offer b=coins n=20, if player.coins gte 20: take player coins 20, set_state guard_1 look_away n 20 (menu has guard.look_away). Caught: seen_by b=guard_1 if player.carrying eq the loot: lose. Touch rules give coins. A guide: spoken act=book: book_slot.",
  ];
}

/** The prompt asks for Feng Shui (the same words as asksFengShui in packages/layout/src/fengshui.ts). */
const FENG_SHUI = /feng[\s-]*(shui|šuej|suej|schui)|fengshui|風水|风水/i;
/**
 * The Form School's room rules the built world is checked on (packages/layout/src/fengshui.ts),
 * in the fill's terms: anchors, nouns and what not to put where.
 */
export const FENG_SHUI_HINT =
  " Feng Shui (Form School), checked on the built world: a desk, counter or bed in a corner far from its room's doorway, its back to a wall; nothing within 3 m inside the front door; mirrors on side walls, never facing the front door; no uncurtained window in line with it; uncluttered rooms; nouns name materials or colours covering 3+ of wood, fire, earth, metal, water ('bamboo plant', 'red silk clutch', 'stone bench', 'brass bowl', 'small fountain').";

export function fillMessages(prompt: string, intent: IntentOut, layout: PackLayout, example: string | string[], seed: number): Msg[] {
  const examples = Array.isArray(example) ? example : [example];
  const label = (i: number) => (examples.length > 1 ? `Example ${i + 1} for a different prompt (copy the style and the kinds of verbs and rules, not the content):` : "Example for a different prompt (copy the style, not the content):");
  return [
    {
      role: "system",
      content: [
        "You compile a game description into GHOSTRUN world ops. Output ONLY JSON Lines: one JSON object per line, no prose, no code fences.",
        ...worldRules(layout),
        ...examples.flatMap((e, i) => [label(i), e.trim()]),
      ].join("\n"),
    },
    {
      role: "user",
      content: `Prompt: ${prompt}\nIntent: ${JSON.stringify(intent)}\nUse seed ${seed}, pack "${layout.packId}", mode "${intent.mode}", sub ${JSON.stringify(intent.sub)}. Headline expect text: "${intent.headline}".${intent.mode === "wander" ? " This is a place to explore: no win or lose rules needed; make its things inspectable (social.inspect with a real one-line text each) and let NPCs guide." : ""}${FENG_SHUI.test(prompt) ? FENG_SHUI_HINT : ""}`,
    },
  ];
}

/**
 * Counterexample-guided repair: the proof's concrete failures go back to the model, which answers
 * with a patch (changed lines by id, new lines, deletions). The caller merges, re-places and
 * re-proves, and keeps the repair only if the receipt got better.
 */
export function repairMessages(prompt: string, intent: IntentOut, layout: PackLayout, fill: string, issues: string[]): Msg[] {
  return [
    {
      role: "system",
      content: [
        "You repair a GHOSTRUN world that failed its proof. Output ONLY JSON Lines, no prose, no code fences:",
        "- a changed line keeps its id, op and kind and replaces the old one entirely (repeat every field you keep);",
        "- a new line uses a new id; {\"op\":\"del\",\"id\":\"...\"} removes a line;",
        "- never repeat unchanged lines; never output meta or end lines.",
        "Fix every issue with the smallest change that keeps the prompt's intent. Each issue says what to change: do that (a fight is balanced by the numbers on combat_sport.shoot and combat_sport.health, and by where things stand: their zone and anchor).",
        ...worldRules(layout),
      ].join("\n"),
    },
    {
      role: "user",
      content: `Prompt: ${prompt}\nIntent: ${JSON.stringify(intent)}\nCurrent world (gameplay lines):\n${fill.trim()}\nProof failures to fix:\n${issues.map((x) => `- ${x}`).join("\n")}`,
    },
  ];
}

/**
 * The person's own change to a world ("only one jump", "add three more coins", "make it night"):
 * a patch in the repair format. Expectations are off limits (the merge locks them too), so the
 * proof keeps checking what the world promised and a change that breaks a promise shows up.
 */
export function editMessages(prompt: string, change: string, intent: IntentOut, layout: PackLayout, fill: string): Msg[] {
  return [
    {
      role: "system",
      content: [
        "You change a GHOSTRUN world the way the person asks. Output ONLY JSON Lines, no prose, no code fences:",
        "- a changed line keeps its id and replaces the old one entirely (repeat every field you keep);",
        "- a new thing gets a new id; {\"op\":\"del\",\"id\":\"...\"} removes a line;",
        "- never repeat unchanged lines; never output end, expect, dress or poster lines.",
        "Do exactly what the change asks and keep everything else. New things must work: bind their verbs and wire their rules.",
        "Movement (jumps, jump height, speed, gravity) is the law line: {\"op\":\"law\",\"player\":{\"jumpsMax\":1,\"jumpH\":1.6,\"speed\":6,\"gravityScale\":1}}.",
        "Looks are one meta line with only the fields that change: {\"op\":\"meta\",\"look\":\"neon city\",\"timeOfDay\":22,\"weather\":\"rain\"}. timeOfDay is 0-24; weather is clear|rain|snow|fog|storm.",
        "The world's expectations stay as they are: the proof re-checks them after your change, so never try to make a check pass by editing it.",
        "If the change asks for something the world language can't express, make the closest change it can.",
        ...worldRules(layout),
      ].join("\n"),
    },
    {
      role: "user",
      content: `Original prompt: ${prompt}\nIntent: ${JSON.stringify(intent)}\nCurrent world (gameplay lines):\n${fill.trim()}\nThe change to make: ${change}`,
    },
  ];
}

/**
 * The Director's cut: a stronger model reworks a world that already plays into the best version of
 * what the person asked for, as a patch in the edit format. The client re-proves the result and
 * offers it only if it still plays at least as well; nothing applies mid-run.
 */
export function directorMessages(prompt: string, intent: IntentOut, layout: PackLayout, fill: string, notes: string[]): Msg[] {
  return [
    {
      role: "system",
      content: [
        "You are the Director. A GHOSTRUN world already works; you turn it into the best version of what the person asked for. Output ONLY JSON Lines, no prose, no code fences:",
        "- a changed line keeps its id and replaces the old one entirely (repeat every field you keep);",
        "- a new thing gets a new id; {\"op\":\"del\",\"id\":\"...\"} removes a line;",
        "- never repeat unchanged lines; never output end, expect, dress or poster lines.",
        "Make four changes, each small, complete and working (bind every new thing's verbs and wire its rules):",
        "1. One signature upgrade: the mechanic the prompt is about becomes central and memorable (a route that needs it, a set piece built around it, a reward for mastering it).",
        "2. More to use: 3-6 new interactive things in different zones, some where the playtest says nobody goes yet.",
        "3. A voice for the cast: every npc gets a persona that fits the world, e.g. \"persona\":{\"identity\":\"the harbour master\",\"personality\":\"gruff, secretly kind\",\"knowledge\":\"which crates hide the shortcut\",\"replyStyle\":\"short, salty\",\"safety\":\"family-friendly\"}. If the world suits a character and has none, add one npc with a menu of two or more options.",
        "4. One twist: a rule that changes the run partway (a door that opens once the timer passes half, a shortcut a switch reveals, a hazard that starts moving after the first score), wired so the world stays winnable.",
        "Never break what works: keep the spawn, the objective and the way to win; never delete a thing or character the prompt names; keep the world's expectations as they are (the proof re-checks them after your change).",
        "A place to explore (mode wander) gets no win or lose rules: its upgrade is more to look at and use, and characters who guide; its twist is something revealed (a hidden room a switch opens, an exhibit that comes alive).",
        ...worldRules(layout),
      ].join("\n"),
    },
    {
      role: "user",
      content: `Original prompt: ${prompt}\nIntent: ${JSON.stringify(intent)}\nMode: ${intent.mode}\nCurrent world (gameplay lines):\n${fill.trim()}\nWhat the playtest found:\n${(notes.length ? notes : ["nothing unusual"]).map((n) => `- ${n}`).join("\n")}`,
    },
  ];
}

/** The Host answers from numbered facts only (the run's causal log, the world's rules), citing them. */
export function hostJsonSchema(facts: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["answer", "cites"],
    properties: {
      answer: { type: "string", maxLength: 280 },
      cites: { type: "array", maxItems: 4, items: { type: "integer", minimum: 1, maximum: Math.max(1, facts) } },
    },
  };
}

export function hostMessages(question: string, facts: string[]): Msg[] {
  return [
    {
      role: "system",
      content: [
        "You are the Host of a small 3D game. The player asks about the run they just played or about the world.",
        "Answer in at most two short sentences, warm and plain, using ONLY the numbered facts below; cite the facts you used by number in cites.",
        "Times are minutes:seconds into the run. 'You' in the facts is the player. Never invent events, places or numbers that are not in the facts.",
        "If the facts don't answer the question, say you can't tell from this run, and cite nothing.",
        "Facts:",
        ...facts.map((f, i) => `[${i + 1}] ${f}`),
      ].join("\n"),
    },
    { role: "user", content: question },
  ];
}

/** What a mind sees: who it is, its typed menu, the situation in a few lines, and what just happened. */
export interface MindInput {
  npc: string;
  role: string;
  persona: string;
  menu: string[];
  current: string;
  situation: string;
  event: string;
  said?: string;
  /** The speech acts this character answers, as the world's rules accept them (none: it only picks options). */
  acts?: MindAct[];
  /** What it can answer a question from: the world's own facts, a few short lines. */
  facts?: string[];
  /** For a booking: today's date ("2026-11-02, Monday") and the visitor's time zone, so "Saturday at 3" is a date. */
  today?: string;
  tz?: string;
}

/** One act a character accepts: offer 20 coins (and the option it earns: look away), book, ask, command. */
export interface MindAct {
  act: string;
  /** What is handed over or bought ("coins", an item); "" for anything. */
  what: string;
  /** The least it takes (coins); 0 for no price. */
  n: number;
  /** The menu option accepting it earns (guard.look_away), "" for none. */
  gives: string;
}

/**
 * Strict schema: the option must be one of the menu's own strings (typed menus, never free actions),
 * and an act one of the closed set this character accepts ("none" when it accepts nothing).
 */
export function mindJsonSchema(menu: string[], acts: readonly MindAct[] = []): Record<string, unknown> {
  const base = { option: { type: "string", enum: menu }, line: { type: "string", maxLength: 120 } };
  if (!acts.length) return { type: "object", additionalProperties: false, required: ["option", "line"], properties: base };
  return {
    type: "object",
    additionalProperties: false,
    required: ["option", "line", "act", "what", "n", "slot"],
    properties: {
      ...base,
      act: { type: "string", enum: ["none", ...new Set(acts.map((a) => a.act))] },
      what: { type: "string", maxLength: 48 },
      n: { type: "integer", minimum: 0, maximum: 9999 },
      slot: { type: "string", maxLength: 16 },
    },
  };
}

/** An act as the mind is told it ("offer: coins, at least 20 (you then play guard.look_away)"). */
const actLine = (a: MindAct) =>
  a.act === "book" ? "book: a time to come (a viewing, a table)"
  : a.act === "ask" ? "ask: a question you answer from what you know"
  : a.act === "command" ? "command: an order to play one of your menu options (put it in what)"
  : `${a.act}: ${a.what || "anything"}${a.n > 0 ? `, at least ${a.n}` : ""}${a.gives ? ` (you then play ${a.gives})` : ""}`;

/**
 * An NPC's mind: picks one option from its typed menu and says one short line in character. The
 * simulation then plays the option deterministically; the line is cosmetic. A character the world
 * lets you talk your way past also answers a speech act: it accepts one (and the act enters the
 * simulation, where the world's rule decides what it does) or refuses it in character.
 */
export function mindMessages(m: MindInput): Msg[] {
  const acts = m.acts ?? [];
  return [
    {
      role: "system",
      content: [
        `You are the mind of ${m.npc}, a ${m.role} in a small 3D game. ${m.persona}`.trim(),
        "Choose exactly ONE option from your menu that fits the situation, and say one short line in character (at most 12 words, family-friendly, no names of real people or brands).",
        "If the player speaks to you, answer them in that line, and follow a reasonable request when your menu allows it (a teammate told to follow, follows).",
        `Menu: ${m.menu.join(", ")}. Current option: ${m.current}.`,
        ...(acts.length
          ? [
              `What the player says may be a speech act you can accept: ${acts.map(actLine).join("; ")}.`,
              "Accept one only when the player really makes it: set act, what and n to what they actually offered (n = the amount). Never accept less than your price or an offer they didn't make.",
              "Refusing or haggling: act 'none', and say it in character ('Twenty? Make it fifty.'). With no act: act 'none', what '', n 0, slot ''.",
              ...(acts.some((a) => a.act === "book") ? [`A booking: act 'book', slot the local date and time asked for as YYYY-MM-DDTHH:MM (today is ${m.today ?? "unknown"}, time zone ${m.tz ?? "unknown"}), only within the hours you know; if it doesn't work, act 'none' and offer another time. Never ask for a name, email or phone.`] : []),
            ]
          : []),
        ...(m.facts?.length ? ["Answer questions only from these facts (say you don't know otherwise):", ...m.facts.map((f) => `- ${f}`)] : []),
      ].join("\n"),
    },
    { role: "user", content: `Situation: ${m.situation}\nWhat just happened: ${m.event}${m.said ? `\nThe player says to you: "${m.said}"` : ""}` },
  ];
}
