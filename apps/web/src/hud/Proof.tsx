import type { Chip, Insights, Receipt, Revealed as Report } from "@ghostrun/proof/light";
import { Fragment, useState, type ReactNode } from "react";
import { fraction, statusWord } from "@ghostrun/proof/light";
import { t, tn } from "../i18n";
import { chipLineT, proofText, words } from "../i18n/words";
import { Revealed } from "./Revealed";
import { FengShui } from "./FengShui";
import type { FengShuiView } from "../fengshui";

export interface ProofState {
  status: "idle" | "proving" | "done" | "error";
  chips: Chip[];
  receipt: Receipt | null;
  error?: string;
  /** The playtest's novice and average runners are still playing (the receipt is out already). */
  playing?: boolean;
}

const bad = (c: Chip) => c.status === "counterexample";

/** The badge's words and tone (the headset's watch says the same). */
export function proofBadge(proof: ProofState): { text: string; tone: "good" | "bad" | "pending" | "warn" } {
  const { status, chips, receipt } = proof;
  const fails = chips.filter(bad).length;
  const win = chips.find((c) => c.id === "T3:win");
  if (status === "proving") return { text: tn(chips.length, "AI runners playing… {n} check", "AI runners playing… {n} checks"), tone: "pending" };
  if (status === "error") return { text: t("proof unavailable"), tone: "warn" };
  if (status !== "done" || !receipt) return { text: t("proof: pending"), tone: "pending" };
  const head = receipt.headline;
  if (fails) return { text: tn(fails, "{n} counterexample", "{n} counterexamples"), tone: "bad" };
  return { text: `${head ? `${head.text}: ${statusWord(head.status, words)}` : t("no counterexamples")}${win ? ` · ${t("{k} AI runners won", { k: fraction(win.k, win.n, words) })}` : ""}`, tone: head && head.status !== "verified" && head.status !== "played" ? "pending" : "good" };
}

/** At most one line, always with its method on hover; turns green only on evidence. */
export function ProofBadge({ proof, onOpen }: { proof: ProofState; onOpen: () => void }) {
  const { receipt } = proof;
  const { text, tone } = proofBadge(proof);
  return (
    <button type="button" className={`glass proof ${tone}`} data-testid="proof-badge" onClick={onOpen} title={receipt ? t("spec {spec} · {ms} ms · press P", { spec: receipt.spec.slice(0, 8), ms: receipt.ms }) : t("AI runners have not played this world yet")}>
      <span className="dot" aria-hidden="true" />
      {tone === "bad" ? `${text} · ${t("tap for details")}` : text}
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
        {on ? t("Hide the runners' routes") : t("Where the runners went")}
      </button>
      <span className="muted"> ({t("{runs} AI runs, {samples} positions", { runs, samples: routes.samples })})</span>
      {hot.length > 0 && <p>{t("Most time: {where}.", { where: hot.map((h) => t("near the {thing} ({pct})", { thing: h.near, pct: pct(h.share) })).join(", ") })}</p>}
      <p className={routes.unused.length ? "warn" : ""}>
        {routes.unused.length ? <>{t("Nobody went near: {things}.", { things: `${routes.unused.slice(0, 4).map((u) => t("the {thing}", { thing: u.noun })).join(", ")}${routes.unused.length > 4 ? t(" and {n} more", { n: routes.unused.length - 4 }) : ""}` })} {t("A design note: give players a reason to go there, or take it out.")}</> : t("Every runner's route passed everything there is to use.")}
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
    <div className="glass receipt" role="dialog" aria-label={t("Proof receipt")} data-testid="receipt">
      <div className="receipt-head">
        <strong>{t("Receipt")}</strong>
        {r && <span className="mono">spec {r.spec.slice(0, 8)} · {r.ms} ms · {t(r.host)}</span>}
        <button type="button" onClick={onClose} aria-label={t("close")}>×</button>
      </div>
      {version && (
        <p className="receipt-version" data-testid="receipt-version">
          {version}
        </p>
      )}
      {r?.headline && (
        <p className={`headline ${r.headline.status}`}>
          {r.headline.text}: <b>{t(r.headline.status.replace("_", " "))}</b>
          <span className="method"> ({r.headline.method.split(" + ").map(proofText).join(" + ")})</span>
        </p>
      )}
      <ul>
        {proof.chips.map((c) => (
          <li key={c.id} className={c.status}>
            {chipLineT(c)}
            {chipAction?.(c)}
          </li>
        ))}
      </ul>
      {r?.par && <p className="par">{t("AI par {s} s · {k} of {n} runners won", { s: r.par.goldS, k: r.par.won, n: r.par.runs })}</p>}
      {fengShui && <FengShui view={fengShui} noteAction={noteAction} />}
      {routes && r?.trails && onRoutes && (
        <Revealed receipt={r} report={report ?? null} playing={proof.playing} noteAction={noteAction}>
          <Routes routes={routes} runs={report?.runs ?? r.trails.length} on={Boolean(routesOn)} onToggle={onRoutes} noteAction={noteAction} />
        </Revealed>
      )}
      {fooled && (
        <p className={`fooled ${fooled.status === "done" ? (fooled.caught ? "caught" : "missed") : ""}`} data-testid="fooled">
          {fooled.status === "planting" && t("Planting a bug in a copy of this world; AI runners are playing it…")}
          {fooled.status === "none" && t("Nothing to plant: this world has more than one way to win (breaking one route isn't a bug).")}
          {fooled.status === "done" && (
            <>
              {t("Planted")}{fooled.of && fooled.of > 1 ? ` (${t("{k} of {n}", { k: ((fooled.k ?? 0) % fooled.of) + 1, n: fooled.of })})` : ""}: <b>{fooled.text}</b>.{" "}
              {fooled.caught ? <>{t("Caught: {by}.", { by: fooled.by ?? t("it no longer proves won") })}</> : <>{t('Not caught: the proof still says it\'s won. That\'s a hole in the proof; please press "This is wrong".')}</>}
            </>
          )}
        </p>
      )}
      {reported && <p className="reported">⚑ {t("Judge-reported:")} {reported}</p>}
      {proof.error && <p className="warn">{proof.error}</p>}
      <div className="receipt-actions">
        {onShare && <button type="button" onClick={onShare} data-testid="share">{t("Share this run")}</button>}
        {onExport && <button type="button" onClick={onExport} data-testid="export" title={t("glTF scene + logic.json (triggers, states, rules) + playtest report")}>{t("Export")}</button>}
        {onTrust && <button type="button" onClick={onTrust} data-testid="why-trust">{t("Why trust this?")}</button>}
        {onFool && (
          <button type="button" onClick={onFool} disabled={fooled?.status === "planting"} data-testid="fool" title={t("Plant a bug that breaks this world in a copy of it, and see whether the proof notices")}>
            {fooled?.status === "done" ? t("Plant another bug") : t("Try to fool it")}
          </button>
        )}
        {onWrong && !writing && <button type="button" onClick={() => setWriting(true)} data-testid="wrong">{t("This is wrong")}</button>}
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
          <textarea value={note} maxLength={500} placeholder={t("What's wrong? (the run so far is attached)")} onChange={(e) => setNote(e.target.value)} autoFocus />
          <button type="submit" disabled={!note.trim()}>{t("Send")}</button>
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
        {cut.status === "working" ? t("Director's cut: Claude Sonnet is reworking this world…") : t("Director's cut: AI runners are playing it ({what})…", { what: cut.summary.slice(0, 3).join(", ") })}
      </div>
    );
  }
  return (
    <button type="button" className="glass repair cut offer" data-testid="cut-chip" onClick={onApply} title={t("Claude Sonnet's version of this world, re-proved on this device: it plays at least as well as the one you have")}>
      <span className="dot" aria-hidden="true" />
      {t("Director's cut ready: {what} · re-proved", { what: cut.summary.slice(0, 4).join(", ") })} · <strong>{t("Apply")}</strong>
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
        {repair.hard ? tn(repair.issues, "Claude Sonnet taking a harder look at {n} issue the proof found", "Claude Sonnet taking a harder look at {n} issues the proof found") : tn(repair.issues, "AI repairing {n} issue the proof found", "AI repairing {n} issues the proof found")}{!repair.hard && repair.round && repair.round > 1 ? ` ${t("(round {k} of 3)", { k: repair.round })}` : ""}…
      </div>
    );
  }
  return (
    <button type="button" className="glass repair offer" data-testid="repair-chip" onClick={onApply} title={t("The repaired world was re-proved on this device and beats the original receipt")}>
      <span className="dot" aria-hidden="true" />
      {repair.left ? tn(repair.left, "{who} improved it ({n} issue left)", "{who} improved it ({n} issues left)", { who: repair.hard ? "Claude Sonnet" : t("AI") }) : t("{who} repaired it", { who: repair.hard ? "Claude Sonnet" : t("AI") })}
      {repair.headline ? `: ${repair.headline}` : ""} · {t("re-proved")}{repair.round && repair.round > 1 ? ` · ${tn(repair.round, "{n} round", "{n} rounds")}` : ""} · <strong>{t("Apply")}</strong>
    </button>
  );
}
