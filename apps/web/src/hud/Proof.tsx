import type { Chip, CrossCheck, Insights, Receipt, Revealed as Report } from "@ghostrun/proof/light";
import { Fragment, useState, type ReactNode } from "react";
import { chipLineAt, crossLine, fraction, statusWord, whereWord } from "@ghostrun/proof/light";
import { Revealed } from "./Revealed";
import "./cloud.css";
import { FengShui } from "./FengShui";
import type { FengShuiView } from "../fengshui";

export interface ProofState {
  status: "idle" | "proving" | "done" | "error";
  chips: Chip[];
  receipt: Receipt | null;
  error?: string;
  /** The playtest's novice and average runners are still playing (the receipt is out already). */
  playing?: boolean;
  /** Where the receipt was proved, and whether the cloud's and this device's agree (cloud.ts). */
  cross?: CrossCheck;
}

const bad = (c: Chip) => c.status === "counterexample";

/** The badge's words and tone (the headset's watch says the same). */
export function proofBadge(proof: ProofState): { text: string; tone: "good" | "bad" | "pending" | "warn" } {
  const { status, chips, receipt } = proof;
  const fails = chips.filter(bad).length;
  const win = chips.find((c) => c.id === "T3:win");
  if (status === "proving") return { text: `AI runners playing… ${chips.length} checks`, tone: "pending" };
  if (status === "error") return { text: "proof unavailable", tone: "warn" };
  if (status !== "done" || !receipt) return { text: "proof: pending", tone: "pending" };
  const head = receipt.headline;
  if (fails) return { text: `${fails} counterexample${fails > 1 ? "s" : ""}`, tone: "bad" };
  return { text: `${head ? `${head.text}: ${statusWord(head.status)}` : "no counterexamples"}${win ? ` · ${fraction(win.k, win.n)} AI runners won` : ""}`, tone: head && head.status !== "verified" && head.status !== "played" ? "pending" : "good" };
}

/** At most one line, always with its method on hover; turns green only on evidence. */
export function ProofBadge({ proof, onOpen }: { proof: ProofState; onOpen: () => void }) {
  const { receipt } = proof;
  const { text, tone } = proofBadge(proof);
  return (
    <button type="button" className={`glass proof ${tone}`} data-testid="proof-badge" onClick={onOpen} title={receipt ? `spec ${receipt.spec.slice(0, 8)} · ${receipt.ms} ms · press P` : "AI runners have not played this world yet"}>
      <span className="dot" aria-hidden="true" />
      {tone === "bad" ? `${text} · tap for details` : text}
    </button>
  );
}

/** "Try to fool it": a bug planted in a copy of this world, and whether the proof caught it. */
export interface Fooled {
  status: "planting" | "done" | "none";
  text?: string;
  caught?: boolean;
  by?: string | null;
  /** Which of how many plantable bugs this was. */
  k?: number;
  of?: number;
}

/** Play analytics in a few words: where the AI runners spent their time, and what nobody went near. */
function Routes({ routes, runs, on, onToggle, noteAction }: { routes: Insights; runs: number; on: boolean; onToggle: () => void; noteAction?: ((key: string) => ReactNode) | undefined }) {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const hot = routes.hot.filter((h) => h.share >= 0.03 && h.near);
  return (
    <div className="routes" data-testid="routes">
      <button type="button" onClick={onToggle} data-testid="routes-toggle" aria-pressed={on}>
        {on ? "Hide the runners' routes" : "Where the runners went"}
      </button>
      <span className="muted"> ({runs} AI runs, {routes.samples} positions)</span>
      {hot.length > 0 && <p>Most time: {hot.map((h) => `near the ${h.near} (${pct(h.share)})`).join(", ")}.</p>}
      <p className={routes.unused.length ? "warn" : ""}>
        {routes.unused.length ? <>Nobody went near: {routes.unused.slice(0, 4).map((u) => `the ${u.noun}`).join(", ")}{routes.unused.length > 4 ? ` and ${routes.unused.length - 4} more` : ""}. A design note: give players a reason to go there, or take it out.</> : "Every runner's route passed everything there is to use."}
      </p>
      {noteAction && routes.unused.slice(0, 4).map((u) => <Fragment key={u.id}>{noteAction(`unused:${u.id}`)}</Fragment>)}
    </div>
  );
}

export function ReceiptPanel({ proof, onClose, onShare, onWrong, onExport, onTrust, onFool, fooled, reported, routes, routesOn, onRoutes, report, version, fengShui, chipAction, noteAction }: { proof: ProofState; onClose: () => void; onShare?: () => void; onWrong?: (note: string) => void; onExport?: () => void; onTrust?: () => void; onFool?: (() => void) | undefined; fooled?: Fooled | null; reported?: string | undefined; routes?: Insights | null; routesOn?: boolean; onRoutes?: () => void; report?: Report | null; /** A remix: which version this receipt is for, and that the original's is its own. */ version?: string | null; /** Feng Shui for one named school, checked on this world (asked for, or offered for an interior). */ fengShui?: FengShuiView | null; /** After a chip's line: its ▶ red/green, when it has one. */ chipAction?: ((c: Chip) => ReactNode) | undefined; /** After a design note (a thing nobody went near, a place runs went wrong): its Apply choices. */ noteAction?: ((key: string) => ReactNode) | undefined }) {
  const r = proof.receipt;
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="glass receipt" role="dialog" aria-label="Proof receipt" data-testid="receipt">
      <div className="receipt-head">
        <strong>Receipt</strong>
        {r && <span className="mono">spec {r.spec.slice(0, 8)} · {r.ms} ms · {whereWord(r.host)}</span>}
        <button type="button" onClick={onClose} aria-label="close">×</button>
      </div>
      {r && (
        <p className={`receipt-where ${proof.cross?.cloud ?? "off"}`} data-testid="receipt-where">
          {crossLine(proof.cross ?? { shown: r.host, cloud: "off", device: "done" })}
        </p>
      )}
      {version && (
        <p className="receipt-version" data-testid="receipt-version">
          {version}
        </p>
      )}
      {r?.headline && (
        <p className={`headline ${r.headline.status}`}>
          {r.headline.text}: <b>{r.headline.status.replace("_", " ")}</b>
          <span className="method"> ({r.headline.method})</span>
        </p>
      )}
      <ul>
        {proof.chips.map((c) => (
          <li key={c.id} className={c.status}>
            {chipLineAt(c, r?.host ?? "device")}
            {chipAction?.(c)}
          </li>
        ))}
      </ul>
      {r?.par && <p className="par">AI par {r.par.goldS} s · {r.par.won} of {r.par.runs} runners won</p>}
      {fengShui && <FengShui view={fengShui} noteAction={noteAction} />}
      {routes && r?.trails && onRoutes && (
        <Revealed receipt={r} report={report ?? null} playing={proof.playing} noteAction={noteAction}>
          <Routes routes={routes} runs={report?.runs ?? r.trails.length} on={Boolean(routesOn)} onToggle={onRoutes} noteAction={noteAction} />
        </Revealed>
      )}
      {fooled && (
        <p className={`fooled ${fooled.status === "done" ? (fooled.caught ? "caught" : "missed") : ""}`} data-testid="fooled">
          {fooled.status === "planting" && "Planting a bug in a copy of this world; AI runners are playing it…"}
          {fooled.status === "none" && "Nothing to plant: this world has more than one way to win (breaking one route isn't a bug)."}
          {fooled.status === "done" && (
            <>
              Planted{fooled.of && fooled.of > 1 ? ` (${(fooled.k ?? 0) % fooled.of + 1} of ${fooled.of})` : ""}: <b>{fooled.text}</b>.{" "}
              {fooled.caught ? <>Caught: {fooled.by ?? "it no longer proves won"}.</> : <>Not caught: the proof still says it's won. That's a hole in the proof; please press "This is wrong".</>}
            </>
          )}
        </p>
      )}
      {reported && <p className="reported">⚑ Judge-reported: {reported}</p>}
      {proof.error && <p className="warn">{proof.error}</p>}
      <div className="receipt-actions">
        {onShare && <button type="button" onClick={onShare} data-testid="share">Share this run</button>}
        {onExport && <button type="button" onClick={onExport} data-testid="export" title="glTF scene + logic.json (triggers, states, rules) + playtest report">Export</button>}
        {onTrust && <button type="button" onClick={onTrust} data-testid="why-trust">Why trust this?</button>}
        {onFool && (
          <button type="button" onClick={onFool} disabled={fooled?.status === "planting"} data-testid="fool" title="Plant a bug that breaks this world in a copy of it, and see whether the proof notices">
            {fooled?.status === "done" ? "Plant another bug" : "Try to fool it"}
          </button>
        )}
        {onWrong && !writing && <button type="button" onClick={() => setWriting(true)} data-testid="wrong">This is wrong</button>}
      </div>
      {writing && onWrong && (
        <form
          className="wrong-form"
          onSubmit={(e) => {
            e.preventDefault();
            onWrong(note);
            setWriting(false);
            setNote("");
          }}
        >
          <textarea value={note} maxLength={500} placeholder="What's wrong? (the run so far is attached)" onChange={(e) => setNote(e.target.value)} autoFocus />
          <button type="submit" disabled={!note.trim()}>Send</button>
        </form>
      )}
    </div>
  );
}

export interface RepairState {
  status: "idle" | "working" | "offer" | "failed";
  issues: number;
  /** Counterexamples left in the repaired world's receipt. */
  left?: number;
  headline?: string;
  /** The repair round under way (working), or how many rounds the offer took. */
  round?: number;
  /** The stronger model's round (Claude Sonnet), after the fast repair couldn't fix it all. */
  hard?: boolean;
}

export type CutState = { status: "idle" } | { status: "working" } | { status: "proving"; summary: string[] } | { status: "offer"; summary: string[] };

/** The Director's cut in one line: Sonnet reworking the world, proving it, or a re-proved version to apply. */
export function CutChip({ cut, onApply }: { cut: CutState; onApply: () => void }) {
  if (cut.status === "idle") return null;
  if (cut.status !== "offer") {
    return (
      <div className="glass repair cut working" data-testid="cut-chip">
        <span className="dot" aria-hidden="true" />
        {cut.status === "working" ? "Director's cut: Claude Sonnet is reworking this world…" : `Director's cut: AI runners are playing it (${cut.summary.slice(0, 3).join(", ")})…`}
      </div>
    );
  }
  return (
    <button type="button" className="glass repair cut offer" data-testid="cut-chip" onClick={onApply} title="Claude Sonnet's version of this world, re-proved on this device: it plays at least as well as the one you have">
      <span className="dot" aria-hidden="true" />
      Director's cut ready: {cut.summary.slice(0, 4).join(", ")} · re-proved · <strong>Apply</strong>
    </button>
  );
}

/** The repair loop's one line: working, or a re-proved better world to apply between runs. */
export function RepairChip({ repair, onApply }: { repair: RepairState; onApply: () => void }) {
  if (repair.status === "idle" || repair.status === "failed") return null;
  if (repair.status === "working") {
    return (
      <div className="glass repair working" data-testid="repair-chip">
        <span className="dot" aria-hidden="true" />
        {repair.hard ? "Claude Sonnet taking a harder look at" : "AI repairing"} {repair.issues} issue{repair.issues > 1 ? "s" : ""} the proof found{!repair.hard && repair.round && repair.round > 1 ? ` (round ${repair.round} of 3)` : ""}…
      </div>
    );
  }
  return (
    <button type="button" className="glass repair offer" data-testid="repair-chip" onClick={onApply} title="The repaired world was re-proved on this device and beats the original receipt">
      <span className="dot" aria-hidden="true" />
      {repair.left ? `${repair.hard ? "Claude Sonnet" : "AI"} improved it (${repair.left} issue${repair.left > 1 ? "s" : ""} left)` : `${repair.hard ? "Claude Sonnet" : "AI"} repaired it`}
      {repair.headline ? `: ${repair.headline}` : ""} · re-proved{repair.round && repair.round > 1 ? ` · ${repair.round} rounds` : ""} · <strong>Apply</strong>
    </button>
  );
}
