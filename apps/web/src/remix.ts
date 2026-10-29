// Remixes: a shared world (a ?s= link) or a gallery world opens as your own copy, and your first
// accepted edit makes it a remix. Its share then carries its line: remixOf (the share id, or g:<slug>
// for a gallery world), the original at the top of the line (its prompt and spec), and the newest
// eight changes on the way (what was asked, on which world, and by whom when they gave a nickname).
// Every version is proved on its own: the line says which spec each receipt is for.
import { nickname } from "@ghostrun/ir";
import { editedPrompt } from "./edits";
import type { World } from "./pipeline";

export const MAX_LINEAGE = 8;
const MAX_TEXT = 300;

/** One change in a remix's line: the world it was made on, what was asked, and who asked. */
export interface Step {
  id: string;
  change: string;
  name?: string;
}

/** What a remix's share stores about where it came from (all of it, or none). */
export interface Lineage {
  remixOf: string;
  origin: { id: string; prompt: string; spec: string };
  /** The newest changes, oldest first. */
  lineage: Step[];
  /** Every change since the original (the list keeps the newest eight). */
  changes: number;
}

/** Where the world on screen came from: a share or a gallery world, and that world's own line when it was a remix. */
export interface RemixSource {
  ref: string;
  kind: "share" | "gallery";
  prompt: string;
  /** The spec of the version that was opened (what its own receipt is for). */
  spec: string;
  line: Lineage | null;
}

export const galleryRef = (slug: string) => `g:${slug}`;

/** A link that opens a world in a remix's line: its share, or its gallery entry. */
export const refLink = (ref: string) => `${window.location.pathname}${ref.startsWith("g:") ? `?g=${encodeURIComponent(ref.slice(2))}` : `?s=${ref}`}`;

const NICK_KEY = "gr_nick";

/** The nickname this device posts best times under, if it's one the board would take. */
export function savedNick(): string {
  try {
    const n = nickname(localStorage.getItem(NICK_KEY) ?? "");
    return n.ok ? n.name : "";
  } catch {
    return "";
  }
}

/** One line of what the person wrote, short enough to store. */
const said = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

/** Your changes so far: the world's accepted edits (shares and gallery worlds open with none). */
export const yourChanges = (w: World | null) => (w?.source?.edits ?? []).map(said).filter(Boolean);

/**
 * The line a share of this world carries: none for an original, the source's own for an unchanged
 * copy of a remix, and with your changes on top once there are any.
 */
export function lineageOf(src: RemixSource | null, w: World | null, name = savedNick()): Lineage | null {
  if (!src) return null;
  const mine = yourChanges(w);
  if (!mine.length) return src.line;
  const origin = src.line?.origin ?? { id: src.ref, prompt: said(src.prompt), spec: src.spec };
  const steps = [...(src.line?.lineage ?? []), ...mine.map((change) => ({ id: src.ref, change, ...(name ? { name } : {}) }))];
  return { remixOf: src.ref, origin, lineage: steps.slice(-MAX_LINEAGE), changes: (src.line?.changes ?? 0) + mine.length };
}

/** A shared world as a remix source (its line, if the record carries one whole). */
export function shareSource(id: string, r: { specHash: string; prompt?: string; remixOf?: string; origin?: Lineage["origin"]; lineage?: Step[]; changes?: number }): RemixSource {
  const line = r.remixOf && r.origin && r.lineage?.length && r.changes ? { remixOf: r.remixOf, origin: r.origin, lineage: r.lineage, changes: r.changes } : null;
  return { ref: id, kind: "share", prompt: r.prompt ?? line?.origin.prompt ?? "", spec: r.specHash, line };
}

/** What an edit of a shared world should be told it was asked for: the original prompt, then each change since. */
export const contextPrompt = (src: RemixSource) => (src.line ? editedPrompt(src.line.origin.prompt || "a shared world", src.line.lineage.map((s) => s.change)) : src.prompt);

const quote = (s: string, n = 72) => `“${s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s}”`;

/** "Remixed from “…” · 2 changes: “make it night”, “add three more coins”", in two parts. */
export function lineText(l: Lineage, shown = 3): { from: string; changes: string } {
  const last = l.lineage.slice(-shown).map((s) => `${quote(s.change, 48)}${s.name ? ` (${s.name})` : ""}`);
  const earlier = l.changes - last.length;
  return {
    from: l.origin.prompt ? `Remixed from ${quote(l.origin.prompt)}` : "Remixed from a shared world",
    changes: `${l.changes} change${l.changes === 1 ? "" : "s"}: ${earlier > 0 ? `${earlier} earlier, then ` : ""}${last.join(", ")}`,
  };
}

/** Which receipt is for which version, said plainly (the spec covers play, not looks). */
export function receiptsLine(l: Lineage, spec: string | undefined): string {
  const orig = l.origin.spec.slice(0, 8);
  if (spec === l.origin.spec) return `Only the looks changed: it plays the same as the original (both spec ${orig}), and AI runners are proving it on your device now.`;
  const mine = spec ? `This version (spec ${spec.slice(0, 8)}) is the one AI runners are proving on your device now` : "This version is proved on your device when it loads";
  return `${mine}; the original (spec ${orig}) has its own receipt, not this one.`;
}

/** The receipt's own line for a remix: which version it proved, and that the original's is another. */
export function receiptVersion(l: Lineage | null, spec: string | undefined): string | null {
  if (!l) return null;
  const head = `Remix of ${quote(l.origin.prompt || "a shared world", 60)} (${l.changes} change${l.changes === 1 ? "" : "s"})`;
  const orig = l.origin.spec.slice(0, 8);
  if (spec === l.origin.spec) return `${head}: only the looks changed, so it is the original's spec (${orig}), proved again here.`;
  return `${head}: this receipt is for this version${spec ? ` (spec ${spec.slice(0, 8)})` : ""} only; the original (spec ${orig}) has its own.`;
}
