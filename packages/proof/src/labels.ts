// The only producer of strings a receipt shows. Every number carries its method, and no
// percentage is printed for fewer than 30 trials (honest labels are a never-cut item).
import type { Chip } from "./types";

export function fraction(k: number, n: number): string {
  if (n < 30) return `${k} of ${n}`;
  return `${Math.round((k / n) * 100)}% (n=${n})`;
}

export function chipLine(c: Chip): string {
  const mark = { verified: "✓", played: "✓", modelled: "~", not_checkable: "–", counterexample: "✗" }[c.status];
  const count = c.n > 0 ? ` · ${fraction(c.k, c.n)}` : "";
  const cx = c.cx ? ` — ${c.cx.text}` : "";
  return `${mark} [${c.tier}] ${c.text}${count}${cx}  (${c.method}${c.src === "ai" ? ", AI-written rule" : c.src === "template" ? ", template rule" : ""})`;
}
