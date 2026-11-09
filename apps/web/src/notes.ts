// Design notes the playtest makes, as changes a person could have typed. "Nobody went near: the
// hover platform" offers "put a neon shard on the hover platform" or "take out the hover platform";
// "near the lava pit: hit the lava pit ×4" offers "make the lava pit jump fairer: a wider ledge".
// Each goes through the live edit like a typed change, is re-proved on a copy of the world, and is
// offered only if it holds (no worse a receipt, still won), as the Director's cut is. A Feng Shui
// principle that fails comes with its own fix (fengShuiNotes), offered the same way.
import type { FengShuiSection } from "@ghostrun/layout";
import type { WorldBundle } from "@ghostrun/ir";
import type { FailSpot, Insights, Revealed } from "@ghostrun/proof/light";
import { fengShuiNotes } from "./fengshui";

export interface DesignNote {
  /** Which note: "unused:<entity id>" (nobody went near it), "fail:<i>" (the i-th place runs went wrong). */
  key: string;
  /** One or two concrete changes, as the person might type them. */
  changes: string[];
  /** How each change reads on its button, where that isn't the change itself (a Feng Shui fix names things by id for the model). */
  said?: string[];
}

const an = (noun: string) => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;

/** A reason to go somewhere: a secret like the world's own, else what the world has you collect, else a coin. */
function reward(b: WorldBundle): string {
  const bonus = b.entities.find((e) => e.tags.includes("bonus") && e.noun)?.noun;
  if (bonus) return bonus;
  const collected = new Set(b.verbs.filter((v) => v.verb === "puzzle.collect").map((v) => v.on));
  return b.entities.find((e) => collected.has(e.id) && e.noun)?.noun || "coin";
}

/** Nobody went near it: give players a reason to go there, or take it out. */
export function unusedChanges(b: WorldBundle, id: string): string[] {
  const e = b.entities.find((x) => x.id === id);
  if (!e) return [];
  const noun = e.noun || id.replace(/_/g, " ");
  return [`put ${an(reward(b))} ${e.kind === "platform" ? "on" : "by"} the ${noun}`, `take out the ${noun}`];
}

/** The win's last stop, by name: the player's goal, else "goal". */
function goalOf(b: WorldBundle): string {
  const g = b.entities.find((e) => e.kind === "goal" && (e.team === "red" || !e.team)) ?? b.entities.find((e) => e.kind === "goal");
  return g?.noun || "goal";
}

/**
 * Where runs went wrong, by the commonest reason there (in the causal log's words, as the playtest
 * report says them): a hazard is made fairer, a fight easier, a step reachable, a route shorter.
 * Nothing for a reason no simple change answers.
 */
export function failChanges(b: WorldBundle, f: Pick<FailSpot, "near" | "why">): string[] {
  const why = f.why[0]?.[0] ?? "";
  let m: RegExpExecArray | null;
  if ((m = /^(?:hit|into) the (.+)$/.exec(why))) return [`make the ${m[1]} jump fairer: a wider ledge`, `move the ${m[1]} off the main path`];
  if ((m = /^knocked out(?: by the (.+))?$/.exec(why))) return [`make the ${m[1] ?? "enemies"} hit less hard`, "give the player more hit points"];
  if ((m = /^got stuck(?: on the way to the (.+))?$/.exec(why))) {
    const to = m[1] ?? f.near;
    return to ? [`make the way to the ${to} easier: a ramp or a lower step`, `move the ${to} somewhere easier to reach`] : [];
  }
  if (/^no win by \d+:\d\d$|^the timer ran out$/.test(why)) return [`make the way to the ${goalOf(b)} shorter`, ...(b.verbs.some((v) => v.verb === "puzzle.timer") ? ["put more time on the clock"] : [])];
  if (/^\w+ reached \d+$/.test(why)) return ["make the rivals a little slower", "give the rivals a longer way to their goal"];
  return [];
}

/** Every note in the receipt a change could answer, with its changes (the receipt's own order). */
export function designNotes(b: WorldBundle, seen: Insights | null, rv: Revealed | null, fs: FengShuiSection | null = null): DesignNote[] {
  const out: DesignNote[] = [];
  for (const n of fs ? fengShuiNotes(fs) : []) out.push({ key: n.id, changes: [n.change], said: [n.text.replace(/^Feng Shui: /, "")] });
  for (const u of seen?.unused.slice(0, 4) ?? []) out.push({ key: `unused:${u.id}`, changes: unusedChanges(b, u.id) });
  for (const [i, f] of (rv?.fails ?? []).entries()) out.push({ key: `fail:${i}`, changes: failChanges(b, f) });
  return out.filter((n) => n.changes.length);
}
