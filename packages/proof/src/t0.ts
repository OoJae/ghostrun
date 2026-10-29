// T0, static: every reference resolves, and the win condition is reachable through the rule graph
// by goal regression (win ← score_gte ← score effect ← enter with carrier ← pickup …).
import type { Rule, WorldBundle } from "@ghostrun/ir";
import { SPECIAL_REFS } from "@ghostrun/ir";
import { HEALTH, SHOOT, verb } from "@ghostrun/kits";
import { clampParams, type Cause, type Produces } from "@ghostrun/plugin-api";
import type { Chip } from "./types";

/** One step of the abstract plan T3 executes. */
export type PlanStep =
  | { do: "pickup"; item: string; rule: string } // pick up `item`
  | { do: "deliver"; item: string; sensor: string; rule: string; times: number; want?: Want } // bring `item` (or the player) into `sensor`
  | { do: "use"; at: string; rule: string; want?: Want } // stand by `at` and press USE
  | { do: "touch"; at: string; rule: string; want?: Want } // touch `at`
  | { do: "collect"; items: string[]; rule: string; times: number; rules?: string[] } // touch `items` until the rule(s) fired `times` in all
  | { do: "wait"; rule: string; want?: Want } // let time run (a timer)
  | { do: "throw"; item: string; rule: string; times?: number; want?: Want } // carrying `item`, get a rival in range and press USE
  | { do: "shove"; at: string; from: string; into?: string; rule: string; times?: number; want?: Want } // knock `at` (out of `from`, or into `into`)
  | { do: "shoot"; at: string; weapon?: string; rule: string; times?: number; want?: Want; hp?: number }; // shoot `at` (an id, a team, '' any rival) until the rule fires (with hp: until its hit points are that low)

/** A precondition step is done when `id` is in state `s` (it has no rule of its own to watch). */
export interface Want {
  id: string;
  s: string;
}

/** What each kit verb in the world can produce, and how an agent causes it. */
export function producers(b: WorldBundle): Produces[] {
  const out: Produces[] = [];
  const npcs = new Set(b.entities.filter((e) => e.kind === "npc").map((e) => e.id));
  for (const vb of [...b.verbs].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const p = verb(vb.verb);
    if (!p) continue;
    let made = p.produces?.({ id: vb.id, on: vb.on, params: clampParams(p.params, vb.params), mem: {} }) ?? [];
    // an NPC's own weapon (claws, its spell) fires when it chooses: nothing the player does
    if (p.id === SHOOT && npcs.has(vb.on)) {
      out.push(...made.map((x) => ({ ...x, cause: null })));
      continue;
    }
    out.push(...made);
    // every usable verb also logs touch a=agent b=it when used, with the same preconditions
    if (p.use && !made.some((x) => x.k === "touch" && x.b === vb.on)) {
      const viaUse = made.find((x) => x.cause?.do === "use" && x.cause.at === vb.on)?.cause;
      out.push({ k: "touch", a: "player", b: vb.on, cause: viaUse ?? { do: "use", at: vb.on } });
    }
  }
  return out;
}

/** Entities the world's verbs make carryable (carry, and a lock's key). */
export function carryables(b: WorldBundle): Set<string> {
  const out = new Set(b.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on));
  const npcs = new Set(b.entities.filter((e) => e.kind === "npc").map((e) => e.id));
  for (const vb of b.verbs) {
    const p = verb(vb.verb);
    // (nobody carries a character: a weapon bound on one is its own)
    for (const id of p?.carries?.({ id: vb.id, on: vb.on, params: clampParams(p.params, vb.params), mem: {} }) ?? []) if (p!.id !== SHOOT || !npcs.has(id)) out.add(id);
  }
  const real = new Set(b.entities.map((e) => e.id));
  for (const id of out) if (!real.has(id)) out.delete(id); // a key named in a verb but never placed
  return out;
}

export function causeSteps(c: Cause, rule: string, want?: Want): PlanStep[] {
  const w = want ? { want } : {};
  switch (c.do) {
    case "use":
      return [...(c.holding ? [{ do: "pickup" as const, item: c.holding, rule: "" }] : []), { do: "use", at: c.at, rule, ...w }];
    case "enter":
      return [{ do: "deliver", item: "player", sensor: c.at, rule, times: 1, ...w }];
    case "touch":
      return [{ do: "touch", at: c.at, rule, ...w }];
    case "throw":
      return [{ do: "pickup", item: c.item, rule: "" }, { do: "throw", item: c.item, rule, ...w }];
    case "shove":
      return [{ do: "shove", at: c.at, from: "", rule, ...w }];
    case "shoot":
      return [...(c.weapon ? [{ do: "pickup" as const, item: c.weapon, rule: "" }] : []), { do: "shoot", at: c.at, ...(c.weapon ? { weapon: c.weapon } : {}), rule, ...w }];
  }
}

/**
 * A shot at `w.a`: with the weapon the rule names, or, when it names none, whichever the player has
 * (its own, else one to hold that the runner picks up: models leave two guns lying about).
 */
const anyGun = (c: Extract<Cause, { do: "shoot" }>, w: Rule["when"]): Cause => (w.b ? { ...c, at: w.a } : { do: "shoot", at: w.a });

/** A cause in a few words, for a chain's explanation. */
const said = (c: Cause) => (c.do === "throw" ? `throw ${c.item}` : c.do === "shoot" ? `shoot ${c.at || "a rival"}` : `${c.do} ${c.at}`);

/** Hit points by id (combat_sport.health, clamped), for everything that has them. */
export function hitPoints(b: WorldBundle): Map<string, number> {
  const spec = verb(HEALTH)!.params;
  const out = new Map<string, number>();
  for (const v of [...b.verbs].sort((x, y) => (x.id < y.id ? -1 : 1))) if (v.verb === HEALTH && !out.has(v.on)) out.set(v.on, Number(clampParams(spec, v.params).hp));
  return out;
}

/** The weapons the player can fire: its own (on "player") and ones it can pick up, clamped. */
export function playerWeapons(b: WorldBundle): { id: string; on: string; held: boolean; range: number; speed: number; damage: number; cooldown: number; at: string[] }[] {
  const spec = verb(SHOOT)!.params;
  const npcs = new Set(b.entities.filter((e) => e.kind === "npc").map((e) => e.id));
  const real = new Set(b.entities.map((e) => e.id));
  return [...b.verbs]
    .sort((x, y) => (x.id < y.id ? -1 : 1))
    .filter((v) => v.verb === SHOOT && (v.on === "player" || (real.has(v.on) && !npcs.has(v.on))))
    .map((v) => {
      const p = clampParams(spec, v.params);
      return { id: v.id, on: v.on, held: v.on !== "player", range: Number(p.range), speed: Number(p.speed), damage: Number(p.damage), cooldown: Number(p.cooldown), at: String(p.at).split(",").filter(Boolean) };
    });
}

export interface WinChain {
  winRule: string;
  steps: PlanStep[];
  explain: string; // "win ← r_win (score_gte team:red 3) ← r_score_red (enter orb→goal_red, carrier red) ← pickup orb"
}

const chip = (c: Omit<Chip, "tier" | "n" | "k" | "cx" | "ms"> & Partial<Chip>): Chip => ({ tier: "T0", n: 0, k: 0, cx: null, ms: 0, ...c });

export function t0(b: WorldBundle, playerTeam: "red" | "blue" = "red"): { chips: Chip[]; chain: WinChain | null; openers: Map<string, PlanStep[]> } {
  const t = performanceNow();
  const chips: Chip[] = [];
  const ents = new Map(b.entities.map((e) => [e.id, e]));
  const ids = new Set([...b.entities.map((e) => e.id), ...b.zones.map((z) => z.id), ...b.states.map((s) => s.id), ...b.rules.map((r) => r.id)]);
  // a path ("player.team", "team:red.score") names its head
  const ok = (ref: string) => ref === "" || (SPECIAL_REFS as readonly string[]).includes(ref.split(".")[0]!) || ref.startsWith("tag:") || ids.has(ref.split(".")[0]!);
  const carryable = carryables(b);
  const made = producers(b);
  const collectedSet = new Set(b.verbs.filter((v) => v.verb === "puzzle.collect").map((v) => v.on));
  const hp = hitPoints(b);
  const weapons = playerWeapons(b);
  // things to throw: how much they hurt and what they can be thrown at besides rivals (clamped)
  const throwSpec = verb("combat_sport.throw")!.params;
  const throws = new Map(b.verbs.filter((v) => v.verb === "combat_sport.throw").map((v) => {
    const p = clampParams(throwSpec, v.params);
    return [v.on, { damage: Number(p.damage), at: String(p.at).split(",").filter(Boolean) }] as const;
  }));
  // what has hit points: an id, a team (anyone on it), or '' (anyone at all)
  const healthy = (ref: string): string[] =>
    ref === "" ? [...hp.keys()] : ref.startsWith("team:") ? [...hp.keys()].filter((id) => (id === "player" ? playerTeam : ents.get(id)?.team) === ref.slice(5)) : hp.has(ref) ? [ref] : [];

  // 1. references (hit points included: a knock-out rule on something with none can never fire)
  let bad = 0;
  for (const r of b.rules) {
    const refs = [r.when.a, r.when.b, ...r.if.map((c) => c.l), ...r.then.map((e) => e.target)];
    const missing = refs.filter((x) => !ok(x));
    const noHp = [
      ...(r.when.t === "health_lte" && ok(r.when.a) && !healthy(r.when.a).length ? [`${r.when.a || "anyone"} (health_lte)`] : []),
      ...r.then.filter((e) => (e.e === "damage" || e.e === "heal") && ok(e.target) && !healthy(e.target).length).map((e) => `${e.target} (${e.e})`),
      ...r.if.filter((c) => /^[a-z][a-z0-9_]*\.hp$/.test(c.l) && ok(c.l) && !hp.has(c.l.split(".")[0]!)).map((c) => `${c.l}`),
    ];
    if (missing.length || noHp.length) {
      bad++;
      const text = [missing.length ? `references unknown ${missing.join(", ")}` : "", noHp.length ? `needs hit points nothing has: ${noHp.join(", ")}` : ""].filter(Boolean).join("; ");
      chips.push(chip({ id: `T0:refs:${r.id}`, subject: { kind: "rule", id: r.id }, status: "counterexample", method: "static def-use", text: `rule ${r.id} ${text}`, src: r.src }));
    }
  }
  if (!bad) chips.push(chip({ id: "T0:refs", subject: { kind: "world", id: "refs" }, status: "verified", method: "static def-use", text: `all ${b.rules.length} rules reference existing things`, src: "" }));

  const startState = (id: string): string => {
    const e = ents.get(id);
    if (e?.init) return e.init;
    for (const v of b.verbs) if (v.on === id && verb(v.verb)?.initial) return verb(v.verb)!.initial!;
    return "";
  };

  // 2. win reachability by goal regression
  const rules = [...b.rules].sort((x, y) => (x.id < y.id ? -1 : 1));
  const sat = (r: Rule, depth: number, seen: Set<string>): { steps: PlanStep[]; explain: string } | null => {
    if (depth > 8 || seen.has(r.id)) return null;
    const s2 = new Set(seen).add(r.id);
    const w = r.when;
    // conditions: "<item>.carrier.team eq T" needs the player on team T; "<id>.state eq S" is
    // regressed to whatever makes it S (a verb's cause, or a rule that sets it), done first
    const pre: PlanStep[] = [];
    const preWhy: string[] = [];
    for (const c of r.if) {
      if (c.l.endsWith(".carrier.team") && c.op === "eq" && c.r !== playerTeam) return null;
      // "<item>.carrier.team is red" on a rule about something else: the player must hold <item>
      // first ("reach the platform IF the ticket is carried by red")
      const held = /^([a-z][a-z0-9_]*)\.carrier\.team$/.exec(c.l)?.[1];
      if (held && c.op === "eq" && held !== w.a && carryable.has(held) && !pre.some((x) => x.do === "pickup" && x.item === held)) {
        pre.push({ do: "pickup", item: held, rule: "" });
        preWhy.push(`holding ${held}`);
        continue;
      }
      // "red ahead of blue" or "red has more than N" on the player's team: score that much first
      const team = /^team:(red|blue)(?:\.score)?$/.exec(c.l)?.[1];
      if (team && (c.op === "gt" || c.op === "gte")) {
        if (team !== playerTeam) return null; // it needs the rivals to score: nothing the player can plan
        // a number (models sometimes write it as a string: "5"), or a lead over another score: two to be safe
        const n = typeof c.r === "number" ? c.r : typeof c.r === "string" && c.r.trim() !== "" && Number.isFinite(Number(c.r)) ? Number(c.r) : null;
        const need = n !== null ? (c.op === "gt" ? n + 1 : n) : 2;
        if (need <= 0) continue;
        // the same planning as "team reaches N" (several once-only scorers become one collect step)
        const sub = satTrigger(r, { ...w, t: "score_gte", a: `team:${team}`, n: need }, depth + 1, s2);
        if (!sub) return null;
        pre.push(...sub.steps);
        preWhy.push(`${team} scores ${need}`);
        continue;
      }
      // "<id>.hp eq 0" (or lte / lt n): worn down to it first, the way a health_lte rule would be;
      // the step is done when its hit points get there (the rule it serves fires later)
      const worn = /^([a-z][a-z0-9_]*)\.hp$/.exec(c.l)?.[1];
      if (worn && (c.op === "eq" || c.op === "lte" || c.op === "lt") && Number.isFinite(Number(c.r))) {
        const n = c.op === "lt" ? Number(c.r) - 1e-6 : Number(c.r);
        const sub = satTrigger(r, { ...w, t: "health_lte", a: worn, b: "", n }, depth + 1, s2);
        if (!sub || !sub.steps.some((st) => st.do === "shoot" && st.at === worn)) return null;
        pre.push(...sub.steps.map((st) => (st.do === "shoot" && st.at === worn ? { ...st, rule: "", hp: n } : st)));
        preWhy.push(`${worn} down to ${Math.max(0, Math.round(n))} HP`);
        continue;
      }
      const m = /^([a-z][a-z0-9_]*)\.state$/.exec(c.l);
      if (!m || c.op !== "eq") continue;
      const [id, want] = [m[1]!, String(c.r)];
      if (startState(id) === want) continue;
      // "when the torch is lit, if the torch is lit": the trigger itself makes it so (doing it first
      // and again as the trigger would flip a switch back off)
      if (w.t === "state_is" && w.a === id && w.s === want) continue;
      const p = made.find((x) => x.k === "state" && x.a === id && x.s === want);
      if (p) {
        pre.push(...(p.cause ? causeSteps(p.cause, "", { id, s: want }) : [{ do: "wait" as const, rule: "", want: { id, s: want } }]));
        preWhy.push(`${id} ${want}`);
        continue;
      }
      const setter = rules.find((r2) => r2.id !== r.id && r2.then.some((e) => (e.e === "set_state" && e.target === id && String(e.v) === want) || (e.e === "open" && e.target === id && want === "open")));
      const sub = setter && sat(setter, depth + 1, s2);
      if (!sub) return null;
      pre.push(...sub.steps);
      preWhy.push(`${id} ${want}`);
    }
    // the same pickup twice in a row (a "holding it" condition, then the throw that needs it too) is one
    const dedupe = (st: PlanStep[]) => st.filter((x, i) => !(x.do === "pickup" && i > 0 && st[i - 1]!.do === "pickup" && (st[i - 1] as { item: string }).item === x.item));
    const withPre = (x: { steps: PlanStep[]; explain: string } | null) => (x && pre.length ? { steps: dedupe([...pre, ...x.steps]), explain: `${x.explain} [after ${preWhy.join(", ")}]` } : x);
    return withPre(satTrigger(r, w, depth, s2));
  };
  const satTrigger = (r: Rule, w: Rule["when"], depth: number, s2: Set<string>): { steps: PlanStep[]; explain: string } | null => {
    switch (w.t) {
      case "score_gte": {
        // several rules each scoring one collectible (crystal_1 … crystal_10): one collect step over all
        const scorers = rules.filter((r2) => r2.id !== r.id && r2.then.some((e) => e.e === "score" && e.target === w.a));
        const items = scorers.map((r2) => (r2.when.t === "touch" && collectedSet.has(r2.when.b) ? r2.when.b : "")).filter(Boolean);
        if (scorers.length > 1 && items.length === scorers.length) {
          const per = scorers[0]!.then.find((e) => e.e === "score")!.n || 1;
          const times = Math.max(1, Math.ceil(w.n / per));
          if (times > items.length) return null; // not enough to collect: the goal can't be met
          return { steps: [{ do: "collect", items, rule: scorers[0]!.id, rules: scorers.map((x) => x.id), times }], explain: `${r.id} (${w.a} reaches ${w.n}) ← collect ${times} of ${items.length}` };
        }
        // a scorer that can fire again is repeated; once-only scorers (one per rival knocked out)
        // are chained until the points add up
        // each scorer fires once in turn (knock out every rival, not one rival twice); if that falls
        // short, the first one that can fire again makes up the rest
        const ways: { sub: { steps: PlanStep[]; explain: string }; per: number; once: boolean }[] = [];
        for (const r2 of rules) {
          if (r2.id === r.id) continue;
          const fx = r2.then.find((e) => e.e === "score" && e.target === w.a);
          const sub = fx && sat(r2, depth + 1, s2);
          if (sub) ways.push({ sub, per: fx!.n || 1, once: r2.once });
        }
        const times = ways.map(() => 0);
        let pts = 0;
        for (let i = 0; i < ways.length && pts < w.n; i++) ((times[i] = 1), (pts += ways[i]!.per));
        const again = ways.findIndex((x) => !x.once);
        if (pts < w.n && again >= 0) {
          const more = Math.ceil((w.n - pts) / ways[again]!.per);
          times[again]! += more;
          pts += more * ways[again]!.per;
        }
        if (pts < w.n) return null;
        const steps = ways.flatMap((x, i) => (times[i] ? x.sub.steps.map((st) => (st.do === "deliver" || st.do === "collect" || st.do === "throw" || st.do === "shove" || st.do === "shoot" ? { ...st, times: times[i]! } : st)) : []));
        return { steps, explain: `${r.id} (${w.a} reaches ${w.n}) ← ${ways.filter((_, i) => times[i]).map((x) => x.sub.explain).join(" + ")}` };
      }
      case "enter": {
        const sensor = ents.get(w.b);
        if (!sensor || sensor.body !== "sensor") return null;
        if (w.a === "player") return { steps: [{ do: "deliver", item: "player", sensor: w.b, rule: r.id, times: 1 }], explain: `${r.id} (player enters ${w.b})` };
        // a rival pushed into it (knock the cars into the pit)
        if (made.some((x) => x.k === "exit" && x.a === w.a && x.cause?.do === "shove")) return { steps: [{ do: "shove", at: w.a, from: "", into: w.b, rule: r.id }], explain: `${r.id} (${w.a} knocked into ${w.b})` };
        if (!carryable.has(w.a)) return null;
        return {
          steps: [{ do: "pickup", item: w.a, rule: "" }, { do: "deliver", item: w.a, sensor: w.b, rule: r.id, times: 1 }],
          explain: `${r.id} (${w.a} into ${w.b}${r.if.length ? ", carried by " + playerTeam : ""}) ← pick up ${w.a}`,
        };
      }
      case "pickup":
        return carryable.has(w.a) ? { steps: [{ do: "pickup", item: w.a, rule: r.id }], explain: `${r.id} (pick up ${w.a})` } : null;
      case "every":
        return { steps: [], explain: `${r.id} (every ${w.n} s)` };
      case "state_is": {
        const p = made.find((x) => x.k === "state" && x.a === w.a && x.s === w.s && x.cause);
        if (p) return { steps: causeSteps(p.cause!, r.id), explain: `${r.id} (${w.a} becomes ${w.s}: ${said(p.cause!)})` };
        // set by another rule ("three clues found → the door opens"): whatever fires that rule
        const setter = rules.find((r2) => r2.id !== r.id && r2.then.some((e) => (e.e === "set_state" && e.target === w.a && String(e.v) === w.s) || (e.e === "open" && e.target === w.a && w.s === "open") || (e.e === "close" && e.target === w.a && w.s === "closed")));
        const sub = setter && sat(setter, depth + 1, s2);
        if (sub) return { steps: sub.steps, explain: `${r.id} (${w.a} becomes ${w.s}) ← ${sub.explain}` };
        // a state that comes by itself in time (a countdown's "done"): wait for it
        return made.some((x) => x.k === "state" && x.a === w.a && x.s === w.s && !x.cause) ? { steps: [{ do: "wait", rule: r.id }], explain: `${r.id} (${w.a} becomes ${w.s} when its countdown runs out)` } : null;
      }
      case "exit": {
        // someone knocked out of a ring (a shove)
        const p = made.find((x) => x.k === "exit" && (!w.a || x.a === w.a) && x.cause?.do === "shove");
        if (!p || p.cause?.do !== "shove") return null;
        return { steps: [{ do: "shove", at: p.cause.at, from: w.b, rule: r.id }], explain: `${r.id} (${p.cause.at} knocked out of ${w.b || "the area"})` };
      }
      case "health_lte": {
        // someone worn down by the player: shot (or a rule that hurts them, repeated) until their hit
        // points get there; the player's own falling is the rivals' doing, nothing to plan
        if (w.a === "player" || w.a === `team:${playerTeam}`) return null;
        const who = healthy(w.a).filter((id) => id !== "player");
        if (!who.length) return null;
        const most = Math.max(...who.map((id) => hp.get(id)!));
        const name = w.a || "a rival";
        const shot = made.find((x) => x.k === "hit" && x.cause?.do === "shoot" && (!w.b || x.b === w.b) && (weapons.find((wp) => wp.on === x.b)?.damage ?? 0) > 0);
        if (shot?.cause?.do === "shoot") {
          const dmg = weapons.find((wp) => wp.on === shot.b)!.damage;
          const hits = Math.max(1, Math.ceil((most - w.n) / dmg));
          return { steps: causeSteps(anyGun(shot.cause, w), r.id), explain: `${r.id} (${name} down to ${w.n} HP) ← shoot ${name} (${hits} hit${hits > 1 ? "s" : ""} of ${dmg})` };
        }
        // or something thrown that hurts (a throwing star) at whoever it can hit: a rival, or a thing in its "at"
        const thrown = made.find((x) => x.k === "hit" && x.cause?.do === "throw" && (!w.b || x.b === w.b) && (throws.get(x.cause.item)?.damage ?? 0) > 0 && who.some((id) => throws.get((x.cause as { item: string }).item)!.at.includes(id) || (ents.get(id)?.kind === "npc" && ents.get(id)?.team !== playerTeam)));
        if (thrown?.cause?.do === "throw") {
          const dmg = throws.get(thrown.cause.item)!.damage;
          const hits = Math.max(1, Math.ceil((most - w.n) / dmg));
          return { steps: causeSteps(thrown.cause, r.id), explain: `${r.id} (${name} down to ${w.n} HP) ← throw ${thrown.cause.item} (${hits} hit${hits > 1 ? "s" : ""} of ${dmg})` };
        }
        for (const r2 of rules) {
          const fx = r2.id !== r.id && !w.b ? r2.then.find((e) => e.e === "damage" && (e.target === w.a || who.includes(e.target))) : undefined;
          const n = fx ? fx.n || Number(fx.v) || 25 : 0;
          // (a once-only one that can't do it alone isn't a way: nothing else wears them down)
          const sub = fx && n > 0 && !(r2.once && n < most - w.n) ? sat(r2, depth + 1, s2) : null;
          if (!sub) continue;
          const times = Math.max(1, Math.ceil((most - w.n) / n));
          const steps = sub.steps.map((st) => (st.do === "deliver" || st.do === "collect" || st.do === "throw" || st.do === "shove" || st.do === "shoot" ? { ...st, times: (st.times ?? 1) * times } : st));
          return { steps, explain: `${r.id} (${name} down to ${w.n} HP) ← ${sub.explain} ×${times}` };
        }
        return null;
      }
      case "touch":
      case "hit": {
        // a rival hit by something thrown, or shot
        if (w.t === "hit" && w.a !== "player") {
          const p = made.find((x) => x.k === "hit" && x.cause?.do === "throw" && (!w.b || x.b === w.b));
          if (p && p.cause?.do === "throw") return { steps: causeSteps(p.cause, r.id), explain: `${r.id} (${w.a || "a rival"} hit by ${p.cause.item})` };
          const s = w.a === `team:${playerTeam}` ? undefined : made.find((x) => x.k === "hit" && x.cause?.do === "shoot" && (!w.b || x.b === w.b));
          if (s?.cause?.do === "shoot") return { steps: causeSteps(anyGun(s.cause, w), r.id), explain: `${r.id} (${w.a || "a rival"} shot by ${s.b === "player" || !w.b ? "you" : s.b})` };
        }
        if (w.a && w.a !== "player") return null;
        // the player is never hit by their own throw or shot
        const ps = made.filter((x) => x.k === w.t && (!w.b || x.b === w.b) && x.cause && !(w.t === "hit" && (x.cause.do === "throw" || x.cause.do === "shoot")));
        if (!ps.length) return null;
        if (w.b || ps.length === 1) return { steps: causeSteps(ps[0]!.cause!, r.id), explain: `${r.id} (${w.t} ${ps[0]!.b})` };
        // "any of": collect the things you touch; if none are collectible, use the first one
        const items = ps.filter((x) => x.cause!.do === "touch").map((x) => x.b!);
        if (!items.length) return { steps: causeSteps(ps[0]!.cause!, r.id), explain: `${r.id} (${w.t} ${ps[0]!.b})` };
        return { steps: [{ do: "collect", items, rule: r.id, times: 1 }], explain: `${r.id} (${w.t} any of ${items.length})` };
      }
      case "timer_end":
        return made.some((x) => x.k === "timer_end" && x.a === w.a) ? { steps: [{ do: "wait", rule: r.id }], explain: `${r.id} (the timer runs out)` } : null;
      default:
        return null;
    }
  };

  // How to open each door, for runners whose path it blocks: its lock, or any rule that opens it.
  const openers = new Map<string, PlanStep[]>();
  for (const d of [...ents.values()].filter((e) => e.kind === "door").sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const lock = made.find((x) => x.k === "state" && x.a === d.id && x.s === "open" && x.cause);
    if (lock) {
      openers.set(d.id, causeSteps(lock.cause!, "", { id: d.id, s: "open" }));
      continue;
    }
    for (const r of rules) {
      if (!r.then.some((e) => (e.e === "open" || (e.e === "set_state" && e.v === "open")) && e.target === d.id)) continue;
      const s = sat(r, 1, new Set());
      if (s) {
        openers.set(d.id, s.steps);
        break;
      }
    }
  }

  let chain: WinChain | null = null;
  const wins = rules.filter((r) => r.then.some((e) => e.e === "win"));
  for (const r of wins) {
    const s = sat(r, 0, new Set());
    if (s) {
      chain = { winRule: r.id, steps: s.steps, explain: `win ← ${s.explain}` };
      break;
    }
  }
  if (b.mode === "play") {
    chips.push(
      chain
        ? chip({ id: "T0:win_chain", subject: { kind: "property", id: "win_reachable" }, status: "verified", method: "static goal regression over rules", text: chain.explain, src: "" })
        : chip({ id: "T0:win_chain", subject: { kind: "property", id: "win_reachable" }, status: "counterexample", method: "static goal regression over rules", text: wins.length ? "no rule chain lets the player trigger the win" : "no rule ever wins the game", src: "", cx: { where: null, have: 0, need: 1, unit: "chain", text: "win unreachable in the rule graph" } }),
    );
  }
  for (const c of chips) c.ms = Math.round(performanceNow() - t);
  return { chips, chain, openers };
}

// Works in browsers, workers, workerd and Node; only used for reporting durations.
const performanceNow = () => (globalThis.performance?.now?.() ?? 0);
