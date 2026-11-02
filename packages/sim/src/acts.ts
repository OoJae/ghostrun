// Speech acts as the simulation takes them. The player says something to a character and its mind
// accepts (or, in the proof, a runner says it and the rule the world declares decides): an accepted
// act is an input like a stick move. It is queued with SimWorld.speak, takes effect on the next
// tick as a `spoken` event the world's rules react to, and is logged with that tick, so a run with a
// bribe in it replays exactly. Nothing an act says can do more than the rules it sets off.
import { ACTS, type Act } from "@ghostrun/ir";

export interface SpeechAct {
  /** Who it is said to (an NPC's id). */
  to: string;
  act: Act;
  /** What is handed over or asked for: a purse word ("coins"), an item's id, a commanded option; "" for nothing. */
  what: string;
  /** How many (the coins offered); 0 when it isn't a count. */
  n: number;
  /** A booking's slot, the visitor's local date and time ("2026-11-07T15:00"); "" for anything else. */
  slot: string;
}

/** A guard (or anyone) in this state sees nothing: what a bribe buys, for as long as the rule says. */
export const LOOK_AWAY = "look_away";

const SLOT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const WHAT = /^[a-z0-9_.]{0,48}$/;

/**
 * An act as it rides in the cast's choice log, beside the options minds pick ("act:offer:coins:20",
 * "act:book::2026-11-07T15:00"): share links, races and replays carry it as they carry a choice.
 */
export function encodeAct(a: SpeechAct): string {
  return `act:${a.act}:${a.what}:${a.slot || a.n}`;
}

/** The act a log entry holds, or null when it is a plain menu choice (or not a well-formed act). */
export function decodeAct(npc: string, option: string): SpeechAct | null {
  if (!option.startsWith("act:")) return null;
  const [, act = "", what = "", ...rest] = option.split(":");
  const v = rest.join(":");
  if (!(ACTS as readonly string[]).includes(act) || !WHAT.test(what)) return null;
  if (SLOT.test(v)) return { to: npc, act: act as Act, what, n: 0, slot: v };
  return /^\d{1,6}$/.test(v) ? { to: npc, act: act as Act, what, n: Number(v), slot: "" } : null;
}
