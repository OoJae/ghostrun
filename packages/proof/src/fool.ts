// "Try to fool it": plant one bug of the kind a careless edit or a model makes, one that really
// breaks the game, and see whether the proof notices. Every mutation is built so the world is
// unwinnable afterwards (the goal 40 m up, the key gone, a condition nothing can meet), so a
// receipt that still says "won" would be a lie. Only worlds with one way to win get them: with two,
// breaking one route isn't a bug.
import type { Rule, WorldBundle } from "@ghostrun/ir";
import { hitPoints, playerWeapons, t0 } from "./t0";
import type { Chip, Receipt } from "./types";

export interface Planted {
  id: string;
  /** What was planted, in a few words ("the silver key is gone"). */
  text: string;
  /** The thing it was done to, for the camera. */
  at: string | null;
  bundle: WorldBundle;
}

const noun = (b: WorldBundle, id: string) => b.entities.find((e) => e.id === id)?.noun || id.replace(/_/g, " ");
const winRules = (b: WorldBundle) => b.rules.filter((r) => r.then.some((e) => e.e === "win"));

/**
 * The bugs that can be planted in this world, in a fixed order (none if it has two ways to win).
 * `parS`, the world's AI par, decides whether a short countdown is a bug (it is if nobody can win
 * that fast).
 */
export function plants(b: WorldBundle, parS: number | null, team: "red" | "blue" = "red"): Planted[] {
  if (b.mode !== "play" || winRules(b).length !== 1) return [];
  const { chain } = t0(b, team);
  if (!chain) return [];
  const out: Planted[] = [];
  const copy = () => structuredClone(b);
  const win = winRules(b)[0]!;

  // the place the run must end in, lifted out of reach
  const last = [...chain.steps].reverse().find((s) => s.do === "deliver");
  if (last && last.do === "deliver" && win.when.t === "enter" && win.when.b === last.sensor) {
    const w = copy();
    const g = w.entities.find((e) => e.id === last.sensor);
    if (g) {
      g.pos = [g.pos[0], g.pos[1] + 40, g.pos[2]];
      out.push({ id: "goal_in_the_sky", text: `the ${noun(b, g.id)} is 40 m up in the air`, at: g.id, bundle: w });
    }
  }

  // the thing the win rule itself names, gone (one of several balls that all score isn't needed)
  const named = (id: string) => win.when.a === id || win.when.b === id || win.if.some((c) => c.l.split(".")[0] === id);
  const first = chain.steps.find((s) => s.do === "pickup" && s.item !== "player" && named(s.item));
  if (first && first.do === "pickup") {
    const w = copy();
    w.entities = w.entities.filter((e) => e.id !== first.item);
    w.verbs = w.verbs.filter((v) => v.on !== first.item);
    out.push({ id: "item_gone", text: `the ${noun(b, first.item)} is gone`, at: first.item, bundle: w });
  }

  // the win rule also needs a state nothing in the world can give
  const thing = b.entities.find((e) => e.kind !== "spawn" && e.kind !== "npc");
  if (thing) {
    const w = copy();
    const r = w.rules.find((x) => x.id === win.id)!;
    r.if = [...r.if, { l: `${thing.id}.state`, op: "eq", r: "never", forS: 0 }];
    out.push({ id: "impossible_condition", text: `winning also needs the ${noun(b, thing.id)} to be "never", which nothing sets`, at: thing.id, bundle: w });
  }

  // a countdown too short for anyone: lose after 5 s, in a world the best run takes 10 s or more
  if (parS !== null && parS >= 10) {
    const w = copy();
    w.verbs.push({ id: "vb_fool_timer", verb: "puzzle.timer", on: "player", params: { seconds: 5 }, signature: false, src: "ai", layer: "gameplay" });
    const lose: Rule = { id: "r_fool_timer", src: "ai", layer: "gameplay", when: { t: "timer_end", a: "player", b: "", s: "", n: 0, act: "" }, if: [], then: [{ e: "lose", target: "player", v: "", n: 0, fx: "" }], once: true, cooldownS: 0, prio: 0 };
    w.rules.push(lose);
    out.push({ id: "five_second_timer", text: "you lose after 5 seconds", at: null, bundle: w });
  }

  // on a course, jumping cut to a hop
  if (b.pack.id === "course") {
    const w = copy();
    w.laws = { ...w.laws, jumpH: 0.3, jumpsMax: 1 };
    out.push({ id: "no_jump", text: "a jump only clears 0.3 m", at: null, bundle: w });
  }
  out.push(...fights(b, chain, team));
  return out;
}

/**
 * Bugs in a fight the win is shot for: the weapon does no harm, the ones to beat are sealed in
 * stone, or they heal faster than anything can hurt them. Each only where it really breaks the
 * game (no rule could do the damage instead).
 */
function fights(b: WorldBundle, chain: NonNullable<ReturnType<typeof t0>["chain"]>, team: "red" | "blue"): Planted[] {
  const shots = chain.steps.filter((s) => s.do === "shoot");
  const weapons = playerWeapons(b);
  if (!shots.length || !weapons.length) return [];
  const out: Planted[] = [];
  const hp = hitPoints(b);
  // who the win needs shot: the ones named, or everyone on the team meant
  const targets = [...new Set(shots.flatMap((s) => (s.at.startsWith("team:") ? b.entities.filter((e) => e.kind === "npc" && e.team === s.at.slice(5)).map((e) => e.id) : s.at ? [s.at] : b.entities.filter((e) => e.kind === "npc" && e.team !== team).map((e) => e.id))))].filter((id) => b.entities.some((e) => e.id === id && e.kind === "npc"));
  if (!targets.length) return [];
  const worn = shots.some((s) => b.rules.find((r) => r.id === s.rule)?.when.t === "health_lte");
  // damage rules can do instead: any repeatable one, or a once-only one big enough alone
  const ruled = (id: string) => b.rules.reduce((n, r) => n + r.then.filter((e) => e.e === "damage" && (e.target === id || e.target === `team:${b.entities.find((x) => x.id === id)?.team}`)).reduce((m, e) => m + (r.once ? e.n || Number(e.v) || 25 : Infinity), 0), 0);
  const most = Math.max(...weapons.map((x) => x.damage));

  if (worn && targets.every((id) => ruled(id) < (hp.get(id) ?? Infinity)) && most > 0) {
    const w = structuredClone(b);
    const ids = new Set(weapons.map((x) => x.id));
    for (const v of w.verbs) if (ids.has(v.id)) v.params = { ...v.params, damage: 0 };
    out.push({ id: "harmless_weapon", text: `your ${weapons[0]!.held ? noun(b, weapons[0]!.on) : "weapon"} does no damage`, at: null, bundle: w });
  }

  // sealed in: a stone box round each of them (four walls and a roof), so no shot gets in
  {
    const w = structuredClone(b);
    let k = 0;
    for (const id of targets) {
      const e = w.entities.find((x) => x.id === id)!;
      const [x, z] = [e.pos[0], e.pos[2]];
      const floor = e.pos[1] - e.size[1] / 2;
      const [r, h, t] = [1.4, 4, 0.4];
      const slabs: [number, number, number, number, number, number][] = [
        [x, floor + h / 2, z + r, 2 * r + t, h, t], [x, floor + h / 2, z - r, 2 * r + t, h, t],
        [x + r, floor + h / 2, z, t, h, 2 * r + t], [x - r, floor + h / 2, z, t, h, 2 * r + t],
        [x, floor + h + t / 2, z, 2 * r + t, t, 2 * r + t],
      ];
      for (const [px, py, pz, sx, sy, sz] of slabs) w.statics.push({ id: `st_fool_${++k}`, src: "template", layer: "gameplay", zone: e.zone, shape: "box", pos: [px, py, pz], rotY: 0, size: [sx, sy, sz], surf: "wall" });
    }
    out.push({ id: "walled_in", text: `${targets.length === 1 ? `the ${noun(b, targets[0]!)} is` : `all ${targets.length} of them are`} sealed in stone, out of any shot`, at: targets[0]!, bundle: w });
  }

  // invulnerable: healed in full every quarter second, when two shots and every damage rule together
  // can't take its hit points in that time
  if (worn && targets.every((id) => 2 * most + (Number.isFinite(ruled(id)) ? ruled(id) : Infinity) < (hp.get(id) ?? 0))) {
    const w = structuredClone(b);
    for (const id of targets) {
      w.rules.push({ id: `r_fool_heal_${id}`.slice(0, 32), src: "ai", layer: "gameplay", when: { t: "every", a: "", b: "", s: "", n: 0.25, act: "" }, if: [], then: [{ e: "heal", target: id, v: "", n: 1000, fx: "" }], once: false, cooldownS: 0, prio: 0 });
    }
    out.push({ id: "invulnerable", text: `${targets.length === 1 ? `the ${noun(b, targets[0]!)} heals` : "they heal"} in full four times a second`, at: targets[0]!, bundle: w });
  }
  return out;
}

const win = (r: Receipt) => (r.chips.find((c) => c.id === "T3:win")?.k ?? 0) >= 10 && !r.chips.some((c) => c.id === "T0:win_chain" && c.status === "counterexample");

/**
 * Did the proof notice? Caught if the broken world no longer proves won; `by` is the first chip
 * that says so (T0 before T1 before T3: the cheapest check that saw it).
 */
export function caught(after: Receipt): { caught: boolean; by: Chip | null } {
  if (win(after)) return { caught: false, by: null };
  const order = ["T0", "T1", "T2", "T3"];
  const bad = after.chips.filter((c) => c.status === "counterexample" && (c.id === "T0:win_chain" || c.id === "T3:win" || c.tier === "T1")).sort((x, y) => order.indexOf(x.tier) - order.indexOf(y.tier));
  return { caught: true, by: bad[0] ?? after.chips.find((c) => c.id === "T3:win") ?? null };
}

/** The world as it stood proved won (only those are worth fooling). */
export const provedWon = win;
