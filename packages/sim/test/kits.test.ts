import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type Entity, type Rule, type Vec3, type VerbBinding, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { cityBlock } from "@ghostrun/pack-city-block";
import { BTN, SimWorld, type InputFrame, type Rapier, type SimEvent } from "../src";
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

type Body = Entity["body"];
const ent = (id: string, kind: Entity["kind"], pos: Vec3, size: Vec3, body: Body, extra: Partial<Entity> = {}): Entity => ({
  id, src: "user", layer: "gameplay", kind, zone: template.zones[0]!.id, anchor: "", pos, rotY: 0, size, noun: id, hyper: id, asset: "",
  body, shape: "box", team: "", tags: [], states: [], init: "", props: {}, ...extra,
});
const vb = (id: string, verb: string, on: string, params: VerbBinding["params"] = {}): VerbBinding => ({ id, src: "user", layer: "gameplay", verb, on, params, signature: false });
const rule = (id: string, when: Partial<Rule["when"]> & { t: Rule["when"]["t"] }, then: { e: Rule["then"][number]["e"]; target: string }[]): Rule => ({
  id, src: "user", layer: "gameplay", when: { a: "", b: "", s: "", n: 0, act: "", ...when }, if: [], then: then.map((x) => ({ v: "", n: 0, fx: "", ...x })), once: false, cooldownS: 0, prio: 0,
});

/** A 60 m floor with the player's spawn at the origin, plus the given things. */
function world(entities: Entity[], verbs: VerbBinding[], rules: Rule[] = []): SimWorld {
  const b: WorldBundle = {
    ...template,
    statics: [{ id: "floor", src: "template", layer: "gameplay", zone: template.zones[0]!.id, shape: "box", pos: [0, -0.5, 0], rotY: 0, size: [60, 1, 60], surf: "floor" }],
    entities: [ent("sp_red", "spawn", [0, 0, 0], [1.2, 0.1, 1.2], "none", { team: "red" }), ...entities],
    verbs, rules, cast: [], expects: [], states: [],
  };
  return new SimWorld(R, b);
}

function run(sim: SimWorld, ticks: number, input: (t: number) => InputFrame | null = () => null): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks && !sim.result; i++) out.push(...sim.step(input(sim.tick + 1)));
  return out;
}
const press = (btn: number) => (t: number): InputFrame => ({ tick: t, wx: 0, wz: 0, btn });
const at = (sim: SimWorld, p: Vec3) => sim.teleport("player", p);

describe("kit verbs in the deterministic sim", () => {
  it("switch: USE flips it on, and a state_is rule opens the door", () => {
    const sim = world(
      [ent("sw", "switch", [1.2, 0.5, 0], [0.4, 1, 0.4], "fixed"), ent("gate", "door", [0, 1.5, 6], [3, 3, 0.3], "fixed")],
      [vb("v_sw", "puzzle.switch", "sw")],
      [rule("r_open", { t: "state_is", a: "sw", s: "on" }, [{ e: "open", target: "gate" }])],
    );
    expect(sim.entity("sw")!.state).toBe("off");
    expect(sim.usable()).toMatchObject({ on: "sw", label: "flip switch" });
    const evs = run(sim, 1, press(BTN.USE));
    expect(evs.some((e) => e.k === "state" && e.a === "sw" && e.v === "on")).toBe(true);
    expect(evs.some((e) => e.rule === "r_open")).toBe(true);
    expect(sim.entity("gate")!.state).toBe("open");
    run(sim, 5); // release
    run(sim, 1, press(BTN.USE));
    expect(sim.entity("sw")!.state).toBe("off");
    sim.free();
  });

  it("plate: down while stood on, up after", () => {
    const sim = world([ent("pl", "plate", [0, 0.05, 3], [1.6, 0.1, 1.6], "fixed")], [vb("v_pl", "puzzle.plate", "pl")]);
    at(sim, [0, 0.95, 3]);
    run(sim, 2);
    expect(sim.entity("pl")!.state).toBe("down");
    at(sim, [0, 0.95, -3]);
    run(sim, 2);
    expect(sim.entity("pl")!.state).toBe("up");
    sim.free();
  });

  it("lock: USE does nothing without the key, opens with it, and uses the key up", () => {
    const sim = world(
      [ent("key", "pickup", [4, 0.25, 4], [0.4, 0.4, 0.4], "dynamic", { shape: "sphere" }), ent("vault", "door", [0, 1.5, -6], [3, 3, 0.3], "fixed")],
      [vb("v_lock", "puzzle.lock", "vault", { key: "key" })],
    );
    at(sim, [0, 0.95, -5]);
    run(sim, 1, press(BTN.USE));
    expect(sim.entity("vault")!.state).toBe("locked");
    run(sim, 3);
    sim.attach("key", "player");
    run(sim, 1, press(BTN.USE));
    expect(sim.entity("vault")!.state).toBe("open");
    expect(sim.entity("key")!.destroyed).toBe(true);
    expect(sim.entity("player")!.carrying).toBe("");
    sim.free();
  });

  it("collect: walking over a coin collects it and a touch rule scores", () => {
    const sim = world(
      [ent("coin_a", "pickup", [3, 0.5, 0], [0.5, 0.5, 0.5], "sensor")],
      [vb("v_c", "puzzle.collect", "coin_a")],
      [rule("r_coin", { t: "touch", a: "player" }, [{ e: "score", target: "team:red" }])],
    );
    const evs = run(sim, 90, (t) => ({ tick: t, wx: 127, wz: 0, btn: 0 }));
    expect(evs.some((e) => e.k === "touch" && e.a === "player" && e.b === "coin_a")).toBe(true);
    expect(sim.entity("coin_a")!.destroyed).toBe(true);
    expect(sim.scores["team:red"]).toBe(1);
    sim.free();
  });

  it("checkpoint + hazard: touching lava respawns at the last checkpoint", () => {
    const sim = world(
      [ent("cp", "checkpoint", [0, 0.6, -3], [2, 1.2, 2], "sensor"), ent("lava", "hazard", [8, 0.05, -8], [2, 0.1, 2], "sensor")],
      [vb("v_cp", "puzzle.checkpoint", "cp"), vb("v_lava", "motion_hazards.hazard", "lava")],
    );
    at(sim, [0, 0.95, -3]);
    run(sim, 2);
    expect(sim.entity("cp")!.state).toBe("reached");
    at(sim, [8, 0.95, -8]);
    const evs = run(sim, 2);
    expect(evs.some((e) => e.k === "hit" && e.a === "player" && e.b === "lava")).toBe(true);
    const p = sim.pos("player");
    expect(Math.abs(p[0])).toBeLessThan(0.5);
    expect(Math.abs(p[2] + 3)).toBeLessThan(0.5);
    sim.free();
  });

  it("portal: entering lands you beside the other end", () => {
    const sim = world(
      [ent("pa", "portal", [5, 1, 5], [1.5, 2, 1.5], "sensor"), ent("pb", "portal", [-10, 1, -10], [1.5, 2, 1.5], "sensor")],
      [vb("v_pa", "puzzle.portal", "pa", { to: "pb" }), vb("v_pb", "puzzle.portal", "pb", { to: "pa" })],
    );
    at(sim, [5, 0.95, 5]);
    run(sim, 30);
    const p = sim.pos("player");
    expect(Math.hypot(p[0] + 10, p[2] + 10)).toBeLessThan(2.5);
    expect(sim.log.filter((e) => e.k === "enter" && e.b === "pa")).toHaveLength(1);
    expect(sim.log.filter((e) => e.k === "enter" && e.b === "pb")).toHaveLength(0); // no ping-pong
    sim.free();
  });

  it("timer: timer_end fires on the second it was set for", () => {
    const sim = world([], [vb("v_t", "puzzle.timer", "player", { seconds: 5 })], [rule("r_late", { t: "timer_end", a: "player" }, [{ e: "lose", target: "player" }])]);
    run(sim, 400);
    expect(sim.result).toBe("lose");
    expect(sim.log.find((e) => e.k === "lose")!.tick).toBe(300);
    sim.free();
  });

  it("jump pad launches to its height; wind pushes; crumble gives way and comes back", () => {
    const sim = world(
      [
        ent("pad", "plate", [6, 0.05, -3], [1.5, 0.1, 1.5], "sensor"),
        ent("gust", "hazard", [-8, 1.5, 8], [4, 3, 4], "sensor"),
        ent("slab", "platform", [0, 2, 14], [3, 0.4, 3], "fixed"),
      ],
      [vb("v_pad", "locomotion.jump_pad", "pad", { height: 6 }), vb("v_w", "motion_hazards.wind", "gust", { x: 6, z: 0 }), vb("v_cr", "motion_hazards.crumble", "slab", { delay: 0.5, back: 2 })],
    );
    at(sim, [6, 0.95, -3]);
    let top = 0;
    for (let i = 0; i < 80; i++) {
      sim.step(null);
      top = Math.max(top, sim.pos("player")[1]);
    }
    expect(top - 0.95).toBeGreaterThan(5.5);
    expect(top - 0.95).toBeLessThan(6.5);

    at(sim, [-9, 0.95, 8]);
    run(sim, 2);
    const x0 = sim.pos("player")[0];
    run(sim, 20);
    expect(sim.pos("player")[0] - x0).toBeGreaterThan(1.5);

    at(sim, [0, 2.2 + 0.96, 14]);
    run(sim, 80);
    expect(sim.entity("slab")!.state).toBe("fallen");
    expect(sim.pos("player")[1]).toBeLessThan(2);
    run(sim, 130);
    expect(sim.entity("slab")!.state).toBe("solid");
    sim.free();
  });

  it("inspect: USE shows the exhibit's text as a touch event", () => {
    const sim = world([ent("statue", "prop", [-2, 1, 0], [1, 2, 1], "fixed")], [vb("v_i", "social.inspect", "statue", { text: "Bronze cat, 1890" })]);
    expect(sim.usable()?.label).toBe("inspect");
    const evs = run(sim, 1, press(BTN.USE));
    expect(evs.find((e) => e.k === "touch")).toMatchObject({ a: "player", b: "statue", v: "Bronze cat, 1890" });
    sim.free();
  });

  it("anyone who falls out of the world respawns", () => {
    const sim = world([], []);
    at(sim, [100, -25, 100]);
    const evs = run(sim, 1);
    expect(evs.some((e) => e.k === "respawn" && e.a === "player")).toBe(true);
    expect(Math.abs(sim.pos("player")[0])).toBeLessThan(0.5);
    sim.free();
  });
});

describe("putting things down", () => {
  it("USE with nothing to use in reach drops what you carry, and you can't grab it straight back", () => {
    const sim = new SimWorld(R, template);
    const orb = sim.pos("orb");
    sim.teleport("player", [orb[0] - 0.4, orb[1] + 0.5, orb[2]]);
    for (let t = 0; t < 20 && sim.entity("orb")?.carrier !== "player"; t++) sim.step(null);
    expect(sim.entity("orb")?.carrier).toBe("player");
    const evs = [...sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.USE }), ...sim.step(null)];
    expect(evs.some((e) => e.k === "drop" && e.a === "orb" && e.b === "player")).toBe(true);
    expect(sim.entity("orb")?.carrier).toBe("");
    for (let t = 0; t < 30; t++) sim.step(null);
    expect(sim.entity("orb")?.carrier).toBe(""); // a second before it can be picked up again
  });
});

describe("what USE picks", () => {
  it("the nearest, but for things to look at, the one you face; a window above your head is in reach to look at", () => {
    // a cushion 0.8 m east, a window 1.6 m north and 2.4 m up: walking north faces the window
    const sim = world(
      [ent("cushion", "prop", [0.8, 0.25, 0], [0.5, 0.5, 0.5], "fixed"), ent("window", "prop", [0, 2.4, 1.6], [1.5, 2, 0.1], "fixed")],
      [vb("vb_c", "social.inspect", "cushion", { text: "A cushion" }), vb("vb_w", "social.inspect", "window", { text: "Rain on the glass" })],
    );
    run(sim, 20);
    expect(sim.usable()?.on).toBe("cushion");
    sim.step({ tick: sim.tick + 1, wx: 0, wz: 40, btn: 0 });
    expect(sim.usable()?.on).toBe("window");
    // a switch (a hand, not a look) still goes to the nearest
    const sim2 = world(
      [ent("lever_a", "switch", [0.8, 0.5, 0], [0.3, 1, 0.3], "fixed"), ent("lever_b", "switch", [0, 0.5, 1.6], [0.3, 1, 0.3], "fixed")],
      [vb("vb_a", "puzzle.switch", "lever_a"), vb("vb_b", "puzzle.switch", "lever_b")],
    );
    run(sim2, 20);
    sim2.step({ tick: sim2.tick + 1, wx: 0, wz: 40, btn: 0 });
    expect(sim2.usable()?.on).toBe("lever_a");
  });
});

describe("rule cascades", () => {
  it("what a score threshold sets off cascades in the same tick: points open the door, the open door wins", () => {
    const sim = world(
      [ent("door", "door", [6, 1.1, 0], [1, 2.2, 0.2], "kinematic")],
      [],
      [
        { ...rule("r_open", { t: "score_gte", a: "team:red", n: 3 }, [{ e: "set_state", target: "door" }]), then: [{ e: "set_state", target: "door", v: "open", n: 0, fx: "" }], once: true },
        { ...rule("r_win", { t: "state_is", a: "door", s: "open" }, [{ e: "win", target: "player" }]), once: true },
      ],
    );
    sim.setScore("team:red", 3);
    const evs = sim.step(null);
    expect(evs.map((e) => e.k)).toEqual(expect.arrayContaining(["score_gte", "state", "win"]));
    expect(sim.result).toBe("win");
  });
});

describe("combat: hit points, shots and knock-outs", () => {
  /** world() with a brain that plays the NPC presses queued for the next tick. */
  function fight(entities: Entity[], verbs: VerbBinding[], rules: Rule[] = [], presses: Map<string, InputFrame> = new Map()): SimWorld {
    const b: WorldBundle = {
      ...template,
      statics: [{ id: "floor", src: "template", layer: "gameplay", zone: template.zones[0]!.id, shape: "box", pos: [0, -0.5, 0], rotY: 0, size: [60, 1, 60], surf: "floor" }],
      entities: [ent("sp_red", "spawn", [0, 0, 0], [1.2, 0.1, 1.2], "none", { team: "red" }), ...entities],
      verbs, rules, cast: [], expects: [], states: [],
    };
    const think = () => {
      const now = new Map(presses);
      presses.clear();
      return now;
    };
    return new SimWorld(R, b, { brain: { think } });
  }
  const someone = (id: string, pos: Vec3, team: Entity["team"] = "blue") => ent(id, "npc", pos, [0.7, 1.8, 0.7], "kinematic", { team, shape: "capsule" });
  const shoot = (on: string, params: VerbBinding["params"] = {}) => vb(`vb_shoot_${on}`, "combat_sport.shoot", on, params);
  const health = (on: string, params: VerbBinding["params"] = {}) => vb(`vb_hp_${on}`, "combat_sport.health", on, params);
  /** Press USE on every tick that is a multiple of `gap` (a fresh press each time). */
  const volley = (gap: number) => (t: number): InputFrame => ({ tick: t, wx: 0, wz: 0, btn: t % gap === 0 ? BTN.USE : 0 });

  it("a spell fired the way you face hits the rival for its damage, and the fourth knocks it out (the rule fires once)", () => {
    const sim = fight(
      [someone("wizard", [0, 0.9, 8])],
      [shoot("player", { damage: 25, cooldown: 0.5, speed: 20, range: 14 }), health("wizard", { hp: 100, respawn: false })],
      [{ ...rule("r_ko", { t: "health_lte", a: "wizard", n: 0 }, [{ e: "win", target: "player" }]), once: true }],
    );
    sim.face("player", 0, 1);
    expect(sim.usable()).toMatchObject({ on: "player", label: "shoot" });
    const evs = run(sim, 400, volley(40));
    const hits = evs.filter((e) => e.k === "hit");
    expect(hits).toHaveLength(4);
    expect(hits[0]).toMatchObject({ a: "wizard", b: "player" });
    expect(evs.filter((e) => e.k === "touch")).toEqual([]); // firing touches nothing
    expect(evs.filter((e) => e.k === "hp").map((e) => e.v)).toEqual([75, 50, 25, 0]);
    expect(evs.some((e) => e.k === "knockout" && e.a === "wizard")).toBe(true);
    expect(sim.fires.get("r_ko")).toBe(1);
    expect(sim.result).toBe("win");
    expect(sim.entity("wizard")!.destroyed).toBe(true);
    sim.free();
  });

  it("cover stops a shot; the cooldown holds fire; a rival knocked out with respawn is back at its start, healed", () => {
    const sim = fight(
      [someone("zombie", [0, 0.9, 8]), ent("crate", "prop", [0, 1, 4], [2, 2, 1], "fixed")],
      [shoot("player", { damage: 50, cooldown: 1, range: 20 }), health("zombie", { hp: 50 })],
    );
    sim.face("player", 0, 1);
    const blocked = run(sim, 60, volley(2));
    expect(blocked.filter((e) => e.k === "shoot")).toHaveLength(1); // 30 presses in a second, one shot
    expect(blocked.some((e) => e.k === "hit")).toBe(false);
    sim.teleport("player", [3, 0.95, 4]);
    sim.face("player", -3, 4);
    const open = run(sim, 60, volley(3));
    expect(open.find((e) => e.k === "hit")).toMatchObject({ a: "zombie", b: "player" });
    expect(open.some((e) => e.k === "knockout" && e.a === "zombie")).toBe(true);
    expect(open.some((e) => e.k === "respawn" && e.a === "zombie")).toBe(true);
    expect(sim.hp("zombie")).toBe(50);
    expect(sim.entity("zombie")!.destroyed).toBe(false);
    sim.free();
  });

  it("aim assist: a rival 30° off the way you face is still the one hit", () => {
    const sim = fight([someone("blue_1", [5, 0.9, 9])], [shoot("player", { range: 20, speed: 30 }), health("blue_1")]);
    sim.face("player", 0, 1);
    const evs = run(sim, 40, volley(1));
    expect(evs.find((e) => e.k === "hit")?.a).toBe("blue_1");
    sim.free();
  });

  it("an NPC's claws hurt the player; health_lte fires crossing its line; heal moves hit points; a held blaster hits as 'blaster'", () => {
    const presses = new Map<string, InputFrame>();
    const sim = fight(
      [someone("ghoul", [0, 0.9, 1.4]), ent("blaster", "pickup", [6, 0.25, 0], [0.4, 0.4, 0.4], "dynamic", { shape: "sphere" })],
      [shoot("ghoul", { range: 1.8, damage: 10 }), shoot("blaster", { damage: 30 }), health("player", { hp: 100, respawn: false }), health("ghoul", { hp: 60 })],
      [rule("r_low", { t: "health_lte", a: "player", n: 50 }, [{ e: "emit", target: "player" }]), rule("r_potion", { t: "every", n: 1 }, [{ e: "heal", target: "player" }])],
      presses,
    );
    presses.set("ghoul", { tick: 1, wx: 0, wz: -60, btn: BTN.USE });
    const bite = run(sim, 3);
    expect(bite.find((e) => e.k === "hit")).toMatchObject({ a: "player", b: "ghoul" });
    expect(sim.hp("player")).toBe(90);
    expect(bite.some((e) => e.rule === "r_low")).toBe(false);
    run(sim, 30); // the claws cool down
    sim.forceHp("player", 55);
    presses.set("ghoul", { tick: sim.tick + 1, wx: 0, wz: -60, btn: BTN.USE });
    const low = run(sim, 3);
    expect(low.some((e) => e.rule === "r_low")).toBe(true); // 55 → 45 crosses 50
    run(sim, 60 - sim.tick); // at one second the potion rule heals 25
    expect(sim.hp("player")).toBe(70);
    sim.attach("blaster", "player");
    sim.teleport("player", [0, 0.95, -6]);
    sim.teleport("ghoul", [0, 0.95, 2]);
    sim.face("player", 0, 1);
    const shot = run(sim, 60, volley(45));
    expect(shot.find((e) => e.k === "hit")).toMatchObject({ a: "ghoul", b: "blaster" });
    expect(sim.hp("ghoul")).toBe(30);
    expect(sim.entity("blaster")!.carrier).toBe("player");
    sim.free();
  });

  it("a shot passes through teammates to the rival behind them", () => {
    const sim = fight([someone("mate", [0, 0.9, 4], "red"), someone("foe", [0, 0.9, 9])], [shoot("player", { range: 20 }), health("foe")]);
    sim.face("player", 0, 1);
    const evs = run(sim, 80, volley(40));
    expect(evs.find((e) => e.k === "hit")?.a).toBe("foe");
    sim.free();
  });
});
