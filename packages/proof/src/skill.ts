// Runner skill levels for the playtest. The proof's own runners are experts: exact, and they back
// "beatable", the par time and the ghost, so nothing here touches them. Novices and average players
// run the same plan through human hands, every slip seeded: they act on what they saw a few ticks
// ago, wobble off their line, stop to look around, mistime jumps, re-plan and notice they're stuck
// later, and in a fight aim wide and fire slower.
import type { Rng } from "@ghostrun/detmath";
import { BTN, type InputFrame } from "@ghostrun/sim";
import type { Level } from "./types";

export interface Skill {
  level: Exclude<Level, "expert">;
  /** Ticks between seeing and doing: the stick, jumps and shots land this much later. */
  lag: number;
  /** The stick turned off its line by up to this (the tangent of the angle), a new slip every `every` ticks. */
  wobble: number;
  every: number;
  /** About this many ticks between stops to look around (on the ground), each up to `look` ticks long. */
  pauseEvery: number;
  look: number;
  /** A jump pressed up to this many ticks early or late (on top of the lag). */
  slop: number;
  /** Ticks between re-plans toward something moving (an expert's 20), and before noticing it's stuck (45). */
  replan: number;
  stuckAfter: number;
  /** Each shot turned off the target by up to this (tangent), and at least this many ticks between shots. */
  aim: number;
  fireGap: number;
}

export const SKILLS: Record<Skill["level"], Skill> = {
  novice: { level: "novice", lag: 15, wobble: 0.6, every: 15, pauseEvery: 240, look: 40, slop: 8, replan: 75, stuckAfter: 150, aim: 0.9, fireGap: 36 },
  average: { level: "average", lag: 8, wobble: 0.3, every: 20, pauseEvery: 480, look: 25, slop: 4, replan: 40, stuckAfter: 90, aim: 0.45, fireGap: 18 },
};

/** What the hands can tell about this tick before acting: is USE a shot, is the runner on the ground. */
export interface Feel {
  shooting: boolean;
  grounded: boolean;
}

const clamp8 = (v: number) => Math.max(-127, Math.min(127, Math.round(v)));

/** (x, z) turned by the angle whose tangent is t (no trigonometry in the simulation path). */
function turn(x: number, z: number, t: number): [number, number] {
  const c = 1 / Math.sqrt(1 + t * t);
  const s = t * c;
  return [x * c - z * s, x * s + z * c];
}

/**
 * A runner's hands: each tick, what it meant goes in and what it does comes out. The stick, jumps
 * and shots are queued `lag` ticks (a jump shifted by up to `slop` either way), the stick wobbles
 * and now and then stops, a shot goes wide and waits its turn. USE for anything else (a switch, a
 * pickup) is pressed at once: a runner that pressed a switch late would press it again and switch
 * it back off.
 */
export function hands(sk: Skill, rng: Rng): (input: InputFrame | null, tick: number, feel: Feel) => InputFrame {
  const later = new Map<number, { wx: number; wz: number; btn: number }>();
  const slot = (t: number) => {
    let s = later.get(t);
    if (!s) later.set(t, (s = { wx: 0, wz: 0, btn: 0 }));
    return s;
  };
  let slip = 0;
  let slipUntil = 0;
  let lastShot = -1e9;
  let pauseAt = Math.round(sk.pauseEvery * (0.5 + rng()));
  let pauseUntil = 0;
  return (input, tick, feel) => {
    const at = tick + sk.lag;
    const s = slot(at);
    s.wx = input?.wx ?? 0;
    s.wz = input?.wz ?? 0;
    const btn = input?.btn ?? 0;
    if (btn & BTN.JUMP) slot(at + Math.max(-sk.lag, Math.round((rng() * 2 - 1) * sk.slop))).btn |= BTN.JUMP;
    if (btn & BTN.USE && feel.shooting) s.btn |= BTN.USE; // a shot is aimed by what it saw: it lands with the stick
    const out = later.get(tick) ?? { wx: 0, wz: 0, btn: 0 };
    later.delete(tick);
    if (tick >= slipUntil) ((slip = (rng() * 2 - 1) * sk.wobble), (slipUntil = tick + sk.every));
    let [wx, wz] = turn(out.wx, out.wz, slip);
    // a look around: only on the ground, and a jump or a fall ends it (what was queued meanwhile is let go)
    if (out.btn & BTN.JUMP || !feel.grounded) pauseUntil = Math.min(pauseUntil, tick);
    else if (tick >= pauseAt) ((pauseUntil = tick + 1 + Math.floor(rng() * sk.look)), (pauseAt = pauseUntil + Math.round(sk.pauseEvery * (0.5 + rng()))));
    if (tick < pauseUntil) [wx, wz] = [0, 0];
    let b = out.btn | (btn & BTN.USE && !feel.shooting ? BTN.USE : 0) | (btn & ~(BTN.JUMP | BTN.USE));
    if (out.btn & BTN.USE) {
      if (tick - lastShot < sk.fireGap) b &= ~BTN.USE;
      else {
        lastShot = tick;
        [wx, wz] = turn(wx, wz, (rng() * 2 - 1) * sk.aim);
      }
    }
    return { tick, wx: clamp8(wx), wz: clamp8(wz), btn: b };
  };
}
