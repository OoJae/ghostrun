// Speech acts, purses, a guard's view and bookings in the deterministic sim: an act is an input
// (queued, heard on the next tick, logged), the world's rules decide what it does.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill, type Cast, type Entity, type Rule, type Vec3, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { cityBlock } from "@ghostrun/pack-city-block";
import { decodeAct, encodeAct, LOOK_AWAY, SimWorld, type Brain, type InputFrame, type Rapier, type SimEvent, type SpeechAct } from "../src";
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

const ent = (id: string, kind: Entity["kind"], pos: Vec3, size: Vec3, body: Entity["body"], extra: Partial<Entity> = {}): Entity => ({
  id, src: "user", layer: "gameplay", kind, zone: template.zones[0]!.id, anchor: "", pos, rotY: 0, size, noun: id, hyper: id, asset: "",
  body, shape: "box", team: "", tags: [], states: [], init: "", props: {}, ...extra,
});
const rule = (id: string, when: Partial<Rule["when"]> & { t: Rule["when"]["t"] }, then: (Partial<Rule["then"][number]> & { e: Rule["then"][number]["e"] })[], extra: Partial<Rule> = {}): Rule => ({
  id, src: "user", layer: "gameplay", when: { a: "", b: "", s: "", n: 0, act: "", ...when }, if: [], then: then.map((x) => ({ target: "", v: "", n: 0, fx: "", ...x })), once: false, cooldownS: 0, prio: 0, ...extra,
});
const guardCast = (npc: string, extra: Partial<Cast> = {}): Cast => ({
  id: `k_${npc}`, src: "user", layer: "gameplay", npc, role: "guard", minded: true, persona: { identity: "", personality: "", knowledge: "", replyStyle: "", tools: [], safety: "" },
  coneDeg: 90, rangeM: 8, hearM: 8, menu: ["guard.watch", "guard.look_away"], dflt: "guard.watch", utility: {}, memory: 0, ...extra,
});

/** A 60 m floor, the player at the origin, a guard 5 m north of it (z +5), plus the given things. */
function world(entities: Entity[], rules: Rule[], extra: { statics?: WorldBundle["statics"]; cast?: Cast[]; brain?: Brain } = {}): SimWorld {
  const b: WorldBundle = {
    ...template,
    statics: [{ id: "floor", src: "template", layer: "gameplay", zone: template.zones[0]!.id, shape: "box", pos: [0, -0.5, 0], rotY: 0, size: [60, 1, 60], surf: "floor" }, ...(extra.statics ?? [])],
    entities: [ent("sp_red", "spawn", [0, 0, 0], [1.2, 0.1, 1.2], "none", { team: "red" }), ent("guard", "npc", [0, 0.9, 5], [0.7, 1.8, 0.7], "kinematic"), ...entities],
    verbs: [], rules, cast: extra.cast ?? [guardCast("guard")], expects: [], states: [],
  };
  return new SimWorld(R, b, extra.brain ? { brain: extra.brain } : {});
}

function run(sim: SimWorld, ticks: number, input: (t: number) => InputFrame | null = () => null): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < ticks && !sim.result; i++) out.push(...sim.step(input(sim.tick + 1)));
  return out;
}
const offer = (n: number, what = "coins"): SpeechAct => ({ to: "guard", act: "offer", what, n, slot: "" });
const bribe = rule("r_bribe", { t: "spoken", a: "guard", act: "offer", b: "coins", n: 20 }, [{ e: "take", target: "player", v: "coins", n: 20 }, { e: "set_state", target: "guard", v: LOOK_AWAY, n: 20 }]);
bribe.if = [{ l: "player.coins", op: "gte", r: 20, forS: 0 }];

describe("speech acts in the sim", () => {
  it("an offer is heard on the next tick as a spoken event; the rule takes the coins and the guard looks away for 20 s, then back", () => {
    const sim = world([], [rule("r_tip", { t: "touch", a: "player", b: "x" }, [{ e: "give", target: "player", v: "coins", n: 25 }]), bribe]);
    sim.forcePurse("player", "coins", 25);
    sim.speak(offer(15));
    const first = run(sim, 1);
    expect(first.find((e) => e.k === "spoken")).toMatchObject({ a: "guard", b: "coins", v: 15, act: "offer" });
    expect(sim.fires.get("r_bribe")).toBeUndefined(); // 15 is under the price
    sim.speak(offer(20));
    const evs = run(sim, 1);
    expect(evs.filter((e) => e.rule === "r_bribe").map((e) => [e.k, e.a, e.v])).toEqual([["purse", "player", 5], ["state", "guard", LOOK_AWAY]]);
    expect(sim.purse("player", "coins")).toBe(5);
    expect(sim.blind("guard")).toBe(true);
    expect(sim.stateLeft("guard")).toBe(1200);
    // it can't be paid again: 5 coins left
    sim.speak(offer(20));
    run(sim, 1);
    expect(sim.fires.get("r_bribe")).toBe(1);
    const back = run(sim, 1199);
    expect(back.find((e) => e.k === "state" && e.a === "guard")).toMatchObject({ v: "", tick: 2 + 1200 }); // paid on tick 2
    expect(sim.blind("guard")).toBe(false);
  });

  it("a guard sees the player in its cone, in range, with a clear line; a wall hides them, and looking away sees nothing", () => {
    const caught = rule("r_caught", { t: "seen_by", a: "player", b: "guard" }, [{ e: "emit", target: "guard", fx: "whistle" }]);
    // facing south toward the player (it walked that way once)
    const facing = (sim: SimWorld) => sim.face("guard", 0, -1);
    const sim = world([], [caught, bribe]);
    facing(sim);
    const seen = run(sim, 61).filter((e) => e.k === "seen_by");
    // seen at once, then every half second while it still sees them
    expect(seen.map((e) => e.tick)).toEqual([1, 31, 61]);
    expect(sim.seeing()).toEqual(["guard"]);
    // out of its cone: 5 m to its east, level with it (90° off where it looks, the cone is 45° a side)
    sim.teleport("player", [5, 0.95, 5]);
    expect(run(sim, 5).some((e) => e.k === "seen_by")).toBe(false);
    // out of range: 10 m south
    sim.teleport("player", [0, 0.95, -5]);
    expect(run(sim, 5).some((e) => e.k === "seen_by")).toBe(false);
    // behind a wall
    const walled = world([], [caught], { statics: [{ id: "wall", src: "template", layer: "gameplay", zone: template.zones[0]!.id, shape: "box", pos: [0, 1.5, 2.5], rotY: 0, size: [6, 3, 0.3], surf: "wall" }] });
    facing(walled);
    expect(run(walled, 5).some((e) => e.k === "seen_by")).toBe(false);
    // bribed: in plain view, and it sees nothing
    const bribed = world([], [caught, bribe]);
    facing(bribed);
    bribed.forcePurse("player", "coins", 20);
    bribed.speak(offer(20));
    const evs = run(bribed, 60);
    // (on tick 1 it looked before the rule that turned it away fired; never again after)
    expect(evs.filter((e) => e.k === "seen_by").map((e) => e.tick)).toEqual([1]);
  });

  it("a guard told to look away by its mind (the brain's option) sees nothing either", () => {
    const caught = rule("r_caught", { t: "seen_by", a: "player", b: "guard" }, [{ e: "emit", target: "guard", fx: "whistle" }]);
    const sim = world([], [caught], { brain: { think: () => new Map(), blind: (id) => id === "guard" } });
    sim.face("guard", 0, -1);
    expect(run(sim, 30).some((e) => e.k === "seen_by")).toBe(false);
  });

  it("an unwatched guard faces what it guards until it moves: the thing the rule catches you holding", () => {
    const gem = ent("gem", "pickup", [6, 0.2, 5], [0.4, 0.4, 0.4], "dynamic");
    const caught = rule("r_caught", { t: "seen_by", a: "player", b: "guard" }, [{ e: "lose", target: "player" }], { once: true });
    caught.if = [{ l: "player.carrying", op: "eq", r: "gem", forS: 0 }];
    const sim = world([gem], [caught]);
    expect(sim.facingOf("guard")).toEqual([1, 0]);
    // standing south of it, holding nothing: unseen (it looks east); holding the gem in its view: caught
    sim.teleport("player", [4, 0.95, 5]);
    run(sim, 2);
    expect(sim.result).toBe(null);
    expect(sim.seeing()).toEqual(["guard"]);
    sim.attach("gem", "player");
    run(sim, 31);
    expect(sim.result).toBe("lose");
  });

  it("a booking takes the slot the act asked for, under the name the rule gives it", () => {
    const book = rule("r_book", { t: "spoken", a: "guard", act: "book" }, [{ e: "book_slot", target: "guard", v: "Viewing at Villa Aurelia" }]);
    const sim = world([], [book]);
    sim.speak({ to: "guard", act: "book", what: "", n: 0, slot: "2026-11-07T15:00" });
    const evs = run(sim, 1);
    expect(evs.find((e) => e.k === "booked")).toMatchObject({ a: "guard", b: "2026-11-07T15:00", v: "Viewing at Villa Aurelia", rule: "r_book" });
    expect(sim.bookings).toEqual([{ tick: 1, with: "guard", what: "Viewing at Villa Aurelia", slot: "2026-11-07T15:00" }]);
  });

  it("a sale hands over a thing in the world, and take of a carried thing leaves the hands empty", () => {
    const potion = ent("potion", "pickup", [10, 0.2, 10], [0.3, 0.3, 0.3], "dynamic");
    const sell = rule("r_sell", { t: "spoken", a: "guard", act: "buy", b: "potion" }, [{ e: "take", target: "player", v: "coins", n: 5 }, { e: "give", target: "player", v: "potion" }]);
    sell.if = [{ l: "player.coins", op: "gte", r: 5, forS: 0 }];
    const keep = rule("r_keep", { t: "spoken", a: "guard", act: "offer", b: "potion" }, [{ e: "take", target: "player", v: "potion" }]);
    const sim = world([potion], [sell, keep]);
    sim.forcePurse("player", "coins", 7);
    sim.speak({ to: "guard", act: "buy", what: "potion", n: 0, slot: "" });
    run(sim, 1);
    expect(sim.entity("player")!.carrying).toBe("potion");
    expect(sim.purse("player", "coins")).toBe(2);
    sim.speak({ to: "guard", act: "offer", what: "potion", n: 0, slot: "" });
    run(sim, 1);
    expect(sim.entity("player")!.carrying).toBe("");
    expect(sim.entity("potion")!.destroyed).toBe(true);
  });

  it("an act rides in the choice log and a run with one replays to the same hash", () => {
    const a: SpeechAct = { to: "guard", act: "book", what: "", n: 0, slot: "2026-11-07T15:00" };
    expect(decodeAct("guard", encodeAct(a))).toEqual(a);
    expect(decodeAct("guard", encodeAct(offer(20)))).toEqual(offer(20));
    expect(decodeAct("guard", "guard.look_away")).toBe(null);
    expect(decodeAct("guard", "act:fly:coins:20")).toBe(null);
    const play = () => {
      const sim = world([], [bribe, rule("r_caught", { t: "seen_by", a: "player", b: "guard" }, [{ e: "emit", target: "guard", fx: "x" }])]);
      sim.forcePurse("player", "coins", 30);
      for (let t = 1; t <= 300; t++) {
        if (t === 100) sim.speak(decodeAct("guard", "act:offer:coins:20")!);
        sim.step({ tick: t, wx: t % 90 < 45 ? 40 : -40, wz: 30, btn: 0 });
      }
      const h = sim.stateHash();
      sim.free();
      return h;
    };
    expect(play()).toBe(play());
  });
});
