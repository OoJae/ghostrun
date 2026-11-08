import { t } from "../i18n";

export function ProofBadge() {
  return (
    <div className="glass proof" data-testid="proof-badge" title={t("AI runners have not proven this world yet")}>
      <span className="dot" aria-hidden="true" />
      {t("proof: pending")}
    </div>
  );
}

export function KeyHint({ visible, sound = false }: { visible: boolean; sound?: boolean }) {
  return (
    <div className={`glass keyhint${visible ? "" : " gone"}`} aria-hidden={!visible} data-testid="key-hint">
      <kbd>WASD</kbd>
      <span className="sep">·</span>
      <kbd>{t("Space")}</kbd>
      <span className="sep">·</span>
      <kbd>F</kbd>
      <span>{t("use")}</span>
      <span className="sep">·</span>
      <kbd>P</kbd>
      <span>{t("receipt")}</span>
      <span className="sep">·</span>
      <kbd>X</kbd>
      <span>{t("logic")}</span>
      <span className="sep">·</span>
      <kbd>T</kbd>
      <span>{t("talk")}</span>
      <span className="sep">·</span>
      <kbd>G</kbd>
      <span>{t("gallery")}</span>
      <span className="sep">·</span>
      {sound && (
        <>
          <kbd>M</kbd>
          <span>{t("sound")}</span>
          <span className="sep">·</span>
        </>
      )}
      <kbd>H</kbd>
      <span>{t("ghost")}</span>
      <span className="sep">·</span>
      <span>{t("drag to orbit")}</span>
    </div>
  );
}
