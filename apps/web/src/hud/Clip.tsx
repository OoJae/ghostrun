// The run's clip on the result card: a small preview (muted, looping) and Save clip; and a clean
// take, which replays this run exactly with the HUD hidden and saves the replay (demo footage).
import { num, t } from "../i18n";
import "./clip.css";

export interface ClipCard {
  /** Being cut from the recording, ready, or nothing was recorded. */
  status: "cutting" | "ready" | "none";
  url: string | null;
  seconds: number;
  onSave: () => void;
  onTake?: (() => void) | undefined;
}

export function ClipPanel({ clip }: { clip: ClipCard }) {
  if (clip.status === "none") return null;
  const s = Math.round(clip.seconds * 10) / 10;
  return (
    <div className="result-clip" data-testid="clip">
      {clip.url ? <video src={clip.url} muted loop autoPlay playsInline aria-label={t("This run's clip")} data-testid="clip-preview" /> : <span className="clip-wait">{t("cutting the clip…")}</span>}
      <div className="clip-actions">
        <button type="button" onClick={clip.onSave} disabled={!clip.url} data-testid="save-clip" title={t("The last seconds of this run, ending where it ended, as a video file")}>
          {t("Save clip")}{clip.url && <span className="muted"> · {num(s)} s</span>}
        </button>
        {clip.onTake && (
          <button type="button" onClick={clip.onTake} data-testid="clip-take" title={t("Replays this run exactly from its inputs with the HUD hidden, and saves the replay as a video (any key calls it off)")}>
            {t("Clean replay")}
          </button>
        )}
      </div>
    </div>
  );
}
