// The playtest in the receipt: how hard the world is (novices, average players and experts, k of n
// each), then what every AI run of every level revealed about it: where the time went (with the
// routes and the heat map over the ground), where runs went wrong and why, where the fights were,
// and when runners reached each step of the win. Every number comes from the proof's labels.
import type { ReactNode } from "react";
import type { Receipt, Revealed as Report } from "@ghostrun/proof/light";
import { bandMethod, bandSaid, failLine, fightLineIn, paceLine, timesLine } from "@ghostrun/proof/light";
import { t } from "../i18n";
import { words } from "../i18n/words";
import "./revealed.css";

export function Revealed({ receipt, report, playing, children }: { receipt: Receipt; report: Report | null; playing?: boolean | undefined; children?: ReactNode }) {
  const pt = receipt.playtest;
  return (
    <div className="revealed" data-testid="revealed">
      {pt ? (
        <p className={`band band-${pt.band.toLowerCase().replace(/\s+/g, "-")}`} data-testid="band" title={bandMethod(pt, words)}>
          {t("Difficulty:")} <b>{t(pt.band)}</b>
          {bandSaid(pt, receipt, words).slice(t(pt.band).length)}
        </p>
      ) : playing ? (
        <p className="band muted" data-testid="band">{t("Novice and average AI runners are playing it now, for the difficulty…")}</p>
      ) : null}
      {pt && report?.times && <p className="times">{timesLine(report.times, words)}</p>}
      <h4>{t("What the AI runners revealed")}</h4>
      {children}
      {report && report.fails.length > 0 && (
        <div data-testid="fails">
          <p>{t("Where runs went wrong:")}</p>
          <ul>
            {report.fails.map((f, i) => (
              <li key={i}>{failLine(f, report.runs, words)}</li>
            ))}
          </ul>
        </div>
      )}
      {report?.fights && (
        <p data-testid="fights">
          {t("Fights:")} {report.fights.spots.map((f) => fightLineIn(f, words)).join("; ")} <span className="muted">({t("{what} in all", { what: fightLineIn(report.fights, words) })})</span>
        </p>
      )}
      {report && report.pace.length > 0 && (
        <p data-testid="pace">
          {t("Pacing")} <span className="muted">({t("median first times")})</span>: {paceLine(report.pace, report.runs, words)}
        </p>
      )}
    </div>
  );
}
