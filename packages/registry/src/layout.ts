// A world's layout: its pack's parameters (how big, how many floors) and sub-zones (a rooftop
// lane), which a structural edit changes. They live in the fill's meta line ("layout" holds only
// what differs from the pack's defaults), so the fill alone still rebuilds the world anywhere, and
// a fill without them (every world from before structural edits) builds on the defaults as it did.
import type { LayoutPack, LayoutParamSpec, PackLayout, Params } from "@ghostrun/plugin-api";

/** What a structural edit may set on one pack: its parameters and its sub-zones. */
export interface LayoutSchema {
  params: Readonly<Record<string, LayoutParamSpec>>;
  subs: readonly string[];
}

/** The meta line as written, or null (no meta line, or not JSON). */
function metaOf(fill: string): Record<string, unknown> | null {
  try {
    const m = JSON.parse(fill.split("\n", 1)[0] ?? "") as Record<string, unknown>;
    return m && m.op === "meta" ? m : null;
  } catch {
    return null;
  }
}

const num = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN);

/**
 * Clamp, never reject (as laws and verb params are): unknown keys dropped, numbers into range and
 * onto their step, anything else keeps `base` ("floors": "two" leaves the floors as they were).
 */
export function clampLayout(pack: LayoutPack, raw: unknown, base: Params = pack.defaults): Params {
  const out: Params = { ...pack.defaults, ...base };
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const [k, sp] of Object.entries(pack.schema ?? {})) {
    const n = num(r[k]);
    if (!Number.isFinite(n)) continue;
    const stepped = sp.min + Math.round((n - sp.min) / sp.step) * sp.step;
    out[k] = Math.round(Math.min(sp.max, Math.max(sp.min, stepped)) * 1000) / 1000;
  }
  return out;
}

/** Only what differs from the pack's defaults (null: the defaults, as every unedited world). */
export function customOf(pack: LayoutPack, params: Params): Params | null {
  const out: Params = {};
  for (const k of Object.keys(pack.schema ?? {})) if (params[k] !== undefined && params[k] !== pack.defaults[k]) out[k] = params[k]!;
  return Object.keys(out).length ? out : null;
}

/** The layout a fill builds on: its pack's parameters (clamped) and sub-zones, and what differs from the defaults. */
export function layoutOf(pack: LayoutPack, fill: string): { params: Params; sub: string[]; custom: Params | null } {
  const m = metaOf(fill);
  const params = clampLayout(pack, m?.layout);
  const sub = Array.isArray(m?.sub) ? (m.sub as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 3) : [];
  return { params, sub, custom: customOf(pack, params) };
}

/**
 * The fill's meta line with its layout settled: the parameters a patch wrote clamped by the pack's
 * schema and kept only where they differ from the defaults, the sub-zones only those the pack has.
 * Undoing every change by hand ("bigger", then "smaller") gives back the original meta line.
 */
export function settleLayout(pack: LayoutPack, subs: readonly string[], fill: string): string {
  const lines = fill.split("\n");
  const m = metaOf(fill);
  if (!m) return fill;
  const { layout: _old, ...rest } = m;
  const custom = customOf(pack, clampLayout(pack, m.layout));
  const sub = Array.isArray(m.sub) ? [...new Set((m.sub as unknown[]).filter((s): s is string => typeof s === "string" && subs.includes(s)))].slice(0, 3) : m.sub;
  lines[0] = JSON.stringify({ ...rest, ...(sub !== undefined ? { sub } : {}), ...(custom ? { layout: custom } : {}) });
  return lines.join("\n");
}

const SUB_NAME: Record<string, string> = { rooftop: "rooftop lane" };
const ROOMS = new Set(["room", "hall", "entrance"]);

/**
 * What a structural edit changed, in a few short phrases for the edit's diff line: the numbers
 * ("map 80 → 120 m"; two of one thing as "maze 9×9 → 12×12 cells"), rooms the layout gained or
 * lost, and sub-zones added or removed ("rooftop lane removed").
 */
export function layoutChange(schema: LayoutSchema, a: { params: Params; sub: readonly string[]; layout: PackLayout }, b: { params: Params; sub: readonly string[]; layout: PackLayout }): string[] {
  const out: string[] = [];
  const groups = new Map<string, string[]>();
  for (const [k, sp] of Object.entries(schema.params)) groups.set(sp.label, [...(groups.get(sp.label) ?? []), k]);
  for (const [label, keys] of groups) {
    if (!keys.some((k) => a.params[k] !== b.params[k])) continue;
    const specs = keys.map((k) => schema.params[k]!);
    if (keys.length === 2) {
      const [u0, u1] = specs.map((s) => (s.unit ?? "").split(" ")[0]);
      out.push(`${label} ${keys.map((k) => a.params[k]).join("×")} → ${keys.map((k) => b.params[k]).join("×")}${u0 && u0 === u1 ? ` ${u0}` : ""}`);
    } else for (const [i, k] of keys.entries()) if (a.params[k] !== b.params[k]) out.push(`${label} ${String(a.params[k])} → ${String(b.params[k])}${specs[i]!.unit ? ` ${specs[i]!.unit}` : ""}`);
  }
  const rooms = (l: PackLayout) => l.zones.filter((z) => ROOMS.has(z.tag)).length;
  const dr = rooms(b.layout) - rooms(a.layout);
  if (dr) out.push(`${Math.abs(dr)} room${Math.abs(dr) > 1 ? "s" : ""} ${dr > 0 ? "added" : "removed"}`);
  for (const s of b.sub) if (!a.sub.includes(s)) out.push(`${SUB_NAME[s] ?? s} added`);
  for (const s of a.sub) if (!b.sub.includes(s)) out.push(`${SUB_NAME[s] ?? s} removed`);
  return out;
}
