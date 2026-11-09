// The receipt in the player's language. The proof writes its chips in English (its output is the
// same on every device, so it can be compared and shared); here the client words them: the labels'
// templates through t(), and the tiers' most common sentences by their shape. A sentence of a shape
// not listed here stays in the proof's own English rather than being guessed at.
import { chipLineIn, type Chip, type Words } from "@ghostrun/proof/light";
import { k, t, tn } from ".";

export const words: Words = Object.assign((s: string, vars?: Readonly<Record<string, string | number>>) => t(s, vars), { n: tn });

/** The tiers' sentences, by shape: the English pattern, and the template its parts fill in. */
const SHAPES: readonly [RegExp, string, readonly string[]][] = [
  [/^all (\d+) rules reference existing things$/, k("all {n} rules reference existing things"), ["n"]],
  [/^walked to and inspected (\d+) of (\d+) things$/, k("walked to and inspected {k} of {n} things"), ["k", "n"]],
  [/^couldn't reach (.+)$/, k("couldn't reach {what}"), ["what"]],
  [/^([a-z][a-z0-9_]*) fires exactly once$/, k("{rule} fires exactly once"), ["rule"]],
  [/^AI runners won by playing it(.*) \(AI par ([\d.]+) s\)$/, k("AI runners won by playing it{vs} (AI par {s} s)"), ["vs", "s"]],
  [/^no AI runner could win(.*)$/, k("no AI runner could win{vs}"), ["vs"]],
  [/^won in ([\d.]+) s: over almost before it starts$/, k("won in {s} s: over almost before it starts"), ["s"]],
  [/^apex ([\d.]+) m < ledge ([\d.]+) m$/, k("apex {a} m < ledge {b} m"), ["a", "b"]],
  [/^runners still win whatever the cast's minds choose \((\d+) schedules\)$/, k("runners still win whatever the cast's minds choose ({n} schedules)"), ["n"]],
  [/^physics, (\d+) AI runners$/, k("physics, {n} AI runners"), ["n"]],
  [/^forced-state ≤(\d+) ticks$/, k("forced-state ≤{n} ticks"), ["n"]],
  [/^physics jump witness, (\d+) attempts per jump count$/, k("physics jump witness, {n} attempts per jump count"), ["n"]],
  [/^physics, (\d+) menu schedules × (\d+) runners$/, k("physics, {n} menu schedules × {k} runners"), ["n", "k"]],
  // team AI: a command forced on a teammate (proof commands.ts)
  [/^the ([a-z]+) ([a-z][a-z0-9_]*) plays ([a-z0-9_.]+) when told$/, k("the {role} {npc} plays {option} when told"), ["role", "npc", "option"]],
  [/^told ([a-z0-9_.]+), it got no nearer where that takes it$/, k("told {option}, it got no nearer where that takes it"), ["option"]],
  [/^told ([a-z0-9_.]+), it kept playing what it played$/, k("told {option}, it kept playing what it played"), ["option"]],
];
/** Whole sentences the tiers write as they are. */
const WHOLE = [
  k("static def-use"), k("static goal regression over rules"), k("physics, an AI visitor walks to and uses each"), k("kinematic reachability (jump apex model)"),
  k("line-of-sight range model (from ground the jump model reaches)"), k("drivability model (ground a vehicle drives to, turning circle, top speed)"),
  k("race-time model (laps × the shortest lap ÷ top speed with boost)"), k("win unreachable in the rule graph"), k("a choice the cast's minds can make stops every runner"),
];

/** One of the proof's sentences in the player's language, if its shape is known; else as the proof wrote it. */
export function proofText(s: string): string {
  if (WHOLE.includes(s)) return t(s);
  for (const [re, template, names] of SHAPES) {
    const m = re.exec(s);
    // numbers stay as the proof wrote them (a rule id or a count is not a quantity to reformat)
    if (m) return t(template, Object.fromEntries(names.map((k, i) => [k, m[i + 1] ?? ""])));
  }
  return s;
}

export const chipLineT = (c: Chip) => chipLineIn(c, words, proofText);
