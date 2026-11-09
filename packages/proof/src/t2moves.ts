// Flight, zero-g and water on the proof ladder, T2: each law forced in the real simulation (fuel
// held to empty, a breath held to its end, the thrust law's speed and its stop).
import { clampLaws, type Vec3, type WorldBundle } from "@ghostrun/ir";
import { flightOf, HEAD_UP, watersOf, zeroG } from "@ghostrun/kits";
import { BTN, SimWorld, type Rapier } from "@ghostrun/sim";
import type { Chip } from "./types";

const round = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;
const now = () => globalThis.performance?.now?.() ?? 0;
const nounOf = (b: WorldBundle, id: string) => `the ${b.entities.find((e) => e.id === id)?.noun || id.replace(/_/g, " ")}`;

/** A spot with room to stand on the spawn's surface (feet), for the forced tests. */
function spawnFeet(b: WorldBundle, playerTeam: string): Vec3 | null {
  const sp = b.entities.find((e) => e.kind === "spawn" && e.team === playerTeam) ?? b.entities.find((e) => e.kind === "spawn");
  return sp ? sp.pos : null;
}

/**
 * T2 for movement laws, forced in the real simulation from the spawn (the cast stands still): a
 * jetpack's fuel held to empty climbs what the model says and then falls, and a landing fills it
 * again; the zero-g law reaches its speed in speed ÷ thrust seconds and brings you to a stop; a
 * breath held to its end under water sends you back to the start.
 */
export function t2Moves(R: Rapier, b: WorldBundle, playerTeam: "red" | "blue" = "red"): Chip[] {
  const chips: Chip[] = [];
  const at = spawnFeet(b, playerTeam);
  if (!at) return chips;
  const free = (sim: SimWorld) => sim.free();
  const f = flightOf({ verbs: b.verbs, laws: { ...b.laws, gravityScale: 1 } });
  const zg = zeroG(clampLaws(b.laws));
  if (f && !zg) {
    const t0 = now();
    const sim = new SimWorld(R, b, { playerTeam, brain: { think: () => new Map() } });
    for (let i = 0; i < 10; i++) sim.step(null);
    const y0 = sim.pos("player")[1];
    const ticks = Math.round(f.fuel * 60);
    let top = y0;
    let out = -1;
    for (let i = 0; i < ticks + 120 && !sim.result; i++) {
      sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.JUMP });
      top = Math.max(top, sim.pos("player")[1]);
      if (out < 0 && sim.player.fuel === 0) out = i + 1;
    }
    const rose = top - y0;
    const fell = sim.pos("player")[1] < top - 0.5;
    const model = f.climb * 0.9 * f.fuel;
    // and down again: a landing refuels
    let landed = false;
    for (let i = 0; i < 1200 && !sim.result && !landed; i++) {
      sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: 0 });
      landed = sim.player.grounded;
    }
    const refuelled = landed && sim.player.fuel === ticks;
    free(sim);
    // (a ceiling over the spawn stops the climb: then the forced test says so, not the model)
    const ok = out === ticks && rose >= model && fell && refuelled;
    chips.push({
      id: "T2:fly", tier: "T2", subject: { kind: "world", id: f.id }, n: 1, k: ok ? 1 : 0, src: "", ms: Math.round(now() - t0),
      method: `forced state (jump held from the spawn for the ${r1(f.fuel)} s of fuel, then let go)`,
      status: ok ? "verified" : "counterexample",
      text: `the ${f.kind}'s fuel lasts ${r1(f.fuel)} s and climbs at least the model's ${r1(model)} m, then you fall, and landing refuels it`,
      cx: ok ? null : { where: null, have: round(rose), need: round(model), unit: "m", text: out !== ticks ? `the fuel ran out after ${out < 0 ? "never" : `${r1(out / 60)} s`}` : !fell ? "it kept flying with the fuel gone" : !refuelled ? "landing didn't refuel it" : `it climbed ${r1(rose)} m in ${r1(f.fuel)} s (a ceiling over the spawn?)` },
    });
  }
  if (zg) {
    const t0 = now();
    const sim = new SimWorld(R, b, { playerTeam, brain: { think: () => new Map() } });
    const laws = sim.laws;
    const up = Math.round((laws.speed / Math.max(1, laws.thrust)) * 60);
    let vy = 0;
    for (let i = 0; i < up + 5 && !sim.result; i++) {
      sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.JUMP });
      vy = sim.player.vy;
    }
    let stopped = -1;
    for (let i = 0; i < up + 30 && !sim.result && stopped < 0; i++) {
      sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: 0 });
      if (Math.abs(sim.player.vy) < 1e-6) stopped = i + 1;
    }
    free(sim);
    // (a ceiling in the way stops it sooner: still a stop)
    const ok = vy > laws.speed * 0.95 - 1e-6 && vy <= laws.speed + 1e-6 && stopped > 0;
    chips.push({
      id: "T2:zero_g", tier: "T2", subject: { kind: "world", id: "laws" }, n: 1, k: ok ? 1 : 0, src: "", ms: Math.round(now() - t0),
      method: `forced state (thrust held up from the spawn for ${r1(up / 60)} s, then let go)`,
      status: ok ? "verified" : "counterexample",
      text: `the thrust law reaches ${r1(laws.speed)} m/s in ${r1(up / 60)} s and stops you again`,
      cx: ok ? null : { where: null, have: round(vy), need: round(laws.speed), unit: "m/s", text: stopped < 0 ? "it never stopped" : `it reached ${r1(vy)} m/s` },
    });
  }
  for (const w of watersOf(b)) {
    const t0 = now();
    const sim = new SimWorld(R, b, { playerTeam, brain: { think: () => new Map() } });
    const x = (w.min[0] + w.max[0]) / 2;
    const z = (w.min[2] + w.max[2]) / 2;
    // the middle of the water, head two metres under (or as deep as it goes)
    const y = Math.max(w.min[1] + HEAD_UP + 0.1, w.max[1] - 2 - HEAD_UP);
    sim.teleport("player", [x, y, z]);
    const base: Omit<Chip, "status" | "text" | "cx" | "method" | "n" | "k"> = { id: `T2:swim:${w.id}`, tier: "T2", subject: { kind: "world", id: w.verb }, src: "", ms: 0 };
    if (w.breath > 0) {
      const limit = Math.round(w.breath * 60);
      let out = -1;
      let back = false;
      for (let i = 0; i < limit + 60 && !sim.result && out < 0; i++) {
        const evs = sim.step({ tick: sim.tick + 1, wx: 0, wz: 0, btn: BTN.DOWN });
        if (evs.some((e) => e.k === "breath_out" && e.a === "player")) ((out = i + 1), (back = evs.some((e) => e.k === "respawn" && e.a === "player")));
      }
      free(sim);
      const ok = out === limit && back;
      chips.push({
        ...base, n: 1, k: ok ? 1 : 0, ms: Math.round(now() - t0), method: `forced state (held under in the ${nounOf(b, w.id).slice(4)}, ${r1(w.breath)} s)`,
        status: ok ? "verified" : "counterexample",
        text: `a breath lasts ${r1(w.breath)} s under water, then you're back at the start`,
        cx: ok ? null : { where: [x, y, z], have: out < 0 ? 0 : round(out / 60), need: w.breath, unit: "s", text: out < 0 ? "the breath never ran out" : !back ? "out of breath, and still there" : `the breath ran out after ${r1(out / 60)} s` },
      });
    } else {
      let up = -1;
      for (let i = 0; i < 600 && !sim.result && up < 0; i++) {
        sim.step(null);
        if (sim.pos("player")[1] + HEAD_UP >= w.max[1] - 0.05) up = i + 1;
      }
      free(sim);
      const ok = up > 0;
      chips.push({
        ...base, n: 1, k: ok ? 1 : 0, ms: Math.round(now() - t0), method: "forced state (let go two metres under)",
        status: ok ? "verified" : "counterexample",
        text: "you float back up to the surface by yourself",
        cx: ok ? null : { where: [x, y, z], have: 0, need: 1, unit: "surfacings", text: "it stayed under for 10 s" },
      });
    }
  }
  return chips;
}
