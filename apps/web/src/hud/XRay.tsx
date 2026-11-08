// Logic X-ray (X): the world's logic in triggers, states and rules, one WHEN / IF / THEN sentence
// per rule with its forced-state proof mark, plus every verb and what it does. Hovering a tile
// that names a thing lights it up in the 3D view. The sentences are @ghostrun/ir's (logic.ts), so
// the MCP tools say the same rules in the same words.
import type { Chip } from "@ghostrun/proof";
import { logicOf, ruleTiles, thingLabel, type Rule, type Tile as Said, type WorldBundle } from "@ghostrun/ir";
import { verb } from "@ghostrun/kits";
import { t, tn } from "../i18n";

const MARK: Record<string, string> = { verified: "✓", played: "✓", modelled: "~", not_checkable: "–", counterexample: "✗" };

function Tile({ id, b, onFocus, kind = "thing" }: { id: string; b: WorldBundle; onFocus(id: string | null): void; kind?: "thing" | "word" | "value" }) {
  if (kind !== "thing" || !id) return <span className={`tile ${kind}`}>{id}</span>;
  const live = id === "player" || b.entities.some((x) => x.id === id);
  return (
    <span className={`tile thing${live ? " live" : ""}`} title={id} onMouseEnter={() => onFocus(live ? id : null)} onMouseLeave={() => onFocus(null)}>
      {thingLabel(id, b)}
    </span>
  );
}

function Sentence({ r, b, chip, onFocus }: { r: Rule; b: WorldBundle; chip: Chip | undefined; onFocus(id: string | null): void }) {
  const s = ruleTiles(r);
  const tiles = (ts: Said[]) => ts.map((t, i) => <Tile key={i} id={t.id} kind={t.kind} b={b} onFocus={onFocus} />);
  return (
    <li className={`sentence ${chip?.status ?? "none"}`}>
      <span className="proofmark" title={chip ? `${chip.status}: ${chip.text}` : "no forced-state test"}>{chip ? MARK[chip.status] : "·"}</span>
      <span className="kw when">{t("WHEN")}</span>
      {tiles(s.when)}
      {s.conds.length > 0 && (
        <>
          <span className="kw if">{t("IF")}</span>
          {s.conds.map((c, i) => (
            <span key={i} className="cond">
              {tiles(c)}
            </span>
          ))}
        </>
      )}
      <span className="kw then">{t("THEN")}</span>
      {s.effects.map((e, i) => (
        <span key={i} className="effect">
          {tiles(e)}
        </span>
      ))}
      {s.once && <span className="once">{t("once")}</span>}
    </li>
  );
}

export function XRay({ bundle, chips, onFocus, onClose }: { bundle: WorldBundle; chips: Chip[]; onFocus(id: string | null): void; onClose(): void }) {
  // secrets read as one line, not five copies of "touch it, it sparkles" (logic.json keeps every rule)
  const { rules: shown, secrets: secretRules, verbs: kitVerbs, secretNoun } = logicOf(bundle);
  const secretsOk = secretRules.length > 0 && secretRules.every((r) => chips.find((c) => c.id === `T2:${r.id}`)?.status === "verified");
  return (
    <div className="glass xray" role="dialog" aria-label={t("Logic X-ray")} data-testid="xray">
      <div className="xray-head">
        <strong>{t("Logic X-ray")}</strong>
        <span className="muted">{tn(shown.length, "{n} rule", "{n} rules")}{secretRules.length ? ` + ${tn(secretRules.length, "{n} secret", "{n} secrets")}` : ""} · {tn(kitVerbs.length, "{n} verb", "{n} verbs")} · {t("triggers, states and rules")}</span>
        <button type="button" onClick={onClose} aria-label={t("close")}>×</button>
      </div>
      <ul className="rules">
        {shown.map((r) => (
          <Sentence key={r.id} r={r} b={bundle} chip={chips.find((c) => c.id === `T2:${r.id}`)} onFocus={onFocus} />
        ))}
      </ul>
      {secretRules.length > 0 && (
        <p className="xray-secrets" data-testid="xray-secrets">
          ★ {t("{n} secret {noun}s: WHEN you touch one THEN it sparkles (once). They count apart from the win.", { n: secretRules.length, noun: secretNoun })}
          <span className={secretsOk ? "proofmark verified" : "proofmark"}> {secretsOk ? t("✓ force-tested") : "…"}</span>
        </p>
      )}
      {kitVerbs.length > 0 && (
        <>
          <div className="xray-sub">{t("Verbs")}</div>
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
