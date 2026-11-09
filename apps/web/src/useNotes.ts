// "Apply" on a design note: its change goes to the live edit exactly as a typed one would, the
// changed world is re-proved on a copy (its own worker) while you play, and it is offered with its
// before/after numbers only if it holds (no worse a receipt, still won: the Director's cut's rule).
// Accepting it swaps it in like an edit, with Undo.
import { useCallback, useRef, useState } from "react";
import { mergeFill, pinLayout } from "@ghostrun/ir";
import type { Receipt } from "@ghostrun/proof/light";
import { changeSummary, cutHolds, editedPrompt, intentFor, receiptDelta, type Delta } from "./edits";
import { liveEdit } from "./live";
import { worldFromFill, type World } from "./pipeline";

export type NoteState =
  | { status: "idle" }
  | { status: "working"; key: string; change: string; step: "editing" | "proving" }
  | { status: "offer"; key: string; change: string; summary: string[]; delta: Delta[] }
  | { status: "held"; key: string; change: string; why: string };

export function useNotes(d: {
  /** The world on screen and its receipt (the note's numbers are measured against it). */
  world: () => World | null;
  receipt: () => Receipt | null;
  /** The prompt the world was built from (for a fixture world, the bar's). */
  prompt: () => string;
  /** A proof of a copy in its own worker. */
  proveOnce: (w: World, runs: number) => Promise<Receipt>;
  /** Swap the changed world in, as an edit (Undo brings this one back). */
  apply: (w: World, change: string, before: Receipt | null) => void;
}) {
  const [state, setState] = useState<NoteState>({ status: "idle" });
  const offered = useRef<{ world: World; base: World } | null>(null);
  const tries = useRef(0);

  /** `change` goes to the edit model; `said` is how the person sees it (a Feng Shui fix names things by id for the model). */
  const tryChange = useCallback(async (key: string, change: string, said = change) => {
    const w = d.world();
    const before = d.receipt();
    if (!w || !before) return;
    const n = ++tries.current;
    const stale = () => n !== tries.current || d.world() !== w;
    offered.current = null;
    setState({ status: "working", key, change: said, step: "editing" });
    const original = w.source?.base ?? w.source?.prompt ?? d.prompt();
    const edits = [...(w.source?.edits ?? []), said];
    const fill0 = pinLayout(w.fill);
    const patch = await liveEdit(editedPrompt(original, edits.slice(0, -1)), change, intentFor(w, original), fill0, w.seed);
    if (stale()) return;
    if (!patch) return setState({ status: "held", key, change: said, why: "The live AI couldn't make that change just now." });
    const { text } = mergeFill(fill0, patch, { edit: true });
    const w2 = worldFromFill(text, w.seed, w.intent.live, w.bundle.pack.id, w.bundle.mode);
    const summary = changeSummary(w.bundle, w2.bundle);
    if (!summary.length) return setState({ status: "held", key, change: said, why: "Nothing in the world changed." });
    w2.source = { prompt: editedPrompt(original, edits), intent: intentFor(w, original), fill: w2.fill, seed: w.seed, pack: w2.bundle.pack.id, base: original, edits };
    setState({ status: "working", key, change: said, step: "proving" });
    const after = await d.proveOnce(w2, 12).catch(() => null);
    if (stale()) return;
    if (!after || !cutHolds(before, after)) return setState({ status: "held", key, change: said, why: `Re-proved on a copy, it didn't hold up (${after ? receiptDelta(before, after).map((x) => `${x.label} ${x.from} → ${x.to}`).join(" · ") || "no runner won" : "the proof failed"}), so it isn't offered.` });
    offered.current = { world: w2, base: w };
    setState({ status: "offer", key, change: said, summary, delta: receiptDelta(before, after) });
  }, []);

  /** Swap the offered change in (only onto the world it was made from). */
  const accept = useCallback(() => {
    const o = offered.current;
    if (state.status !== "offer" || !o || d.world() !== o.base) return;
    offered.current = null;
    setState({ status: "idle" });
    d.apply(o.world, state.change, d.receipt());
  }, [state]);

  /** A new world on screen: an old offer no longer applies. */
  const reset = useCallback(() => {
    tries.current++;
    offered.current = null;
    setState({ status: "idle" });
  }, []);

  return { state, tryChange, accept, reset };
}
