// Structural edits ("add a floor", "make the map bigger", "remove the rooftop lane"): changes to
// the geometry itself. The patch's layout op lands in the fill's meta line (ir mergeFill), settles
// against the pack's schema (clamped, defaults dropped), and the fill is re-anchored onto the new
// layout (the same seed, the new parameters) before it is placed and proved. Old fills carry no
// layout, so gallery worlds and share links rebuild exactly as before.
import { layoutLaws, mergeFill, parseFill, type MergeStats } from "@ghostrun/ir";
import { reanchor } from "@ghostrun/layout";
import type { Params } from "@ghostrun/plugin-api";
import { layoutChange, layoutOf, PACKS, schemaFor, settleLayout } from "@ghostrun/registry";

export interface Restructured {
  text: string;
  /** What the layout change did, for the edit's diff line ("map 80 → 120 m · 2 rooms added"). */
  summary: string[];
  /** The re-anchoring, one line per move (the placer's other repairs read the same way). */
  notes: string[];
}

const packOf = (fill: string) => {
  try {
    const m = JSON.parse(fill.split("\n", 1)[0] ?? "") as { pack?: unknown };
    return PACKS.find((p) => p.id === m.pack) ?? PACKS[0]!;
  } catch {
    return PACKS[0]!;
  }
};
const same = (a: Params, b: Params) => Object.keys({ ...a, ...b }).every((k) => a[k] === b[k]);

/**
 * A merged fill on the layout its meta line now asks for: settled, re-anchored, and what changed.
 * `before` is the fill the patch was merged into (its layout is where things stood).
 */
export function restructure(before: string, after: string, seed: number): Restructured {
  const entry = packOf(after);
  const pack = entry.impl;
  const text = settleLayout(pack, entry.subs, after);
  const a = layoutOf(pack, before);
  const b = layoutOf(pack, text);
  if (same(a.params, b.params) && a.sub.join() === b.sub.join()) return { text, summary: [], notes: [] };
  // both layouts fitted to the same laws: an edit pins them (pinLayout), so only the shape changes
  const laws = layoutLaws(text, parseFill(text, { seed }).draft.laws);
  const l0 = pack.generate({ seed, params: a.params, sub: a.sub, laws, harder: false });
  const l1 = pack.generate({ seed, params: b.params, sub: b.sub, laws, harder: false });
  const moved = reanchor(text, l0, l1);
  const summary = layoutChange(schemaFor(entry.id), { ...a, layout: l0 }, { ...b, layout: l1 });
  if (moved.moved.length) summary.push(`${moved.moved.length} thing${moved.moved.length > 1 ? "s" : ""} re-anchored`);
  return { text: moved.fill, summary, notes: moved.notes };
}

/** An edit's patch merged into the world's fill, its layout (if the patch changed it) settled and re-anchored. */
export function mergeEdit(fill0: string, patch: string, seed: number): { text: string; stats: MergeStats; layout: Restructured | null } {
  const merged = mergeFill(fill0, patch, { edit: true });
  if (!merged.stats.layout) return { ...merged, layout: null };
  const layout = restructure(fill0, merged.text, seed);
  return { text: layout.text, stats: merged.stats, layout };
}

/** How big a world is, by pack: the numbers "bigger" and "smaller" scale (the outdoor map has a fixed size). */
const SIZE: Record<string, readonly string[]> = { city_block: ["length", "depth"], floor_plan: ["width", "depth"], arena: ["length", "width"], maze: ["cols", "rows"], course: ["segments"], service_venue: ["width", "depth"], puzzle_rooms: ["size"], stage: ["width", "depth"], orrery: ["scale"] };

/** The card's one-click layout changes, as the layout op an edit would write (null: this pack can't). */
export function layoutPatch(fill: string, change: { scale?: number; set?: Params; sub?: string[] }): string | null {
  const entry = packOf(fill);
  if (!entry.impl.schema) return null;
  const now = layoutOf(entry.impl, fill);
  const params: Params = { ...change.set };
  // a step at least: a maze one cell bigger, a course one segment longer
  if (change.scale) for (const k of SIZE[entry.id] ?? []) {
    const x = now.params[k] as number;
    const step = entry.impl.schema[k]!.step;
    params[k] = change.scale > 1 ? Math.max(x + step, Math.round(x * change.scale)) : Math.min(x - step, Math.round(x * change.scale));
  }
  if (!Object.keys(params).length && !change.sub) return null;
  return JSON.stringify({ op: "layout", ...(Object.keys(params).length ? { params } : {}), ...(change.sub ? { sub: change.sub } : {}) });
}

/** What the card can do to this world's layout: bigger or smaller (within its pack's range), a floor, its sub-zones. */
export function layoutOptions(fill: string): { bigger: boolean; smaller: boolean; floors: number | null; subs: { id: string; on: boolean }[] } {
  const entry = packOf(fill);
  const schema = entry.impl.schema ?? {};
  const now = layoutOf(entry.impl, fill);
  const keys = SIZE[entry.id] ?? [];
  return {
    bigger: keys.some((k) => (now.params[k] as number) < schema[k]!.max),
    smaller: keys.some((k) => (now.params[k] as number) > schema[k]!.min),
    floors: schema.floors ? (now.params.floors as number) : null,
    subs: entry.subs.map((id) => ({ id, on: now.sub.includes(id) })),
  };
}
