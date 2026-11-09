// Teammates you can command (a CTF mate, your side of a team arena): one forced-state test for
// every option a command can pick on a teammate's typed menu. The command is said as a speech act,
// the simulation hears it on the next tick, and the teammate must then play that option and act
// on it: within three seconds it is nearer where the option takes it (or there already, or the
// option is to stand). The envelope (T3) already covers every option a command can pick, since a
// command picks only from the menu; this is the check that a command really does pick it.
import { behaviourOf, castBrain, commandables } from "@ghostrun/bots";
import type { Vec3, WorldBundle } from "@ghostrun/ir";
import type { NavWorld } from "@ghostrun/nav";
import { PLAYER_HALF_HEIGHT, PLAYER_RADIUS, SimWorld, type Rapier } from "@ghostrun/sim";
import type { Chip } from "./types";

/** Ticks a teammate has to act on a command. */
export const COMMAND_TICKS = 180;
/** Nearer by this much (m), or this close (m), counts as acting on it. */
const NEARER = 1;
const THERE = 1.5;

const flat = (a: Vec3, b: Vec3) => Math.sqrt((a[0] - b[0]) * (a[0] - b[0]) + (a[2] - b[2]) * (a[2] - b[2]));

/** Where the player waits while a teammate is told to follow: where the objective starts (a walk away), on the navmesh. */
function awayPoint(b: WorldBundle, nav: NavWorld): Vec3 | null {
  const carried = new Set(b.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on));
  const item = [...b.entities].sort((x, y) => (x.id < y.id ? -1 : 1)).find((e) => carried.has(e.id));
  const at = item ? nav.nearest(item.pos) : null;
  return at ? [at[0] + 1.5, at[1] + PLAYER_HALF_HEIGHT + PLAYER_RADIUS + 0.05, at[2]] : null;
}

export function t2Commands(R: Rapier, b: WorldBundle, nav: NavWorld, playerTeam: "red" | "blue" = "red"): Chip[] {
  const chips: Chip[] = [];
  for (const mate of commandables(b, playerTeam)) {
    const role = b.cast.find((c) => c.npc === mate.npc)?.role ?? "teammate";
    for (const option of [...new Set(Object.values(mate.options))].sort()) {
      const t0 = globalThis.performance?.now?.() ?? 0;
      const brain = castBrain(nav, b);
      const sim = new SimWorld(R, b, { playerTeam, brain });
      let obeyed = false;
      let acted = false;
      let d0 = 0;
      let best = Infinity;
      try {
        // following is only a test with somewhere to follow to: the player waits a walk away
        if (behaviourOf(option) === "follow") {
          const away = awayPoint(b, nav);
          if (away) sim.teleport("player", away);
        }
        sim.speak({ to: mate.npc, act: "command", what: option, n: 0, slot: "" });
        sim.step(null);
        obeyed = brain.bots.find((x) => x.id === mate.npc)?.option === option;
        const aim0 = brain.aimOf(sim, mate.npc);
        d0 = aim0 ? flat(sim.pos(mate.npc), aim0) : 0;
        for (let i = 0; obeyed && i < COMMAND_TICKS && !acted && !sim.result; i++) {
          sim.step(null);
          const still = brain.bots.find((x) => x.id === mate.npc)?.option === option;
          if (!still) break;
          const aim = brain.aimOf(sim, mate.npc);
          if (!aim) {
            acted = true; // nothing left to do: it stands where the option wants it
            break;
          }
          const d = flat(sim.pos(mate.npc), aim);
          best = Math.min(best, d);
          if (d < THERE || d < d0 - NEARER) acted = true;
        }
        if (!aim0) acted = obeyed;
      } finally {
        sim.free();
      }
      const ok = obeyed && acted;
      chips.push({
        id: `T2:command:${mate.npc}:${option}`, tier: "T2", subject: { kind: "world", id: `command:${mate.npc}` },
        status: ok ? "verified" : "counterexample", method: `forced-state ≤${COMMAND_TICKS} ticks`, n: 1, k: ok ? 1 : 0,
        text: `the ${role} ${mate.npc} plays ${option} when told`,
        cx: ok ? null : obeyed
          ? { where: null, have: Math.round((d0 - best) * 10) / 10, need: NEARER, unit: "m", text: `told ${option}, it got no nearer where that takes it` }
          : { where: null, have: 0, need: 1, unit: "commands", text: `told ${option}, it kept playing what it played` },
        src: "", ms: Math.round((globalThis.performance?.now?.() ?? 0) - t0),
      });
    }
  }
  return chips;
}
