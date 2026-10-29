// The end of a run: how long it took against the AI par, why it ended (the Host's story, each
// moment replayable), and the way back in.
import { useState, type FormEvent } from "react";
import type { WorldBundle } from "@ghostrun/ir";
import { clock, why, type Fact, type Story } from "../host";
import { raceClock, split } from "../race";
import "./race.css";

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
function AskHost({ onAsk, onReplay }: { onAsk: (q: string) => Promise<{ answer: string; cites: Fact[] } | null>; onReplay?: ((tick: number) => void) | undefined }) {
  const [q, setQ] = useState("");
  const [a, setA] = useState<{ answer: string; cites: Fact[] } | "asking" | "failed" | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = q.trim();
    if (!t || a === "asking") return;
    setA("asking");
    setA((await onAsk(t)) ?? "failed");
  };
  return (
    <div className="host" data-testid="host">
      <form onSubmit={submit}>
        <input value={q} maxLength={200} placeholder="Ask the Host: why did I lose?" aria-label="Ask the Host" data-testid="host-input" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </form>
      {a === "asking" && <p className="muted">the Host is looking at your run…</p>}
      {a === "failed" && <p className="muted">The Host couldn't answer just now.</p>}
      {a && typeof a === "object" && (
        <p className="host-answer" data-testid="host-answer">
          <b>Host:</b> {a.answer}{" "}
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

export function ResultCard({ result, bundle, par, onAgain, onShare, director, onTwist, onReplay, onAsk, race }: { result: RunResult; bundle: WorldBundle; par: number | null; onAgain: () => void; onShare: () => void; director?: { line: string; label: string; status: "proving" | "ready" } | null; onTwist?: () => void; onReplay?: (tick: number) => void; onAsk?: ((q: string) => Promise<{ answer: string; cites: Fact[] } | null>) | undefined; race?: RaceCard | undefined }) {
  const t = Math.round((result.tick / 60) * 10) / 10;
  const reason = why(bundle, result.rule);
  const vsPar = par === null ? null : result.k === "win" ? (t <= par ? `You beat the AI par of ${par} s by ${Math.round((par - t) * 10) / 10} s.` : `AI runners do it in ${par} s: there's a faster route.`) : null;
  return (
    <div className={`glass result ${result.k}`} role="dialog" aria-label="Run result" data-testid="result">
      <div className="result-head">{result.k === "win" ? "You win" : "You lose"}</div>
      <div className="result-time">
        {t} s{reason && <span className="muted"> · {reason}</span>}
      </div>
      {vsPar && <p className="result-note">{vsPar}</p>}
      {race?.vs && result.k === "win" && (
        <p className="result-race" data-testid="result-race">
          vs {race.vs.name} {raceClock(race.vs.ticks)}: you {raceClock(result.tick)}{" "}
          <span className={result.tick <= race.vs.ticks ? "ahead" : "behind"}>({split((result.tick - race.vs.ticks) / 60)})</span>
        </p>
      )}
      {result.story && result.story.moments.length > 0 && (
        <ol className="result-story" data-testid="story" aria-label="What happened">
          {result.story.moments.map((m) => (
            <li key={`${m.tick}:${m.text}`}>
              {onReplay ? (
                <button type="button" onClick={() => onReplay(m.tick)} title="Replay this moment exactly as it happened">
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
      {onAsk && <AskHost onAsk={onAsk} onReplay={onReplay} />}
      {director && (
        <p className="result-director" data-testid="director">
          <b>Director:</b> {director.line} <span className="muted">({director.label}; {director.status === "ready" ? "re-proved ✓" : "re-proving…"})</span>
        </p>
      )}
      <div className="result-actions">
        <button type="button" onClick={onAgain} data-testid="again">
          Play again <kbd>R</kbd>
        </button>
        {director?.status === "ready" && onTwist && (
          <button type="button" onClick={onTwist} data-testid="twist">
            Play with the twist
          </button>
        )}
        {race?.onRaceMe && (
          <button type="button" onClick={race.onRaceMe} data-testid="race-me" title="A link that opens this world with your run as the ghost to beat">
            Race me
          </button>
        )}
        {race?.onBoard && (
          <button type="button" onClick={race.onBoard} data-testid="best-times">
            Best times
          </button>
        )}
        <button type="button" onClick={onShare}>Share this run</button>
      </div>
      {race && (
        <div className="result-card">
          <output data-testid="result-card" aria-label="Your result, to paste anywhere">{race.text}</output>
          <button type="button" onClick={race.onCopy} data-testid="copy-card">
            {race.copied ?? "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
