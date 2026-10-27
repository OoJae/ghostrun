// Play analytics from the AI runners' routes: what nobody went near, and where the time went. The
// same questions the runners already answer about winning ("can it be won?") asked about design:
// a world where every runner walks past half of what's in it has a design note to make.
import type { WorldBundle } from "@ghostrun/ir";
import type { Trail } from "./types";

export interface Insights {
  /** Things to use or look at that no runner came within 4 m of. */
  unused: { id: string; noun: string }[];
  /** The 2 m cells where runners spent the most time, with their share of it. */
  hot: { x: number; z: number; share: number; near: string }[];
  /** Samples behind the numbers (runs × positions). */
  samples: number;
}

const CELL = 2;

export function insights(b: WorldBundle, trails: readonly Trail[]): Insights {
  const pts: [number, number][] = [];
  for (const t of trails) for (let i = 0; i + 2 < t.xyz.length; i += 3) pts.push([t.xyz[i]!, t.xyz[i + 2]!]);
  // what a player is meant to go to: things with a verb (to use, carry, look at), not the spawn
  const used = new Set(b.verbs.map((v) => v.on));
  const things = b.entities.filter((e) => e.kind !== "spawn" && e.kind !== "npc" && used.has(e.id) && !e.tags.includes("bonus") && !e.tags.includes("area"));
  const unused = pts.length
    ? things
        .filter((e) => !pts.some(([x, z]) => (x - e.pos[0]) * (x - e.pos[0]) + (z - e.pos[2]) * (z - e.pos[2]) < 16))
        .map((e) => ({ id: e.id, noun: e.noun || e.id.replace(/_/g, " ") }))
    : [];
  const cells = new Map<string, number>();
  for (const [x, z] of pts) {
    const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    cells.set(k, (cells.get(k) ?? 0) + 1);
  }
  const nearest = (x: number, z: number) => {
    let best = "";
    let bestD = 64; // within 8 m
    for (const e of b.entities) {
      if (e.kind === "spawn" || e.tags.includes("bonus") || e.tags.includes("area")) continue;
      const d = (x - e.pos[0]) * (x - e.pos[0]) + (z - e.pos[2]) * (z - e.pos[2]);
      if (d < bestD) ((bestD = d), (best = e.noun || e.id.replace(/_/g, " ")));
    }
    return best;
  };
  // busiest cells, merged by what they're near (two cells by the orb are one place to a reader)
  const byNear = new Map<string, { x: number; z: number; n: number }>();
  for (const [k, n] of [...cells].sort((u, v) => v[1] - u[1] || (u[0] < v[0] ? -1 : 1))) {
    const [cx, cz] = k.split(",").map(Number) as [number, number];
    const [x, z] = [(cx + 0.5) * CELL, (cz + 0.5) * CELL];
    const near = nearest(x, z);
    const key = near || k;
    const cur = byNear.get(key);
    if (cur) cur.n += n;
    else byNear.set(key, { x, z, n });
  }
  const hot = [...byNear]
    .sort((u, v) => v[1].n - u[1].n || (u[0] < v[0] ? -1 : 1))
    .slice(0, 3)
    .map(([near, c]) => ({ x: c.x, z: c.z, share: pts.length ? c.n / pts.length : 0, near: near.includes(",") ? "" : near }));
  return { unused, hot, samples: pts.length };
}
