// T0, static: every reference resolves, and the win condition is reachable through the rule graph
// by goal regression (win ← score_gte ← score effect ← enter with carrier ← pickup …).
import type { Rule, WorldBundle } from "@ghostrun/ir";
import { SPECIAL_REFS } from "@ghostrun/ir";
import { verb } from "@ghostrun/kits";
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
  | { do: "shove"; at: string; from: string; rule: string; times?: number; want?: Want }; // knock `at` (out of `from`, a sensor)

/** A precondition step is done when `id` is in state `s` (it has no rule of its own to watch). */
export interface Want {
  id: string;
  s: string;
}

/** What each kit verb in the world can produce, and how an agent causes it. */
export function producers(b: WorldBundle): Produces[] {
  const out: Produces[] = [];
  for (const vb of [...b.verbs].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const p = verb(vb.verb);
    if (!p) continue;
    const made = p.produces?.({ id: vb.id, on: vb.on, params: clampParams(p.params, vb.params), mem: {} }) ?? [];
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
  for (const vb of b.verbs) {
    const p = verb(vb.verb);
    for (const id of p?.carries?.({ id: vb.id, on: vb.on, params: clampParams(p.params, vb.params), mem: {} }) ?? []) out.add(id);
  }
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
  }
}

/** A cause in a few words, for a chain's explanation. */
const said = (c: Cause) => (c.do === "throw" ? `throw ${c.item}` : `${c.do} ${c.at}`);

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

  // 1. references
  let bad = 0;
  for (const r of b.rules) {
    const refs = [r.when.a, r.when.b, ...r.if.map((c) => c.l), ...r.then.map((e) => e.target)];
    const missing = refs.filter((x) => !ok(x));
    if (missing.length) {
      bad++;
      chips.push(chip({ id: `T0:refs:${r.id}`, subject: { kind: "rule", id: r.id }, status: "counterexample", method: "static def-use", text: `rule ${r.id} references unknown ${missing.join(", ")}`, src: r.src }));
    }
  }
  if (!bad) chips.push(chip({ id: "T0:refs", subject: { kind: "world", id: "refs" }, status: "verified", method: "static def-use", text: `all ${b.rules.length} rules reference existing things`, src: "" }));

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
        const need = typeof c.r === "number" ? (c.op === "gt" ? c.r + 1 : c.r) : 2; // a lead over another score: two to be safe
        if (need <= 0) continue;
        // the same planning as "team reaches N" (several once-only scorers become one collect step)
        const sub = satTrigger(r, { ...w, t: "score_gte", a: `team:${team}`, n: need }, depth + 1, s2);
        if (!sub) return null;
        pre.push(...sub.steps);
        preWhy.push(`${team} scores ${need}`);
        continue;
      }
      const m = /^([a-z][a-z0-9_]*)\.state$/.exec(c.l);
      if (!m || c.op !== "eq") continue;
      const [id, want] = [m[1]!, String(c.r)];
      if ((ents.get(id)?.states.length ? ents.get(id)!.init : "") === want) continue;
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
    const withPre = (x: { steps: PlanStep[]; explain: string } | null) => (x && pre.length ? { steps: [...pre, ...x.steps], explain: `${x.explain} [after ${preWhy.join(", ")}]` } : x);
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
        const steps = ways.flatMap((x, i) => (times[i] ? x.sub.steps.map((st) => (st.do === "deliver" || st.do === "collect" || st.do === "throw" || st.do === "shove" ? { ...st, times: times[i]! } : st)) : []));
        return { steps, explain: `${r.id} (${w.a} reaches ${w.n}) ← ${ways.filter((_, i) => times[i]).map((x) => x.sub.explain).join(" + ")}` };
      }
      case "enter": {
        const sensor = ents.get(w.b);
        if (!sensor || sensor.body !== "sensor") return null;
        if (w.a === "player") return { steps: [{ do: "deliver", item: "player", sensor: w.b, rule: r.id, times: 1 }], explain: `${r.id} (player enters ${w.b})` };
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
        return p ? { steps: causeSteps(p.cause!, r.id), explain: `${r.id} (${w.a} becomes ${w.s}: ${said(p.cause!)})` } : null;
      }
      case "exit": {
        // someone knocked out of a ring (a shove)
        const p = made.find((x) => x.k === "exit" && (!w.a || x.a === w.a) && x.cause?.do === "shove");
        if (!p || p.cause?.do !== "shove") return null;
        return { steps: [{ do: "shove", at: p.cause.at, from: w.b, rule: r.id }], explain: `${r.id} (${p.cause.at} knocked out of ${w.b || "the area"})` };
      }
      case "touch":
      case "hit": {
        // a rival hit by something thrown
        if (w.t === "hit" && w.a !== "player") {
          const p = made.find((x) => x.k === "hit" && x.cause?.do === "throw" && (!w.b || x.b === w.b));
          if (p && p.cause?.do === "throw") return { steps: causeSteps(p.cause, r.id), explain: `${r.id} (${w.a || "a rival"} hit by ${p.cause.item})` };
        }
        if (w.a && w.a !== "player") return null;
        // the player is never hit by their own throw
        const ps = made.filter((x) => x.k === w.t && (!w.b || x.b === w.b) && x.cause && !(w.t === "hit" && x.cause.do === "throw"));
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
