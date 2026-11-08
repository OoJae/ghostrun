import type { Intent } from "../pipeline";
import { t, tn } from "../i18n";
import "./picture.css";

/** A count of a role, in the HUD's language (the roles are a closed set). */
const roleCount = (role: string, n: number): string =>
  ({
    guard: () => tn(n, "{n} guard", "{n} guards"), merchant: () => tn(n, "{n} merchant", "{n} merchants"), guide: () => tn(n, "{n} guide", "{n} guides"),
    rival: () => tn(n, "{n} rival", "{n} rivals"), teammate: () => tn(n, "{n} teammate", "{n} teammates"), creature: () => tn(n, "{n} creature", "{n} creatures"),
    citizen: () => tn(n, "{n} citizen", "{n} citizens"),
  } as Record<string, () => string>)[role]?.() ?? `${n} ${role}`;

function castLine(cast: Intent["cast"]): string {
  const counts = new Map<string, number>();
  for (const k of cast) counts.set(k.role, (counts.get(k.role) ?? 0) + 1);
  return [...counts].map(([role, n]) => roleCount(role, n)).join(" · ") || t("none");
}

/** A world built from a picture says so plainly: inspired by it (its place and the things in it), never rebuilt from it. */
export interface Inspired {
  setting: string;
  objects: string[];
}

export function IntentCard({ intent, specHash, note, inspired }: { intent: Intent; specHash: string | undefined; note?: string | null; inspired?: Inspired | null }) {
  return (
    <aside className="glass intent" data-testid="intent-card">
      <header>
        <span className="eyebrow">{t("Intent")}</span>
        <span className="mode">{t(intent.mode)}</span>
      </header>
      {inspired && (
        <p className="inspired" data-testid="inspired-note" title={t("Your image suggested the place, the mood, the colours and the things in it; the world was written from those words, so it is inspired by the image, not a copy of it")}>
          {t("Inspired by your image:")} {inspired.setting}
          {inspired.objects.length > 0 && <span className="dim"> · {inspired.objects.join(", ")}</span>}
        </p>
      )}
      {note && (
        <p className="subst" data-testid="subst-note" title={t("The prompt asked for something no world can do yet; this is what you get instead")}>
          {note}
        </p>
      )}
      {intent.live && (
        <dl className="card10">
          <dt>{t("You are")}</dt>
          <dd>{intent.live.role}</dd>
          <dt>{t("Goal")}</dt>
          <dd>{intent.live.goal}</dd>
          {intent.live.fail && (
            <>
              <dt>{t("Fail")}</dt>
              <dd>{intent.live.fail}</dd>
            </>
          )}
          <dt>{t("Cast")}</dt>
          <dd>{castLine(intent.cast)}</dd>
        </dl>
      )}
      <dl className={intent.live ? "tech" : ""}>
        <dt>{t("Pack")}</dt>
        <dd>
          {intent.pack}
          {intent.sub.length > 0 && <span className="dim"> + {intent.sub.join(", ")}</span>}
        </dd>
        <dt>{t("Zones")}</dt>
        <dd>
          {intent.zones.length}
          <span className="dim"> · {intent.zones.map((z) => z.name).join(" · ")}</span>
        </dd>
        <dt>{t("Rules")}</dt>
        <dd>{intent.rules}</dd>
        <dt>{t("Cast")}</dt>
        <dd>{castLine(intent.cast)}</dd>
        <dt>{t("Jumps")}</dt>
        <dd>{intent.jumpsMax > 1 ? t("double jump (×{n})", { n: intent.jumpsMax }) : tn(intent.jumpsMax, "{n} jump", "{n} jumps")}</dd>
        <dt>{t("Look")}</dt>
        <dd>
          {intent.look} <span className="dim">· {intent.weather}</span>
        </dd>
      </dl>
      {intent.headline && (
        <div className="headline">
          <span className="eyebrow">{t("Headline expectation")}</span>
          <p>{intent.headline}</p>
        </div>
      )}
      <footer className="dim" title={specHash}>
        spec {specHash ? `${specHash.slice(0, 12)}…` : t("hashing…")}
      </footer>
    </aside>
  );
}
