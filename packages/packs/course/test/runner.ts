// A course-aware scripted runner for the deterministic sim: walks each pad to its edge, jumps the
// next hop with the fewest jumps the T1 model says it needs (air-jumping at each apex), and walks
// beams straight down their centre lines. It shows the course is beatable in real physics, which
// the proof's T3 runners can't yet show (they follow navmesh paths with one jump per plan step).
import type { Laws, WorldBundle } from "@ghostrun/ir";
import { apex, reachAt } from "@ghostrun/proof";
import { BTN, SimWorld, steerTo, type Rapier } from "@ghostrun/sim";
import { gap } from "./reach";

export interface Plat {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  top: number;
  cx: number;
  cz: number;
  w: number;
  min: [number, number];
  max: [number, number];
}

/** The route: every platform at or above the start pad, in course order (the course only runs +z). */
export function courseRoute(b: WorldBundle): Plat[] {
  return b.statics
    .filter((s) => s.surf === "ledge" && s.pos[1] + s.size[1] / 2 > -0.01)
    .map((s) => {
      const [x0, x1, z0, z1] = [s.pos[0] - s.size[0] / 2, s.pos[0] + s.size[0] / 2, s.pos[2] - s.size[2] / 2, s.pos[2] + s.size[2] / 2];
      return { x0, x1, z0, z1, top: s.pos[1] + s.size[1] / 2, cx: s.pos[0], cz: s.pos[2], w: s.size[0], min: [x0, z0] as [number, number], max: [x1, z1] as [number, number] };
    })
    .sort((a, b) => a.z0 - b.z0);
}

export interface RunOut {
  result: "win" | "lose" | null;
  ticks: number;
  reached: number; // route index of the last platform stood on
  hops: number; // route length − 1
  jumps: number[]; // jumps used per jumped hop
}

export function runCourse(R: Rapier, b: WorldBundle, goal: [number, number], opts: { laws?: Partial<Laws>; maxTicks?: number } = {}): RunOut {
  const sim = new SimWorld(R, b, opts.laws ? { laws: opts.laws } : {});
  const maxTicks = opts.maxTicks ?? 60 * 150;
  const laws = sim.laws;
  const route = courseRoute(b);
  const used: number[] = [];
  let budget = maxTicks;
  const clamp = (v: number) => Math.max(-127, Math.min(127, Math.round(v)));
  const step = (wx: number, wz: number, btn: number) => {
    sim.step({ tick: sim.tick + 1, wx, wz, btn });
    budget--;
  };
  /** Proportional walk onto (x, z), so it can settle precisely (beams are 0.5 m wide). */
  const walk = (x: number, z: number, tol: number) => {
    for (let t = 0; t < 900 && budget > 0 && !sim.result; t++) {
      const p = sim.pos("player");
      const dx = x - p[0];
      const dz = z - p[2];
      if (dx * dx + dz * dz < tol * tol) return true;
      step(clamp(dx * 120), clamp(dz * 120), 0);
    }
    return false;
  };
  const hop = (a: Plat, n: Plat): boolean => {
    const rise = n.top - a.top;
    const g = gap(a, n);
    if (g <= 0.01 && Math.abs(rise) < 0.41) {
      // walk across; on or onto a beam, stay on its centre line
      const tx = n.w < 1.2 ? n.cx : a.w < 1.2 ? a.cx : Math.max(a.x0 + 0.4, Math.min(a.x1 - 0.4, n.cx));
      return walk(tx, a.z1 - 0.5, 0.05) && walk(tx, n.z0 + Math.min(0.6, (n.z1 - n.z0) / 2), 0.1);
    }
    let jumps = 1;
    while (jumps < laws.jumpsMax && !(rise <= apex(laws, jumps) + 1e-9 && g <= reachAt(laws, jumps, rise))) jumps++;
    used.push(jumps);
    const tx = Math.max(a.x0 + 0.4, Math.min(a.x1 - 0.4, n.cx));
    if (!walk(tx, a.z1 - 0.3, 0.08)) return false;
    const aim = { x: n.cx, z: n.z0 + Math.min(1.2, (n.z1 - n.z0) / 2) };
    // With little air control the take-off speed decides the landing: like an analog stick, pick
    // the speed that comes down at the aim (airtime of `jumps` chained jumps ending `rise` higher).
    const g0 = 9.81 * laws.gravityScale;
    const ta = Math.sqrt(2 * g0 * laws.jumpH) / g0;
    const airtime = jumps * ta + Math.sqrt(Math.max(0, (2 * (jumps * laws.jumpH - rise)) / g0));
    const p0 = sim.pos("player");
    const dist = Math.sqrt((aim.x - p0[0]) * (aim.x - p0[0]) + (aim.z - p0[2]) * (aim.z - p0[2]));
    const scale = laws.airControl < 0.3 ? Math.min(1, dist / airtime / laws.speed) : 1;
    for (let t = 0; t < 300 && budget > 0 && !sim.result; t++) {
      const p = sim.pos("player");
      const again = t > 6 && sim.player.vy <= 0.5 && sim.player.jumpsUsed > 0 && sim.player.jumpsUsed < jumps;
      const f = steerTo(0, { x: p[0], z: p[2] }, aim);
      const wx = scale < 1 ? Math.round(((aim.x - p0[0]) / dist) * 127 * scale) : f.wx;
      const wz = scale < 1 ? Math.round(((aim.z - p0[2]) / dist) * 127 * scale) : f.wz;
      step(wx, wz, t === 0 || again ? BTN.JUMP : 0);
      if (again) step(wx, wz, 0); // release, so the next press is a fresh one
      const q = sim.pos("player");
      const on = q[0] >= n.x0 && q[0] <= n.x1 && q[2] >= n.z0 && q[2] <= n.z1;
      if (t > 2 && sim.player.grounded && on && q[1] - 0.9 > n.top - 0.15) return true;
      if (q[1] - 0.9 < Math.min(a.top, n.top) - 1.5) return false; // fell
    }
    return false;
  };
  let reached = 0;
  for (let i = 1; i < route.length && !sim.result; i++) {
    if (!hop(route[i - 1]!, route[i]!)) break;
    reached = i;
  }
  if (reached === route.length - 1) walk(goal[0], goal[1], 0.3);
  for (let t = 0; t < 30 && !sim.result; t++) step(0, 0, 0);
  const out: RunOut = { result: sim.result, ticks: sim.tick, reached, hops: route.length - 1, jumps: used };
  sim.free();
  return out;
}
