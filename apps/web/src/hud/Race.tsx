// Racing a ghost, in one line: who you race and their time, and how far ahead or behind you are
// right now ("AI 0:41.4 · you −1.2 s"), with the ghost's toggle. The split is read a few times a
// second from the live simulation (race.ts says how "the same point of the win" is found).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { GhostTrack, RaceTracker, raceClock, split, type Rival } from "../race";
import type { RapierSim } from "../sim/rapier";
import type { RunResult } from "./Result";
import "./race.css";

export function RaceChip({ rival, getSim, secrets, result, hidden, onToggle, onBoard }: { rival: Rival; getSim: () => RapierSim | null; secrets: ReadonlySet<string>; result: RunResult | null; hidden: boolean; onToggle: () => void; onBoard?: (() => void) | undefined }) {
  /** undefined: nothing to compare with yet (or the stub simulation plays); null: off the ghost's route. */
  const [delta, setDelta] = useState<number | null | undefined>(undefined);
  const tracker = useRef<{ sim: RapierSim; ghost: Rival["ghost"]; t: RaceTracker } | null>(null);
  useEffect(() => {
    const read = () => {
      const s = getSim();
      if (!s) return setDelta(undefined);
      // a new run (Play again) or a new rival starts the comparison over
      if (tracker.current?.sim !== s || tracker.current.ghost !== rival.ghost) tracker.current = { sim: s, ghost: rival.ghost, t: new RaceTracker(new GhostTrack(rival.ghost), secrets) };
      setDelta(tracker.current.t.delta(s.sim));
    };
    read();
    const t = setInterval(read, 250);
    return () => clearInterval(t);
  }, [rival, getSim, secrets]);

  const theirs = rival.ghost.ticks;
  let you: ReactNode;
  if (result?.k === "win") {
    const d = (result.tick - theirs) / 60;
    you = <span className={d <= 0 ? "ahead" : "behind"} data-testid="race-final">you {raceClock(result.tick)} ({split(d)})</span>;
  } else if (result?.k === "lose") {
    you = <span className="behind">you didn't finish</span>;
  } else if (delta === undefined) {
    you = null;
  } else if (delta === null) {
    you = <span className="muted" title="Too far from where the ghost was at your stage of the win to compare">you: off its route</span>;
  } else {
    you = <span className={delta <= 0 ? "ahead" : "behind"} title={delta <= 0 ? "Ahead of the ghost at this point of the win" : "Behind the ghost at this point of the win"} data-testid="race-delta">you {split(delta)}</span>;
  }
  return (
    <div className={`glass race ${rival.kind}`} data-testid="race">
      <span className="race-dot" aria-hidden="true" />
      <span title={rival.how} data-testid="race-rival">
        {rival.name} {raceClock(theirs)}
      </span>
      {you && <span className="sep">·</span>}
      {you}
      <button type="button" onClick={onToggle} aria-pressed={!hidden} title="Show or hide the ghost (H)" data-testid="ghost-toggle">
        {hidden ? "show ghost" : "hide ghost"}
      </button>
      {onBoard && (
        <button type="button" onClick={onBoard} data-testid="race-board">
          best times
        </button>
      )}
    </div>
  );
}
