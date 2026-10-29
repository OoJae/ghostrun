// A person's run replayed headless from what a share stores (the world, the int8 input log and the
// NPC mind choices), exactly as the browser played it: the same SimWorld, the same cast brain, the
// minds applied on their ticks, a missing tick played as no input. "Race me" links draw the ghost
// it records, and the best-times board checks a claimed time against the tick it really won on.
import { castBrain } from "@ghostrun/bots";
import type { WorldBundle } from "@ghostrun/ir";
import { buildNav } from "@ghostrun/nav";
import { SimWorld, type InputFrame, type Rapier } from "@ghostrun/sim";
import { GhostRecorder, secretsOf, type Ghost } from "./ghost";

export interface Replayed {
  /** How the replay ended: won, lost, or the inputs ran out first (null). */
  result: "win" | "lose" | null;
  /** The tick it won on (null unless it won). */
  winTick: number | null;
  /** Ticks played. */
  ticks: number;
  /** The run sampled for racing (null unless it won). */
  ghost: Ghost | null;
  /** The simulation's state hash where the replay stopped. */
  hash: string;
}

/** At most ten minutes of play, like the share store's input cap. */
const MAX_TICKS = 36_000;

export function replayRun(R: Rapier, b: WorldBundle, inputs: readonly InputFrame[], minds: readonly { tick: number; npc: string; option: string }[] = []): Replayed {
  const nav = buildNav(b);
  const brain = castBrain(nav, b);
  const sim = new SimWorld(R, b, { brain });
  try {
    const rec = new GhostRecorder(sim, secretsOf(b));
    const last = Math.min(MAX_TICKS, inputs.at(-1)?.tick ?? 0);
    const chosen = [...minds].sort((x, y) => x.tick - y.tick);
    let i = 0;
    let m = 0;
    for (let t = 1; t <= last && !sim.result; t++) {
      while (i < inputs.length && inputs[i]!.tick < t) i++;
      const f = inputs[i]?.tick === t ? inputs[i]! : { tick: t, wx: 0, wz: 0, btn: 0 };
      // a mind's choice takes effect on its tick, before the step (as RapierSim applies it)
      for (; m < chosen.length && chosen[m]!.tick <= t; m++) if (chosen[m]!.tick === t) brain.choose(chosen[m]!.npc, chosen[m]!.option);
      sim.step(f);
      rec.step(sim, f);
    }
    const won = sim.result === "win";
    return { result: sim.result, winTick: won ? sim.tick : null, ticks: sim.tick, ghost: won ? rec.finish(sim) : null, hash: sim.stateHash() };
  } finally {
    sim.free();
    nav.destroy();
  }
}
