import { Fragment, useState, type ReactNode } from "react";
import { FENG_SHUI_RULES, FENG_SHUI_SCHOOL_SOURCE, type FengShuiVerdict } from "@ghostrun/layout";
import { fengShuiFix, fengShuiHead, fengShuiWhy } from "@ghostrun/proof/light";
import { t } from "../i18n";
import { words } from "../i18n/words";
import type { FengShuiView } from "../fengshui";

const RULES = new Map(FENG_SHUI_RULES.map((r) => [r.id, r]));
const MARK: Record<FengShuiVerdict, string> = { holds: "✓", fails: "✗", not_checkable: "–" };
// the receipt's own tones: green holds, red fails, faded can't be checked
const TONE: Record<FengShuiVerdict, string> = { holds: "verified", fails: "counterexample", not_checkable: "not_checkable" };

/** One named school's principles, checked on this world: each verdict with its reason, its fix and its source. */
export function FengShui({ view, noteAction }: { view: FengShuiView; /** A failed principle's Apply (its fix, re-proved on a copy first). */ noteAction?: ((key: string) => ReactNode) | undefined }) {
  const [open, setOpen] = useState(view.asked);
  const { section } = view;
  if (!open) {
    return (
      <p className="fengshui-ask">
        <button type="button" data-testid="fengshui-ask" onClick={() => setOpen(true)}>
          {t("Check its Feng Shui")}
        </button>
        <span className="muted"> ({t("{school}: {n} principles, each with its source", { school: t(section.school), n: section.findings.length })})</span>
      </p>
    );
  }
  const tone = !section.checked ? "not_checkable" : section.holds === section.checked ? "verified" : "counterexample";
  return (
    <section className="fengshui" data-testid="fengshui" aria-label={t("Feng Shui")}>
      <p className={`headline ${tone}`} data-testid="fengshui-head">
        <b>{fengShuiHead(section, words)}</b>
        <span className="method"> ({t("checked on the placed world: its rooms and doorways, where things stand and what they are named")})</span>
      </p>
      <ul>
        {section.findings.map((f) => {
          const rule = RULES.get(f.rule)!;
          return (
            <li key={f.rule} className={TONE[f.verdict]} data-testid={`fengshui-${f.rule}`}>
              {MARK[f.verdict]} <b title={`${rule.principle} ${t("Checked:")} ${rule.check}`}>{t(rule.name)}</b>: {fengShuiWhy(f, words)}.
              {f.fix && <span className="fix"> {t("Fix: {fix}.", { fix: fengShuiFix(f.fix, words) })}</span>}
              {f.fix && noteAction?.(`fengshui:${f.rule}`)}
              <span className="sources">
                {rule.sources.map((s, i) => (
                  <Fragment key={s.url}>
                    {i ? "; " : ` ${t("Source:")} `}
                    <a href={s.url} target="_blank" rel="noreferrer" title={`“${s.says}” (${s.where}, ${s.date})`}>
                      {s.by}, {s.title}
                    </a>
                  </Fragment>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="sources">
        {t("The {school}, the oldest branch of feng shui, reads the shape of a place and how qi flows through it", { school: t(section.school) })} (
        <a href={FENG_SHUI_SCHOOL_SOURCE.url} target="_blank" rel="noreferrer">
          {FENG_SHUI_SCHOOL_SOURCE.title}, {FENG_SHUI_SCHOOL_SOURCE.where}
        </a>
        ). {t("A design reading, not a claim about luck.")}
      </p>
    </section>
  );
}
