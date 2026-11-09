// The person's own corrections to a world's intent, from the Intent card ("rebuild it as a maze",
// "make it a race", "just let me explore"): the fields they pinned, each checked as the intent
// schema checks it, replace what the intent model chose, so the fill is written for them. Safety
// is never pinnable: the model's verdict on the prompt stands.
import * as v from "valibot";
import { IntentOut } from "./prompts";

const { pack, sub, mode, genre } = IntentOut.entries;

export const IntentPin = v.strictObject({
  pack: v.optional(v.pipe(pack, v.maxLength(24))),
  sub: v.optional(v.pipe(sub, v.maxLength(3))),
  mode: v.optional(mode),
  genre: v.optional(v.pipe(genre, v.trim(), v.minLength(1), v.maxLength(48))),
});
export type IntentPin = v.InferOutput<typeof IntentPin>;

/**
 * A pin from a request: valid fields only (a pack the registry has, sub-zones that pack has), or
 * an error saying what was wrong. No pin at all is `{}`.
 */
export function readPin(raw: unknown, subsOf: (pack: string) => readonly string[] | undefined): { ok: true; pin: IntentPin } | { ok: false; error: string } {
  if (raw == null) return { ok: true, pin: {} };
  const r = v.safeParse(IntentPin, raw);
  if (!r.success) return { ok: false, error: `bad intent: ${r.issues[0]?.message ?? "invalid"}`.slice(0, 120) };
  const pin = r.output;
  if (pin.pack !== undefined && !subsOf(pin.pack)) return { ok: false, error: `bad intent: no pack '${pin.pack}'` };
  const allowed = pin.pack !== undefined ? subsOf(pin.pack)! : undefined;
  if (pin.sub && allowed && pin.sub.some((s) => !allowed.includes(s))) return { ok: false, error: `bad intent: pack '${pin.pack}' has no sub-zone ${pin.sub.find((s) => !allowed.includes(s))}` };
  return { ok: true, pin };
}

/** The model's intent with the pinned fields in place (a pinned pack keeps only the sub-zones it has). */
export function pinIntent(intent: IntentOut, pin: IntentPin, subsOf: (pack: string) => readonly string[] | undefined): IntentOut {
  const out: IntentOut = { ...intent };
  if (pin.pack !== undefined) out.pack = pin.pack;
  if (pin.mode !== undefined) out.mode = pin.mode;
  if (pin.genre !== undefined) out.genre = pin.genre;
  if (pin.sub !== undefined) out.sub = pin.sub;
  else if (pin.pack !== undefined) out.sub = intent.sub.filter((s) => subsOf(pin.pack!)?.includes(s));
  return out;
}

/** The intent call's line about a pin: what the person chose, to keep and to fit the rest to. */
export function pinLine(pin: IntentPin): string {
  return `The person chose these themselves: ${JSON.stringify(pin)}. Keep them exactly, and write every other field to fit them (a headline the chosen pack and genre can show).`;
}
