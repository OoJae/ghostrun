// The real thing: the organizer's CTF brief (fill → pack → placer) played by the product's
// SimWorld (KCC, carry, tags, triggers, rule cascades) with scripted player inputs against the
// world's own bots (navmesh paths, menus), and a zombie horde fought with a blaster (shots marched
// per tick, hit points, knock-outs, armed bots firing back), and a go-kart race (the arcade drive
// model through the KCC, gates in order, laps, racer bots at the wheel). The state hash and the full event log
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
import type { Vec3 } from "@ghostrun/ir";
import ctf from "../../../packages/ir/fixtures/ctf-neon.jsonl?raw";
import zombies from "../../../packages/ir/fixtures/zombie-survival.jsonl?raw";
import kart from "../../../packages/ir/fixtures/kart-race.jsonl?raw";

export interface CtfResult {
  hash: string;
  events: number;
  log: string;
  scores: string;
  result: string;
  /** Shots, hits and knock-outs in the log: the fight really happened. */
  fights: string;
}

export interface RaceResult extends CtfResult {
  /** Laps done (lap_done events) and gates passed, by every racer: the race really happened. */
  laps: number;
  checkpoints: number;
  /** The racers in race order at the end. */
  order: string;
}

// scripted input: run one way then the other, weaving (buttons as given)
const weave = (btn: (t: number) => number): Input => (_sim, _nav, t) => {
  const phase = Math.floor(t / 240) % 4;
  return [phase === 0 || phase === 1 ? 127 : -127, ((t * 7) % 61) - 30, btn(t)];
};

export function runCtf(R: Rapier, ticks: number): CtfResult {
  const fill = parseFill(ctf, { seed: 7 });
  const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  // jump periodically
  return play(R, placeWorld({ ...fill.draft, engine: "det" }, layout).bundle, ticks, weave((t) => (t % 53 === 0 || t % 53 === 9 ? BTN.JUMP : 0)), () => ({}));
}

export function runZombies(R: Rapier, ticks: number): CtfResult {
  const fill = parseFill(zombies, { seed: 33 });
  const layout = arena.generate({ seed: 33, params: arena.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  // fire every fifth of a second (the cooldown decides which ones leave the barrel), jump now and then
  return play(R, placeWorld({ ...fill.draft, engine: "det" }, layout).bundle, ticks, weave((t) => (t % 12 === 0 ? BTN.USE : 0) | (t % 97 === 0 ? BTN.JUMP : 0)), () => ({}));
}

export function runRace(R: Rapier, ticks: number): RaceResult {
  const fill = parseFill(kart, { seed: 41 });
  const layout = arena.generate({ seed: 41, params: arena.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  // scripted driving, at the wheel from the start: steer at the navmesh path to the next gate three
  // metres on, boost every four seconds, and reverse out of a wall it is pinned on
  let path: Vec3[] = [];
  let aim = "";
  let movingAt = 0;
  let back = 0;
  const drive: Input = (sim, nav, t) => {
    const race = sim.raceOf("player");
    const ride = sim.ride("player");
    if (!race || !ride) return [0, 0, 0];
    const p = sim.pos("player");
    if (race.next !== aim || t % 30 === 0) {
      const g = sim.pos(race.next);
      const to: Vec3 = nav.nearest([g[0], p[1] - 0.9, g[2]], 2) ?? g;
      path = nav.path([p[0], p[1] - 0.9, p[2]], to) ?? [to];
      aim = race.next;
    }
    const d2 = (q: Vec3) => (q[0] - p[0]) * (q[0] - p[0]) + (q[2] - p[2]) * (q[2] - p[2]);
    while (path.length > 1 && d2(path[0]!) < 9) path.shift();
    if (Math.abs(ride.speed) > 1.5) movingAt = t;
    if (t - movingAt > 45) ((back = t + 40), (movingAt = t));
    const q = path[0]!;
    const [ux, uz] = t < back ? [-ride.hx, -ride.hz] : [q[0] - p[0], q[2] - p[2]];
    const l = Math.sqrt(ux * ux + uz * uz) || 1;
    return [Math.round((ux / l) * 110), Math.round((uz / l) * 110), t % 240 === 120 ? BTN.JUMP : 0];
  };
  return play(R, placeWorld({ ...fill.draft, engine: "det" }, layout).bundle, ticks, drive, (sim) => {
    const order = sim.standings();
    const checkpoints = order.reduce((n, id) => {
      const r = sim.raceOf(id);
      return n + (r ? r.laps * r.gates + r.passed : 0);
    }, 0);
    return { laps: sim.log.filter((e) => e.k === "lap_done").length, checkpoints, order: order.join(",") };
  });
}

type Input = (sim: SimWorld, nav: ReturnType<typeof buildNav>, t: number) => [number, number, number];

function play<T extends object>(R: Rapier, world: Parameters<typeof buildNav>[0], ticks: number, input: Input, end: (sim: SimWorld) => T): CtfResult & T {
  const nav = buildNav(world);
  const sim = new SimWorld(R, world, { brain: castBrain(nav, world) });
  for (let t = 1; t <= ticks && !sim.result; t++) {
    const [wx, wz, btn] = input(sim, nav, t);
    sim.step({ tick: t, wx, wz, btn });
  }
  const log = JSON.stringify(sim.log);
  const out = {
    hash: sim.stateHash(),
    events: sim.log.length,
    log: hex32(xxh32(new TextEncoder().encode(log))),
    scores: JSON.stringify(sim.scores),
    result: String(sim.result),
    fights: (["shoot", "hit", "knockout"] as const).map((k) => sim.log.filter((e) => e.k === k).length).join("/"),
    ...end(sim),
  };
  sim.free();
  nav.destroy();
  return out;
}
