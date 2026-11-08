// ?record=1, for screen-recording the demo: the cursor hides over the world (and anywhere once it
// rests), the extras step aside (key hints, the mute and VR buttons, the proof badge and its chips,
// the intent card, toasts), and one small caption strip says what a viewer should know: the
// prompt, how fast it was playable, where the world came from, and what the proof says. The
// collapsed prompt pill steps aside too (the strip says the prompt): clicking the strip opens the bar.
import { useEffect } from "react";
import { statusWord } from "@ghostrun/proof/light";
import type { ProofState } from "./Proof";
import "./clip.css";
import { t } from "../i18n";

/** The cursor hides after resting this long. */
const REST_MS = 1500;

export interface StripSource {
  mode: "checking" | "live" | "fixture";
  /** The edge replayed it from its cache: when and by whom it was built (its label). */
  cached: string | null;
  /** "Build it fresh": the edge's cache was skipped for this build. */
  bypassed: boolean;
  fellBack: boolean;
  /** A shared run or a gallery world (built before, not now). */
  kind: "share" | "gallery" | null;
}

/** Where the world came from, in a few words. */
export function sourceLine(s: StripSource): string {
  if (s.kind === "share") return "a shared run";
  if (s.kind === "gallery") return "recorded live AI world";
  if (s.mode === "fixture") return "recorded world";
  if (s.mode === "checking") return "…";
  if (s.cached) return s.cached;
  const who = s.fellBack ? "live AI · Claude Haiku" : "live AI";
  return s.bypassed ? `${who} · cache bypassed` : who;
}

function proofLine(p: ProofState): { text: string; tone: string } | null {
  if (p.status === "proving") return { text: "AI runners playing…", tone: "pending" };
  if (p.status !== "done" || !p.receipt) return null;
  const fails = p.chips.filter((c) => c.status === "counterexample").length;
  const head = p.receipt.headline;
  if (head) return { text: `${head.text}: ${statusWord(head.status)}`, tone: head.status === "counterexample" ? "bad" : head.status === "verified" || head.status === "played" ? "good" : "pending" };
  return fails ? { text: `${fails} counterexample${fails > 1 ? "s" : ""}`, tone: "bad" } : { text: "no counterexamples", tone: "good" };
}

export function RecordStrip({ prompt, ttffMs, busy, source, proof, onExpand }: { prompt: string; ttffMs: number | null; busy: boolean; source: StripSource; proof: ProofState; onExpand: () => void }) {
  useEffect(() => {
    const body = document.body.classList;
    body.add("record-mode");
    let t: ReturnType<typeof setTimeout> | undefined;
    const moved = () => {
      body.remove("cursor-rest");
      clearTimeout(t);
      t = setTimeout(() => body.add("cursor-rest"), REST_MS);
    };
    moved();
    window.addEventListener("pointermove", moved, { passive: true });
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointermove", moved);
      body.remove("record-mode", "cursor-rest");
    };
  }, []);
  const p = proofLine(proof);
  return (
    <button type="button" className="glass record-strip" onClick={onExpand} title={t("Edit the prompt")} data-testid="record-strip">
      <span className="mark" aria-hidden="true" />
      <span className="rs-prompt" title={prompt}>
        {prompt}
      </span>
      <span className="sep">·</span>
      <span className="rs-time">{busy || ttffMs === null ? t("building…") : t("playable in {s} s", { s: (ttffMs / 1000).toFixed(1) })}</span>
      <span className="sep">·</span>
      <span className="rs-source">{sourceLine(source)}</span>
      {p && (
        <>
          <span className="sep">·</span>
          <span className={`rs-proof ${p.tone}`}>{p.text}</span>
        </>
      )}
    </button>
  );
}
