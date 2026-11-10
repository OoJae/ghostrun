// A world you fly, swim or float in: the jetpack's fuel while you fly, your breath while your head
// is under water (read from the sim ten times a second, like the hit points), and what Space and C
// do here. Nothing at all in an ordinary world.
import { useEffect, useMemo, useState, type RefObject } from "react";
import type { WorldBundle } from "@ghostrun/ir";
import type { Engine } from "../engine";
import { t } from "../i18n";
import { meters, movesOf, upDown, type LiveMoves } from "../moves";

export function MovesHud({ engine, active, bundle, touch }: { engine: RefObject<Engine | null>; active: boolean; bundle: WorldBundle | null; touch: boolean }) {
  const world = useMemo(() => movesOf(bundle), [bundle]);
  const [live, setLive] = useState<LiveMoves | null>(null);
  useEffect(() => {
    if (!active || !world) return void setLive(null);
    const read = () => {
      const m = engine.current?.rapierSim?.sim.moves("player") ?? null;
      setLive((x) => (x && m && x.mode === m.mode && x.fuel === m.fuel && x.breath === m.breath && x.fuelMax === m.fuelMax && x.breathMax === m.breathMax ? x : m));
    };
    read();
    const id = setInterval(read, 100);
    return () => clearInterval(id);
  }, [engine, active, world]);
  if (!active || !world) return null;
  const bars = meters(live);
  const keys = upDown(world);
  return (
    <div className="moves" data-testid="moves">
      {bars.fuel !== undefined && <Meter id="fuel" label={t("Fuel")} aria={t("Jetpack fuel left")} k={bars.fuel} colour="#ffb23d" />}
      {bars.breath !== undefined && <Meter id="breath" label={t("Breath")} aria={t("Breath left under water")} k={bars.breath} colour="#3bb8ff" />}
      {!touch && (
        <div className="glass moves-hint" data-testid="moves-hint">
          <kbd>{t("Space")}</kbd> {t(keys.up)}
          <span className="sep">·</span>
          <kbd>C</kbd> {t(keys.down)}
        </div>
      )}
    </div>
  );
}

function Meter({ id, label, aria, k, colour }: { id: string; label: string; aria: string; k: number; colour: string }) {
  const low = k < 0.25;
  return (
    <div className="glass meter" data-testid={id} role="meter" aria-label={aria} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(k * 100)}>
      <span>{label}</span>
      <span className="meter-track">
        <span style={{ display: "block", width: `${k * 100}%`, height: "100%", background: low ? "#ff3b5c" : colour, transition: "width 120ms linear" }} />
      </span>
    </div>
  );
}
