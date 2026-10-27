// Test helpers: the T1 surface graph (same surfaces, gaps and hop rule as packages/proof/src/t1.ts,
// using its exported ballistic model) so tests can ask about single anchors, which T1 itself only
// answers per zone.
import type { Laws, Vec3, WorldBundle } from "@ghostrun/ir";
import type { PackLayout } from "@ghostrun/plugin-api";
import { apex, reachAt } from "@ghostrun/proof";

export interface Surf {
  id: string;
  zone: string;
  top: number;
  min: [number, number];
  max: [number, number];
}

export function surfaces(b: WorldBundle): Surf[] {
  return b.statics
    .filter((s) => s.surf === "floor" || s.surf === "ledge" || s.surf === "roof" || s.surf === "wall")
    .map((s) => ({
      id: s.id,
      zone: s.zone,
      top: s.pos[1] + s.size[1] / 2,
      min: [s.pos[0] - s.size[0] / 2, s.pos[2] - s.size[2] / 2] as [number, number],
      max: [s.pos[0] + s.size[0] / 2, s.pos[2] + s.size[2] / 2] as [number, number],
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function gap(a: Pick<Surf, "min" | "max">, b: Pick<Surf, "min" | "max">): number {
  const dx = Math.max(0, a.min[0] - b.max[0], b.min[0] - a.max[0]);
  const dz = Math.max(0, a.min[1] - b.max[1], b.min[1] - a.max[1]);
  return Math.sqrt(dx * dx + dz * dz);
}

export function surfaceUnder(ss: Surf[], p: Vec3): Surf | undefined {
  let best: Surf | undefined;
  for (const s of ss) {
    if (p[0] < s.min[0] || p[0] > s.max[0] || p[2] < s.min[1] || p[2] > s.max[1]) continue;
    if (s.top > p[1] + 0.2) continue;
    if (!best || s.top > best.top) best = s;
  }
  return best;
}

/** T1's BFS: walk between touching surfaces under 0.41 m apart, else hop within the ballistic reach. */
export function reachable(ss: Surf[], start: Surf, laws: Laws, jumps: number): Set<string> {
  const up = apex(laws, jumps);
  const seen = new Set([start.id]);
  const queue = [start];
  while (queue.length) {
    const s = queue.shift()!;
    for (const t of ss) {
      if (seen.has(t.id)) continue;
      const rise = t.top - s.top;
      if (rise > up + 1e-9) continue;
      const limit = Math.abs(rise) < 0.41 ? 0.01 : reachAt(laws, jumps, rise);
      if (limit < 0 || gap(s, t) > limit) continue;
      seen.add(t.id);
      queue.push(t);
    }
  }
  return seen;
}

/** A minimal fill (one zone per slot, a red spawn) as JSONL, plus any extra op lines. */
export function fillFor(packId: string, layout: PackLayout, seed: number, laws: Partial<Laws>, spawn: { slot: string; anchor: string }, extra: string[] = []): string {
  return [
    JSON.stringify({ op: "meta", mode: "play", pack: packId, seed }),
    ...layout.zones.map((z) => JSON.stringify({ op: "zone", id: `z_${z.slot}`, slot: z.slot, tag: z.tag, name: z.slot })),
    JSON.stringify({ op: "spawn", id: "sp_red", zone: `z_${spawn.slot}`, anchor: spawn.anchor, team: "red" }),
    ...extra,
    JSON.stringify({ op: "law", player: laws }),
    JSON.stringify({ op: "end", layer: "gameplay" }),
  ].join("\n");
}

/** Every anchor of a layout, flattened. */
export const allAnchors = (layout: PackLayout) => layout.zones.flatMap((z) => Object.entries(z.anchors).map(([name, a]) => ({ slot: z.slot, name, a })));

/** Statics (as AABBs) that reach into the 2 × 1.95 × 2 m box standing on an anchor. */
export function solidsNear(layout: PackLayout, a: Vec3, r = 1): string[] {
  const hits: string[] = [];
  layout.statics.forEach((s, i) => {
    if (s.surf === "water" || s.surf === "hazard") return; // not solid to stand next to
    const lo = [s.pos[0] - s.size[0] / 2, s.pos[1] - s.size[1] / 2, s.pos[2] - s.size[2] / 2];
    const hi = [s.pos[0] + s.size[0] / 2, s.pos[1] + s.size[1] / 2, s.pos[2] + s.size[2] / 2];
    const inX = hi[0]! > a[0] - r && lo[0]! < a[0] + r;
    const inZ = hi[2]! > a[2] - r && lo[2]! < a[2] + r;
    const inY = hi[1]! > a[1] + 0.05 && lo[1]! < a[1] + 2;
    if (inX && inY && inZ) hits.push(`#${i} ${s.zoneSlot}/${s.surf}`);
  });
  return hits;
}
