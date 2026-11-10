// The command wheel: your teammates' four orders on keys 1–4 (or a tap), what each teammate is doing
// now, and the last order given. Read off the simulation (the option each plays); an order goes in
// as a logged command act (team.ts), never decided here.
import { useEffect, useState, type RefObject } from "react";
import type { Engine } from "../engine";
import { probe } from "../probe";
import { COMMAND_LABEL, COMMANDS, commandOf, DOING, type Command, type Commandable } from "../team";
import { t } from "../i18n";

interface Props {
  engine: RefObject<Engine | null>;
  active: boolean;
  /** Stepped aside (the receipt is open over the same corner); orders by key still work. */
  hidden?: boolean;
  mates: readonly Commandable[];
  /** What the game is about ("glowing orb"), for "Get the …". */
  thing: string;
  name: (npc: string) => string;
  last: Command | null;
  onCommand: (c: Command) => void;
}

export function TeamWheel({ engine, active, hidden, mates, thing, name, last, onCommand }: Props) {
  const [doing, setDoing] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!active || !mates.length) return void setDoing({});
    const read = () => {
      const r = engine.current?.rapierSim;
      if (!r) return;
      const next = Object.fromEntries(mates.map((m) => [m.npc, r.optionOf(m.npc)]));
      probe().team = { mates: next, last, orders: r.minds.filter((m) => m.option.startsWith("act:command:")).map((m) => m.option) };
      setDoing((x) => (JSON.stringify(x) === JSON.stringify(next) ? x : next));
    };
    read();
    const id = setInterval(read, 200);
    return () => clearInterval(id);
  }, [engine, active, mates, last]);
  if (!active || hidden || !mates.length) return null;
  const takes = (c: Command) => mates.some((m) => m.options[c]);
  return (
    <div className="glass teamwheel" data-testid="team" role="group" aria-label={t("Team orders")}>
      <span className="eyebrow">{t("Team orders")}</span>
      <div className="team-orders">
        {COMMANDS.map((c, i) => (
          <button
            type="button"
            key={c}
            data-testid={`order-${c}`}
            className={last === c ? "on" : ""}
            disabled={!takes(c)}
            title={takes(c) ? t("Press {key}", { key: i + 1 }) : t("No teammate's menu has this")}
            onClick={(e) => (e.currentTarget.blur(), onCommand(c))}
          >
            <kbd>{i + 1}</kbd> {t(COMMAND_LABEL[c], { thing })}
          </button>
        ))}
      </div>
      <ul className="team-doing" data-testid="team-doing">
        {mates.map((m) => {
          const c = commandOf(m, doing[m.npc] ?? "");
          return (
            <li key={m.npc}>
              <b>{name(m.npc)}</b>: {c ? t(DOING[c], { thing }) : (doing[m.npc] ?? "").replace(/^.*\./, "").replace(/_/g, " ")}
            </li>
          );
        })}
      </ul>
      <p className="muted team-note">{t("Orders pick from each teammate's own menu; say them too (T).")}</p>
    </div>
  );
}
