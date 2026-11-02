// Merging a repair patch into a fill, line by line: a patch line with an id replaces the base line
// with that id (in place), {"op":"del","id"} removes it, and a new id is inserted with its op's
// group so the fill keeps its canonical order. Meta and end lines always come from the base.
// An edit (the person's own change) may also restyle the world through a meta line's cosmetic
// fields, but never touches its expectations: the proof keeps checking what the world promised,
// so a change that breaks a promise shows up as a counterexample instead of quietly rewriting it.

import { splitObjects } from "./fill";

const ORDER = ["meta", "zone", "spawn", "goal", "ent", "verb", "law", "state", "rule", "npc", "expect", "end"] as const;

interface Line {
  raw: string;
  op: string;
  id: string;
}

function parse(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n").flatMap(splitObjects)) {
    const t = raw.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { op?: unknown; id?: unknown; layer?: unknown };
      out.push({ raw: t, op: typeof o.op === "string" ? o.op : "", id: typeof o.id === "string" ? o.id : o.op === "end" ? `end:${String(o.layer)}` : o.op === "law" ? "law" : "" });
    } catch {
      out.push({ raw: t, op: "", id: "" });
    }
  }
  return out;
}

export interface MergeStats {
  replaced: number;
  added: number;
  deleted: number;
  ignored: number;
  /** Expectation lines an edit tried to change (always kept as they were). */
  locked: number;
  /** Structural edits that changed the layout (absent when there were none). */
  layout?: number;
}

/** Meta fields an edit may change: how the world looks, never what it is (pack, mode, seed). */
const COSMETIC_META = ["look", "mood", "timeOfDay", "weather"] as const;
/** Lines an edit never writes: the promises, and the cosmetic tail (live fills stop before it). */
const EDIT_LOCKED = new Set(["expect", "sig", "dress", "poster"]);

function restyle(lines: Line[], patch: Line, stats: MergeStats) {
  const at = lines.findIndex((l) => l.op === "meta");
  if (at < 0) return void stats.ignored++;
  const base = JSON.parse(lines[at]!.raw) as Record<string, unknown>;
  const p = JSON.parse(patch.raw) as Record<string, unknown>;
  const next = { ...base };
  for (const k of COSMETIC_META) if (k in p) next[k] = p[k];
  const raw = JSON.stringify(next);
  if (raw === lines[at]!.raw) return void stats.ignored++;
  lines[at] = { ...lines[at]!, raw };
  stats.replaced++;
}

/**
 * A structural edit, {"op":"layout","params":{"floors":2},"sub":["rooftop"]}, goes in the meta
 * line: the pack's numbers over the ones it had, the sub-zones replaced when given. Raw here; the
 * registry clamps them by the pack's schema (registry settleLayout), and the client re-anchors
 * whatever stood where the old layout had an anchor the new one doesn't.
 */
function relayout(lines: Line[], patch: Line, stats: MergeStats) {
  const at = lines.findIndex((l) => l.op === "meta");
  if (at < 0) return void stats.ignored++;
  const base = JSON.parse(lines[at]!.raw) as Record<string, unknown>;
  const p = JSON.parse(patch.raw) as { params?: unknown; sub?: unknown };
  const next = { ...base };
  const nums = Object.entries(p.params && typeof p.params === "object" ? p.params : {})
    .map(([k, x]) => [k, typeof x === "string" && x.trim() ? Number(x) : x] as const)
    .filter((e): e is readonly [string, number] => /^[a-z][a-z_]{0,23}$/.test(e[0]) && typeof e[1] === "number" && Number.isFinite(e[1]));
  const had = base.layout && typeof base.layout === "object" ? (base.layout as Record<string, unknown>) : {};
  if (nums.length) next.layout = { ...had, ...Object.fromEntries(nums) };
  if (Array.isArray(p.sub)) next.sub = p.sub.filter((s): s is string => typeof s === "string").slice(0, 3);
  const raw = JSON.stringify(next);
  if (raw === lines[at]!.raw) return void stats.ignored++;
  lines[at] = { ...lines[at]!, raw };
  stats.replaced++;
  stats.layout = (stats.layout ?? 0) + 1;
}

const PLACED = new Set(["spawn", "goal", "ent", "npc"]);

/**
 * A thing a patch rewrites keeps what makes it that thing when the patch leaves it out: its kind (a
 * goal rewritten as an ent line is still a goal) and its zone.
 */
function keepKind(old: Line, p: Line): Line {
  if (!PLACED.has(old.op) || !PLACED.has(p.op)) return p;
  try {
    const o = JSON.parse(old.raw) as Record<string, unknown>;
    const n = JSON.parse(p.raw) as Record<string, unknown>;
    const kind = old.op === "ent" ? o.kind : old.op;
    const add = { ...(p.op === "ent" && n.kind === undefined && typeof kind === "string" ? { kind } : {}), ...(n.zone === undefined && o.zone !== undefined ? { zone: o.zone } : {}) };
    return Object.keys(add).length ? { ...p, raw: JSON.stringify({ ...n, ...add }) } : p;
  } catch {
    return p;
  }
}

export function mergeFill(base: string, patch: string, opts: { edit?: boolean } = {}): { text: string; stats: MergeStats } {
  const lines = parse(base);
  const stats: MergeStats = { replaced: 0, added: 0, deleted: 0, ignored: 0, locked: 0 };
  for (const p of parse(patch)) {
    // only an edit reshapes the world; a repair fixes it on the geometry it has
    if (p.op === "layout") {
      if (opts.edit) relayout(lines, p, stats);
      else stats.ignored++;
      continue;
    }
    if (opts.edit && p.op === "meta") {
      restyle(lines, p, stats);
      continue;
    }
    if (opts.edit && (EDIT_LOCKED.has(p.op) || (p.op === "del" && lines.some((l) => l.id === p.id && EDIT_LOCKED.has(l.op))))) {
      if (p.op === "expect" || p.op === "del") stats.locked++;
      else stats.ignored++;
      continue;
    }
    if (!p.op || p.op === "meta" || p.op === "end") {
      stats.ignored++;
      continue;
    }
    if (p.op === "del") {
      const n = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.id === p.id && lines[i]!.op !== "meta" && lines[i]!.op !== "end") lines.splice(i, 1);
      stats.deleted += n - lines.length;
      continue;
    }
    const at = p.id ? lines.findIndex((l) => l.id === p.id && l.op !== "end") : -1;
    if (at >= 0) {
      lines[at] = keepKind(lines[at]!, p);
      stats.replaced++;
      continue;
    }
    // new line: after the last line of its op group, or before the first line of a later group
    const rank = ORDER.indexOf(p.op as (typeof ORDER)[number]);
    let insert = lines.findIndex((l) => l.op === "end");
    if (rank >= 0) {
      const later = lines.findIndex((l) => {
        const r = ORDER.indexOf(l.op as (typeof ORDER)[number]);
        return r > rank;
      });
      if (later >= 0) insert = later;
    }
    lines.splice(insert < 0 ? lines.length : insert, 0, p);
    stats.added++;
  }
  // a patched fill says so in its meta line: the placer never second-guesses laws a patch left as
  // they were (it only allows a jump the win needs in a fresh fill nobody wrote laws for)
  const meta = lines.findIndex((l) => l.op === "meta");
  if (meta >= 0 && stats.replaced + stats.added + stats.deleted > 0) {
    const m = JSON.parse(lines[meta]!.raw) as Record<string, unknown>;
    if (!m.patched) lines[meta] = { ...lines[meta]!, raw: JSON.stringify({ ...m, patched: true }) };
  }
  return { text: `${lines.map((l) => l.raw).join("\n")}\n`, stats };
}

/** The gameplay lines of a fill (through its gameplay end marker); repairs never need the cosmetic tail. */
export function gameplayLines(fill: string): string {
  const lines = fill.split("\n");
  const end = lines.findIndex((l) => l.includes('"op":"end"') && l.includes('"gameplay"'));
  return (end >= 0 ? lines.slice(0, end + 1) : lines).join("\n");
}
