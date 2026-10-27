// T0, static: every reference resolves, and the win condition is reachable through the rule graph
// by goal regression (win ← score_gte ← score effect ← enter with carrier ← pickup …).
import type { Rule, WorldBundle } from "@ghostrun/ir";
import { SPECIAL_REFS } from "@ghostrun/ir";
import type { Chip } from "./types";

/** One step of the abstract plan T3 executes: pick up `item`, or bring `item` into `sensor`. */
export type PlanStep = { do: "pickup"; item: string; rule: string } | { do: "deliver"; item: string; sensor: string; rule: string; times: number };

export interface WinChain {
  winRule: string;
  steps: PlanStep[];
  explain: string; // "win ← r_win (score_gte team:red 3) ← r_score_red (enter orb→goal_red, carrier red) ← pickup orb"
}

const chip = (c: Omit<Chip, "tier" | "n" | "k" | "cx" | "ms"> & Partial<Chip>): Chip => ({ tier: "T0", n: 0, k: 0, cx: null, ms: 0, ...c });

export function t0(b: WorldBundle, playerTeam: "red" | "blue" = "red"): { chips: Chip[]; chain: WinChain | null } {
  const t = performanceNow();
  const chips: Chip[] = [];
  const ents = new Map(b.entities.map((e) => [e.id, e]));
  const ids = new Set([...b.entities.map((e) => e.id), ...b.zones.map((z) => z.id), ...b.states.map((s) => s.id), ...b.rules.map((r) => r.id)]);
  const ok = (ref: string) => ref === "" || (SPECIAL_REFS as readonly string[]).includes(ref) || ref.startsWith("tag:") || ids.has(ref.split(".")[0]!);
  const carryable = new Set(b.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on));

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
    // conditions: only "<item>.carrier.team eq T" needs work (the player must be on team T)
    for (const c of r.if) {
      if (c.l.endsWith(".carrier.team") && c.op === "eq" && c.r !== playerTeam) return null;
    }
    switch (w.t) {
      case "score_gte": {
        for (const r2 of rules) {
          if (r2.id === r.id) continue;
          const fx = r2.then.find((e) => e.e === "score" && e.target === w.a);
          if (!fx) continue;
          const sub = sat(r2, depth + 1, s2);
          if (!sub) continue;
          const per = fx.n || 1;
          const times = Math.max(1, Math.ceil(w.n / per));
          const steps = sub.steps.map((st) => (st.do === "deliver" ? { ...st, times } : st));
          return { steps, explain: `${r.id} (${w.a} reaches ${w.n}) ← ${sub.explain}` };
        }
        return null;
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
      default:
        return null;
    }
  };

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
  return { chips, chain };
}

// Works in browsers, workers, workerd and Node; only used for reporting durations.
const performanceNow = () => (globalThis.performance?.now?.() ?? 0);
