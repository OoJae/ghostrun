// The Logic X-ray in words: one WHEN / IF / THEN sentence per rule, built as the tiles the X-ray
// draws (a thing, a word or a value) and said as plain text for anything that reads instead of
// looks (the MCP tools). Rules on a bonus pickup are the world's secrets, told apart from the game.
import type { Rule, VerbBinding, WorldBundle } from "./schema";

/** One tile of a sentence: a thing in the world (by id), a word, or a value. */
export interface Tile {
  kind: "thing" | "word" | "value";
  id: string;
}

export interface RuleTiles {
  when: Tile[];
  /** One group per IF condition. */
  conds: Tile[][];
  /** One group per THEN effect. */
  effects: Tile[][];
  once: boolean;
}

const WHEN: Record<string, string> = {
  enter: "enters", exit: "leaves", pickup: "is picked up by", drop: "is dropped by", touch: "touches", hit: "is hit by",
  state_is: "becomes", score_gte: "reaches", timer_end: "runs out", every: "every",
};

const T = (id: string): Tile => ({ kind: "thing", id });
const W = (id: string): Tile => ({ kind: "word", id });
const V = (id: string): Tile => ({ kind: "value", id });

export function ruleTiles(r: Rule): RuleTiles {
  const w = r.when;
  const when: Tile[] =
    w.t === "every" ? [W("every"), V(`${w.n} s`)]
    : w.t === "score_gte" ? [T(w.a), W("reaches"), V(String(w.n))]
    : w.t === "state_is" ? [T(w.a), W("becomes"), V(w.s)]
    : w.t === "timer_end" ? [W("the timer"), W("runs out")]
    : w.t === "health_lte" ? [T(w.a || "anyone"), ...(w.n > 0 ? [W("drops to"), V(`${w.n} HP`)] : [W("is knocked out")]), ...(w.b ? [W("by"), T(w.b)] : [])]
    : [T(w.a || "anything"), W(WHEN[w.t] ?? w.t), w.b ? T(w.b) : W("anything")];
  const conds = r.if.map((c) => [T(c.l.split(".")[0]!), W(`${c.l.split(".").slice(1).join(" ")} ${c.op === "eq" ? "=" : c.op}`), V(String(c.r))]);
  const effects = r.then.map((e): Tile[] =>
    e.e === "score" ? [W(`+${e.n || 1}`), T(e.target)]
    : e.e === "win" || e.e === "lose" ? [W(e.e === "win" ? "you win" : "you lose")]
    : e.e === "set_state" ? [T(e.target), W("becomes"), V(String(e.v))]
    : e.e === "emit" ? [W("✨"), V(e.fx)]
    : e.e === "teleport" ? [W("send"), T(e.target), W("to"), T(String(e.v))]
    : e.e === "damage" || e.e === "heal" ? [W(`${e.e === "damage" ? "−" : "+"}${e.n || Number(e.v) || 25} HP`), T(e.target)]
    : [W(e.e === "destroy" ? "remove" : e.e), T(e.target)],
  );
  return { when, conds, effects, once: r.once };
}

/** What a thing tile says: the player, a team, or the thing's noun (its id when it has none). */
export function thingLabel(id: string, b: WorldBundle): string {
  if (id === "player") return "player";
  if (id.startsWith("team:")) return `${id.slice(5)} team`;
  return b.entities.find((x) => x.id === id)?.noun || id;
}

const said = (ts: readonly Tile[], b: WorldBundle) =>
  ts
    .map((t) => (t.kind === "thing" && t.id ? thingLabel(t.id, b) : t.id))
    .filter(Boolean)
    .join(" ");

/** "WHEN glowing orb enters neon goal ring THEN +1 red team (once)". */
export function ruleText(r: Rule, b: WorldBundle): string {
  const s = ruleTiles(r);
  const conds = s.conds.map((c) => said(c, b)).join(" and ");
  return `WHEN ${said(s.when, b)}${conds ? ` IF ${conds}` : ""} THEN ${s.effects.map((e) => said(e, b)).join(", ")}${s.once ? " (once)" : ""}`;
}

const ends = (r: Rule) => (r.then.some((e) => e.e === "win" || e.e === "lose") ? 1 : 0);

/**
 * The X-ray's view of a world: its rules (the ones that win or lose last), its secrets (rules on a
 * bonus pickup, said once, not five times over), the verbs worth listing and what the secrets are.
 */
export function logicOf(b: WorldBundle): { rules: Rule[]; secrets: Rule[]; verbs: VerbBinding[]; secretNoun: string } {
  const bonus = new Set(b.entities.filter((e) => e.tags.includes("bonus")).map((e) => e.id));
  return {
    rules: b.rules.filter((r) => !bonus.has(r.when.b)).sort((x, y) => ends(x) - ends(y)),
    secrets: b.rules.filter((r) => bonus.has(r.when.b)),
    verbs: b.verbs.filter((v) => (v.on !== "player" || v.verb === "puzzle.timer") && !bonus.has(v.on)),
    secretNoun: b.entities.find((e) => bonus.has(e.id))?.noun ?? "gem",
  };
}
