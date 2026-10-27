import type { Chip, Receipt } from "@ghostrun/proof";
import { chipLine, fraction, statusWord } from "@ghostrun/proof";

export interface ProofState {
  status: "idle" | "proving" | "done" | "error";
  chips: Chip[];
  receipt: Receipt | null;
  error?: string;
}

const bad = (c: Chip) => c.status === "counterexample";

/** At most one line, always with its method on hover; turns green only on evidence. */
export function ProofBadge({ proof, onOpen }: { proof: ProofState; onOpen: () => void }) {
  const { status, chips, receipt } = proof;
  const fails = chips.filter(bad).length;
  const win = chips.find((c) => c.id === "T3:win");
  let text = "proof: pending";
  let tone = "pending";
  if (status === "proving") text = `AI runners playing… ${chips.length} checks`;
  if (status === "error") ((text = "proof unavailable"), (tone = "warn"));
  if (status === "done" && receipt) {
    const head = receipt.headline;
    if (fails) ((text = `${fails} counterexample${fails > 1 ? "s" : ""} · tap for details`), (tone = "bad"));
    else ((text = `${head ? `${head.text}: ${statusWord(head.status)}` : "no counterexamples"}${win ? ` · ${fraction(win.k, win.n)} AI runners won` : ""}`), (tone = head && head.status !== "verified" && head.status !== "played" ? "pending" : "good"));
  }
  return (
    <button type="button" className={`glass proof ${tone}`} data-testid="proof-badge" onClick={onOpen} title={receipt ? `spec ${receipt.spec.slice(0, 8)} · ${receipt.ms} ms · press P` : "AI runners have not played this world yet"}>
      <span className="dot" aria-hidden="true" />
      {text}
    </button>
  );
}

export function ReceiptPanel({ proof, onClose }: { proof: ProofState; onClose: () => void }) {
  const r = proof.receipt;
  return (
    <div className="glass receipt" role="dialog" aria-label="Proof receipt" data-testid="receipt">
      <div className="receipt-head">
        <strong>Receipt</strong>
        {r && <span className="mono">spec {r.spec.slice(0, 8)} · {r.ms} ms · {r.host}</span>}
        <button type="button" onClick={onClose} aria-label="close">×</button>
      </div>
      {r?.headline && (
        <p className={`headline ${r.headline.status}`}>
          {r.headline.text}: <b>{r.headline.status.replace("_", " ")}</b>
          <span className="method"> ({r.headline.method})</span>
        </p>
      )}
      <ul>
        {proof.chips.map((c) => (
          <li key={c.id} className={c.status}>{chipLine(c)}</li>
        ))}
      </ul>
      {r?.par && <p className="par">AI par {r.par.goldS} s · {r.par.won} of {r.par.runs} runners won</p>}
      {proof.error && <p className="warn">{proof.error}</p>}
    </div>
  );
}

export interface RepairState {
  status: "idle" | "working" | "offer" | "failed";
  issues: number;
  /** Counterexamples left in the repaired world's receipt. */
  left?: number;
  headline?: string;
}

/** The repair loop's one line: working, or a re-proved better world to apply between runs. */
export function RepairChip({ repair, onApply }: { repair: RepairState; onApply: () => void }) {
  if (repair.status === "idle" || repair.status === "failed") return null;
  if (repair.status === "working") {
    return (
      <div className="glass repair working" data-testid="repair-chip">
        <span className="dot" aria-hidden="true" />
        AI repairing {repair.issues} issue{repair.issues > 1 ? "s" : ""} the proof found…
      </div>
    );
  }
  return (
    <button type="button" className="glass repair offer" data-testid="repair-chip" onClick={onApply} title="The repaired world was re-proved on this device and beats the original receipt">
      <span className="dot" aria-hidden="true" />
      {repair.left ? `AI improved it (${repair.left} issue${repair.left > 1 ? "s" : ""} left)` : "AI repaired it"}
      {repair.headline ? `: ${repair.headline}` : ""} · re-proved · <strong>Apply</strong>
    </button>
  );
}
