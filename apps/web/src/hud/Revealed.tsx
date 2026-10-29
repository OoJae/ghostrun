// The playtest in the receipt: how hard the world is (novices, average players and experts, k of n
// each), then what every AI run of every level revealed about it: where the time went (with the
// routes and the heat map over the ground), where runs went wrong and why, where the fights were,
// and when runners reached each step of the win. Every number comes from the proof's labels.
import type { ReactNode } from "react";
import type { Receipt, Revealed as Report } from "@ghostrun/proof/light";
import { bandMethod, bandSaid, failLine, fightLine, paceLine, timesLine } from "@ghostrun/proof/light";
import "./revealed.css";

export function Revealed({ receipt, report, playing, children }: { receipt: Receipt; report: Report | null; playing?: boolean | undefined; children?: ReactNode }) {
  const pt = receipt.playtest;
  return (
    <div className="revealed" data-testid="revealed">
      {pt ? (
        <p className={`band band-${pt.band.toLowerCase().replace(/\s+/g, "-")}`} data-testid="band" title={bandMethod(pt)}>
          Difficulty: <b>{pt.band}</b>
          {bandSaid(pt, receipt).slice(pt.band.length)}
        </p>
      ) : playing ? (
        <p className="band muted" data-testid="band">Novice and average AI runners are playing it now, for the difficulty…</p>
      ) : null}
      {pt && report?.times && <p className="times">{timesLine(report.times)}</p>}
      <h4>What the AI runners revealed</h4>
      {children}
      {report && report.fails.length > 0 && (
        <div data-testid="fails">
          <p>Where runs went wrong:</p>
          <ul>
            {report.fails.map((f) => (
              <li key={`${f.x},${f.z}`}>{failLine(f, report.runs)}</li>
            ))}
          </ul>
        </div>
      )}
      {report?.fights && (
        <p data-testid="fights">
          Fights: {report.fights.spots.map((f) => fightLine(f)).join("; ")} <span className="muted">({fightLine(report.fights)} in all)</span>
        </p>
      )}
      {report && report.pace.length > 0 && (
        <p data-testid="pace">
          Pacing <span className="muted">(median first times)</span>: {paceLine(report.pace, report.runs)}
        </p>
      )}
    </div>
  );
}
