// Merging a repair patch into a fill, line by line: a patch line with an id replaces the base line
// with that id (in place), {"op":"del","id"} removes it, and a new id is inserted with its op's
// group so the fill keeps its canonical order. Meta and end lines always come from the base.

const ORDER = ["meta", "zone", "spawn", "goal", "ent", "verb", "law", "state", "rule", "npc", "expect", "end"] as const;

interface Line {
  raw: string;
  op: string;
  id: string;
}

function parse(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
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
}

export function mergeFill(base: string, patch: string): { text: string; stats: MergeStats } {
  const lines = parse(base);
  const stats: MergeStats = { replaced: 0, added: 0, deleted: 0, ignored: 0 };
  for (const p of parse(patch)) {
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
      lines[at] = p;
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
  return { text: `${lines.map((l) => l.raw).join("\n")}\n`, stats };
}

/** The gameplay lines of a fill (through its gameplay end marker); repairs never need the cosmetic tail. */
export function gameplayLines(fill: string): string {
  const lines = fill.split("\n");
  const end = lines.findIndex((l) => l.includes('"op":"end"') && l.includes('"gameplay"'));
  return (end >= 0 ? lines.slice(0, end + 1) : lines).join("\n");
}
