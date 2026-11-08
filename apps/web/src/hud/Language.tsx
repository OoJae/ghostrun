// The language chip: the HUD in another language, remembered on this device. Every language but
// English says, in its own words and in English, that it was machine-translated and nobody has
// reviewed it yet.
import { LANGUAGE_NAMES, LOCALES, t, type Locale } from "../i18n";

export function LanguageChip({ lang, onPick }: { lang: Locale; onPick: (l: Locale) => void }) {
  return (
    <div className="glass langchip" data-testid="lang-chip">
      <select value={lang} aria-label={t("Language")} title={t("Language")} data-testid="lang-select" onChange={(e) => onPick(e.currentTarget.value as Locale)} onKeyDown={(e) => e.stopPropagation()}>
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LANGUAGE_NAMES[l]}
          </option>
        ))}
      </select>
      {lang !== "en" && (
        <span className="langnote" data-testid="lang-note">
          {t("machine-translated, unreviewed")}
          <span lang="en"> (machine-translated, unreviewed)</span>
        </span>
      )}
    </div>
  );
}
