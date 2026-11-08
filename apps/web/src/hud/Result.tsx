// The end of a run: how long it took against the AI par, why it ended (the Host's story, each
// moment replayable), and the way back in.
import { useEffect, useState, type FormEvent } from "react";
import type { WorldBundle } from "@ghostrun/ir";
import { firstSentences, recap } from "../audio/lines";
import { clock, why, type Fact, type Story } from "../host";
import { num, t } from "../i18n";
import { raceClock, split } from "../race";
import { ClipPanel, type ClipCard } from "./Clip";
import "./race.css";
import "./voice.css";

/** The Host's voice on the card: it says the recap (and each answer), and says the last line again. */
export interface HostVoice {
  say(text: string): void;
  again(): void;
}

/** After the win or lose sting has rung out, so the Host isn't talking over it. */
const RECAP_DELAY_MS = 900;

/** The race side of a result: the line to paste anywhere, "Race me", and the world's best times. */
export interface RaceCard {
  /** One line, Wordle-style (its link appears once it has been made). */
  text: string;
  /** Copy the line (making its link first, if the share service is reachable). */
  onCopy: () => void;
  /** Feedback on the copy button ("Copied"), or null. */
  copied: string | null;
  /** A win only: a link that plays this run as the ghost to beat. */
  onRaceMe?: (() => void) | undefined;
  onBoard?: (() => void) | undefined;
  /** The ghost this run raced, for the split at the line. */
  vs?: { name: string; ticks: number } | null;
}

export interface RunResult {
  k: "win" | "lose";
  tick: number;
  rule: string;
  story?: Story | null;
  /** What the Host may answer from: this run's facts, frozen when it ended. */
  facts?: Fact[];
}

/** Ask the Host about this run: the answer cites its facts, and a cited moment replays. */
function AskHost({ onAsk, onReplay, voice }: { onAsk: (q: string) => Promise<{ answer: string; cites: Fact[] } | null>; onReplay?: ((tick: number) => void) | undefined; voice?: HostVoice | undefined }) {
  const [q, setQ] = useState("");
  const [a, setA] = useState<{ answer: string; cites: Fact[] } | "asking" | "failed" | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = q.trim();
    if (!t || a === "asking") return;
    setA("asking");
    const got = await onAsk(t);
    setA(got ?? "failed");
    // the gist out loud; the whole answer and its replayable moments stay on the card
    if (got) voice?.say(firstSentences(got.answer, 2));
  };
  return (
    <div className="host" data-testid="host">
      <form onSubmit={submit}>
        <input value={q} maxLength={200} placeholder={t("Ask the Host: why did I lose?")} aria-label={t("Ask the Host")} data-testid="host-input" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </form>
      {a === "asking" && <p className="muted">{t("the Host is looking at your run…")}</p>}
      {a === "failed" && <p className="muted">{t("The Host couldn't answer just now.")}</p>}
      {a && typeof a === "object" && (
        <p className="host-answer" data-testid="host-answer">
          <b>{t("Host:")}</b> {a.answer}{" "}
          {a.cites
            .filter((f) => f.tick !== null)
            .map((f) => (
              <button key={f.text} type="button" title={f.text} onClick={() => onReplay?.(f.tick!)}>
                ▶ {clock(f.tick!)}
              </button>
            ))}
        </p>
      )}
    </div>
  );
}

export function ResultCard({ result, bundle, par, onAgain, onShare, director, onTwist, onReplay, onAsk, race, voice, clip }: { result: RunResult; bundle: WorldBundle; par: number | null; onAgain: () => void; onShare: () => void; director?: { line: string; label: string; status: "proving" | "ready" } | null; onTwist?: () => void; onReplay?: (tick: number) => void; onAsk?: ((q: string) => Promise<{ answer: string; cites: Fact[] } | null>) | undefined; race?: RaceCard | undefined; voice?: HostVoice | undefined; clip?: ClipCard | undefined }) {
  const s = Math.round((result.tick / 60) * 10) / 10;
  const reason = why(bundle, result.rule);
  const said = recap(result, bundle);
  useEffect(() => {
    if (!voice) return;
    const at = setTimeout(() => voice.say(said), RECAP_DELAY_MS);
    return () => clearTimeout(at);
  }, [result]); // once per run's end (the card re-renders as the race line and Director land)
  const vsPar = par === null ? null : result.k === "win" ? (s <= par ? t("You beat the AI par of {par} s by {by} s.", { par, by: Math.round((par - s) * 10) / 10 }) : t("AI runners do it in {par} s: there's a faster route.", { par })) : null;
  return (
    <div className={`glass result ${result.k}`} role="dialog" aria-label={t("Run result")} data-testid="result">
      <div className="result-head">{result.k === "win" ? t("You win") : t("You lose")}</div>
      <div className="result-time">
        {num(s)} s{reason && <span className="muted"> · {reason}</span>}
        {voice && (
          <button type="button" className="host-voice" onClick={voice.again} aria-label={t("The Host says it again")} title={t("The Host: “{said}”", { said })} data-testid="host-voice">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 6h2.2L8 3.2v9.6L4.7 10H2.5z" />
              <path d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8M12.4 3.9a5.8 5.8 0 0 1 0 8.2" />
            </svg>
          </button>
        )}
      </div>
      {vsPar && <p className="result-note">{vsPar}</p>}
      {race?.vs && result.k === "win" && (
        <p className="result-race" data-testid="result-race">
          {t("vs {name} {time}: you {mine}", { name: race.vs.name, time: raceClock(race.vs.ticks), mine: raceClock(result.tick) })}{" "}
          <span className={result.tick <= race.vs.ticks ? "ahead" : "behind"}>({split((result.tick - race.vs.ticks) / 60)})</span>
        </p>
      )}
      {result.story && result.story.moments.length > 0 && (
        <ol className="result-story" data-testid="story" aria-label={t("What happened")}>
          {result.story.moments.map((m) => (
            <li key={`${m.tick}:${m.text}`}>
              {onReplay ? (
                <button type="button" onClick={() => onReplay(m.tick)} title={t("Replay this moment exactly as it happened")}>
                  ▶ {clock(m.tick)}
                </button>
              ) : (
                <span className="mono">{clock(m.tick)}</span>
              )}{" "}
              {m.text}
            </li>
          ))}
        </ol>
      )}
      {onAsk && <AskHost onAsk={onAsk} onReplay={onReplay} voice={voice} />}
      {director && (
        <p className="result-director" data-testid="director">
          <b>{t("Director:")}</b> {director.line} <span className="muted">({director.label}; {director.status === "ready" ? t("re-proved ✓") : t("re-proving…")})</span>
        </p>
      )}
      <div className="result-actions">
        <button type="button" onClick={onAgain} data-testid="again">
          {t("Play again")} <kbd>R</kbd>
        </button>
        {director?.status === "ready" && onTwist && (
          <button type="button" onClick={onTwist} data-testid="twist">
            {t("Play with the twist")}
          </button>
        )}
        {race?.onRaceMe && (
          <button type="button" onClick={race.onRaceMe} data-testid="race-me" title={t("A link that opens this world with your run as the ghost to beat")}>
            {t("Race me")}
          </button>
        )}
        {race?.onBoard && (
          <button type="button" onClick={race.onBoard} data-testid="best-times">
            {t("Best times")}
          </button>
        )}
        <button type="button" onClick={onShare}>{t("Share this run")}</button>
      </div>
      {clip && <ClipPanel clip={clip} />}
      {race && (
        <div className="result-card">
          <output data-testid="result-card" aria-label={t("Your result, to paste anywhere")}>{race.text}</output>
          <button type="button" onClick={race.onCopy} data-testid="copy-card">
            {race.copied ?? t("Copy")}
          </button>
        </div>
      )}
    </div>
  );
}
