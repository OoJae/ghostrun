// A race, at a glance: which lap you're on, where you stand among the racers, and how many gates of
// this lap are behind you. Shown only in a world with a track.
import { useEffect, useState, type RefObject } from "react";
import type { Engine } from "../engine";

interface Standing {
  lap: number;
  laps: number;
  place: number;
  racers: number;
  gate: number;
  gates: number;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

export function LapBoard({ engine, active }: { engine: RefObject<Engine | null>; active: boolean }) {
  const [s, setS] = useState<Standing | null>(null);
  useEffect(() => {
    if (!active) return void setS(null);
    const read = () => {
      const sim = engine.current?.rapierSim?.sim;
      const race = sim?.raceOf("player");
      const track = sim?.verbs.find((v) => v.plugin.id === "racing.track");
      if (!sim || !race || !track) return setS(null);
      const laps = Math.max(1, Number(track.bound.params.laps) || 1);
      const order = sim.standings();
      const next: Standing = { lap: Math.min(laps, race.laps + 1), laps, place: order.indexOf("player") + 1, racers: order.length, gate: race.passed, gates: race.gates };
      setS((x) => (x && x.lap === next.lap && x.laps === next.laps && x.place === next.place && x.racers === next.racers && x.gate === next.gate && x.gates === next.gates ? x : next));
    };
    read();
    const t = setInterval(read, 150);
    return () => clearInterval(t);
  }, [engine, active]);
  if (!s) return null;
  return (
    <div className="glass" data-testid="lap" aria-label={`Lap ${s.lap} of ${s.laps}, ${ordinal(s.place)} of ${s.racers}`} style={{ position: "absolute", top: 112, left: "50%", transform: "translateX(-50%)", padding: "6px 14px", display: "flex", alignItems: "baseline", gap: 14, fontWeight: 600, fontSize: 13, fontVariantNumeric: "tabular-nums" }}>
      <span>
        LAP <b style={{ fontSize: 18 }}>{s.lap}</b>/{s.laps}
      </span>
      {s.racers > 1 && (
        <span style={{ color: s.place === 1 ? "#ffd23d" : undefined }}>
          <b style={{ fontSize: 18 }}>{ordinal(s.place)}</b>/{s.racers}
        </span>
      )}
      <span style={{ display: "flex", gap: 4, alignSelf: "center" }} aria-hidden="true" title="gates this lap">
        {Array.from({ length: s.gates }, (_, i) => (
          <span key={i} style={{ width: 8, height: 8, borderRadius: 2, background: i < s.gate ? "#ffb02e" : "rgba(255,255,255,0.18)" }} />
        ))}
      </span>
    </div>
  );
}
