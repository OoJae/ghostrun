// The player's hit points, under the score: shown only in a world where the player has them.
import { useEffect, useState, type RefObject } from "react";
import type { Engine } from "../engine";

export function HealthBar({ engine, active }: { engine: RefObject<Engine | null>; active: boolean }) {
  const [hp, setHp] = useState<{ now: number; max: number } | null>(null);
  useEffect(() => {
    if (!active) return void setHp(null);
    const read = () => {
      const sim = engine.current?.rapierSim?.sim;
      const max = sim?.maxHp("player") ?? null;
      setHp((x) => {
        const now = sim?.hp("player") ?? 0;
        if (max === null) return null;
        return x && x.now === now && x.max === max ? x : { now, max };
      });
    };
    read();
    const t = setInterval(read, 100);
    return () => clearInterval(t);
  }, [engine, active]);
  if (!hp) return null;
  const k = Math.max(0, Math.min(1, hp.now / hp.max));
  const hue = k > 0.5 ? "#3dffa8" : k > 0.25 ? "#ffd23d" : "#ff3b5c";
  return (
    <div className="glass" data-testid="hp" role="meter" aria-label="Your hit points" aria-valuemin={0} aria-valuemax={hp.max} aria-valuenow={hp.now} style={{ position: "absolute", top: 112, left: "50%", transform: "translateX(-50%)", padding: "6px 12px", display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: 13 }}>
      <span>HP</span>
      <span style={{ width: 140, height: 8, borderRadius: 4, background: "rgba(255,255,255,0.15)", overflow: "hidden" }}>
        <span style={{ display: "block", width: `${k * 100}%`, height: "100%", background: hue, transition: "width 120ms linear" }} />
      </span>
      <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 28, textAlign: "right" }}>{Math.ceil(hp.now)}</span>
    </div>
  );
}
