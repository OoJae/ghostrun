// Prompt builders for the fast lane. Wire schemas stay constant across worlds (warm grammar
// cache): flat, every field required, no unions, no field named reasoning/thinking/trace.
import * as v from "valibot";
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
  verbs: [
    { id: "locomotion.jump", line: 'player jump; params {"jumpsMax":1-3}; also set the law line' },
    { id: "physics_props.carry", line: "on an item entity: the player picks it up by touching it and carries it" },
    { id: "motion_hazards.oscillate", line: 'on a platform entity: moves back and forth; params {"axis":"x"|"z","travel":metres,"period":seconds}' },
  ],
  triggers: ["enter (a=moving thing or 'player', b=sensor entity like a goal)", "exit", "pickup (a=item, b='player')", "score_gte (a='team:red'|'team:blue', n=threshold)", "every (n=seconds)"],
  effects: ["score (target 'team:red'|'team:blue', n=points)", "win (target 'player')", "lose (target 'player')", "reset (target=entity: back to its start)", "set_state (target, v=state)", "emit (target, fx=visual effect name)", "destroy (target)", "open/close (target door)", "teleport (target, v=destination entity id)"],
  conditions: "if: [{\"l\":\"orb.carrier.team\",\"op\":\"eq\",\"r\":\"red\"}] — paths: <id>.team, <id>.state, <id>.carrier.team, team:red.score",
};

export function fillMessages(prompt: string, intent: IntentOut, layout: PackLayout, example: string, seed: number): { role: "system" | "user"; content: string }[] {
  const slots = layout.zones
    .map((z) => `- slot "${z.slot}" (${z.tag})${Object.keys(z.anchors).length ? `: anchors ${Object.keys(z.anchors).join(", ")}` : ": no anchors (omit anchor to scatter)"}`)
    .join("\n");
  return [
    {
      role: "system",
      content: [
        "You compile a game description into GHOSTRUN world ops. Output ONLY JSON Lines: one JSON object per line, no prose, no code fences.",
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
        `Verbs:\n${SUPPORTED.verbs.map((x) => `- ${x.id}: ${x.line}`).join("\n")}`,
        `Rule triggers: ${SUPPORTED.triggers.join("; ")}.`,
        `Rule effects: ${SUPPORTED.effects.join("; ")}.`,
        `Conditions: ${SUPPORTED.conditions}.`,
        "Laws line for movement: {\"op\":\"law\",\"player\":{\"jumpsMax\":2,\"jumpH\":1.6,\"speed\":6}}.",
        "Play worlds MUST have: a red spawn for the player, a way to win and a way to lose, and an expect line with \"headline\":true stating the prompt-specific property (props: requires (need [\"jumps>=2\"]), win_reachable, reachable, unreachable, fair_teams).",
        "Expect lines name things by id: a = where the player starts (the spawn id), b = the ZONE id (or goal entity id) the property is about. Example: {\"op\":\"expect\",\"id\":\"x_roof\",\"prop\":\"requires\",\"a\":\"sp_red\",\"b\":\"z_roof\",\"need\":[\"jumps>=2\"],\"headline\":true,\"text\":\"Rooftop lane needs double jump\"}. Never use a verb id or 'player' in a or b.",
        "Budgets: ≤8 zones, ≤40 entities, ≤12 verbs, ≤16 rules, ≤4 minded npcs + 8 plain, ≤6 expects.",
        "NPC line: {\"op\":\"npc\",\"id\":\"guard_1\",\"role\":\"guard|merchant|guide|rival|teammate|creature|citizen\",\"zone\":\"...\",\"anchor\":\"...\",\"team\":\"\",\"menu\":[\"guard.patrol\"],\"dflt\":\"guard.patrol\"}.",
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
