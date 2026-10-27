// T3, physics witnesses: AI runners execute the win chain in the real deterministic simulation,
// following navmesh paths with seeded variation against the world's own bots, and a jump witness
// checks each "requires" (alone: geometry, not tactics).
import { stream } from "@ghostrun/detmath";
import type { Expect, Vec3, WorldBundle } from "@ghostrun/ir";
import type { NavWorld } from "@ghostrun/nav";
import { castBrain } from "@ghostrun/bots";
import { BTN, SimWorld, type Rapier } from "@ghostrun/sim";
import type { PlanStep, WinChain } from "./t0";
import type { Chip } from "./types";

const RUN_TICKS = 60 * 60; // one minute of play per run
const TOO_EASY_S = 3;

interface RunResult {
  won: boolean;
  ticks: number;
  stuck: number;
}

type Target = Vec3 | (() => Vec3);
const at = (t: Target) => (typeof t === "function" ? t() : t);
const d2h = (a: Vec3, b: Vec3) => (a[0] - b[0]) * (a[0] - b[0]) + (a[2] - b[2]) * (a[2] - b[2]); // never **: not bit-identical across engines

/**
 * Walk the player to `goal` along the navmesh; a function goal is a moving target (an item in
 * someone's hands) and is re-planned as it moves. Returns false if it can't get there in time.
 */
function walkTo(sim: SimWorld, nav: NavWorld, goal: Target, rng: () => number, speed: number, budget: { ticks: number }, stop: () => boolean): boolean {
  const moving = typeof goal === "function";
  const plan = (aim: Vec3): Vec3[] | null => {
    const from = sim.pos("player");
    const feet: Vec3 = [from[0], from[1] - 0.9, from[2]];
    let path = nav.path(feet, aim);
    if (!path && moving) {
      const near = nav.nearest(aim);
      path = (near && nav.path(feet, near)) || [aim];
    }
    return path && path.map((p, i) => (i === path.length - 1 ? p : ([p[0] + (rng() - 0.5) * 0.3, p[1], p[2] + (rng() - 0.5) * 0.3] as Vec3)));
  };
  let aim = at(goal);
  let pts = plan(aim);
  if (!pts) return false;
  let i = 0;
  let replanAt = sim.tick + 20;
  let lastProgressTick = sim.tick;
  let best = Infinity;
  while (budget.ticks > 0 && !sim.result) {
    if (stop()) return true;
    if (moving && sim.tick >= replanAt) {
      const now = at(goal);
      if (d2h(now, aim) > 2.25 || i >= pts.length) {
        aim = now;
        pts = plan(aim)!;
        i = 0;
        best = Infinity;
      }
      replanAt = sim.tick + 20;
    }
    const p = sim.pos("player");
    while (i < pts.length && d2h(p, pts[i]!) < 0.45 * 0.45) {
      i++;
      best = Infinity;
    }
    if (i >= pts.length && !moving) return true;
    // past the last waypoint of a moving target: head straight for it until the next re-plan
    const wp = i < pts.length ? pts[i]! : at(goal);
    const d2 = d2h(p, wp);
    if (d2 < best - 0.01) {
      best = d2;
      lastProgressTick = sim.tick;
    }
    const ux = wp[0] - p[0];
    const uz = wp[2] - p[2];
    const k = (127 * speed) / (Math.sqrt(ux * ux + uz * uz) || 1);
    let wx = Math.round(ux * k);
    let wz = Math.round(uz * k);
    let btn = 0;
    if (sim.tick - lastProgressTick > 45) {
      // stuck against something: sidestep and hop, deterministically
      wx = Math.round((rng() - 0.5) * 254);
      wz = Math.round((rng() - 0.5) * 254);
      btn = BTN.JUMP;
      lastProgressTick = sim.tick;
    }
    sim.step({ tick: sim.tick + 1, wx, wz, btn });
    budget.ticks--;
  }
  return stop();
}

/** The static surface a point stands on (highest top at or below it). */
function surfaceUnder(b: WorldBundle, p: Vec3) {
  let best: WorldBundle["statics"][number] | undefined;
  for (const s of b.statics) {
    const top = s.pos[1] + s.size[1] / 2;
    if (Math.abs(p[0] - s.pos[0]) > s.size[0] / 2 || Math.abs(p[2] - s.pos[2]) > s.size[2] / 2 || top > p[1] + 0.2) continue;
    if (!best || top > best.pos[1] + best.size[1] / 2) best = s;
  }
  return best;
}

/**
 * Jump link: when the target is on a raised surface the navmesh can't reach on foot, walk to the
 * closest face of that surface, jump (and air-jump at the apex), then land on top.
 */
function climbOnto(sim: SimWorld, nav: NavWorld, b: WorldBundle, target: Vec3, rng: () => number, budget: { ticks: number }): boolean {
  const s = surfaceUnder(b, [target[0], target[1] + 0.1, target[2]]);
  if (!s) return false;
  const top = s.pos[1] + s.size[1] / 2;
  const p = sim.pos("player");
  const [minX, maxX, minZ, maxZ] = [s.pos[0] - s.size[0] / 2, s.pos[0] + s.size[0] / 2, s.pos[2] - s.size[2] / 2, s.pos[2] + s.size[2] / 2];
  const clampX = Math.min(maxX - 0.8, Math.max(minX + 0.8, target[0]));
  const clampZ = Math.min(maxZ - 0.8, Math.max(minZ + 0.8, target[2]));
  // candidate approach points 0.7 m outside each face, nearest walkable one first
  const faces: { at: Vec3; dir: [number, number] }[] = [
    { at: [clampX, 0, minZ - 0.7], dir: [0, 1] }, { at: [clampX, 0, maxZ + 0.7], dir: [0, -1] },
    { at: [minX - 0.7, 0, clampZ], dir: [1, 0] }, { at: [maxX + 0.7, 0, clampZ], dir: [-1, 0] },
  ];
  const d2 = (a: Vec3) => (a[0] - p[0]) * (a[0] - p[0]) + (a[2] - p[2]) * (a[2] - p[2]);
  faces.sort((u, v) => d2(u.at) - d2(v.at));
  for (const f of faces) {
    if (!nav.path([p[0], 0, p[2]], f.at)) continue;
    if (!walkTo(sim, nav, f.at, rng, 1, budget, () => false)) continue;
    let on = false;
    for (let t = 0; t < 150 && budget.ticks > 0 && !on; t++) {
      const q = sim.pos("player");
      const above = q[1] - 0.9 > top + 0.05;
      const inX = f.dir[0] === 0 ? 0 : Math.max(-127, Math.min(127, Math.round((clampX - q[0]) * 60)));
      const inZ = f.dir[1] === 0 ? 0 : Math.max(-127, Math.min(127, Math.round((clampZ - q[2]) * 60)));
      const wx = above ? inX : f.dir[0] * 127;
      const wz = above ? inZ : f.dir[1] * 127;
      const again = t > 6 && sim.player.vy <= 0.5 && sim.player.jumpsUsed > 0 && sim.player.jumpsUsed < sim.laws.jumpsMax;
      sim.step({ tick: sim.tick + 1, wx, wz, btn: t === 0 || again ? BTN.JUMP : 0 });
      if (again) sim.step({ tick: sim.tick + 1, wx, wz, btn: 0 });
      budget.ticks -= again ? 2 : 1;
      on = t > 0 && sim.player.grounded && q[1] - 0.9 > top - 0.1;
    }
    if (on) return true;
  }
  return false;
}

/**
 * Drop link, the way down: standing on a raised surface the navmesh can't leave, walk off its
 * edge on the side facing the target (the navmesh has no off-mesh links for drops).
 */
function dropDown(sim: SimWorld, b: WorldBundle, target: Vec3, budget: { ticks: number }): boolean {
  const p = sim.pos("player");
  const s = surfaceUnder(b, [p[0], p[1] - 0.8, p[2]]);
  if (!s) return false;
  const top = s.pos[1] + s.size[1] / 2;
  if (top < 0.5) return false; // already on the ground level
  const [hx, hz] = [s.size[0] / 2, s.size[2] / 2];
  // leave across the edge nearest the target: push the clamped target 1 m past that edge
  const cx = Math.min(s.pos[0] + hx, Math.max(s.pos[0] - hx, target[0]));
  const cz = Math.min(s.pos[2] + hz, Math.max(s.pos[2] - hz, target[2]));
  const ex = Math.abs(cx - s.pos[0]) / hx >= Math.abs(cz - s.pos[2]) / hz;
  const out: Vec3 = ex ? [s.pos[0] + Math.sign(cx - s.pos[0] || 1) * (hx + 1), 0, cz] : [cx, 0, s.pos[2] + Math.sign(cz - s.pos[2] || 1) * (hz + 1)];
  for (let t = 0; t < 240 && budget.ticks > 0 && !sim.result; t++) {
    const q = sim.pos("player");
    if (q[1] - 0.9 < top - 0.5 && sim.player.grounded) return true;
    const ux = out[0] - q[0];
    const uz = out[2] - q[2];
    const k = 127 / (Math.sqrt(ux * ux + uz * uz) || 1);
    sim.step({ tick: sim.tick + 1, wx: Math.round(ux * k), wz: Math.round(uz * k), btn: 0 });
    budget.ticks--;
  }
  return false;
}

/** Walk there, climbing onto a raised surface first if the navmesh can't reach it on foot. */
function goTo(sim: SimWorld, nav: NavWorld, b: WorldBundle, target: Target, rng: () => number, speed: number, budget: { ticks: number }, stop: () => boolean): boolean {
  const p = sim.pos("player");
  const t = at(target);
  if (typeof target !== "function" && !nav.path([p[0], p[1] - 0.9, p[2]], t) && !stop()) {
    const q = sim.pos("player");
    if (dropDown(sim, b, t, budget) && nav.path([q[0], q[1] - 0.9, q[2]], t)) {
      // down, and the target is walkable from here
    } else if (!nav.path([sim.pos("player")[0], sim.pos("player")[1] - 0.9, sim.pos("player")[2]], t) && !climbOnto(sim, nav, b, t, rng, budget)) return stop();
  }
  return walkTo(sim, nav, target, rng, speed, budget, stop);
}

interface Run {
  sim: SimWorld;
  nav: NavWorld;
  b: WorldBundle;
  rng: () => number;
  speed: number;
  budget: { ticks: number };
  openers: ReadonlyMap<string, PlanStep[]>;
  opened: Set<string>;
}

const live = (r: Run) => r.budget.ticks > 0 && !r.sim.result;

/** Counts a rule's firings from now on. */
function counter(sim: SimWorld, rule: string): () => number {
  let seen = sim.log.length;
  let n = 0;
  return () => {
    for (; seen < sim.log.length; seen++) if (sim.log[seen]!.rule === rule) n++;
    return n;
  };
}

/** Does the segment a→b cross the box (grown by the capsule radius) on the ground plane? */
function crosses(a: Vec3, b: Vec3, c: Vec3, size: Vec3): boolean {
  let lo = 0;
  let hi = 1;
  for (const k of [0, 2] as const) {
    const d = b[k] - a[k];
    const min = c[k] - size[k] / 2 - 0.35;
    const max = c[k] + size[k] / 2 + 0.35;
    if (Math.abs(d) < 1e-9) {
      if (a[k] < min || a[k] > max) return false;
      continue;
    }
    let u = (min - a[k]) / d;
    let v = (max - a[k]) / d;
    if (u > v) [u, v] = [v, u];
    lo = Math.max(lo, u);
    hi = Math.min(hi, v);
    if (lo > hi) return false;
  }
  return true;
}

/** If a closed door stands on the way to `target`, open it first (once per door per run). */
function clearDoors(r: Run, target: Vec3) {
  const p = r.sim.pos("player");
  const path = r.nav.path([p[0], p[1] - 0.9, p[2]], target);
  if (!path) return;
  for (let i = 1; i < path.length; i++) {
    for (const d of r.b.entities) {
      if (d.kind !== "door" || r.opened.has(d.id)) continue;
      const e = r.sim.entity(d.id);
      if (!e || e.destroyed || e.state === "open" || !crosses(path[i - 1]!, path[i]!, d.pos, d.size)) continue;
      r.opened.add(d.id);
      for (const st of r.openers.get(d.id) ?? []) if (perform(r, st, "") !== "ok") return;
    }
  }
}

/** Where to stand to reach a solid thing: the closest walkable point to it. */
const spotBy = (r: Run, id: string): Vec3 => {
  const e = r.b.entities.find((x) => x.id === id)!;
  return r.nav.nearest(e.pos) ?? e.pos;
};

/** Execute one plan step in physics; "lost" means a carried item was taken (start over). */
function perform(r: Run, st: PlanStep, carried: string): "ok" | "lost" | "stuck" {
  const { sim, nav, b, rng, speed, budget } = r;
  const go = (t: Vec3 | (() => Vec3), stop: () => boolean) => {
    if (typeof t !== "function") clearDoors(r, t);
    return goTo(sim, nav, b, t, rng, speed, budget, stop);
  };
  const gone = (id: string) => sim.entity(id)?.destroyed === true;
  switch (st.do) {
    case "pickup": {
      const has = () => sim.entity(st.item)?.carrier === "player";
      // it may be in someone else's hands: chase the carrier (a tag knocks it loose)
      const where = () => {
        const c = sim.entity(st.item)!.carrier;
        return c ? sim.pos(c) : sim.pos(st.item);
      };
      if (!sim.entity(st.item)!.carrier) clearDoors(r, sim.pos(st.item));
      return go(where, has) ? "ok" : "stuck";
    }
    case "deliver": {
      const fired = counter(sim, st.rule);
      const lost = () => carried !== "" && sim.entity(carried)?.carrier !== "player";
      const sensor = b.entities.find((e) => e.id === st.sensor)!;
      go(sensor.pos, () => fired() > 0 || lost());
      if (fired() > 0) return "ok";
      return lost() && live(r) ? "lost" : "stuck";
    }
    case "use": {
      const fired = counter(sim, st.rule);
      const done = () => (st.rule ? fired() > 0 : sim.entity(st.at)?.state === "open");
      for (let attempt = 0; attempt < 3 && live(r) && !done(); attempt++) {
        go(spotBy(r, st.at), () => sim.usable()?.on === st.at || done());
        if (sim.usable()?.on !== st.at || !live(r)) continue;
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.USE });
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: 0 });
        budget.ticks -= 2;
      }
      return done() ? "ok" : "stuck";
    }
    case "touch": {
      const fired = counter(sim, st.rule);
      go(spotBy(r, st.at), () => fired() > 0 || gone(st.at));
      return fired() > 0 || gone(st.at) ? "ok" : "stuck";
    }
    case "collect": {
      const fired = counter(sim, st.rule);
      while (live(r) && fired() < st.times) {
        const p = sim.pos("player");
        const left = st.items.filter((id) => !gone(id)).sort((x, y) => d2h(sim.pos(x), p) - d2h(sim.pos(y), p) || (x < y ? -1 : 1));
        if (!left.length) break;
        const it = left[0]!;
        const t0 = sim.tick;
        const ok = go(spotBy(r, it), () => gone(it));
        if (!gone(it) && (!ok || sim.tick === t0)) return "stuck"; // never spin in place
      }
      return fired() >= st.times ? "ok" : "stuck";
    }
    case "wait": {
      const fired = counter(sim, st.rule);
      while (live(r) && fired() === 0) {
        sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: 0 });
        budget.ticks--;
      }
      return fired() > 0 ? "ok" : "stuck";
    }
  }
}

function witnessRun(R: Rapier, b: WorldBundle, nav: NavWorld, chain: WinChain, openers: ReadonlyMap<string, PlanStep[]>, seed: number, playerTeam: "red" | "blue"): RunResult {
  // The cast plays too: runners must beat the same bots the judge will face.
  const sim = new SimWorld(R, b, { playerTeam, brain: castBrain(nav, b) });
  const rng = stream(seed, `t3:run`);
  const r: Run = { sim, nav, b, rng, speed: 0.85 + rng() * 0.15, budget: { ticks: RUN_TICKS }, openers, opened: new Set() };
  let stuck = 0;
  let lastTop = -1;
  outer: while (live(r)) {
    if (sim.tick === lastTop) break; // a whole pass without a tick: never spin
    lastTop = sim.tick;
    let carried = "";
    for (const st of chain.steps) {
      const res = perform(r, st, carried);
      if (st.do === "pickup" && res === "ok") carried = st.item;
      if (res === "lost") continue outer; // tagged on the way: go and win it back
      if (res === "stuck") {
        if (live(r)) stuck++;
        break outer;
      }
      if (sim.result) break outer;
    }
    if (chain.steps.length === 0) break;
  }
  const out = { won: sim.result === "win", ticks: sim.tick, stuck };
  sim.free();
  return out;
}

/** Physics check of a "requires jumps>=k" expectation: approach the target's ledge and jump. */
function jumpWitness(R: Rapier, b: WorldBundle, nav: NavWorld, x: Expect, jumps: number, attempt: number, playerTeam: "red" | "blue"): boolean {
  const targets = b.statics.filter((s) => s.zone === x.b);
  if (!targets.length) return false;
  const seg = targets[attempt % targets.length]!;
  const top = seg.pos[1] + seg.size[1] / 2;
  const faceZ = seg.pos[2] - seg.size[2] / 2;
  const xs = seg.pos[0] + ((attempt % 3) - 1) * seg.size[0] * 0.25;
  const sim = new SimWorld(R, b, { playerTeam, laws: { jumpsMax: jumps } });
  const budget = { ticks: RUN_TICKS };
  walkTo(sim, nav, [xs, 0, faceZ - 0.7], stream(attempt, "t3:jump"), 1, budget, () => false);
  // One attempt: jump, air-jump at each apex, keep pushing toward the face; stop on landing.
  let onTop = false;
  for (let t = 0; t < 150 && !onTop; t++) {
    const first = t === 0;
    const again = t > 6 && sim.player.vy <= 0.5 && sim.player.jumpsUsed < jumps && sim.player.jumpsUsed > 0;
    // push toward the face until the feet clear the ledge, then steer to the middle of the top
    const q = sim.pos("player");
    const above = q[1] - 0.9 > top + 0.05;
    const mid = faceZ + seg.size[2] / 2;
    const wz = above ? Math.max(-127, Math.min(127, Math.round((mid - q[2]) * 60))) : 127;
    sim.step({ tick: sim.tick + 1, wx: 0, wz, btn: first || again ? BTN.JUMP : 0 });
    if (again) sim.step({ tick: sim.tick + 1, wx: 0, wz, btn: 0 });
    const p = sim.pos("player");
    const inside = p[0] >= seg.pos[0] - seg.size[0] / 2 && p[0] <= seg.pos[0] + seg.size[0] / 2 && p[2] > faceZ && p[2] <= faceZ + seg.size[2];
    onTop = t > 0 && sim.player.grounded && inside && p[1] - 0.9 > top - 0.05;
    if (t > 0 && sim.player.grounded && !inside && p[1] < 1.5) break; // landed back on the street
  }
  sim.free();
  return onTop;
}

export function t3(R: Rapier, b: WorldBundle, nav: NavWorld, chain: WinChain | null, runs: number, playerTeam: "red" | "blue" = "red", openers: ReadonlyMap<string, PlanStep[]> = new Map()): { chips: Chip[]; par: { goldS: number; runs: number; won: number } | null } {
  const chips: Chip[] = [];
  let par: { goldS: number; runs: number; won: number } | null = null;
  if (chain && b.mode === "play") {
    const t0 = globalThis.performance?.now?.() ?? 0;
    const results = Array.from({ length: runs }, (_, i) => witnessRun(R, b, nav, chain, openers, b.seed * 1000 + i, playerTeam));
    const bots = b.entities.filter((e) => e.kind === "npc" && e.body !== "none" && e.body !== "sensor").length;
    const vs = bots ? ` vs ${bots} bot${bots > 1 ? "s" : ""}` : "";
    const won = results.filter((r) => r.won);
    const gold = won.length ? Math.min(...won.map((r) => r.ticks)) / 60 : 0;
    par = won.length ? { goldS: Math.round(gold * 10) / 10, runs, won: won.length } : null;
    chips.push({
      id: "T3:win",
      tier: "T3",
      subject: { kind: "property", id: "win_reachable" },
      status: won.length ? "played" : "counterexample",
      method: `physics, ${runs} AI runners${vs}`,
      n: runs,
      k: won.length,
      text: won.length ? `AI runners won by playing it${vs} (AI par ${par!.goldS} s)` : `no AI runner could win${vs}`,
      cx: won.length ? null : { where: null, have: 0, need: 1, unit: "wins", text: `${results.reduce((a, r) => a + r.stuck, 0)} runs got stuck` },
      src: "",
      ms: Math.round((globalThis.performance?.now?.() ?? 0) - t0),
    });
    // a win in under 3 s means the world asks nothing of the player: honest, but not a game
    if (par && par.goldS < TOO_EASY_S) {
      chips.push({
        id: "T3:too_easy", tier: "T3", subject: { kind: "property", id: "win_reachable" }, status: "counterexample", method: `physics, ${runs} AI runners`,
        n: runs, k: won.length, text: `won in ${par.goldS} s: the win needs none of what the world asks for`,
        cx: { where: null, have: par.goldS, need: TOO_EASY_S, unit: "s", text: `AI par ${par.goldS} s < ${TOO_EASY_S} s` }, src: "", ms: 0,
      });
    }
  }
  for (const x of b.expects.filter((e) => e.prop === "requires")) {
    const m = x.need.map((n) => /^jumps>=(\d+)$/.exec(n.replace(/\s/g, ""))).find(Boolean);
    if (!m) continue;
    const k = Number(m[1]);
    const t0 = globalThis.performance?.now?.() ?? 0;
    const n = 4;
    const withK = Array.from({ length: n }, (_, i) => jumpWitness(R, b, nav, x, k, i, playerTeam)).filter(Boolean).length;
    const withFewer = Array.from({ length: n }, (_, i) => jumpWitness(R, b, nav, x, k - 1, i, playerTeam)).filter(Boolean).length;
    const good = withK > 0 && withFewer === 0;
    chips.push({
      id: `T3:${x.id}`,
      tier: "T3",
      subject: { kind: "property", id: x.id },
      status: good ? "played" : "counterexample",
      method: `physics jump witness, ${n} attempts per jump count`,
      n,
      k: withK,
      text: `${x.text || x.id}: reached with ${k} jumps ${withK} of ${n}, with ${k - 1} ${withFewer} of ${n}`,
      cx: good ? null : { where: null, have: withFewer, need: 0, unit: "attempts", text: withK === 0 ? `never reached with ${k} jumps` : `reached with only ${k - 1} jump(s)` },
      src: x.src === "user" ? "user" : x.src,
      ms: Math.round((globalThis.performance?.now?.() ?? 0) - t0),
    });
  }
  return { chips, par };
}
