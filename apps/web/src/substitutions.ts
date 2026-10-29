// What a prompt can ask for that the kits can't do yet, and the one honest line the Intent card
// says about it. Edit freely: `ask` is matched against the prompt, `has` against the built world's
// verb ids, and the note shows only when the prompt asks and the world has no such verb.
import type { WorldBundle } from "@ghostrun/ir";

export interface Substitution {
  ask: RegExp;
  /** A verb id that would do it for real (once a kit has one, the note goes away by itself). */
  has: RegExp;
  note: string | ((prompt: string, verbs: ReadonlySet<string>) => string);
}

export const SUBSTITUTIONS: readonly Substitution[] = [
  {
    ask: /\b(cars?|race ?cars?|vehicles?|driv(e|es|ing|er)|go-?karts?|karts?|trucks?|motor(bike|cycle)s?|sail(s|ing)?|pilot(s|ing)?|boat races?)\b/i,
    has: /^vehicle\.|\.(drive|ride|pilot|steer)$/,
    note: (p) => (/\brac(e|es|ing)\b/i.test(p) ? "No vehicles yet: you race on foot" : "No vehicles yet: you play it on foot"),
  },
  {
    ask: /\b(fly|flies|flying|soar(s|ing)?|jetpacks?)\b/i,
    has: /\.(fly|glide|jetpack|hover)$/,
    note: "No flying yet: you get up high by jumping",
  },
  {
    ask: /\b(swim(s|ming)?|div(e|es|ing)|underwater|scuba|snorkel(s|ling)?)\b/i,
    has: /\.(swim|dive)$/,
    note: "No swimming yet: water is scenery, you stay on foot",
  },
  {
    // a basketball's "shoot five hoops" is a throw, not a gun
    ask: /\b(shoot(s|ing)?(?!\s+(\w+\s+)?(hoops?|baskets?|goals?|the ball|a ball|pucks?))|shooters?|guns?|blasters?|pistols?|rifles?|laser tag|bows? and arrows?|arrows?|spells?|fireballs?|wands?|magic missiles?)\b/i,
    has: /^combat_sport\.shoot$/,
    note: (_p, verbs) => (verbs.has("combat_sport.throw") ? "No shooting yet: you throw instead" : "No shooting yet: you win by moving and using things"),
  },
];

/** The note for this prompt and world, or null when the world does what was asked. */
export function substitution(prompt: string, bundle: Pick<WorldBundle, "verbs">): string | null {
  const verbs = new Set(bundle.verbs.map((v) => v.verb));
  for (const s of SUBSTITUTIONS) {
    if (!s.ask.test(prompt) || [...verbs].some((v) => s.has.test(v))) continue;
    return typeof s.note === "string" ? s.note : s.note(prompt, verbs);
  }
  return null;
}
