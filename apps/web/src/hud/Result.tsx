// The end of a run: how long it took against the AI par, why it ended, and the way back in.
import type { Rule, WorldBundle } from "@ghostrun/ir";

export interface RunResult {
  k: "win" | "lose";
  tick: number;
  rule: string;
}

/** Why a run ended, in words: the trigger of the rule that fired the win or the loss. */
function why(b: WorldBundle, ruleId: string): string {
  const r: Rule | undefined = b.rules.find((x) => x.id === ruleId);
  if (!r) return "";
  const name = (id: string) => (id.startsWith("team:") ? `${id.slice(5)} team` : b.entities.find((e) => e.id === id)?.noun || id.replace(/_/g, " "));
  const w = r.when;
  switch (w.t) {
    case "score_gte":
      return `${name(w.a)} reached ${w.n}`;
    case "timer_end":
      return "time ran out";
    case "hit":
      return `hit by the ${name(w.b)}`;
    case "enter":
      return w.a === "player" ? `reached the ${name(w.b)}` : `the ${name(w.a)} reached the ${name(w.b)}`;
    case "touch":
      return w.b ? `touched the ${name(w.b)}` : "collected enough";
    case "state_is":
      return `the ${name(w.a)} became ${w.s}`;
    default:
      return "";
  }
}

export function ResultCard({ result, bundle, par, onAgain, onShare, director, onTwist }: { result: RunResult; bundle: WorldBundle; par: number | null; onAgain: () => void; onShare: () => void; director?: { line: string; label: string; status: "proving" | "ready" } | null; onTwist?: () => void }) {
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
        <button type="button" onClick={onShare}>Share this run</button>
      </div>
    </div>
  );
}
