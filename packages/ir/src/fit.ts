// The laws a layout was fitted to. Packs size their geometry from the laws (a rooftop ledge just
// above one jump's apex), so a fresh build fits the layout to the fill's own laws. An edited fill
// pins them in its meta line ("fit"): changing the laws later changes how the player moves in the
// same geometry ("higher jumps" means higher jumps in the same city, not a taller city), and the
// fill alone still rebuilds the identical world anywhere.
import { parseFill } from "./fill";
import { clampLaws } from "./laws";
import type { Laws } from "./schema";

const FIT_KEYS = ["jumpH", "jumpsMax", "speed", "gravityScale"] as const;

/** The laws to generate the layout with: the pinned fit over the fill's laws, if the fill has one. */
export function layoutLaws(fill: string, laws: Laws): Laws {
  try {
    const m = JSON.parse(fill.split("\n", 1)[0] ?? "") as { op?: string; fit?: Record<string, unknown> };
    if (m.op !== "meta" || !m.fit || typeof m.fit !== "object") return laws;
    const fit: Partial<Laws> = {};
    for (const k of FIT_KEYS) if (typeof m.fit[k] === "number") fit[k] = m.fit[k] as number;
    return clampLaws({ ...laws, ...fit });
  } catch {
    return laws;
  }
}

/** Pin a fill's layout to the laws it was fitted to, read off the fill itself (once; a pin is kept). */
export function pinLayout(fill: string): string {
  const lines = fill.split("\n");
  try {
    const m = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    if (m.op !== "meta" || m.fit) return fill;
    const laws = parseFill(fill, { seed: 1 }).draft.laws; // laws never depend on the seed
    lines[0] = JSON.stringify({ ...m, fit: Object.fromEntries(FIT_KEYS.map((k) => [k, laws[k]])) });
    return lines.join("\n");
  } catch {
    return fill;
  }
}

/**
 * A fresh fill whose laws nobody wrote: no law line, and never edited or patched (an edit pins
 * "fit" in its meta line, a merged patch marks it "patched"). Only then may the placer allow a jump
 * the win needs; laws someone wrote ("only one jump") are kept, and a broken promise shows.
 */
export function lawsUnwritten(fill: string): boolean {
  const lines = fill.split("\n");
  try {
    const m = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    if (m.op === "meta" && (m.fit || m.patched)) return false;
  } catch {
    // no meta line: judged on the law lines alone
  }
  return !lines.some((l) => /"op"\s*:\s*"law"/.test(l));
}
