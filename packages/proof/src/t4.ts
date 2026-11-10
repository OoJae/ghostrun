// T4, the route model: a fast graph model of the world that plays a thousand modelled runs in a few
// milliseconds, for what physics is too slow to play that often (where players spend their time,
// screening many candidate edits, whether either team's spawn wins more often). The win chain
// becomes legs between the places its steps happen, each measured on the navmesh, with the jumps
// the surface graph (t1.ts) says the leg climbs and the deadly things it passes. A modelled runner
// walks them at its level's pace, may miss a jump, touch a hazard or fall to a rival, and runs out
// of time if the world has a countdown.
//
// Calibrated, never played: the model is anchored to this world by its own 12 expert runs (their
// median clear time sets its time scale, their win rate its risk), and its other numbers are
// checked against the playtest's novice and average runs. Every number it gives is "modelled",
// with the calibration error measured on the committed bench worlds (t4-fit.ts, `ghostrun
// calibrate`), and the receipt never shows it as played or verified.
import { stream, type Rng } from "@ghostrun/detmath";
import { clampLaws, type Vec3, type WorldBundle } from "@ghostrun/ir";
import { lowHazards, type NavWorld } from "@ghostrun/nav";
import { insights } from "./insights";
import { allRuns, median } from "./revealed";
import { apex, hopRoute, surfaceUnder, surfaces, type Surface } from "./t1";
import type { PlanStep, WinChain } from "./t0";
import { FIT, PARAMS, type Params } from "./t4-fit";
import type { Level, Model, Playtest, Receipt } from "./types";

/** Modelled runs per level (three levels: 1,200 in all). */
export const MODEL_RUNS = 400;
const LEVELS: readonly Level[] = ["novice", "average", "expert"];

/** One stretch of the route: from the last place to the next. */
export interface Leg {
  /** Metres walked (the navmesh path, else the straight line and a third again). */
  d: number;
  /** Jumps up onto something on the way (the surface graph's hops), and the least room a jump has (apex − rise, m). */
  jumps: number;
  room: number;
  /** Deadly things within a metre of the way. */
  hazards: number;
  /** Seconds the step itself takes there (talking, firing, waiting out a timer). */
  extra: number;
  /** The way, sampled about every metre (x, z pairs): where a modelled runner is along it. */
  pts: number[];
}

export interface Route {
  legs: Leg[];
  /** The countdown that loses the run (s), 0 if none. */
  timer: number;
  /** Rivals who can stop a run (NPCs not on the player's side). */
  rivals: number;
  /** The player's walking speed, m/s. */
  speed: number;
}

/** The world's own anchors: its time scale (physics expert median ÷ modelled) and how risky it is. */
export interface Anchor {
  scale: number;
  risk: number;
}

const d2 = (a: Vec3, b: Vec3) => (a[0] - b[0]) * (a[0] - b[0]) + (a[2] - b[2]) * (a[2] - b[2]);

function pathLength(path: Vec3[]): number {
  let l = 0;
  for (let i = 1; i < path.length; i++) {
    const dy = path[i]![1] - path[i - 1]![1];
    l += Math.sqrt(d2(path[i]!, path[i - 1]!) + dy * dy);
  }
  return l;
}

/** The places a step happens, in order, and the seconds it takes once there. */
function placesOf(b: WorldBundle, st: PlanStep, from: Vec3, team: string): { pts: Vec3[]; extra: number } {
  const pos = (id: string): Vec3 | null => b.entities.find((e) => e.id === id)?.pos ?? null;
  const one = (id: string, extra = 0.3) => {
    const p = pos(id);
    return { pts: p ? [p] : [], extra };
  };
  switch (st.do) {
    case "pickup":
      return one(st.item, 0.2);
    case "deliver": {
      const item = st.item === "player" ? null : pos(st.item);
      const sensor = pos(st.sensor);
      const pts: Vec3[] = [];
      for (let i = 0; i < Math.min(5, Math.max(1, st.times)); i++) {
        if (item) pts.push(item);
        if (sensor) pts.push(sensor);
      }
      return { pts, extra: 0.2 };
    }
    case "use":
    case "touch":
      return one(st.at, 0.4);
    case "speak":
      return one(st.to, 1.5);
    case "collect": {
      // nearest first, as many as the rule needs
      const left = st.items.map(pos).filter((p): p is Vec3 => p !== null);
      const pts: Vec3[] = [];
      let here = from;
      for (let k = 0; k < Math.min(left.length, Math.max(1, st.times)); k++) {
        let bi = 0;
        for (let i = 1; i < left.length; i++) if (d2(here, left[i]!) < d2(here, left[bi]!)) bi = i;
        here = left.splice(bi, 1)[0]!;
        pts.push(here);
      }
      return { pts, extra: 0.1 };
    }
    case "wait": {
      const r = b.rules.find((x) => x.id === st.rule);
      const v = r ? b.verbs.find((x) => x.verb === "puzzle.timer" && x.on === r.when.a) : undefined;
      return { pts: [], extra: v ? Math.min(600, Math.max(1, Number(v.params.seconds ?? 10) || 10)) : 5 };
    }
    case "throw":
      return { pts: [], extra: 1.5 };
    case "shove":
      return one(st.at, 1.5);
    case "shoot": {
      const target = st.at && !st.at.startsWith("team:") ? pos(st.at) : null;
      if (target) return { pts: [target], extra: 2 * Math.max(1, st.times ?? 1) };
      // any rival (or a team): the nearest one standing
      const rivals = b.entities.filter((e) => e.kind === "npc" && e.team !== team && e.body !== "none" && e.body !== "sensor");
      let best: Vec3 | null = null;
      for (const e of rivals) if (!best || d2(from, e.pos) < d2(from, best)) best = e.pos;
      return { pts: best ? [best] : [], extra: 2 * Math.max(1, st.times ?? 1) };
    }
    case "drive": {
      const track = b.verbs.find((v) => v.on === st.track);
      const gates = String(track?.params.gates ?? "").split(",").map((id) => pos(id.trim())).filter((p): p is Vec3 => p !== null);
      const line = pos(st.track);
      const lap = [...gates, ...(line ? [line] : [])];
      const pts: Vec3[] = [];
      for (let l = 0; l < Math.min(5, Math.max(1, st.laps)); l++) pts.push(...lap);
      return { pts, extra: 0 };
    }
  }
}

/** The deadly boxes: standing hazards and lose-on-entry sensors (what T3's runners keep clear of). */
function deadlyOf(b: WorldBundle): { pos: Vec3; size: Vec3 }[] {
  const losing = new Set(b.rules.filter((r) => (r.when.t === "enter" || r.when.t === "hit") && r.when.a === "player" && r.then.some((x) => x.e === "lose")).map((r) => r.when.b));
  const low = new Set(lowHazards(b).map((h) => h.id));
  return b.entities.filter((e) => (e.body === "sensor" || e.body === "fixed") && (losing.has(e.id) || low.has(e.id) || b.verbs.some((v) => v.on === e.id && v.verb === "motion_hazards.hazard"))).map((e) => ({ pos: e.pos, size: e.size }));
}

/**
 * The route graph a modelled runner plays: the chain's places in order from the spawn, each leg
 * measured on the navmesh, its climbs counted on the surface graph. Null when the chain has no
 * place to go (nothing to model).
 */
export function routeOf(b: WorldBundle, nav: NavWorld, chain: WinChain, team: "red" | "blue" = "red", start?: Vec3): Route | null {
  const laws = clampLaws(b.laws);
  const spawn = start ?? (b.entities.find((e) => e.kind === "spawn" && e.team === team) ?? b.entities.find((e) => e.kind === "spawn"))?.pos;
  if (!spawn) return null;
  const ss = surfaces(b);
  const deadly = deadlyOf(b);
  const legs: Leg[] = [];
  let here: Vec3 = spawn;
  let pending = 0;
  for (const st of chain.steps) {
    const { pts, extra } = placesOf(b, st, here, team);
    if (!pts.length) {
      pending += extra;
      continue;
    }
    pts.forEach((to, i) => {
      const path = nav.path(here, to) ?? [here, to];
      const walked = nav.path(here, to) ? pathLength(path) : Math.sqrt(d2(here, to)) * 1.33;
      // the climbs on the way: the surface graph's fewest-hop route from the ground here to there
      const a = surfaceUnder(ss, [here[0], here[1] + 0.2, here[2]]);
      const z = surfaceUnder(ss, [to[0], to[1] + 0.2, to[2]]);
      let jumps = 0;
      let room = 9;
      const hops = a && z && a.id !== z.id ? hopRoute(ss, a, z, laws) : null;
      for (let k = 1; hops && k < hops.length; k++) {
        const rise = hops[k]!.top - hops[k - 1]!.top;
        if (rise <= 0.41 && !(hops[k - 1] as Surface).launch) continue;
        jumps++;
        room = Math.min(room, apex(laws, laws.jumpsMax) - Math.max(0, rise));
      }
      // the way sampled every metre or so, for the hazards beside it and the places it passes
      const at: number[] = [];
      let hazards = 0;
      const near = new Set<number>();
      for (let k = 1; k < path.length; k++) {
        const [p, q] = [path[k - 1]!, path[k]!];
        const n = Math.max(1, Math.round(Math.sqrt(d2(p, q))));
        for (let j = 0; j < n; j++) {
          const x = p[0] + ((q[0] - p[0]) * j) / n;
          const zz = p[2] + ((q[2] - p[2]) * j) / n;
          at.push(x, zz);
          deadly.forEach((h, hi) => {
            if (Math.abs(x - h.pos[0]) <= h.size[0] / 2 + 1 && Math.abs(zz - h.pos[2]) <= h.size[2] / 2 + 1) near.add(hi);
          });
        }
      }
      hazards = near.size;
      legs.push({ d: walked, jumps, room, hazards, extra: (i === pts.length - 1 ? extra : 0.2) + pending, pts: at.length ? at : [to[0], to[2]] });
      pending = 0;
      here = to;
    });
  }
  if (!legs.length) return null;
  if (pending) legs[legs.length - 1]!.extra += pending;
  const clocks = b.rules.filter((r) => r.when.t === "timer_end" && r.then.some((e) => e.e === "lose")).flatMap((r) => b.verbs.filter((v) => v.verb === "puzzle.timer" && v.on === r.when.a)).map((v) => Math.min(600, Math.max(5, Number(v.params.seconds ?? 60) || 60)));
  const rivals = b.entities.filter((e) => e.kind === "npc" && e.team !== team && e.body !== "none" && e.body !== "sensor").length;
  return { legs, timer: clocks.length ? Math.min(...clocks) : 0, rivals, speed: laws.speed };
}

/** One modelled run's outcome: won, the seconds it took (or lasted), the seconds spent on each leg. */
export interface ModelRun {
  won: boolean;
  s: number;
  legs: number[];
}

/** Play one modelled run of `route` at `level` (params, the world's anchors, a seeded stream). */
export function modelRun(route: Route, level: Level, p: Params, a: Anchor, rng: Rng): ModelRun {
  const lv = p.levels[level];
  const v = route.speed * (0.85 + 0.15 * rng());
  let t = 0;
  const legs: number[] = [];
  let won = true;
  for (const leg of route.legs) {
    let s = (leg.d / v + leg.jumps * p.jumpS + leg.extra) * lv.pace * (1 + p.noise * (rng() * 2 - 1));
    let dead = false;
    // each jump: a miss (more likely with little room) is gone back for, losing time, and now and
    // then (a fall, a jump never made) ends the run
    for (let j = 0; j < leg.jumps && !dead; j++) {
      const q = Math.min(0.95, lv.jump * a.risk * (leg.room < 0.5 ? 2 : 1));
      if (rng() < q) {
        s += p.retryS;
        if (rng() < p.fatal) dead = true;
      }
    }
    for (let h = 0; h < leg.hazards && !dead; h++) if (rng() < Math.min(0.95, lv.hazard * a.risk)) dead = true;
    if (!dead && route.rivals && rng() < Math.min(0.95, lv.rival * a.risk * Math.min(3, route.rivals) * (s / 10))) dead = true;
    if (!dead && rng() < Math.min(0.95, lv.leg * a.risk)) dead = true;
    s *= a.scale;
    t += s;
    legs.push(s);
    if (route.timer && t > route.timer) {
      legs[legs.length - 1] = s - (t - route.timer);
      t = route.timer;
      won = false;
      break;
    }
    if (dead) {
      won = false;
      break;
    }
  }
  return { won, s: t, legs };
}

/** `n` modelled runs at one level, on a stream of their own. */
export function modelRuns(route: Route, level: Level, n: number, p: Params, a: Anchor, seed: number, tag = ""): ModelRun[] {
  const rng = stream(seed, `t4:${level}${tag}`);
  return Array.from({ length: n }, () => modelRun(route, level, p, a, rng));
}

const winShare = (rs: readonly ModelRun[]) => (rs.length ? rs.filter((r) => r.won).length / rs.length : 0);

/** The physics runs at each level on this world: wins and the winners' clear times (s). */
export function physicsOf(receipt: Receipt, pt: Playtest): Record<Level, { runs: number; won: number; times: number[] }> {
  const out = { novice: { runs: 0, won: 0, times: [] as number[] }, average: { runs: 0, won: 0, times: [] as number[] }, expert: { runs: 0, won: 0, times: [] as number[] } };
  for (const l of pt.levels) ((out[l.level].runs = l.runs), (out[l.level].won = l.won));
  for (const tr of [...(receipt.trails ?? []), ...pt.trails]) if (tr.won && tr.ticks) out[tr.level ?? "expert"].times.push(tr.ticks / 60);
  return out;
}

/**
 * The world's anchors from its own expert runs: the time scale that puts the modelled experts'
 * median clear time on the physics one, then the risk that brings the modelled experts' win rate
 * nearest to theirs (smoothed: k + ½ of n + 1).
 */
export function anchorOf(route: Route, p: Params, experts: { runs: number; won: number; times: number[] }, seed: number): Anchor {
  let scale = 1;
  if (experts.times.length) {
    const free = { ...route, timer: 0 };
    const m = median(modelRuns(free, "expert", 200, p, { scale: 1, risk: 0 }, seed, ":scale").map((r) => r.s));
    if (m > 0) scale = Math.min(4, Math.max(0.25, median(experts.times) / m));
  }
  // the risk nearest 1 whose modelled experts win within the physics runs' own sampling spread of
  // theirs (k of 12 says little more than that); none: the nearest outright
  const want = experts.runs ? experts.won / experts.runs : 1;
  const spread = experts.runs ? Math.sqrt(Math.max(want * (1 - want), 0.04) / experts.runs) + 0.5 / experts.runs : 0.1;
  let risk = 1;
  let best = Infinity;
  let within = Infinity;
  for (let k = -8; k <= 8; k++) {
    const r = k < 0 ? 1 / (1 + -k * 0.5) : 1 + k * 0.5;
    const got = winShare(modelRuns(route, "expert", 200, p, { scale, risk: r }, seed, ":risk"));
    const e = Math.abs(got - want);
    const far = Math.abs(k);
    if (e <= spread && far < within) ((within = far), (risk = r), (best = -1));
    else if (within === Infinity && e < best - 1e-9) ((best = e), (risk = r));
  }
  return { scale, risk };
}

/**
 * Where modelled runners spend their time, measured as the receipt measures the physics runs'
 * ("Most time": insights over positions three times a second): each modelled run walks its legs'
 * ways at the pace it took them.
 */
export function heatOf(b: WorldBundle, route: Route, runs: readonly ModelRun[]): { near: string; share: number }[] {
  const xyz: number[] = [];
  for (const r of runs) {
    r.legs.forEach((s, i) => {
      const pts = route.legs[i]!.pts;
      const n = pts.length / 2;
      const k = Math.max(1, Math.round(s * 3));
      for (let j = 0; j < k; j++) {
        const at = Math.min(n - 1, Math.floor((j / k) * n));
        xyz.push(pts[at * 2]!, 0, pts[at * 2 + 1]!);
      }
    });
  }
  return insights(b, [{ won: true, xyz }]).hot.filter((h) => h.near).map((h) => ({ near: h.near, share: h.share }));
}

/** How far two heat maps differ: the mean gap in share over the places either puts in its top three. */
export function heatGap(a: readonly { near: string; share: number }[], b: readonly { near: string; share: number }[]): number {
  const names = [...new Set([...a.slice(0, 3), ...b.slice(0, 3)].map((x) => x.near))];
  if (!names.length) return 0;
  const of = (xs: readonly { near: string; share: number }[], n: string) => xs.find((x) => x.near === n)?.share ?? 0;
  return names.reduce((s, n) => s + Math.abs(of(a, n) - of(b, n)), 0) / names.length;
}

/** The p-th quantile of xs (nearest rank). */
const quantile = (xs: readonly number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]! : 0;
};

/**
 * The other team's route on a team map: the same chain from the other spawn, each thing of one
 * team swapped for its counterpart of the other (the red goal for the blue one, by name or else
 * the nearest of the same kind). Null when the map has no second side.
 */
function mirrored(b: WorldBundle, chain: WinChain, team: "red" | "blue"): { chain: WinChain; spawn: Vec3 } | null {
  const other = team === "red" ? "blue" : "red";
  const spawn = b.entities.find((e) => e.kind === "spawn" && e.team === other);
  if (!spawn || !b.entities.some((e) => e.kind === "spawn" && e.team === team)) return null;
  const swap = new Map<string, string>();
  let teamed = 0;
  for (const e of b.entities) {
    if (e.team !== "red" && e.team !== "blue") continue;
    const want = e.team === "red" ? "blue" : "red";
    const named = e.id.replace(/red/g, "\u0000").replace(/blue/g, "red").replace(/\u0000/g, "blue");
    const twin = b.entities.find((x) => x.id === named && x.team === want) ?? b.entities.filter((x) => x.kind === e.kind && x.team === want).sort((x, y) => d2(x.pos, e.pos) - d2(y.pos, e.pos))[0];
    if (twin) swap.set(e.id, twin.id);
  }
  const sw = (id: string) => swap.get(id) ?? id;
  const steps = chain.steps.map((st): PlanStep => {
    switch (st.do) {
      case "pickup": return { ...st, item: sw(st.item) };
      case "deliver": return { ...st, item: st.item === "player" ? st.item : sw(st.item), sensor: sw(st.sensor) };
      case "use": case "touch": case "shove": return { ...st, at: sw(st.at) };
      case "speak": return { ...st, to: sw(st.to) };
      case "collect": return { ...st, items: st.items.map(sw) };
      case "throw": return { ...st, item: sw(st.item) };
      case "shoot": return { ...st, at: st.at ? sw(st.at) : st.at };
      default: return st;
    }
  });
  for (const st of chain.steps) for (const id of [("item" in st ? st.item : ""), ("sensor" in st ? st.sensor : ""), ("at" in st ? st.at : "")]) if (id && swap.has(id)) teamed++;
  // no step of the chain belongs to a team: not a team map (both sides would run the same route)
  if (!teamed) return null;
  return { chain: { ...chain, steps }, spawn: spawn.pos };
}

/** Modelled matches on a team map: each side's expert runs the route from its own spawn; the first to win takes it. */
function matches(b: WorldBundle, nav: NavWorld, chain: WinChain, route: Route, a: Anchor, team: "red" | "blue", p: Params, n: number, seed: number): { red: number; err: number; matches: number } | null {
  const m = mirrored(b, chain, team);
  if (!m) return null;
  const theirs = routeOf(b, nav, m.chain, team === "red" ? "blue" : "red", m.spawn);
  if (!theirs) return null;
  const mine = modelRuns(route, "expert", n, p, a, seed, ":team:mine");
  const them = modelRuns(theirs, "expert", n, p, a, seed, ":team:theirs");
  const redFirst = (k: number) => {
    let red = 0;
    let decided = 0;
    for (let i = 0; i < n; i++) {
      const [x, y] = [mine[i]!, them[i]!];
      const xs = x.won ? x.s : Infinity;
      const ys = y.won ? y.s * k : Infinity;
      if (xs === Infinity && ys === Infinity) continue;
      decided++;
      const mineFirst = xs < ys || (xs === ys && i % 2 === 0);
      if (mineFirst === (team === "red")) red++;
    }
    return decided ? red / decided : 0.5;
  };
  const red = redFirst(1);
  // ± as far as it moves if either side's modelled times are off by the bench's clear-time error
  const err = Math.max(Math.abs(redFirst(1 + FIT.times) - red), Math.abs(redFirst(1 / (1 + FIT.times)) - red));
  return { red, err, matches: n };
}

/**
 * T4 on a proved world: the route model anchored by the experts, its win rates, clear times and
 * heat beside the playtest's, and (on a team map) red against blue from the spawns. Null when
 * there's no route to model or no expert won (nothing to anchor it on).
 */
export function t4(b: WorldBundle, nav: NavWorld, chain: WinChain, receipt: Receipt, pt: Playtest, team: "red" | "blue" = "red", p: Params = PARAMS): Model | null {
  const t0 = globalThis.performance?.now?.() ?? 0;
  if (b.mode !== "play") return null;
  const route = routeOf(b, nav, chain, team);
  if (!route) return null;
  const phys = physicsOf(receipt, pt);
  if (!phys.expert.won) return null;
  const a = anchorOf(route, p, phys.expert, b.seed);
  const runs = LEVELS.map((l) => modelRuns(route, l, MODEL_RUNS, p, a, b.seed));
  const won = runs.flatMap((rs) => rs.filter((r) => r.won).map((r) => r.s));
  const heat = heatOf(b, route, runs.flat());
  const physHeat = insights(b, allRuns({ ...receipt, playtest: pt })).hot.filter((h) => h.near);
  return {
    runs: MODEL_RUNS * LEVELS.length,
    levels: LEVELS.map((level, i) => ({ level, p: winShare(runs[i]!), err: FIT.win[level], physics: { runs: phys[level].runs, won: phys[level].won } })),
    times: won.length ? { median: quantile(won, 0.5), lo: quantile(won, 0.1), hi: quantile(won, 0.9), err: FIT.times, physics: median([...phys.novice.times, ...phys.average.times, ...phys.expert.times]) } : null,
    heat: heat.slice(0, 3),
    heatErr: FIT.heat,
    heatGap: heatGap(heat, physHeat),
    teams: matches(b, nav, chain, route, a, team, p, MODEL_RUNS * LEVELS.length, b.seed),
    anchor: a,
    ms: Math.round((globalThis.performance?.now?.() ?? 0) - t0),
  };
}

/**
 * Screening a candidate world on T4 (no physics): its modelled win rates per level, on the
 * anchors of the world it was made from (the same world, changed: the same time scale and risk).
 */
export function screen(b: WorldBundle, nav: NavWorld, chain: WinChain, a: Anchor, n: number, team: "red" | "blue" = "red", p: Params = PARAMS): { levels: Record<Level, number>; median: number } | null {
  const route = routeOf(b, nav, chain, team);
  if (!route) return null;
  const runs = LEVELS.map((l) => modelRuns(route, l, n, p, a, b.seed, ":screen"));
  const won = runs.flatMap((rs) => rs.filter((r) => r.won).map((r) => r.s));
  return { levels: { novice: winShare(runs[0]!), average: winShare(runs[1]!), expert: winShare(runs[2]!) }, median: quantile(won, 0.5) };
}
