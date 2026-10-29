// The real thing: the organizer's CTF brief (fill → pack → placer) played by the product's
// SimWorld (KCC, carry, tags, triggers, rule cascades) with scripted player inputs against the
// world's own bots (navmesh paths, menus), and a zombie horde fought with a blaster (shots marched
// per tick, hit points, knock-outs, armed bots firing back). The state hash and the full event log
// must be identical on every runtime, or a cloud proof wouldn't be valid in the judge's browser.
// Recast must already be initialised in this realm (runNavQ does it first).
import { castBrain } from "@ghostrun/bots";
import { hex32, xxh32 } from "@ghostrun/detmath";
import { parseFill } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import { arena } from "@ghostrun/pack-arena";
import { cityBlock } from "@ghostrun/pack-city-block";
import { BTN, SimWorld, type Rapier } from "@ghostrun/sim";
import ctf from "../../../packages/ir/fixtures/ctf-neon.jsonl?raw";
import zombies from "../../../packages/ir/fixtures/zombie-survival.jsonl?raw";

export interface CtfResult {
  hash: string;
  events: number;
  log: string;
  scores: string;
  result: string;
  /** Shots, hits and knock-outs in the log: the fight really happened. */
  fights: string;
}

export function runCtf(R: Rapier, ticks: number): CtfResult {
  const fill = parseFill(ctf, { seed: 7 });
  const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  // jump periodically
  return play(R, placeWorld({ ...fill.draft, engine: "det" }, layout).bundle, ticks, (t) => (t % 53 === 0 || t % 53 === 9 ? BTN.JUMP : 0));
}

export function runZombies(R: Rapier, ticks: number): CtfResult {
  const fill = parseFill(zombies, { seed: 33 });
  const layout = arena.generate({ seed: 33, params: arena.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  // fire every fifth of a second (the cooldown decides which ones leave the barrel), jump now and then
  return play(R, placeWorld({ ...fill.draft, engine: "det" }, layout).bundle, ticks, (t) => (t % 12 === 0 ? BTN.USE : 0) | (t % 97 === 0 ? BTN.JUMP : 0));
}

function play(R: Rapier, world: Parameters<typeof buildNav>[0], ticks: number, btn: (t: number) => number): CtfResult {
  const nav = buildNav(world);
  const sim = new SimWorld(R, world, { brain: castBrain(nav, world) });
  // scripted input: run one way then the other, weaving
  for (let t = 1; t <= ticks && !sim.result; t++) {
    const phase = Math.floor(t / 240) % 4;
    const wx = phase === 0 || phase === 1 ? 127 : -127;
    const wz = ((t * 7) % 61) - 30;
    sim.step({ tick: t, wx, wz, btn: btn(t) });
  }
  const log = JSON.stringify(sim.log);
  const out = {
    hash: sim.stateHash(),
    events: sim.log.length,
    log: hex32(xxh32(new TextEncoder().encode(log))),
    scores: JSON.stringify(sim.scores),
    result: String(sim.result),
    fights: (["shoot", "hit", "knockout"] as const).map((k) => sim.log.filter((e) => e.k === k).length).join("/"),
  };
  sim.free();
  nav.destroy();
  return out;
}
