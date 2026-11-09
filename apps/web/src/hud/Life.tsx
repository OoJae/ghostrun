// A place's life, said: which creatures live here, and that they are ambient (cosmetic, never in the
// spec hash or the proof). The receipt's place stamp says the same beside the tour.
import type { WorldBundle } from "@ghostrun/ir";
import { CAST, kindCount, settingOf } from "../life";
import { pickLook, type Cue } from "../render/pick";
import { t } from "../i18n";

/** "fireflies, 2 deer and 2 owls" for a place's life, or null when it has none (a game). */
export function lifeWords(b: WorldBundle, cue: Cue): string | null {
  if (b.mode !== "wander") return null;
  const parts = CAST[settingOf(b, pickLook(cue).id)].map(([kind, n]) => kindCount(kind, n));
  return parts.length > 1 ? t("{list} and {last}", { list: parts.slice(0, -1).join(", "), last: parts.at(-1)! }) : (parts[0] ?? null);
}

export function LifeNote({ words }: { words: string }) {
  return (
    <div className="glass lifenote" data-testid="life-note" role="note" title={t("Cosmetic: not part of the world's spec hash or its proof")}>
      {t("Ambient life: {what}. They react to you; the proof doesn't count them.", { what: words })}
    </div>
  );
}
