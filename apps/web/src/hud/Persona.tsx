// Persona sliders: the world's minded characters, each with a slider per trait (persona.ts). Moving a
// slider that changes gameplay is an edit: re-proved, its numbers shown here with the proof's word
// on it and Undo. The quiet ↔ chatty slider is persona prose: the spec and the receipt stand.
import { useEffect, useRef, useState } from "react";
import type { EditState } from "./Edit";
import { ENDS, valueWords, type Character, type Slider } from "../persona";
import { t } from "../i18n";

interface Props {
  characters: readonly Character[];
  edit: EditState;
  /** The proof's line on what a slider can change (the envelope, a bribe's price), from the receipt shown. */
  proved: string[];
  /** The last slider change is the one on show (its Undo is offered here). */
  mine: boolean;
  canUndo: boolean;
  onSlide: (s: Slider, to: number) => void;
  onUndo: () => void;
  /** Open or not (kept by the app: the panel stays open while an edit swaps the world in). */
  open: boolean;
  setOpen: (open: boolean) => void;
}

const COMMIT_MS = 350;

export function PersonaPanel({ characters, edit, proved, mine, canUndo, onSlide, onUndo, open, setOpen }: Props) {
  const [draft, setDraft] = useState<Record<string, number>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = (s: Slider) => `${s.npc}:${s.trait}`;
  // a new world (or the edit landing) shows the values as they now are
  useEffect(() => setDraft({}), [characters]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  if (!characters.length) return null;
  const busy = edit.status === "editing" || edit.status === "proving" || edit.status === "racing";
  const slide = (s: Slider, v: number) => {
    setDraft((d) => ({ ...d, [key(s)]: v }));
    if (timer.current) clearTimeout(timer.current);
    // let a drag settle: one edit, re-proved once, for where it stops
    timer.current = setTimeout(() => onSlide(s, v), COMMIT_MS);
  };
  if (!open)
    return (
      <button type="button" className="glass persona-open" data-testid="persona-open" onClick={() => setOpen(true)} title={t("Tune the characters' personas")}>
        {t("Characters")}
      </button>
    );
  return (
    <aside className="glass persona" data-testid="persona" aria-label={t("Characters")}>
      <div className="persona-head">
        <span className="eyebrow">{t("Characters")}</span>
        <button type="button" className="persona-close" aria-label={t("close")} onClick={() => setOpen(false)}>
          ×
        </button>
      </div>
      {characters.map((c) => (
        <section key={c.npc} className="persona-who" data-testid={`persona-${c.npc}`}>
          <b>{c.name}</b> <span className="muted">· {t(c.role)}</span>
          {c.sliders.map((s) => {
            const v = draft[key(s)] ?? s.value;
            const words = valueWords(s, v);
            return (
              <label key={s.trait} className="persona-slider">
                <span className="persona-ends">
                  <span>{t(ENDS[s.trait][0])}</span>
                  <span className="persona-value" data-testid={`persona-value-${c.npc}-${s.trait}`}>
                    {t(words.template, words.vars)}
                  </span>
                  <span>{t(ENDS[s.trait][1])}</span>
                </span>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={v}
                  disabled={busy}
                  data-testid={`persona-${c.npc}-${s.trait}`}
                  aria-label={`${c.name}: ${t(ENDS[s.trait][0])} – ${t(ENDS[s.trait][1])}`}
                  onChange={(e) => slide(s, Number(e.target.value))}
                />
                <span className="persona-kind muted">{s.gameplay ? t("changes play: re-proved") : t("persona prose: not in the proof")}</span>
              </label>
            );
          })}
        </section>
      ))}
      {mine && edit.status !== "idle" && (
        <div className="persona-result" data-testid="persona-result">
          {edit.status === "editing" && <p className="muted">{t("changing the world…")}</p>}
          {(edit.status === "proving" || edit.status === "done") && <p className="edit-summary">{edit.summary.join(" · ")}</p>}
          {edit.status === "proving" && <p className="muted">{t("AI runners re-proving…")}</p>}
          {edit.status === "done" && edit.delta && (
            <ul className="edit-delta">
              {edit.delta.length === 0 && <li className="same">{t("Receipt unchanged: every check came out the same.")}</li>}
              {edit.delta.map((d) => (
                <li key={d.label}>
                  {d.label}: {d.from} → <b>{d.to}</b>
                </li>
              ))}
            </ul>
          )}
          {edit.status === "done" && edit.failures.length > 0 && (
            <ul className="edit-failures">
              {edit.failures.map((f) => (
                <li key={f}>✗ {f}</li>
              ))}
            </ul>
          )}
          {edit.status === "done" && proved.length > 0 && (
            <ul className="persona-proved" data-testid="persona-proved">
              {proved.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {edit.status === "failed" && <p className="warn">{edit.message}</p>}
          {canUndo && !busy && (
            <button type="button" className="edit-undo" onClick={onUndo} data-testid="persona-undo">
              {t("Undo")}
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
