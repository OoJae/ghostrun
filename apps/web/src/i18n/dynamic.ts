// Words that reach t() as values rather than as literals: a world's mode, where a receipt was proved,
// a headline's status, the Feng Shui rules' names and school (packages/layout), the stopwatch's
// splits. Listed here so every locale has them (the key test reads this file with the rest).
import { FENG_SHUI_RULES, FENG_SHUI_SCHOOL } from "@ghostrun/layout";
import { k } from ".";

export const DYNAMIC: readonly string[] = [
  k("play"), k("wander"),
  k("node"), k("edge"), k("device"),
  k("verified"), k("played"), k("modelled"), k("not checkable"), k("counterexample"),
  k("Form School"),
  k("Command position"), k("No straight line through"), k("No mirror facing the front door"), k("A clear way in"), k("Uncluttered rooms"), k("Five elements in balance"),
  k("gpu init"), k("build"), k("compile"), k("frame"), k("edit"), k("race"), k("gallery"), k("fill"), k("layout"),
  // the Intent card's choices and fields (card.ts, render/pick.ts)
  k("Jumps"), k("Gravity"), k("Speed"), k("Look"), k("Weather"), k("Genre"), k("Pack"), k("game"),
  k("normal"), k("moon"), k("zero-g"), k("slow"), k("fast"), k("day"), k("dusk"), k("night"),
  k("clear"), k("rain"), k("snow"), k("fog"), k("storm"),
  k("capture the flag"), k("heist"), k("escape"), k("collect"), k("duel"), k("parkour"), k("tour"), k("hide and seek"), k("survival"),
  k("Neon city"), k("Grove"), k("Gallery"), k("Aquarium"), k("Desert"), k("Beach"), k("Seabed"), k("Snow"), k("Ice cave"), k("Space station"),
  k("Moon"), k("Haunted"), k("Haunted library"), k("Medieval"), k("Wizard school"), k("Candy"), k("Jungle"), k("Home"), k("Tea house"), k("Library"),
];

/** The names the layout package gives, which must be among the keys above. */
export const NAMED: readonly string[] = [FENG_SHUI_SCHOOL, ...FENG_SHUI_RULES.map((r) => r.name)];
