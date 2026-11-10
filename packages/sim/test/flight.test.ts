// The flight, zero-g and swimming laws in the deterministic sim: what a jetpack's fuel buys, what
// the thrust law does with no gravity, and a breath held under water.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LAWS, parseFill, type Entity, type Vec3, type VerbBinding, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { cityBlock } from "@ghostrun/pack-city-block";
import { BTN, SimWorld, type InputFrame, type Rapier } from "../src";
import { loadRapierNode } from "../src/rapier/node";

let R: Rapier;
let template: WorldBundle;

beforeAll(async () => {
  R = await loadRapierNode();
  const ctf = readFileSync(new URL("../../ir/fixtures/ctf-neon.jsonl", import.meta.url), "utf8");
  const fill = parseFill(ctf, { seed: 7 });
  const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: [], laws: fill.draft.laws, harder: false });
  template = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout).bundle;
});

const ent = (id: string, kind: Entity["kind"], pos: Vec3, size: Vec3, body: Entity["body"]): Entity => ({
  id, src: "user", layer: "gameplay", kind, zone: template.zones[0]!.id, anchor: "", pos, rotY: 0, size, noun: id, hyper: id, asset: "",
  body, shape: "box", team: "", tags: [], states: [], init: "", props: {},
});
const vb = (id: string, verb: string, on: string, params: VerbBinding["params"] = {}): VerbBinding => ({ id, src: "user", layer: "gameplay", verb, on, params, signature: false });

function bundle(entities: Entity[], verbs: VerbBinding[], laws: Partial<WorldBundle["laws"]> = {}, floor = true): WorldBundle {
  return {
    ...template,
    laws: { ...DEFAULT_LAWS, ...laws },
    statics: floor ? [{ id: "floor", src: "template", layer: "gameplay", zone: template.zones[0]!.id, shape: "box", pos: [0, -0.5, 0], rotY: 0, size: [60, 1, 60], surf: "floor" }] : [],
    entities: [ent("sp_red", "spawn", [0, 0, 0], [1.2, 0.1, 1.2], "none"), ...entities].map((e) => (e.kind === "spawn" ? { ...e, team: "red" as const } : e)),
    verbs, rules: [], cast: [], expects: [], states: [],
  };
}

const held = (btn: number, wx = 0, wz = 0) => (t: number): InputFrame => ({ tick: t, wx, wz, btn });
function run(sim: SimWorld, ticks: number, input: (t: number) => InputFrame | null) {
  const evs = [];
  for (let i = 0; i < ticks; i++) evs.push(...sim.step(input(sim.tick + 1)));
  return evs;
}
const feet = (sim: SimWorld) => sim.pos("player")[1] - 0.9;

describe("a jetpack (locomotion.fly)", () => {
  it("climbs at its climb speed for as long as its fuel lasts, then falls; landing refuels it", () => {
    const sim = new SimWorld(R, bundle([], [vb("vb_fly", "locomotion.fly", "player", { climb: 3, fuel: 4 })]));
    run(sim, 10, () => null); // settle on the floor
    expect(sim.moves()).toMatchObject({ mode: "walk", kind: "jetpack", fuel: 4, fuelMax: 4 });
    const evs = run(sim, 4 * 60, held(BTN.JUMP));
    expect(evs.some((e) => e.k === "jump")).toBe(true);
    // 4 s at 3 m/s, less the moment it takes to speed up
    expect(feet(sim)).toBeGreaterThan(10.5);
    expect(feet(sim)).toBeLessThan(12.3);
    expect(sim.moves()!.fuel).toBe(0);
    const top = feet(sim);
    run(sim, 70, held(BTN.JUMP));
    expect(feet(sim)).toBeLessThan(top); // out of fuel: holding jump does nothing (it coasts up, then falls)
    run(sim, 180, () => null);
    expect(sim.player.grounded).toBe(true);
    expect(sim.moves()!.fuel).toBe(4);
  });

  it("dives on crouch and sinks slowly with neither held; the stick flies at full speed", () => {
    const sim = new SimWorld(R, bundle([], [vb("vb_fly", "locomotion.fly", "player", { climb: 4, fuel: 20 })]));
    run(sim, 5, () => null);
    run(sim, 120, held(BTN.JUMP));
    const y0 = feet(sim);
    run(sim, 60, held(0, 127, 0));
    expect(sim.pos("player")[0]).toBeGreaterThan(4.5); // ~6 m/s across
    expect(y0 - feet(sim)).toBeGreaterThan(0.6); // sank about a metre
    expect(y0 - feet(sim)).toBeLessThan(1.3);
    const y1 = feet(sim);
    run(sim, 30, held(BTN.DOWN));
    expect(y1 - feet(sim)).toBeGreaterThan(1.2);
  });

  it("is bit-identical run to run", () => {
    const go = () => {
      const sim = new SimWorld(R, bundle([], [vb("vb_fly", "locomotion.fly", "player")]));
      run(sim, 400, (t) => ({ tick: t, wx: t % 90 < 45 ? 127 : -60, wz: 40, btn: t % 200 < 120 ? BTN.JUMP : t % 200 < 150 ? BTN.DOWN : 0 }));
      const h = sim.stateHash();
      sim.free();
      return h;
    };
    expect(go()).toBe(go());
  });
});

describe("the zero-g thrust law (gravity below 0.05 g)", () => {
  it("speeds up toward the stick at the thrust, never past the speed, and stops again", () => {
    const sim = new SimWorld(R, bundle([], [], { gravityScale: 0, thrust: 4, speed: 6 }));
    run(sim, 30, held(BTN.JUMP)); // up off the floor: 0.5 s at 4 m/s² is 2 m/s
    expect(sim.player.vy).toBeGreaterThan(1.8);
    expect(sim.player.vy).toBeLessThan(2.1);
    run(sim, 30, () => null); // and back to a stop
    expect(Math.abs(sim.player.vy)).toBeLessThan(1e-6);
    run(sim, 120, held(0, 127, 0));
    expect(sim.player.vx).toBeCloseTo(6, 5);
    expect(sim.moves()!.mode).toBe("float");
  });

  it("a straight line: what you let go of drifts nowhere (nothing pulls)", () => {
    const sim = new SimWorld(R, bundle([], [], { gravityScale: 0 }));
    run(sim, 20, held(BTN.JUMP));
    run(sim, 200, () => null);
    const y = sim.pos("player")[1];
    run(sim, 60, () => null);
    expect(sim.pos("player")[1]).toBe(y);
  });
});

describe("water (locomotion.swim)", () => {
  // a pool 10 × 4 × 10 m sunk into the floor's level: the floor has a hole in it here, the pool's own bottom at −4
  const pool = (breath: number) => {
    const b = bundle([ent("pool", "prop", [0, -2, 8], [10, 4, 10], "sensor")], [vb("vb_swim", "locomotion.swim", "pool", { breath })], {}, false);
    b.statics = [
      { id: "bed", src: "template", layer: "gameplay", zone: b.zones[0]!.id, shape: "box", pos: [0, -4.5, 8], rotY: 0, size: [10, 1, 10], surf: "floor" },
      { id: "shore", src: "template", layer: "gameplay", zone: b.zones[0]!.id, shape: "box", pos: [0, -2.5, -5], rotY: 0, size: [10, 5, 16], surf: "floor" },
    ];
    return b;
  };

  it("you float at the surface, dive on crouch, and come back up by yourself", () => {
    const sim = new SimWorld(R, pool(0));
    sim.teleport("player", [0, -1, 8]);
    run(sim, 120, () => null);
    expect(sim.pos("player")[1]).toBeGreaterThan(-0.45);
    expect(sim.pos("player")[1]).toBeLessThan(-0.15);
    expect(sim.moves()!.mode).toBe("swim");
    run(sim, 90, held(BTN.DOWN));
    expect(sim.pos("player")[1]).toBeLessThan(-2.4);
    run(sim, 300, () => null);
    expect(sim.pos("player")[1]).toBeGreaterThan(-0.45);
  });

  it("a breath runs out after its seconds under: back at the start", () => {
    const sim = new SimWorld(R, pool(3));
    sim.teleport("player", [0, -3, 8]);
    const evs = run(sim, 4 * 60, held(BTN.DOWN));
    const out = evs.find((e) => e.k === "breath_out");
    expect(out).toMatchObject({ a: "player", b: "pool" });
    expect(out!.tick).toBeGreaterThan(170);
    expect(out!.tick).toBeLessThan(190);
    expect(evs.some((e) => e.k === "respawn" && e.a === "player")).toBe(true);
  });

  it("a jump at the surface climbs out onto the shore", () => {
    const sim = new SimWorld(R, pool(0));
    sim.teleport("player", [0, -0.3, 4]);
    run(sim, 60, () => null);
    let on = false;
    for (let i = 0; i < 120 && !on; i++) {
      sim.step({ tick: sim.tick + 1, wx: 0, wz: -127, btn: i % 20 === 0 ? BTN.JUMP : 0 });
      on = sim.player.grounded && feet(sim) > -0.1;
    }
    expect(on).toBe(true);
  });
});
