// T2, forced state (GameGen-Verifier pattern): for each rule, force the world into the rule's
// precondition, step at most 120 ticks, and assert the rule fired exactly once.
import type { Rule, Vec3, WorldBundle } from "@ghostrun/ir";
import type { Cause } from "@ghostrun/plugin-api";
import { BTN, SimWorld, type Rapier } from "@ghostrun/sim";
import { producers } from "./t0";
import type { Chip } from "./types";

const MAX_TICKS = 120;

/** Is a standing capsule at p clear of every static and solid entity? */
function clear(b: WorldBundle, p: Vec3): boolean {
  const boxes = [...b.statics, ...b.entities.filter((e) => e.body === "fixed" || e.body === "kinematic")];
  return !boxes.some((x) => Math.abs(p[0] - x.pos[0]) < x.size[0] / 2 + 0.35 && Math.abs(p[2] - x.pos[2]) < x.size[2] / 2 + 0.35 && p[1] - 0.95 < x.pos[1] + x.size[1] / 2 - 0.05 && p[1] + 0.95 > x.pos[1] - x.size[1] / 2);
}

/** Put the player where the verb's cause happens; true when USE must be pressed on the first tick. */
function force(sim: SimWorld, b: WorldBundle, c: Cause): string | boolean {
  const e = b.entities.find((x) => x.id === c.at);
  if (!e) return `${c.at} not found`;
  const floor = e.pos[1] - e.size[1] / 2;
  if (c.do === "enter" || c.do === "touch") {
    sim.teleport("player", [e.pos[0], Math.max(floor, 0) + 0.95, e.pos[2]]);
    return false;
  }
  if (c.holding) sim.attach(c.holding, "player");
  const spots: Vec3[] = [
    [e.pos[0], 0.95, e.pos[2] - e.size[2] / 2 - 0.6], [e.pos[0], 0.95, e.pos[2] + e.size[2] / 2 + 0.6],
    [e.pos[0] - e.size[0] / 2 - 0.6, 0.95, e.pos[2]], [e.pos[0] + e.size[0] / 2 + 0.6, 0.95, e.pos[2]],
  ];
  const spot = spots.find((p) => clear(b, p));
  if (!spot) return `no room to stand next to ${c.at}`;
  sim.teleport("player", spot);
  return true;
}

function plan(sim: SimWorld, b: WorldBundle, r: Rule, playerTeam: string): string | boolean | null {
  const w = r.when;
  const team = r.if.find((c) => c.l.endsWith(".carrier.team") && c.op === "eq")?.r;
  switch (w.t) {
    case "enter": {
      const sensor = b.entities.find((e) => e.id === w.b);
      if (!sensor) return "sensor not found";
      const centre: Vec3 = [sensor.pos[0], sensor.pos[1], sensor.pos[2]];
      if (w.a === "player") {
        sim.teleport("player", [centre[0], centre[1] + 0.2, centre[2]]);
        return null;
      }
      // carried item: pick a carrier from the required team (the player first, then an NPC)
      const carrier = team === undefined || team === playerTeam ? "player" : b.entities.find((e) => e.kind === "npc" && e.team === team)?.id;
      if (!carrier) return `no agent on team ${String(team)} to carry ${w.a}`;
      sim.attach(w.a, carrier);
      sim.teleport(carrier, [centre[0], carrier === "player" ? 0.95 : sensor.pos[1], centre[2]]);
      return null;
    }
    case "pickup": {
      const item = b.entities.find((e) => e.id === w.a);
      if (!item) return "item not found";
      sim.teleport("player", [item.pos[0] + 0.5, 0.95, item.pos[2]]);
      return null;
    }
    case "score_gte":
      sim.setScore(w.a, w.n);
      return null;
    case "every":
      return w.n * 60 > MAX_TICKS ? `fires every ${w.n} s, longer than the ${MAX_TICKS}-tick bound` : null;
    case "state_is": {
      const p = producers(b).find((x) => x.k === "state" && x.a === w.a && x.s === w.s && x.cause);
      return p ? force(sim, b, p.cause!) : `nothing in the world makes ${w.a} '${w.s}'`;
    }
    case "touch":
    case "hit": {
      const p = producers(b).find((x) => x.k === w.t && (!w.b || x.b === w.b) && x.cause);
      return p ? force(sim, b, p.cause!) : `nothing produces ${w.t}${w.b ? ` on ${w.b}` : ""}`;
    }
    case "timer_end": {
      const v = sim.verbs.find((x) => x.bound.on === w.a && x.plugin.id === "puzzle.timer");
      if (!v) return `no timer on ${w.a}`;
      v.bound.mem.end = 2; // forced: the timer runs out on the next tick
      return null;
    }
    default:
      return `trigger '${w.t}' has no forced-state recipe yet`;
  }
}

export function t2(R: Rapier, b: WorldBundle, playerTeam: "red" | "blue" = "red"): Chip[] {
  const chips: Chip[] = [];
  for (const r of [...b.rules].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const t0 = globalThis.performance?.now?.() ?? 0;
    const sim = new SimWorld(R, b, { playerTeam });
    const base: Omit<Chip, "status" | "text" | "cx"> = { id: `T2:${r.id}`, tier: "T2", subject: { kind: "rule", id: r.id }, method: `forced-state ≤${MAX_TICKS} ticks`, n: 1, k: 0, src: r.src, ms: 0 };
    const how = plan(sim, b, r, playerTeam);
    const why = typeof how === "string" ? how : null;
    if (why) {
      chips.push({ ...base, n: 0, status: "not_checkable", text: `${r.id}: ${why}`, cx: null });
      sim.free();
      continue;
    }
    const firedTicks = new Set<number>();
    for (let i = 0; i < MAX_TICKS && !sim.result; i++) {
      const input = how === true && i === 0 ? { tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.USE } : null;
      for (const e of sim.step(input)) if (e.rule === r.id) firedTicks.add(e.tick);
    }
    const n = firedTicks.size;
    sim.free();
    chips.push({
      ...base,
      k: n === 1 ? 1 : 0,
      status: n === 1 ? "verified" : "counterexample",
      text: `${r.id} fires exactly once`,
      cx: n === 1 ? null : { where: null, have: n, need: 1, unit: "firings", text: n === 0 ? "never fired when forced" : `fired ${n} times` },
      ms: Math.round((globalThis.performance?.now?.() ?? 0) - t0),
    });
  }
  return chips;
}
