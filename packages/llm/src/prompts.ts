// Prompt builders for the fast lane. Wire schemas stay constant across worlds (warm grammar
// cache): flat, every field required, no unions, no field named reasoning/thinking/trace.
import * as v from "valibot";
import { VERBS } from "@ghostrun/kits";
import type { PackLayout } from "@ghostrun/plugin-api";

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

/** Runtime-supported vocabulary today. The list grows as kits land; the LLM only sees what runs. */
export const SUPPORTED = {
  verbs: VERBS.map((v) => ({ id: v.id, line: v.line })),
  triggers: [
    "enter (a=moving thing or 'player', b=sensor entity like a goal)",
    "exit",
    "pickup (a=item, b='player')",
    "state_is (a=entity, s=state it changes to: a switch 'on', a plate 'down', a door 'open', a checkpoint 'reached')",
    "touch (a='player', b=thing collected or inspected; leave b empty for any)",
    "hit (a='player', b=hazard)",
    "timer_end (a=the id the timer verb is bound on, e.g. 'player')",
    "score_gte (a='team:red'|'team:blue', n=threshold)",
    "every (n=seconds)",
  ],
  effects: ["score (target 'team:red'|'team:blue', n=points)", "win (target 'player')", "lose (target 'player')", "reset (target=entity: back to its start)", "set_state (target, v=state)", "emit (target, fx=visual effect name)", "destroy (target)", "open/close (target door)", "teleport (target, v=destination entity id)"],
  conditions: "if: [{\"l\":\"orb.carrier.team\",\"op\":\"eq\",\"r\":\"red\"}] — paths: <id>.team, <id>.state, <id>.carrier.team, team:red.score",
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
        `Verbs:\n${SUPPORTED.verbs.map((x) => `- ${x.id}: ${x.line}`).join("\n")}`,
        `Rule triggers: ${SUPPORTED.triggers.join("; ")}.`,
        `Rule effects: ${SUPPORTED.effects.join("; ")}.`,
        `Conditions: ${SUPPORTED.conditions}.`,
        "Laws line for movement: {\"op\":\"law\",\"player\":{\"jumpsMax\":2,\"jumpH\":1.6,\"speed\":6}}.",
        "Play worlds MUST have: a red spawn for the player, a way to win and a way to lose, and an expect line with \"headline\":true stating the prompt-specific property (props: requires (need [\"jumps>=2\"]), win_reachable, reachable, unreachable, fair_teams).",
        "Expect lines name things by id: a = where the player starts (the spawn id), b = the ZONE id (or goal entity id) the property is about. Example: {\"op\":\"expect\",\"id\":\"x_roof\",\"prop\":\"requires\",\"a\":\"sp_red\",\"b\":\"z_roof\",\"need\":[\"jumps>=2\"],\"headline\":true,\"text\":\"Rooftop lane needs double jump\"}. Never use a verb id or 'player' in a or b.",
        "Budgets: ≤8 zones, ≤40 entities, ≤32 verbs, ≤20 rules, ≤4 minded npcs + 8 plain, ≤6 expects.",
        "NPC line: {\"op\":\"npc\",\"id\":\"guard_1\",\"role\":\"guard|merchant|guide|rival|teammate|creature|citizen\",\"zone\":\"...\",\"anchor\":\"...\",\"team\":\"\",\"menu\":[\"guard.patrol\"],\"dflt\":\"guard.patrol\"}.",
  ];
}

export function fillMessages(prompt: string, intent: IntentOut, layout: PackLayout, example: string, seed: number): Msg[] {
  return [
    {
      role: "system",
      content: [
        "You compile a game description into GHOSTRUN world ops. Output ONLY JSON Lines: one JSON object per line, no prose, no code fences.",
        ...worldRules(layout),
        "Example for a different prompt (copy the style, not the content):",
        example.trim(),
      ].join("\n"),
    },
    {
      role: "user",
      content: `Prompt: ${prompt}\nIntent: ${JSON.stringify(intent)}\nUse seed ${seed}, pack "${layout.packId}", sub ${JSON.stringify(intent.sub)}. Headline expect text: "${intent.headline}".`,
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
        "- a changed line keeps its id and replaces the old one entirely (repeat every field you keep);",
        "- a new line uses a new id; {\"op\":\"del\",\"id\":\"...\"} removes a line;",
        "- never repeat unchanged lines; never output meta or end lines.",
        "Fix every issue with the smallest change that keeps the prompt's intent.",
        ...worldRules(layout),
      ].join("\n"),
    },
    {
      role: "user",
      content: `Prompt: ${prompt}\nIntent: ${JSON.stringify(intent)}\nCurrent world (gameplay lines):\n${fill.trim()}\nProof failures to fix:\n${issues.map((x) => `- ${x}`).join("\n")}`,
    },
  ];
}
