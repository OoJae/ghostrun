// Hitting and knocking out other players: dodgeball, snowball fights, bumper cars, sumo rings.
// As with every kit, the verbs only produce events (a hit, someone leaving a ring); the world's
// rules turn them into points, wins and losses.
import type { VerbPlugin } from "@ghostrun/plugin-api";

/** The nearest character within `range` of `from` on another team (any other one, without teams). */
function nearestRival(c: Parameters<NonNullable<VerbPlugin["tick"]>>[0], from: string, range: number): string {
  const me = c.ent(from);
  const p = c.pos(from);
  let best = "";
  let bestD = range * range;
  for (const a of c.agents()) {
    const e = c.ent(a);
    if (a === from || !e || e.destroyed || (me?.team && e.team === me.team)) continue;
    const q = c.pos(a);
    const d = (q[0] - p[0]) * (q[0] - p[0]) + (q[2] - p[2]) * (q[2] - p[2]);
    if (d < bestD) ((bestD = d), (best = a));
  }
  return best;
}

export const throwVerb: VerbPlugin = {
  id: "combat_sport.throw",
  line: 'on a ball/snowball: carry it, USE hits the nearest rival in range (hit a=the one hit b=it), then it goes back to its spot; params {"range":3-20}',
  on: ["pickup"],
  params: { range: { def: 10, min: 3, max: 20 } },
  carries: (b) => [b.on],
  use: {
    radius: 1.5,
    label: "throw",
    run(c, b, actor) {
      if (c.ent(actor)?.carrying !== b.on) return false;
      const target = nearestRival(c, actor, Number(b.params.range));
      if (!target) return false;
      // the hit first, the release next tick: rules see who threw it ("IF ball.carrier.team eq red")
      c.emit("hit", target, b.on);
      b.mem.release = 1;
    },
  },
  tick(c, b) {
    if (!b.mem.release) return;
    b.mem.release = 0;
    c.release(b.on, c.ent(b.on)!.home); // back in play where it started (not at their feet, or they'd simply keep it)
  },
  produces: (b) => [{ k: "hit", a: "", b: b.on, cause: { do: "throw", item: b.on } }],
};

const KNOCK_TICKS = 24;

export const shoveVerb: VerbPlugin = {
  id: "combat_sport.shove",
  line: 'on a rival/bumper car (npc): USE next to it knocks it back ~4 m, e.g. out of a ring (exit a=it b=ring); params {"force":4-12}',
  on: ["npc"],
  params: { force: { def: 10, min: 4, max: 12 } },
  use: {
    radius: 1.6,
    label: "shove",
    run(c, b, actor) {
      if (actor === b.on) return false;
      const p = c.pos(actor);
      const q = c.pos(b.on);
      const [dx, dz] = [q[0] - p[0], q[2] - p[2]];
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const f = Number(b.params.force);
      b.mem.kb = KNOCK_TICKS;
      b.mem.kx = (dx / len) * f;
      b.mem.kz = (dz / len) * f;
    },
  },
  tick(c, b) {
    const left = Number(b.mem.kb ?? 0);
    if (left <= 0) return;
    c.shove(b.on, Number(b.mem.kx), Number(b.mem.kz));
    b.mem.kb = left - 1;
  },
  produces: (b) => [{ k: "exit", a: b.on, b: "", cause: { do: "shove", at: b.on } }],
};

export const catchVerb: VerbPlugin = {
  id: "combat_sport.catch",
  line: "on someone to catch (a thief, a pickpocket, an npc): USE next to them catches them (touch a=player b=them)",
  on: ["npc"],
  params: {},
  use: {
    radius: 1.6,
    label: "catch",
    run(_c, b, actor) {
      return actor !== b.on; // the sim logs touch a=actor b=them
    },
  },
  produces: (b) => [{ k: "touch", a: "player", b: b.on, cause: { do: "use", at: b.on } }],
};

export const COMBAT: VerbPlugin[] = [throwVerb, shoveVerb, catchVerb];
