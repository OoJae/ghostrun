// T2, forced state (GameGen-Verifier pattern): for each rule, force the world into the rule's
// precondition, step at most 120 ticks, and assert the rule fired exactly once.
import type { Rule, Vec3, WorldBundle } from "@ghostrun/ir";
import type { Cause } from "@ghostrun/plugin-api";
import { BTN, SimWorld, type InputFrame, type Rapier } from "@ghostrun/sim";
import { producers } from "./t0";
import type { Chip } from "./types";

const MAX_TICKS = 120;

/** Is a standing capsule at p clear of every static and solid entity, with ground under its feet? */
function clear(b: WorldBundle, p: Vec3): boolean {
  const boxes = [...b.statics, ...b.entities.filter((e) => e.body === "fixed" || e.body === "kinematic")];
  const blocked = boxes.some((x) => Math.abs(p[0] - x.pos[0]) < x.size[0] / 2 + 0.35 && Math.abs(p[2] - x.pos[2]) < x.size[2] / 2 + 0.35 && p[1] - 0.95 < x.pos[1] + x.size[1] / 2 - 0.05 && p[1] + 0.95 > x.pos[1] - x.size[1] / 2);
  const feet = p[1] - 0.95;
  const ground = b.statics.some((x) => Math.abs(p[0] - x.pos[0]) <= x.size[0] / 2 && Math.abs(p[2] - x.pos[2]) <= x.size[2] / 2 && Math.abs(x.pos[1] + x.size[1] / 2 - feet) < 0.6);
  return !blocked && ground;
}

/** Put the player where the verb's cause happens; true when USE must be pressed on the first tick. */
function force(sim: SimWorld, b: WorldBundle, c: Cause): string | boolean {
  if (c.do === "throw" || c.do === "shove") return `${c.do} needs a target (handled by its trigger)`;
  const e = b.entities.find((x) => x.id === c.at);
  if (!e) return `${c.at} not found`;
  const floor = e.pos[1] - e.size[1] / 2;
  if (c.do === "enter" || c.do === "touch") {
    sim.teleport("player", [e.pos[0], Math.max(floor, 0) + 0.95, e.pos[2]]);
    return false;
  }
  if (c.holding) sim.attach(c.holding, "player");
  const y = floor + 0.97;
  const spots: Vec3[] = [
    [e.pos[0], y, e.pos[2] - e.size[2] / 2 - 0.6], [e.pos[0], y, e.pos[2] + e.size[2] / 2 + 0.6],
    [e.pos[0] - e.size[0] / 2 - 0.6, y, e.pos[2]], [e.pos[0] + e.size[0] / 2 + 0.6, y, e.pos[2]],
  ];
  const spot = spots.find((p) => clear(b, p));
  if (!spot) return `no room to stand next to ${c.at}`;
  sim.teleport("player", spot);
  return true;
}

/** NPC presses for a forced test (a rival shoving the player), read by the sim on the next tick. */
type Presses = Map<string, InputFrame>;

function plan(sim: SimWorld, b: WorldBundle, r: Rule, playerTeam: string, presses: Presses = new Map()): string | boolean | null {
  const w = r.when;
  const team = r.if.find((c) => c.l.endsWith(".carrier.team") && c.op === "eq")?.r;
  switch (w.t) {
    case "enter": {
      const sensor = b.entities.find((e) => e.id === w.b);
      if (!sensor) return "sensor not found";
      if (w.a && w.a !== "player" && !sim.entity(w.a)) return `${w.a} isn't in the world`;
      const centre: Vec3 = [sensor.pos[0], sensor.pos[1], sensor.pos[2]];
      if (w.a === "player") {
        sim.teleport("player", [centre[0], centre[1] + 0.2, centre[2]]);
        return null;
      }
      // a rival knocked into it: the rival just outside, the player beyond them, shove
      if (producers(b).some((x) => x.k === "exit" && x.a === w.a && x.cause?.do === "shove")) {
        const y = sensor.pos[1] - sensor.size[1] / 2 + 0.95;
        const edge = sensor.size[0] / 2 + 0.9;
        sim.teleport(w.a, [centre[0] + edge, y, centre[2]]);
        sim.teleport("player", [centre[0] + edge + 1.2, y, centre[2]]);
        return true;
      }
      // carried item: pick a carrier from the required team (the player first, then an NPC)
      const carrier = team === undefined || team === playerTeam ? "player" : b.entities.find((e) => e.kind === "npc" && e.team === team)?.id;
      if (!carrier) return `no agent on team ${String(team)} to carry ${w.a}`;
      sim.attach(w.a, carrier);
      // stand on the sensor's own floor (a goal on a course's finish platform is 10 m up, not at 0)
      sim.teleport(carrier, [centre[0], carrier === "player" ? sensor.pos[1] - sensor.size[1] / 2 + 0.95 : sensor.pos[1], centre[2]]);
      return null;
    }
    case "pickup": {
      const item = b.entities.find((e) => e.id === w.a);
      if (!item) return "item not found";
      sim.teleport("player", [item.pos[0] + 0.5, item.pos[1] - item.size[1] / 2 + 0.95, item.pos[2]]);
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
      if (p?.cause?.do === "throw") {
        const item = p.cause.item;
        // "team:blue is hit": anyone on blue; "team:red is hit" (yours): a rival throws it at you
        const hitTeam = w.a.startsWith("team:") ? w.a.slice(5) : null;
        const other = playerTeam === "red" ? "blue" : "red";
        // "a hit by the ball blue threw": a rival on that team throws it, at the player
        const by = r.if.find((c) => c.l === `${item}.carrier.team` && c.op === "eq" && c.r !== playerTeam)?.r ?? (hitTeam === playerTeam ? other : undefined);
        if (by !== undefined) {
          const thrower = b.entities.find((e) => e.kind === "npc" && e.team === by && e.body !== "sensor" && e.body !== "none");
          if (!thrower) return `no one on ${String(by)} to throw ${item}`;
          sim.attach(item, thrower.id);
          const q = sim.pos("player");
          sim.teleport(thrower.id, [q[0] + 2.5, q[1], q[2]]);
          presses.set(thrower.id, { tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.USE });
          return null;
        }
        // holding the ball, a few metres from what the rule names (a rival, a pin) or any rival: throw
        const target = b.entities.find((e) => (w.a && !hitTeam ? e.id === w.a : e.kind === "npc" && e.team !== playerTeam && (!hitTeam || e.team === hitTeam)));
        if (!target) return `no rival to throw ${item} at`;
        sim.attach(item, "player");
        const t = sim.pos(target.id);
        const y = t[1] - (target.kind === "npc" ? 0 : target.size[1] / 2 - 0.95);
        // from the side where it is the nearest thing to hit (pins stand close together)
        const others = String(b.verbs.find((v) => v.verb === "combat_sport.throw" && v.on === item)?.params.at ?? "").split(",").filter((id) => id && id !== target.id).map((id) => sim.pos(id));
        const sides: Vec3[] = [[t[0] + 1.5, y, t[2]], [t[0] - 1.5, y, t[2]], [t[0], y, t[2] + 1.5], [t[0], y, t[2] - 1.5]];
        const d2 = (u: Vec3, v: Vec3) => (u[0] - v[0]) * (u[0] - v[0]) + (u[2] - v[2]) * (u[2] - v[2]);
        sim.teleport("player", sides.find((q) => others.every((o) => d2(q, o) > d2(q, t) + 0.3)) ?? sides[0]!);
        return true;
      }
      return p ? force(sim, b, p.cause!) : `nothing produces ${w.t}${w.b ? ` on ${w.b}` : ""}`;
    }
    case "exit": {
      // knocked out of a ring: the target just inside its edge, the player on the inner side, shove
      const p = producers(b).find((x) => x.k === "exit" && (!w.a || x.a === w.a) && x.cause?.do === "shove");
      const ring = b.entities.find((e) => e.id === w.b);
      if (!p || p.cause?.do !== "shove") return `nothing knocks ${w.a || "anyone"} out of ${w.b || "anything"}`;
      if (!ring) return `${w.b} not found`;
      const y = ring.pos[1] - ring.size[1] / 2 + 0.95;
      const edge = Math.max(0.5, ring.size[0] / 2 - 0.8);
      sim.teleport(p.cause.at, [ring.pos[0] + edge, y, ring.pos[2]]);
      if (p.cause.at !== "player") {
        sim.teleport("player", [ring.pos[0] + edge - 1.2, y, ring.pos[2]]);
        return true;
      }
      // the player shoved out: a rival on the inner side does it
      const rival = b.entities.find((e) => e.kind === "npc" && e.body !== "sensor" && e.body !== "none" && e.team !== playerTeam && b.verbs.some((v) => v.verb === "combat_sport.shove" && v.on === e.id));
      if (!rival) return "no rival to shove the player out";
      sim.teleport(rival.id, [ring.pos[0] + edge - 1.2, y, ring.pos[2]]);
      presses.set(rival.id, { tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.USE });
      return null;
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
    const presses: Presses = new Map();
    const sim = new SimWorld(R, b, { playerTeam, brain: { think: () => { const now = new Map(presses); presses.clear(); return now; } } });
    const base: Omit<Chip, "status" | "text" | "cx"> = { id: `T2:${r.id}`, tier: "T2", subject: { kind: "rule", id: r.id }, method: `forced-state ≤${MAX_TICKS} ticks`, n: 1, k: 0, src: r.src, ms: 0 };
    // the rule's state conditions are part of its precondition: force them too
    for (const c of r.if) {
      const m = /^([a-z][a-z0-9_]*)\.state$/.exec(c.l);
      if (m && c.op === "eq") sim.forceState(m[1]!, String(c.r));
      // score conditions ("red ahead of blue", "red has at least 2"): set the scores that meet them
      const t = /^(team:(?:red|blue))(?:\.score)?$/.exec(c.l)?.[1];
      if (t) {
        const other = typeof c.r === "string" ? /^(team:(?:red|blue))(?:\.score)?$/.exec(c.r)?.[1] : undefined;
        const rv = other ? (sim.scores[other] ?? 0) : Number(c.r);
        if (Number.isFinite(rv)) {
          const want = c.op === "gt" ? rv + 1 : c.op === "gte" || c.op === "eq" ? rv : c.op === "lt" || c.op === "lte" ? Math.max(0, rv - (c.op === "lt" ? 1 : 0)) : null;
          if (want !== null && (c.op !== "lt" || rv > 0)) sim.setScore(t, want);
          else if (other && (c.op === "lt" || c.op === "lte")) sim.setScore(other, (sim.scores[t] ?? 0) + (c.op === "lt" ? 1 : 0));
        }
      }
    }
    // "<item>.carrier.team is <the player's team>" on a rule about something else: hand it over
    for (const c of r.if) {
      const held = /^([a-z][a-z0-9_]*)\.carrier\.team$/.exec(c.l)?.[1];
      if (held && c.op === "eq" && c.r === playerTeam && held !== r.when.a && b.entities.some((e) => e.id === held && e.kind !== "npc")) sim.attach(held, "player");
    }
    const how = plan(sim, b, r, playerTeam, presses);
    const why = typeof how === "string" ? how : null;
    if (why) {
      chips.push({ ...base, n: 0, status: "not_checkable", text: `${r.id}: ${why}`, cx: null });
      sim.free();
      continue;
    }
    // force the cause, see the rule fire, take the cause away (back to spawn), and make sure it
    // does not fire again on its own: a bounce pad re-triggering is a new cause, a loop is a bug
    const firedTicks = new Set<number>();
    const home = sim.entity("player")!.home;
    for (let i = 0; i < MAX_TICKS && !sim.result; i++) {
      const input = how === true && i === 0 ? { tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.USE } : null;
      const before = firedTicks.size;
      const was = sim.fires.get(r.id) ?? 0;
      sim.step(input);
      if ((sim.fires.get(r.id) ?? 0) > was) firedTicks.add(sim.tick);
      if (before === 0 && firedTicks.size === 1 && r.when.t !== "score_gte" && r.when.t !== "every" && r.when.t !== "timer_end") sim.teleport("player", home);
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
