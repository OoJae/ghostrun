// "Change it": the person's own edit to the world they're playing. It comes back re-proved, with
// its numbers: what changed in the world, and how the receipt moved.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Delta } from "../edits";

export type EditState =
  | { status: "idle" }
  | { status: "editing"; change: string }
  | { status: "racing"; change: string; total: number; proved: number }
  | { status: "proving"; change: string; summary: string[]; locked: number; race?: string[]; notes?: string[] }
  | { status: "done"; change: string; summary: string[]; locked: number; delta: Delta[] | null; failures: string[]; race?: string[]; notes?: string[] }
  | { status: "failed"; change: string; message: string; race?: string[] };

const SIGN = { "-1": "worse", "0": "same", "1": "better" } as const;

interface Props {
  state: EditState;
  enabled: boolean;
  suggestions: string[];
  canUndo: boolean;
  onEdit: (change: string) => void;
  onUndo: () => void;
  /** Bumped to put the cursor in the box (Remix opens a world for your first change). */
  focusKey?: number;
  placeholder?: string | undefined;
  /** Shown above it: where a shared or gallery world came from. */
  children?: ReactNode;
}

export function EditBox({ state, enabled, suggestions, canUndo, onEdit, onUndo, focusKey = 0, placeholder, children }: Props) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusKey) input.current?.focus();
  }, [focusKey]);
  const busy = state.status === "editing" || state.status === "racing" || state.status === "proving";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy || !enabled) return;
    onEdit(t);
    setText("");
  };
  return (
    <aside className={`glass editbox ${state.status}`} data-testid="edit-box">
      {children}
      <form onSubmit={submit}>
        <span className="eyebrow">Change it</span>
        <input
          ref={input}
          value={text}
          maxLength={300}
          disabled={!enabled}
          spellCheck={false}
          aria-label="Change this world"
          data-testid="edit-input"
          placeholder={enabled ? (placeholder ?? "say what to change…") : "edits need the live AI lane"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
        />
      </form>
      {state.status === "idle" && enabled && (
        <div className="edit-chips">
          {suggestions.map((s) => (
            <button type="button" key={s} onClick={() => onEdit(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {state.status !== "idle" && (
        <div className="edit-result" data-testid="edit-result">
          <p className="edit-change">“{state.change}”</p>
          {state.status === "editing" && <p className="muted">changing the world…</p>}
          {state.status === "racing" && (
            <p className="muted">
              {state.proved === 0 ? `writing ${state.total} harder versions…` : `racing ${state.total} harder versions: ${state.proved} of ${state.total} proved…`}
            </p>
          )}
          {state.status === "failed" && <p className="warn">{state.message}</p>}
          {(state.status === "proving" || state.status === "done") && (
            <>
              {/* a structural edit's re-anchoring, move by move, on hover */}
              <p className="edit-summary" data-testid="edit-summary" title={state.notes?.length ? state.notes.join("\n") : undefined}>
                {state.summary.join(" · ")}
              </p>
              {state.locked > 0 && <p className="muted">The world's promises were kept as they were; the proof re-checks them.</p>}
              {state.status === "proving" && <p className="muted">AI runners re-proving…</p>}
              {state.status === "done" && state.delta && (
                <ul className="edit-delta" data-testid="edit-delta">
                  {state.delta.length === 0 && <li className="same">Receipt unchanged: every check came out the same.</li>}
                  {state.delta.map((d) => (
                    <li key={d.label} className={SIGN[String(d.sign) as keyof typeof SIGN]}>
                      {d.label}: {d.from} → <b>{d.to}</b>
                    </li>
                  ))}
                </ul>
              )}
              {state.status === "done" && state.failures.length > 0 && (
                <ul className="edit-failures">
                  {state.failures.map((f) => (
                    <li key={f}>✗ {f}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {(state.status === "proving" || state.status === "done" || state.status === "failed") && state.race && (
            <ul className="edit-race" data-testid="edit-race">
              {state.race.map((r) => (
                <li key={r} className={r.includes("harder and fair") ? "kept" : ""}>
                  {r}
                </li>
              ))}
            </ul>
          )}
          {canUndo && !busy && (
            <button type="button" className="edit-undo" onClick={onUndo} data-testid="edit-undo">
              Undo
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
