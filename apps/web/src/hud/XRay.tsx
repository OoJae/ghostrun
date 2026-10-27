// Logic X-ray (X): the world's logic in triggers, states and rules, one WHEN / IF / THEN sentence
// per rule with its forced-state proof mark, plus every verb and what it does. Hovering a tile
// that names a thing lights it up in the 3D view.
import type { Chip } from "@ghostrun/proof";
import type { Rule, WorldBundle } from "@ghostrun/ir";
import { verb } from "@ghostrun/kits";

const WHEN: Record<string, string> = {
  enter: "enters", exit: "leaves", pickup: "is picked up by", drop: "is dropped by", touch: "touches", hit: "is hit by",
  state_is: "becomes", score_gte: "reaches", timer_end: "runs out", every: "every",
};
const MARK: Record<string, string> = { verified: "✓", played: "✓", modelled: "~", not_checkable: "–", counterexample: "✗" };

function Tile({ id, b, onFocus, kind = "thing" }: { id: string; b: WorldBundle; onFocus(id: string | null): void; kind?: "thing" | "word" | "value" }) {
  if (kind !== "thing" || !id) return <span className={`tile ${kind}`}>{id}</span>;
  const e = b.entities.find((x) => x.id === id);
  const label = id === "player" ? "player" : id.startsWith("team:") ? id.slice(5) + " team" : e?.noun || id;
  return (
    <span className={`tile thing${e || id === "player" ? " live" : ""}`} title={id} onMouseEnter={() => onFocus(e || id === "player" ? id : null)} onMouseLeave={() => onFocus(null)}>
      {label}
    </span>
  );
}

function Sentence({ r, b, chip, onFocus }: { r: Rule; b: WorldBundle; chip: Chip | undefined; onFocus(id: string | null): void }) {
  const w = r.when;
  const T = (id: string) => <Tile id={id} b={b} onFocus={onFocus} />;
  const V = (v: string) => <Tile id={v} b={b} onFocus={onFocus} kind="value" />;
  const W = (v: string) => <Tile id={v} b={b} onFocus={onFocus} kind="word" />;
  return (
    <li className={`sentence ${chip?.status ?? "none"}`}>
      <span className="proofmark" title={chip ? `${chip.status}: ${chip.text}` : "no forced-state test"}>{chip ? MARK[chip.status] : "·"}</span>
      <span className="kw when">WHEN</span>
      {w.t === "every" ? (
        <>{W("every")}{V(`${w.n} s`)}</>
      ) : w.t === "score_gte" ? (
        <>{T(w.a)}{W("reaches")}{V(String(w.n))}</>
      ) : w.t === "state_is" ? (
        <>{T(w.a)}{W("becomes")}{V(w.s)}</>
      ) : w.t === "timer_end" ? (
        <>{W("the timer")}{W("runs out")}</>
      ) : (
        <>{T(w.a || "anything")}{W(WHEN[w.t] ?? w.t)}{w.b ? T(w.b) : W("anything")}</>
      )}
      {r.if.length > 0 && (
        <>
          <span className="kw if">IF</span>
          {r.if.map((c, i) => (
            <span key={i} className="cond">
              {T(c.l.split(".")[0]!)}
              {W(`${c.l.split(".").slice(1).join(" ")} ${c.op === "eq" ? "=" : c.op}`)}
              {V(String(c.r))}
            </span>
          ))}
        </>
      )}
      <span className="kw then">THEN</span>
      {r.then.map((e, i) => (
        <span key={i} className="effect">
          {e.e === "score" ? (
            <>{W(`+${e.n || 1}`)}{T(e.target)}</>
          ) : e.e === "win" || e.e === "lose" ? (
            W(e.e === "win" ? "you win" : "you lose")
          ) : e.e === "set_state" ? (
            <>{T(e.target)}{W("becomes")}{V(String(e.v))}</>
          ) : e.e === "emit" ? (
            <>{W("✨")}{V(e.fx)}</>
          ) : e.e === "teleport" ? (
            <>{W("send")}{T(e.target)}{W("to")}{T(String(e.v))}</>
          ) : (
            <>{W(e.e === "destroy" ? "remove" : e.e)}{T(e.target)}</>
          )}
        </span>
      ))}
      {r.once && <span className="once">once</span>}
    </li>
  );
}

export function XRay({ bundle, chips, onFocus, onClose }: { bundle: WorldBundle; chips: Chip[]; onFocus(id: string | null): void; onClose(): void }) {
  const kitVerbs = bundle.verbs.filter((v) => v.on !== "player" || v.verb === "puzzle.timer");
  return (
    <div className="glass xray" role="dialog" aria-label="Logic X-ray" data-testid="xray">
      <div className="xray-head">
        <strong>Logic X-ray</strong>
        <span className="muted">{bundle.rules.length} rules · {kitVerbs.length} verbs · triggers, states and rules</span>
        <button type="button" onClick={onClose} aria-label="close">×</button>
      </div>
      <ul className="rules">
        {[...bundle.rules]
          .sort((a, b) => (a.then.some((e) => e.e === "win" || e.e === "lose") ? 1 : 0) - (b.then.some((e) => e.e === "win" || e.e === "lose") ? 1 : 0))
          .map((r) => (
            <Sentence key={r.id} r={r} b={bundle} chip={chips.find((c) => c.id === `T2:${r.id}`)} onFocus={onFocus} />
          ))}
      </ul>
      {kitVerbs.length > 0 && (
        <>
          <div className="xray-sub">Verbs</div>
          <ul className="verbs">
            {kitVerbs.map((v) => (
              <li key={v.id}>
                <Tile id={v.on} b={bundle} onFocus={onFocus} />
                <span className="verb-id">{v.verb}</span>
                <span className="muted">{verb(v.verb)?.line.split(";")[0] ?? ""}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
