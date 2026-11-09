// Team AI you can command: the teammates on your side (a CTF mate, your half of a team arena) take
// one of four orders, from the command wheel (keys 1–4), or said or typed in the talk box. Each order
// picks an option on the teammate's own typed menu (@ghostrun/bots commandOption) and goes into the
// simulation as a command act, logged with its tick like a bribe ("act:command::teammate.follow"),
// so replays and share links carry it. Nothing here decides what the teammate does: the menu does.
import { COMMANDS, commandables, type Command, type Commandable } from "@ghostrun/bots";
import type { WorldBundle } from "@ghostrun/ir";
import type { SpeechAct } from "@ghostrun/sim";
import { k, t } from "./i18n";

export { COMMANDS, type Command, type Commandable };

/** The wheel's words for each order ({thing}: what the game is about, "the glowing orb"). */
export const COMMAND_LABEL: Record<Command, string> = { follow: k("Follow me"), defend: k("Defend the base"), get: k("Get the {thing}"), attack: k("Attack") };
/** What a teammate is doing, by the order it was given. */
export const DOING: Record<Command, string> = { follow: k("following you"), defend: k("defending the base"), get: k("going for the {thing}"), attack: k("attacking") };

/** The thing the game is fought over (what a command "get" goes for): its noun, or "objective". */
export function objectiveOf(b: WorldBundle): string {
  const carried = new Set(b.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on));
  const item = [...b.entities].sort((x, y) => (x.id < y.id ? -1 : 1)).find((e) => carried.has(e.id));
  return item?.noun || item?.hyper || "objective";
}

/** The teammates the player can command in this world (none when the flag is off is the caller's call). */
export const teammates = (b: WorldBundle, playerTeam: string): Commandable[] => commandables(b, playerTeam);

/** One order to every teammate whose menu takes it: the acts to queue (one per teammate). */
export function commandActs(mates: readonly Commandable[], c: Command): SpeechAct[] {
  return mates.flatMap((m) => (m.options[c] ? [{ to: m.npc, act: "command" as const, what: m.options[c]!, n: 0, slot: "" }] : []));
}

/** The order an option carries out, for showing what a teammate is doing (null: one no order picks). */
export function commandOf(m: Commandable, option: string): Command | null {
  // (two orders can pick the same option: the first in the wheel's order names it)
  return COMMANDS.find((c) => m.options[c] === option) ?? null;
}

// what a said or typed order sounds like, in English; the wheel's own words in the player's language count too
const SAID: readonly [Command, RegExp][] = [
  ["follow", /\b(follow|come (with|to|here)|with me|on me|stay (close|with)|escort me|cover me)\b/],
  ["defend", /\b(defend|guard|protect|hold (the )?(base|line|fort)|stay (back|home|at)|go back|fall back|back to (the )?base|go home)\b/],
  ["get", /\b(get|grab|fetch|take|bring|steal|capture|pick up)\b/],
  ["attack", /\b(attack|charge|rush|push|go (for|after) them|chase|hunt|tackle|intercept|stop them)\b/],
];

/** The order a sentence gives ("follow me!", "go defend the base", "get the orb"), or null when it gives none of the four. */
export function matchCommand(said: string, thing = "objective"): Command | null {
  const s = said.toLowerCase().normalize("NFKC").replace(/[!?.,;:]+/g, " ").trim();
  if (!s) return null;
  // the wheel's words, in the player's language and in English, said as they are
  for (const c of COMMANDS) {
    const words = [t(COMMAND_LABEL[c], { thing }), COMMAND_LABEL[c].replace("{thing}", thing)].map((w) => w.toLowerCase());
    if (words.some((w) => s === w || s.includes(w))) return c;
  }
  // the item by name ("the orb!") is an order to get it
  const noun = thing.toLowerCase();
  const last = noun.split(/\s+/).at(-1) ?? "";
  for (const [c, re] of SAID) if (re.test(s)) return c;
  if (last.length > 2 && new RegExp(`\\b${last.replace(/[^a-z0-9]/g, "")}\\b`).test(s)) return "get";
  return null;
}
