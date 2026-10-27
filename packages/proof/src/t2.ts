// T2, forced state (GameGen-Verifier pattern): for each rule, force the world into the rule's
// precondition, step at most 120 ticks, and assert the rule fired exactly once.
import type { Rule, Vec3, WorldBundle } from "@ghostrun/ir";
import { SimWorld, type Rapier } from "@ghostrun/sim";
import type { Chip } from "./types";

const MAX_TICKS = 120;

function plan(sim: SimWorld, b: WorldBundle, r: Rule, playerTeam: string): string | null {
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
    const why = plan(sim, b, r, playerTeam);
    if (why) {
      chips.push({ ...base, n: 0, status: "not_checkable", text: `${r.id}: ${why}`, cx: null });
      sim.free();
      continue;
    }
    const firedTicks = new Set<number>();
    for (let i = 0; i < MAX_TICKS && !sim.result; i++) {
      for (const e of sim.step(null)) if (e.rule === r.id) firedTicks.add(e.tick);
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
