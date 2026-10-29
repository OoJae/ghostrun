// What failed, in words a model can act on: the receipt's counterexamples (and the fill lines the
// parser rejected) turned into concrete repair requests that say what to change, plus the score a
// repaired world must beat to be kept.
import { clampLaws, ENTITY_KINDS, type Entity, type FillNote, type Rule, type WorldBundle } from "@ghostrun/ir";
import { SHOOT, verb } from "@ghostrun/kits";
import { clampParams } from "@ghostrun/plugin-api";
import { hitPoints, playerWeapons } from "./t0";
import { zonesNeeding } from "./t1";
import type { Receipt } from "./types";

/**
 * The repair requests for a receipt; `lines` are the parser's notes on the fill (a rejected line
 * is often why a rule or the win went missing, so those come first).
 */
export function issuesOf(r: Receipt, b: WorldBundle, lines: readonly FillNote[] = []): string[] {
  // (a world that proves fine is left alone, whatever lines it lost)
  const failing = r.chips.some((c) => c.status === "counterexample") || (b.mode === "play" && !r.chips.some((c) => c.id === "T3:win"));
  const out: string[] = failing ? lineIssues(lines, b) : [];
  const goal = b.entities.find((e) => e.kind === "goal");
  for (const c of r.chips) {
    if (c.status !== "counterexample") continue;
    const cx = c.cx?.text ?? "";
    if (c.id === "T0:win_chain") out.push(`No chain of rules lets the player win (${c.text}): ${whyNoWin(b)}`);
    else if (c.id === "T3:too_easy") out.push(`AI runners win in ${c.cx?.have ?? "?"} s without engaging the world: ${tooEasy(b)}`);
    else if (c.id === "T3:win") out.push(`AI runners could not win in 2 minutes of play (${cx || c.text}). ${whyLost(b, cx)}`);
    else if (c.tier === "T2") {
      const rule = b.rules.find((x) => x.id === c.subject.id);
      const numeric = rule?.if.some((x) => /\.(hp|score)$|^team:/.test(x.l));
      const conds = rule?.if.length ? `${/but not/.test(cx) ? "" : ` Its conditions: ${rule.if.map(cond).join(", ")}.`}${numeric ? ' Hit points and scores are numbers ("r":0, never "0").' : ""}` : "";
      const said = cx || "fails when its trigger is forced";
      out.push(`Rule ${c.subject.id} ${said}${said.includes(":") ? ". Fix" : ": fix"} its trigger, conditions or the verb that should cause it.${conds}`);
    } else if (c.id.startsWith("T1:range:")) out.push(`Rule ${c.subject.id} needs a shot that can't land (${cx || c.text}): put the target in the open, within the weapon's range of ground the player can reach, or give the combat_sport.shoot verb more range.`);
    else if (c.id.startsWith("T1:drive:")) out.push(`The race can't be driven (${cx || c.text}): put the line and every gate (the racing.track gates) on open ground a vehicle can drive to, a few metres apart, with no jump on the way.`);
    else if (c.id.startsWith("T1:laps:")) out.push(`Rule ${c.subject.id} asks for more laps than the clock allows (${cx}): fewer laps, or a longer timer.`);
    else if (c.tier === "T1" || c.id.startsWith("T3:x")) {
      const x = b.expects.find((e) => e.id === c.subject.id);
      const k = Number(/jumps>=(\d+)/.exec(x?.need.join(",") ?? "")?.[1] ?? 0);
      const real = x && k ? zonesNeeding(b, clampLaws(b.laws), x.a, k) : [];
      out.push(`Expectation ${c.subject.id} ("${c.text.split(":")[0]}") is false: ${cx}.${real.length ? ` Zones that really need ${k} jumps from ${x!.a}: ${real.map((z) => `${z} (${b.zones.find((q) => q.id === z)?.name ?? z})`).join(", ")}; point b at one and rewrite the text to match.` : " Fix the claim or the geometry."}`);
    } else out.push(`${c.id}: ${c.text}${cx ? ` (${cx})` : ""}`);
  }
  // (said already when the rule graph has no win at all)
  if (b.mode === "play" && !r.chips.some((c) => c.id === "T3:win") && !r.chips.some((c) => c.id === "T0:win_chain" && c.status === "counterexample")) out.push(`The world has no winnable objective the AI runners could play.${goal ? "" : " Add a goal or a rival to beat, and a win rule that depends on it."}`);
  if (b.mode === "wander") {
    const sights = new Set(b.verbs.filter((v) => v.verb === "social.inspect" || v.verb === "puzzle.switch").map((v) => v.on));
    if (sights.size < 5) out.push(`This place has only ${sights.size} thing(s) to look at or use. Add 6-10 inspectable things (ent + social.inspect with a real one-line text) spread over different zones and anchors, and a guide npc.`);
  }
  return out.slice(0, 8);
}

/**
 * Lower is better: counterexamples first, then a red headline, then no runner winning. A play world
 * whose rules can't be played at all (no runner ran: the win chain broke) is worse than any played
 * one, however many checks it no longer reaches.
 */
export function badness(r: Receipt): number {
  const cx = r.chips.filter((c) => c.status === "counterexample").length;
  const head = r.headline?.status === "counterexample" ? 1 : 0;
  const win = r.chips.find((c) => c.id === "T3:win");
  const lose = win ? (win.n - win.k) / Math.max(1, win.n) : 1;
  const unplayed = !win && r.chips.some((c) => c.id === "T0:win_chain") ? 1 : 0;
  return cx * 10 + head * 5 + lose * 3 + unplayed * 15;
}

export const better = (repaired: Receipt, original: Receipt) => badness(repaired) < badness(original);

const r1 = (x: number) => Math.round(x * 10) / 10;
const flat = (a: readonly number[], c: readonly number[]) => Math.sqrt((a[0]! - c[0]!) * (a[0]! - c[0]!) + (a[2]! - c[2]!) * (a[2]! - c[2]!));
const cond = (c: Rule["if"][number]) => `${c.l} ${c.op} ${JSON.stringify(c.r)}`;
const spawnOf = (b: WorldBundle) => b.entities.find((e) => e.kind === "spawn" && e.team === "red") ?? b.entities.find((e) => e.kind === "spawn");
const fights = (b: WorldBundle) => b.verbs.some((v) => v.verb === SHOOT);
/** Where a thing is, in words: its zone, how far from the spawn and how high above it. */
function where(b: WorldBundle, e: Entity): string {
  const sp = spawnOf(b);
  const zone = b.zones.find((z) => z.id === e.zone);
  const up = sp ? r1(e.pos[1] - e.size[1] / 2 - sp.pos[1]) : 0;
  return `in ${e.zone}${zone?.name ? ` (${zone.name})` : ""}${sp ? `, ${Math.round(flat(e.pos, sp.pos))} m from the spawn${up >= 1 ? ` and ${up} m above it` : ""}` : ""}`;
}

/** The rivals' guns, clamped as the sim plays them: who, how hard, how often, how far. */
function rivalGuns(b: WorldBundle): { on: string; damage: number; cooldown: number; range: number }[] {
  const spec = verb(SHOOT)!.params;
  const npcs = new Set(b.entities.filter((e) => e.kind === "npc" && e.team !== "red").map((e) => e.id));
  return b.verbs.filter((v) => v.verb === SHOOT && npcs.has(v.on)).map((v) => {
    const p = clampParams(spec, v.params);
    return { on: v.on, damage: Number(p.damage), cooldown: Number(p.cooldown), range: Number(p.range) };
  });
}

/** The player's best weapon (its own first), and how many of its hits wear `id` down. */
function hitsFor(b: WorldBundle, id: string): { range: number; damage: number; cooldown: number; hits: number; hp: number } | null {
  const w = playerWeapons(b).sort((x, y) => Number(x.held) - Number(y.held) || y.damage - x.damage)[0];
  const hp = hitPoints(b).get(id);
  if (!w || hp === undefined) return null;
  return { range: w.range, damage: w.damage, cooldown: w.cooldown, hp, hits: w.damage > 0 ? Math.ceil(hp / w.damage) : Infinity };
}

/** Why the rule graph has no win: what each win rule waits for, and why nothing gives it. */
function whyNoWin(b: WorldBundle): string {
  const wins = b.rules.filter((r) => r.then.some((e) => e.e === "win"));
  if (!wins.length) {
    const rival = b.entities.find((e) => e.kind === "npc" && e.team !== "red");
    return fights(b) && rival
      ? `no rule wins the game. Add one for beating the rivals, e.g. {"op":"rule","id":"r_win","when":{"t":"health_lte","a":"${rival.id}","n":0},"then":[{"e":"win","target":"player"}],"once":true}.`
      : "no rule wins the game. Add a win rule that depends on the objective (bring the item to the goal, collect them all, flip every switch).";
  }
  const why = wins.slice(0, 2).map((r) => {
    const w = r.when;
    const ent = (id: string) => b.entities.find((e) => e.id === id);
    const pre = r.if.length ? ` (and needs ${r.if.map(cond).join(", ")})` : "";
    if (w.t === "score_gte") {
      const scorers = b.rules.filter((x) => x.then.some((e) => e.e === "score" && e.target === w.a));
      const team = w.a.replace("team:", "");
      if (!scorers.length) return `${r.id} waits for ${team} to score ${w.n}, but no rule scores for ${team}${fights(b) ? ` (a hit on a rival scoring for ${team} is {"t":"hit","a":"team:${team === "red" ? "blue" : "red"}","b":""} → {"e":"score","target":"${w.a}","n":1})` : ""}`;
      return `${r.id} waits for ${team} to score ${w.n}, and nothing the player can do sets off ${scorers.map((x) => x.id).join(", ")}${pre}`;
    }
    if (w.t === "enter" || w.t === "exit") {
      const s = ent(w.b);
      if (!s) return `${r.id} waits for ${w.a || "someone"} to ${w.t} '${w.b}', which is not in the world${pre}`;
      if (w.a !== "player" && !b.verbs.some((v) => v.on === w.a && v.verb.endsWith(".carry"))) return `${r.id} waits for ${w.a} to ${w.t} ${w.b}, but nothing carries ${w.a} there (bind physics_props.carry on it)${pre}`;
    }
    if (w.t === "health_lte") {
      if (!hitPoints(b).has(w.a) && !w.a.startsWith("team:")) return `${r.id} waits for ${w.a || "someone"} to be knocked out, but ${w.a || "nobody"} has no hit points (bind combat_sport.health on it)`;
      if (!playerWeapons(b).some((x) => x.damage > 0) && !b.verbs.some((v) => v.verb === "combat_sport.throw")) return `${r.id} waits for ${w.a} to be knocked out, but the player has nothing that hurts (bind combat_sport.shoot on "player")`;
    }
    return `${r.id} (when ${w.t}${w.a ? ` ${w.a}` : ""}${w.b ? ` ${w.b}` : ""}) can't be set off by anything the player can do${pre}`;
  });
  return `${why.join("; ")}. Fix the win rule or what it waits for.`;
}

/** Too easy: what the win is, how near and how quick, and what would make it a game. */
function tooEasy(b: WorldBundle): string {
  const sp = spawnOf(b);
  const ko = b.rules.find((r) => r.when.t === "health_lte" && r.then.some((e) => e.e === "win") && b.entities.some((e) => e.id === r.when.a));
  const target = ko && b.entities.find((e) => e.id === ko.when.a);
  if (ko && target) {
    const h = hitsFor(b, target.id);
    const d = sp ? Math.round(flat(target.pos, sp.pos)) : null;
    const near = h && d !== null && d < h.range ? `, in your weapon's ${h.range} m range from the start` : "";
    return `the win is knocking out ${target.id}, ${d !== null ? `${d} m from the spawn` : "near the spawn"}${near}${h ? `, down in ${h.hits} hit${h.hits > 1 ? "s" : ""} of ${h.damage}` : ""}. Make it a fight: move ${target.id} out of range (behind cover or up on a deck), give it more hp, or make ${ko.id} need more first (e.g. {"l":"<other>.hp","op":"lte","r":0} in its if).`;
  }
  const goal = b.entities.find((e) => e.kind === "goal");
  if (!goal) return "the win does not depend on the objective. Make the win require it (carrying the item in, a locked door with its key elsewhere, or collecting things first).";
  const doors = b.entities.filter((e) => e.kind === "door" && e.zone === goal.zone).map((e) => `${e.id}@${e.anchor}`);
  return `the win does not depend on the objective. ${goal.id} is ${where(b, goal)}; doors in that zone: ${doors.length ? doors.join(", ") : "none"}. Make the win require it (carry the item into ${goal.id}, a locked door with its key elsewhere on the goal room's doorway, or collecting things first), or move ${goal.id} further from the spawn with obstacles on the way.`;
}

/** Why runs didn't win, from the runs' endings: lost to someone's fire, or stuck on a step. */
function whyLost(b: WorldBundle, cx: string): string {
  const generic = "Make the objective reachable on foot or within the allowed jumps, and make every door on the way openable.";
  const shooters = [...cx.matchAll(/(?:knocked out|shot) by ([a-z][a-z0-9_]*)/g)].map((m) => m[1]!);
  if (shooters.length) {
    const guns = rivalGuns(b);
    const named = guns.filter((g) => shooters.includes(g.on));
    const all = named.length ? named : guns;
    const hp = hitPoints(b).get("player");
    const dps = all.reduce((n, g) => n + g.damage / Math.max(0.15, g.cooldown), 0);
    const oneHit = b.rules.find((r) => r.when.t === "hit" && (r.when.a === "player" || r.when.a === "team:red") && r.then.some((e) => e.e === "lose"));
    const mine = all.map((g) => hitsFor(b, g.on)).filter((x): x is NonNullable<typeof x> => x !== null);
    const hits = mine.reduce((n, x) => n + x.hits, 0);
    const odds = `${all.map((g) => g.on).join(", ")} deal${all.length === 1 ? "s" : ""} ${[...new Set(all.map((g) => g.damage))].join("/")} every ${[...new Set(all.map((g) => g.cooldown))].join("/")} s (${r1(dps)} HP/s${all.length > 1 ? " together" : ""})`;
    const you = oneHit ? `and ${oneHit.id} loses on the first hit` : hp !== undefined ? `against your ${hp} HP (down in about ${r1(hp / Math.max(1e-6, dps))} s)` : "";
    const back = hits ? `, while knocking ${all.length === 1 ? "it" : "them"} out takes ${hits} of your hits${mine[0] ? ` (${mine[0].damage} every ${mine[0].cooldown} s)` : ""}` : "";
    const fix = oneHit ? `lose on a knock-out instead ({"t":"health_lte","a":"player","n":0} with combat_sport.health on the player)` : "give the player more hp (combat_sport.health on player)";
    return `Runs are lost to the rivals' fire: ${odds} ${you}${back}. Make the fight winnable: ${fix}, less damage or a longer cooldown on their combat_sport.shoot, or cover (fixed props) between them and the spawn.`;
  }
  const step = /at '([a-z]+) ([a-z0-9_:,]+)'/.exec(cx);
  if (!step) return generic;
  const [, act, what] = step;
  const e = b.entities.find((x) => x.id === what);
  if (act === "shoot" && e) {
    const h = hitsFor(b, e.id);
    // too tough to wear down in a run (a minute of firing at most), else out of reach
    if (h && h.hits * h.cooldown > 60) return `Runners got stuck shooting ${e.id}: it has ${h.hp} HP and your weapon does ${h.damage} every ${h.cooldown} s (${h.damage > 0 ? `${h.hits} hits` : "it can't be hurt"}). Lower its hp (combat_sport.health) or raise the damage of your combat_sport.shoot.`;
    return `Runners got stuck shooting ${e.id}: it stands ${where(b, e)}${h ? `, and your weapon reaches ${h.range} m` : ""}. Put ${e.id} on ground the player can walk to, with a clear line to it, or give combat_sport.shoot more range.`;
  }
  if (act === "deliver" && e) {
    const at = b.rules.find((r) => r.when.t === "enter" && r.when.b === e.id && r.if.length);
    return at ? `Runners got to ${e.id} but ${at.id} did not fire there: it also needs ${at.if.map(cond).join(", ")}. Check those can be true by then (hit points and scores are numbers, "r":0).` : `Runners couldn't get into ${e.id}: it stands ${where(b, e)}. ${generic}`;
  }
  return e ? `Runners got stuck trying to ${act} ${e.id}: it stands ${where(b, e)}. ${generic}` : generic;
}

/** A shape for each op the repair can copy (kept to what is required). */
const SHAPE: Record<string, string> = {
  ent: `{"op":"ent","id":"crate_1","kind":"prop","noun":"crate","zone":"<zone id>","anchor":"<anchor>","body":"fixed"}`,
  goal: `{"op":"goal","id":"exit","zone":"<zone id>","anchor":"<anchor>","noun":"exit door"}`,
  verb: `{"op":"verb","id":"vb_x","verb":"<kit.verb>","on":"<entity id or player>","params":{}}`,
  rule: `{"op":"rule","id":"r_x","when":{"t":"enter","a":"player","b":"<sensor id>"},"if":[],"then":[{"e":"win","target":"player"}],"once":true}`,
  npc: `{"op":"npc","id":"guard_1","role":"rival","zone":"<zone id>","anchor":"<anchor>","team":"blue","menu":["rival.attack"]}`,
};

/**
 * Fill lines the parser threw away (gameplay only), with what to write instead; lines thrown away
 * for the same reason are one issue ("rules r_tag_red, r_tag_blue were dropped: they name …").
 */
function lineIssues(notes: readonly FillNote[], b: WorldBundle): string[] {
  const groups = new Map<string, { which: string[]; how: string; say: (many: boolean) => string }>();
  for (const n of notes) {
    if (n.op === "dress" || n.op === "poster" || n.op === "meta" || n.op === "end") continue; // (looks, never the proof)
    let key = "";
    let how = "rejected";
    let say: (many: boolean) => string = () => "";
    if (n.kind === "unresolved") {
      const refs = [...n.text.matchAll(/'([^']+)'/g)].map((m) => m[1]!).filter((x) => x !== n.op).map((x) => `'${x}'`).join(", ") || "an id";
      [key, how] = [`u:${refs}`, "dropped"];
      say = (many) => `${many ? "they name" : "it names"} ${refs}, which nothing in the world is. Use an id that exists, "player", or "team:red"/"team:blue" (anyone on that team).`;
    } else if (n.kind === "invalid") {
      const bad = /^kind:.*received "([^"]+)"/.exec(n.text)?.[1];
      // "crystal_hp" with kind "health": the crystal's hit points
      const owner = n.id?.replace(/_(hp|health|hit_?points|life)$/, "");
      const on = owner && (owner === "player" || b.entities.some((e) => e.id === owner)) ? owner : "";
      if (bad && /health|hp|hit_?points|life/.test(bad)) {
        key = `hp:${bad}`;
        say = () => `"${bad}" is not a kind. Hit points are a verb on whoever has them, e.g. {"op":"verb","id":"vb_hp_${on || "x"}","verb":"combat_sport.health","on":"${on || "<id>"}","params":{"hp":100}}.`;
      } else if (n.text.startsWith("kind:")) {
        key = `kind:${bad ?? ""}`;
        say = () => `${bad ? `kind "${bad}" is not a kind` : "it has no kind"}; an ent needs one of ${ENTITY_KINDS.join("|")}, e.g. ${SHAPE.ent}.`;
      } else {
        key = `x:${n.op ?? ""}:${n.text}`;
        say = () => `${n.text.replace(/Invalid (key|type): /, "")}.${n.op && SHAPE[n.op] ? ` A valid ${n.op} line: ${SHAPE[n.op]}.` : ""}`;
      }
    }
    if (!key) continue;
    const g = groups.get(key) ?? { which: [], how, say };
    g.which.push(n.id ? `${n.op ?? "line"} ${n.id}` : `fill line ${n.line}`);
    groups.set(key, g);
  }
  const out = [...groups.values()].map((g) => {
    const ops = [...new Set(g.which.map((w) => w.split(" ")[0]!))];
    const many = g.which.length > 1;
    const names = many && ops.length === 1 && ops[0] !== "fill" ? `${ops[0]}s ${g.which.map((w) => w.split(" ")[1]).join(", ")}` : g.which.join(", ");
    return `${names} ${many ? "were" : "was"} ${g.how}: ${g.say(many)}`;
  });
  // (a few, the first first: the rest usually share the cause)
  return out.slice(0, b.mode === "play" ? 3 : 2);
}
