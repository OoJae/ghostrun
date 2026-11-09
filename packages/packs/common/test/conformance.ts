// The geometry rules every pack is held to, as one check the packs' own tests run over their CI
// seeds: (1) every anchor you stand on is reachable on foot on the navmesh the runners use, from
// the spawn; (2) nothing solid stands where a character stands on an anchor, the spawn least of
// all; (3) every doorway is a real 0.9 × 2.1 m gap with a lintel over it; (4) every zone owns ground
// the T1 surface graph reaches from the spawn using only hops whose gap is at most 0.8 of the jump's
// reach (0.95 with the 'harder' chip), so a layout never needs a frame-perfect jump; (5) anything
// raised (a counter top, a lighting rig) stands on something or is a wall-mounted anchor.
import { DEFAULT_LAWS, parseFill, type Laws, type Vec3, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "@ghostrun/nav";
import type { PackLayout } from "@ghostrun/plugin-api";
import { apex, reachAt } from "@ghostrun/proof";

export interface Surf {
  id: string;
  zone: string;
  top: number;
  min: [number, number];
  max: [number, number];
}

/** The surfaces T1 plans over (packages/proof/src/t1.ts): floors, ledges, roofs and wall tops. */
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

/** T1's BFS, with each jump's gap held to `share` of the ballistic reach (1: T1 exactly). */
export function reachable(ss: Surf[], start: Surf, laws: Laws, share = 1): Set<string> {
  const jumps = laws.jumpsMax;
  const up = apex(laws, jumps);
  const seen = new Set([start.id]);
  const queue = [start];
  while (queue.length) {
    const s = queue.shift()!;
    for (const t of ss) {
      if (seen.has(t.id)) continue;
      const rise = t.top - s.top;
      if (rise > up + 1e-9) continue;
      const walk = Math.abs(rise) < 0.41;
      const limit = walk ? 0.01 : reachAt(laws, jumps, rise) * share;
      if (limit < 0 || gap(s, t) > limit) continue;
      seen.add(t.id);
      queue.push(t);
    }
  }
  return seen;
}

/** A minimal fill for a layout: one zone per slot, a red spawn on the given anchor, the laws. */
export function fillFor(packId: string, layout: PackLayout, seed: number, laws: Partial<Laws>, spawn: { slot: string; anchor: string }, mode: "play" | "wander" = "play"): string {
  return [
    JSON.stringify({ op: "meta", mode, pack: packId, seed }),
    ...layout.zones.map((z) => JSON.stringify({ op: "zone", id: `z_${z.slot}`, slot: z.slot, tag: z.tag, name: z.slot })),
    JSON.stringify({ op: "spawn", id: "sp_red", zone: `z_${spawn.slot}`, anchor: spawn.anchor, team: "red" }),
    JSON.stringify({ op: "law", player: laws }),
    JSON.stringify({ op: "end", layer: "gameplay" }),
  ].join("\n");
}

export function placeShell(packId: string, layout: PackLayout, seed: number, laws: Laws, spawn: { slot: string; anchor: string }): WorldBundle {
  const fill = parseFill(fillFor(packId, layout, seed, laws, spawn), { seed });
  return placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout).bundle;
}

/** Statics (as boxes) that reach into the box a character of radius r fills standing on `a`. */
export function solidsAt(layout: PackLayout, a: Vec3, r: number, h = 1.8): string[] {
  const hits: string[] = [];
  layout.statics.forEach((s, i) => {
    if (s.surf === "water" || s.surf === "hazard") return;
    const inX = s.pos[0] + s.size[0] / 2 > a[0] - r && s.pos[0] - s.size[0] / 2 < a[0] + r;
    const inZ = s.pos[2] + s.size[2] / 2 > a[2] - r && s.pos[2] - s.size[2] / 2 < a[2] + r;
    const inY = s.pos[1] + s.size[1] / 2 > a[1] + 0.05 && s.pos[1] - s.size[1] / 2 < a[1] + h;
    if (inX && inY && inZ) hits.push(`#${i} ${s.zoneSlot}/${s.surf} at ${s.pos.join(",")}`);
  });
  return hits;
}

export interface ConformOpts {
  spawn: { slot: string; anchor: string };
  laws?: Laws;
  harder?: boolean;
  /** Anchors that hang (a rig, a planet's moon on a stalk): not stood on, not walked to. */
  hanging?: (slot: string, name: string) => boolean;
}

/** Every rule above broken by this layout, in words (empty: it conforms). */
export function conformance(packId: string, layout: PackLayout, seed: number, opts: ConformOpts): string[] {
  const laws = opts.laws ?? DEFAULT_LAWS;
  const out: string[] = [];
  const b = placeShell(packId, layout, seed, laws, opts.spawn);
  const spawnAt = layout.zones.find((z) => z.slot === opts.spawn.slot)?.anchors[opts.spawn.anchor];
  if (!spawnAt) return [`no spawn anchor ${opts.spawn.slot}.${opts.spawn.anchor}`];
  // (2) the spawn and every anchor stood on are clear of geometry
  for (const s of solidsAt(layout, spawnAt, 0.6)) out.push(`spawn inside ${s}`);
  const ss = surfaces(b);
  const nav = buildNav(b);
  try {
    for (const z of layout.zones) {
      for (const [name, a] of Object.entries(z.anchors)) {
        const where = `${z.slot}.${name}`;
        if (opts.hanging?.(z.slot, name)) continue;
        const raised = a[1] > z.floorY + 0.5;
        if (raised) {
          // (5) a wall-height anchor sits against a wall; anything else stands on a surface
          const onWall = name.startsWith("wall_") || layout.statics.some((s) => s.surf === "wall" && Math.abs(a[0] - s.pos[0]) <= s.size[0] / 2 + 0.35 && Math.abs(a[2] - s.pos[2]) <= s.size[2] / 2 + 0.35 && Math.abs(a[1] - s.pos[1]) <= s.size[1] / 2);
          const under = surfaceUnder(ss, a);
          if (!onWall && !(under && a[1] - under.top < 0.05)) out.push(`${where} hangs in the air at ${a.join(",")}`);
          continue;
        }
        for (const s of solidsAt(layout, a, 0.35)) out.push(`${where} inside ${s}`);
        // (1) on foot
        if (!nav.path(spawnAt, a)) out.push(`${where} unreachable on foot`);
      }
      // (3) doorways: a 0.9 m gap at standing height, a 2.1 m lintel over it
      for (const [name, a] of Object.entries(z.anchors)) {
        if (!name.startsWith("doorway_")) continue;
        const walls = layout.statics.filter((s) => s.surf === "wall");
        const inside = (s: (typeof walls)[number], y: number) => Math.abs(a[0] - s.pos[0]) < s.size[0] / 2 - 0.01 && Math.abs(a[2] - s.pos[2]) < s.size[2] / 2 - 0.01 && Math.abs(y - s.pos[1]) < s.size[1] / 2;
        if (walls.some((s) => inside(s, a[1] + 1))) out.push(`${z.slot}.${name} is blocked`);
        const lintel = walls.find((s) => inside(s, a[1] + 2.6));
        if (!lintel) out.push(`${z.slot}.${name} has no lintel`);
        else {
          const bottom = lintel.pos[1] - lintel.size[1] / 2 - a[1];
          const across = Math.max(lintel.size[0], lintel.size[2]);
          if (Math.abs(bottom - 2.1) > 0.011 || Math.abs(across - 0.9) > 0.011) out.push(`${z.slot}.${name} is ${across.toFixed(2)} × ${bottom.toFixed(2)} m, not 0.9 × 2.1`);
        }
      }
    }
  } finally {
    nav.destroy();
  }
  // (4) every zone owns ground reached with comfortable hops
  const start = surfaceUnder(ss, spawnAt);
  if (!start) return [...out, "nothing under the spawn"];
  const comfy = reachable(ss, start, laws, opts.harder ? 0.95 : 0.8);
  for (const z of b.zones) if (!ss.some((s) => s.zone === z.id && comfy.has(s.id))) out.push(`zone ${z.slot} owns no ground reachable from the spawn with gaps ≤ 0.8 × max jump`);
  return out;
}
