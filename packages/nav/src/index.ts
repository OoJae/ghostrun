// Navmesh for runners and NPCs: recast-navigation built from the world's statics and fixed props.
// NPCs move, so they are dynamic obstacles for the KCC, never baked in. Loads from a pre-compiled
// wasm module on every runtime (S0b).
import { getNavMeshPositionsAndIndices, init as initRecast, NavMesh, NavMeshQuery } from "@recast-navigation/core";
import { generateSoloNavMesh } from "@recast-navigation/generators";
import RecastFactory from "@recast-navigation/wasm/wasm";
import type { Vec3, WorldBundle } from "@ghostrun/ir";

let ready: Promise<void> | undefined;

/** Initialise recast once per realm from an already-compiled module. */
export function initNav(module: WebAssembly.Module): Promise<void> {
  ready ??= initRecast((() =>
    RecastFactory({
      instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
        WebAssembly.instantiate(module, imports).then((inst) => done(inst, module));
        return {};
      },
    })) as unknown as typeof RecastFactory);
  return ready;
}

export const AGENT = { radius: 0.35, height: 1.8, climb: 0.4 } as const;
// 0.1 m voxels with a 0.3 m erosion keep real-scale 0.9 m doorways open for a 0.7 m capsule
// (at 0.2 m, ceil-rounded erosion of 0.4 m per side seals them). Physics witnesses (T3) still
// catch any gap the slightly smaller erosion lets through.
const CS = 0.1;
const CH = 0.1;

function pushBox(pos: number[], idx: number[], c: Vec3, s: Vec3) {
  const b = pos.length / 3;
  const [hx, hy, hz] = [s[0] / 2, s[1] / 2, s[2] / 2];
  for (const [x, y, z] of [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] as const) {
    pos.push(c[0] + x * hx, c[1] + y * hy, c[2] + z * hz);
  }
  for (const [a, d, e] of [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 6, 2], [3, 7, 6], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]] as const) {
    idx.push(b + a, b + d, b + e);
  }
}

export interface NavWorld {
  mesh: NavMesh;
  query: NavMeshQuery;
  polys: number;
  /** Ground path between two points, or null if unreachable by walking. */
  path(from: Vec3, to: Vec3): Vec3[] | null;
  /** Closest walkable point within a few metres (e.g. under a player standing on a roof), or null. */
  nearest(p: Vec3): Vec3 | null;
  destroy(): void;
}

/** Build the walking navmesh: statics plus fixed solid entities (props) as obstacles. */
export function buildNav(b: WorldBundle): NavWorld {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const s of [...b.statics].sort((x, y) => (x.id < y.id ? -1 : 1))) pushBox(pos, idx, s.pos, s.size);
  // somewhere you lose by walking into (out of bounds, a pit sensor) is avoided like a hazard
  const losing = new Set(b.rules.filter((r) => r.when.t === "enter" && r.when.a === "player" && r.then.some((x) => x.e === "lose")).map((r) => r.when.b));
  for (const e of [...b.entities].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    // NPCs move and doors open: both are obstacles for the KCC, never baked in
    if (e.kind !== "npc" && e.kind !== "door" && e.body === "fixed" && e.shape !== "none") pushBox(pos, idx, e.pos, e.size);
    // a standing hazard (lava, spikes) is no place to walk: AI paths go around it, as a player
    // would (moving hazards stay out: they're dodged in time, not in space)
    else if ((e.kind === "hazard" && (e.body === "sensor" || e.body === "fixed")) || losing.has(e.id)) pushBox(pos, idx, [e.pos[0], e.pos[1] - e.size[1] / 2 + 1.5, e.pos[2]], [e.size[0], 3, e.size[2]]);
  }
  const { success, navMesh } = generateSoloNavMesh(pos, idx, {
    cs: CS,
    ch: CH,
    walkableRadius: Math.floor(AGENT.radius / CS),
    walkableHeight: Math.ceil(AGENT.height / CH),
    walkableClimb: Math.floor(AGENT.climb / CH),
    walkableSlopeAngle: 45,
  });
  if (!success || !navMesh) throw new Error("navmesh build failed");
  const query = new NavMeshQuery(navMesh);
  const polys = getNavMeshPositionsAndIndices(navMesh)[1].length / 3;
  return {
    mesh: navMesh,
    query,
    polys,
    path(from, to) {
      const r = query.computePath({ x: from[0], y: from[1], z: from[2] }, { x: to[0], y: to[1], z: to[2] }, { halfExtents: { x: 1, y: 2, z: 1 } });
      if (!r.success || r.path.length === 0) return null;
      const last = r.path[r.path.length - 1]!;
      // computePath snaps to the nearest polygon; reject paths that end far from the target
      const ex = last.x - to[0];
      const ez = last.z - to[2];
      if (ex * ex + ez * ez > 1.0) return null;
      return r.path.map((p) => [p.x, p.y, p.z] as Vec3);
    },
    nearest(p) {
      const r = query.findClosestPoint({ x: p[0], y: p[1], z: p[2] }, { halfExtents: { x: 4, y: 6, z: 4 } });
      return r.success && r.polyRef ? [r.point.x, r.point.y, r.point.z] : null;
    },
    destroy() {
      query.destroy();
      navMesh.destroy();
    },
  };
}
