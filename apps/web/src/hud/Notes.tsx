// A design note's Apply: its one or two changes as buttons; the one tried says how it's going, and
// comes back re-proved with its numbers and an Apply that swaps it in (with Undo), or says why not.
import type { DesignNote } from "../notes";
import type { NoteState } from "../useNotes";
import "./show.css";

const SIGN = { "-1": "worse", "0": "same", "1": "better" } as const;

export function NoteApply({ note, state, onTry, onAccept }: { note: DesignNote; state: NoteState; onTry: (key: string, change: string, said: string) => void; onAccept: () => void }) {
  const mine = state.status !== "idle" && state.key === note.key;
  const busy = state.status === "working";
  return (
    <div className="note-apply" data-testid="note-apply">
      {(!mine || state.status === "held") &&
        note.changes.map((c, i) => (
          <button type="button" key={c} disabled={busy} onClick={() => onTry(note.key, c, note.said?.[i] ?? c)} title="The live AI makes this change; AI runners re-prove it on a copy first, and it's offered only if it holds up">
            Apply: {note.said?.[i] ?? c}
          </button>
        ))}
      {mine && state.status === "working" && <p className="muted">“{state.change}”: {state.step === "editing" ? "changing a copy of the world…" : "AI runners re-proving the copy…"}</p>}
      {mine && state.status === "held" && <p className="muted">“{state.change}”: {state.why}</p>}
      {mine && state.status === "offer" && (
        <div className="note-offer" data-testid="note-offer">
          <p>
            “{state.change}”: {state.summary.join(" · ")} · re-proved on a copy:
          </p>
          <ul className="edit-delta">
            {state.delta.length === 0 && <li className="same">every check came out the same</li>}
            {state.delta.map((x) => (
              <li key={x.label} className={SIGN[String(x.sign) as keyof typeof SIGN]}>
                {x.label}: {x.from} → <b>{x.to}</b>
              </li>
            ))}
          </ul>
          <button type="button" onClick={onAccept} data-testid="note-accept">
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
