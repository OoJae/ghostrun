// The receipt's headline: the world's headline expectation, with the worst word any chip about it
// earned (a counterexample beats a verified, a verified beats a played), and how each was found.
import type { WorldBundle } from "@ghostrun/ir";
import type { Chip, ChipStatus, Receipt } from "./types";

export function headlineOf(b: WorldBundle, chips: readonly Chip[]): Receipt["headline"] {
  const x = b.expects.find((e) => e.headline);
  if (!x) return null;
  const mine = chips.filter(
    (c) => c.subject.id === x.id || (x.prop === "win_reachable" && c.subject.id === "win_reachable") || (b.mode === "wander" && x.prop === "reachable" && !x.b && c.subject.id === "tour"),
  );
  const status: ChipStatus = mine.some((c) => c.status === "counterexample")
    ? "counterexample"
    : mine.some((c) => c.status === "verified")
      ? "verified"
      : mine.some((c) => c.status === "played")
        ? "played"
        : "not_checkable";
  return { expect: x.id, text: x.text, status, method: mine.map((c) => c.method).join(" + ") || "none" };
}
