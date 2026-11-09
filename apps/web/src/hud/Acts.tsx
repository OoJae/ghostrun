// What talking has done, on screen: the coins you hold, a guard who sees you (or looks away, and for
// how long), a yes-or-no for an act that spends money or books a time, and each booking made, with
// its calendar file. Read off the simulation, never decided here.
import { useEffect, useState, type RefObject } from "react";
import type { WorldBundle } from "@ghostrun/ir";
import type { Booking, SpeechAct } from "@ghostrun/sim";
import { download, fileName, icsFor, slotWords, today } from "../acts";
import type { Engine } from "../engine";
import { probe } from "../probe";

export interface Asking {
  npc: string;
  name: string;
  act: SpeechAct;
}

interface Seen {
  purse: [string, number][];
  seeing: string[];
  away: [string, number][];
  bookings: Booking[];
}

const same = (a: Seen, b: Seen) => JSON.stringify(a) === JSON.stringify(b);

export function ActsHud({ engine, active, bundle, asking, onYes, onNo }: { engine: RefObject<Engine | null>; active: boolean; bundle: WorldBundle | null; asking: Asking | null; onYes: () => void; onNo: () => void }) {
  const [seen, setSeen] = useState<Seen>({ purse: [], seeing: [], away: [], bookings: [] });
  useEffect(() => {
    if (!active) return void setSeen({ purse: [], seeing: [], away: [], bookings: [] });
    const read = () => {
      const r = engine.current?.rapierSim;
      const sim = r?.sim;
      if (!sim) return;
      const next: Seen = {
        purse: sim.words.map((w) => [w, sim.purse("player", w)]),
        seeing: sim.seeing(),
        away: [...sim.npcs.keys()].filter((id) => sim.watches(id) && sim.blind(id)).map((id) => [id, Math.ceil(sim.stateLeft(id) / 60)]),
        bookings: [...sim.bookings],
      };
      // for the browser tests: the purse, who sees you, who looks away, the bookings and the acts logged
      probe().acts = { purse: Object.fromEntries(next.purse), seeing: next.seeing, away: Object.fromEntries(next.away), bookings: next.bookings.length, log: r.minds.filter((m) => m.option.startsWith("act:")).map((m) => m.option) };
      setSeen((x) => (same(x, next) ? x : next));
    };
    read();
    const t = setInterval(read, 200);
    return () => clearInterval(t);
  }, [engine, active]);
  if (!bundle) return null;
  const name = (id: string) => bundle.entities.find((e) => e.id === id)?.noun || id.replace(/_/g, " ");
  const { tz } = today();
  const lang = bundle.lang || "en";
  const what = (a: SpeechAct) => (a.act === "book" ? `Book: ${bundle.rules.find((r) => r.when.t === "spoken" && r.when.a === a.to && r.when.act === "book")?.then.find((e) => e.e === "book_slot")?.v || "a booking"}, ${slotWords(a.slot, tz, lang)}?` : `${a.act === "buy" ? "Buy" : "Pay"} ${a.n ? `${a.n} ` : ""}${a.what.replace(/_/g, " ")}?`);
  return (
    <div className="acts" style={{ position: "absolute", top: 150, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, zIndex: 5 }}>
      {seen.purse.length > 0 && (
        <div className="glass" data-testid="purse" style={{ padding: "4px 10px", fontWeight: 600, fontSize: 13 }}>
          {seen.purse.map(([w, n]) => `${n} ${w}`).join(" · ")}
        </div>
      )}
      {seen.seeing.map((id) => (
        <div key={id} className="glass" data-testid="seen" role="status" style={{ padding: "4px 10px", fontSize: 13, color: "#ffd23d" }}>
          The {name(id)} sees you
        </div>
      ))}
      {seen.away.map(([id, s]) => (
        <div key={id} className="glass" data-testid="looking-away" role="status" style={{ padding: "4px 10px", fontSize: 13 }}>
          The {name(id)} looks away{s > 0 ? ` · ${s} s` : ""}
        </div>
      ))}
      {asking && (
        <div className="glass" data-testid="act-confirm" role="dialog" aria-label={`${asking.name} asks`} style={{ padding: "8px 12px", display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          <span>{what(asking.act)}</span>
          <button type="button" data-testid="act-yes" onClick={onYes}>
            {asking.act.act === "book" ? "Book it" : "Yes"}
          </button>
          <button type="button" data-testid="act-no" onClick={onNo}>
            Not now
          </button>
        </div>
      )}
      {seen.bookings.map((b, i) => (
        <div key={`${b.tick}-${i}`} className="glass" data-testid="booked" role="status" style={{ padding: "8px 12px", display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          <span>
            Booked with the {name(b.with)}: {b.what}, {slotWords(b.slot, tz, lang)} ({tz})
          </span>
          <button
            type="button"
            data-testid="ics"
            onClick={() => {
              const text = icsFor(b, tz, name(b.with));
              if (text) download(text, fileName(b.what));
            }}
          >
            Add to calendar (.ics)
          </button>
        </div>
      ))}
    </div>
  );
}
