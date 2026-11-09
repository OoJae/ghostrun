// After a structural edit the same fill stands on a new layout (the same seed, new parameters).
// Whatever stood on an anchor the new layout no longer has (the hall's back wall under a new
// staircase, a rooftop lane taken away) moves to the nearest free anchor of its zone, or the
// nearest free one anywhere when its zone has none left. The move is written into the fill, so the
// fill alone still rebuilds the same world, and logged like the placer's other repairs.
import type { Vec3, Zone } from "@ghostrun/ir";
import type { PackLayout, ZoneSpec } from "@ghostrun/plugin-api";
import { bindZones } from "./index";

const PLACED = new Set(["spawn", "goal", "ent", "npc"]);
/** Anchors kept for their own kind: a door stands in a doorway, a spawn on a spawn pad, a goal on a goal spot. */
const SPECIAL = /^(doorway|spawn|goal)/;

export interface Reanchored {
  fill: string;
  /** One line per move, in the placer's words. */
  notes: string[];
  /** The ids that moved. */
  moved: string[];
}

export function reanchor(fill: string, before: PackLayout, after: PackLayout): Reanchored {
  const lines = fill.split("\n");
  const rows = lines.map((raw) => {
    try {
      const o = JSON.parse(raw) as unknown;
      return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  });
  const zones: Zone[] = rows
    .filter((o): o is Record<string, unknown> => o?.op === "zone" && typeof o.id === "string")
    .map((o): Zone => ({ id: o.id as string, src: "ai", layer: "gameplay", pack: before.packId, slot: String(o.slot ?? ""), tag: String(o.tag ?? ""), name: "", parent: "" }));
  if (!zones.length) return { fill, notes: [], moved: [] };
  const was = bindZones(zones, before);
  const now = bindZones(zones, after);
  // (a line naming a zone that doesn't exist is the first zone's: the parser repairs it so)
  const zoneOf = (z: unknown) => (typeof z === "string" && now.has(z) ? z : zones[0]!.id);

  const used = new Set<string>();
  const todo: { i: number; zone: string; anchor: string; from: Vec3; high: boolean }[] = [];
  rows.forEach((o, i) => {
    if (!o || !PLACED.has(String(o.op)) || typeof o.anchor !== "string" || !o.anchor) return;
    const zone = zoneOf(o.zone);
    if (now.get(zone)!.anchors[o.anchor]) return void used.add(`${zone}/${o.anchor}`);
    const s0 = was.get(zone)!;
    const from = s0.anchors[o.anchor];
    // no such anchor before either: the placer scatters it in its zone, as it always has
    if (from) todo.push({ i, zone, anchor: o.anchor, from, high: from[1] > s0.floorY + 0.5 });
  });

  const notes: string[] = [];
  const moved: string[] = [];
  for (const t of todo) {
    const o = rows[t.i]!;
    const kind = SPECIAL.exec(t.anchor)?.[1];
    const nearest = (cands: [string, ZoneSpec][]) => {
      let best: { zone: string; anchor: string; d: number } | null = null;
      for (const [zone, spec] of cands) {
        for (const [anchor, p] of Object.entries(spec.anchors)) {
          if (used.has(`${zone}/${anchor}`) || SPECIAL.exec(anchor)?.[1] !== kind) continue;
          // wall-height things go on wall-height anchors first, floor things on the floor
          const off = (p[1] > spec.floorY + 0.5 ? 1 : 0) !== (t.high ? 1 : 0) ? 1e4 : 0;
          const [dx, dy, dz] = [p[0] - t.from[0], p[1] - t.from[1], p[2] - t.from[2]];
          const d = dx * dx + dy * dy + dz * dz + off;
          if (!best || d < best.d || (d === best.d && `${zone}/${anchor}` < `${best.zone}/${best.anchor}`)) best = { zone, anchor, d };
        }
      }
      return best;
    };
    const pick = nearest([[t.zone, now.get(t.zone)!]]) ?? nearest([...now]);
    const slot = now.get(t.zone)!.slot;
    const id = String(o.id ?? "");
    if (pick) {
      used.add(`${pick.zone}/${pick.anchor}`);
      rows[t.i] = { ...o, anchor: pick.anchor, ...(pick.zone !== t.zone ? { zone: pick.zone } : {}) };
      notes.push(`${id}: anchor '${t.anchor}' is gone from '${slot}' in the new layout, re-anchored to '${pick.anchor}'${pick.zone !== t.zone ? ` in ${pick.zone}` : ""} (the nearest free anchor)`);
    } else {
      rows[t.i] = { ...o, anchor: "" };
      notes.push(`${id}: anchor '${t.anchor}' is gone from '${slot}' in the new layout and no anchor is free, placed in zone`);
    }
    lines[t.i] = JSON.stringify(rows[t.i]);
    moved.push(id);
  }
  return { fill: lines.join("\n"), notes, moved };
}

/** An anchor nothing stands on: somewhere a thing could be moved to. */
export interface FreeAnchor {
  zone: string;
  anchor: string;
  /** Where it is (the floor under whatever would stand there). */
  at: Vec3;
  /** At wall height (where a painting hangs) rather than on the floor. */
  high: boolean;
}

/**
 * The anchors of a world's layout that nothing in its fill stands on, in every zone (never a
 * doorway, a spawn pad or a goal spot: those keep their own kind), in a stable order: where the
 * diorama's hand can drop a thing. A move op names one, and the placer does the rest.
 */
export function freeAnchors(fill: string, layout: PackLayout): FreeAnchor[] {
  const rows = fill.split("\n").map((raw) => {
    try {
      const o = JSON.parse(raw) as unknown;
      return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  });
  const zones: Zone[] = rows
    .filter((o): o is Record<string, unknown> => o?.op === "zone" && typeof o.id === "string")
    .map((o): Zone => ({ id: o.id as string, src: "ai", layer: "gameplay", pack: layout.packId, slot: String(o.slot ?? ""), tag: String(o.tag ?? ""), name: "", parent: "" }));
  if (!zones.length) return [];
  const bound = bindZones(zones, layout);
  const zoneOf = (z: unknown) => (typeof z === "string" && bound.has(z) ? z : zones[0]!.id);
  const used = new Set<string>();
  for (const o of rows) if (o && PLACED.has(String(o.op)) && typeof o.anchor === "string" && o.anchor) used.add(`${zoneOf(o.zone)}/${o.anchor}`);
  const out: FreeAnchor[] = [];
  const slots = new Set<string>();
  for (const z of zones) {
    const spec = bound.get(z.id)!;
    // (two zones bound to one slot share its anchors: the first of them has them)
    if (slots.has(spec.slot)) continue;
    slots.add(spec.slot);
    for (const anchor of Object.keys(spec.anchors).sort()) {
      if (used.has(`${z.id}/${anchor}`) || SPECIAL.test(anchor)) continue;
      const p = spec.anchors[anchor]!;
      out.push({ zone: z.id, anchor, at: [p[0], p[1], p[2]], high: p[1] > spec.floorY + 0.5 });
    }
  }
  return out;
}
