// Talking to an NPC (T near one): type a line, or hold the mic and say it. What you say fills the
// box as you speak and goes when you let go; the answer comes back out loud and as the subtitle.
// Where the browser has no speech recognition (Firefox, the Quest browser) the mic isn't shown.
import { useEffect, useRef, useState } from "react";
import { firstVoiceNote, speechApi, transcript, voiceError, type Recognition } from "./listen";
import { t } from "../i18n";
import "./voice.css";

export function TalkBox({ name, lang, onSay, onClose, onListen }: { name: string; lang: string; onSay: (text: string) => void; onClose: () => void; onListen?: () => void }) {
  const [said, setSaid] = useState("");
  const [on, setOn] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const Api = speechApi();
  // closed while listening (Escape, walking off): stop without sending half a sentence
  useEffect(
    () => () => {
      const r = rec.current;
      if (!r) return;
      r.onend = r.onresult = null;
      r.stop();
    },
    [],
  );

  const send = (text: string) => {
    if (text.trim()) onSay(text.trim().slice(0, 200));
    onClose();
  };

  const hold = () => {
    if (!Api || rec.current) return;
    onListen?.(); // the NPC stops talking, so the mic hears you and not them
    const first = firstVoiceNote();
    if (first) setNote(first);
    const r = new Api();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = true; // keeps listening through a pause until you let go
    let text = "";
    r.onresult = (e) => {
      text = transcript(e);
      setSaid(text);
    };
    r.onerror = (e) => setNote(voiceError(e.error, "talk"));
    r.onend = () => {
      rec.current = null;
      setOn(false);
      if (text) send(text);
    };
    rec.current = r;
    try {
      r.start();
      setOn(true);
    } catch {
      rec.current = null;
    }
  };
  const release = () => rec.current?.stop();

  return (
    <form
      className="glass talk"
      data-testid="talk"
      onSubmit={(e) => {
        e.preventDefault();
        send(said);
      }}
    >
      <input autoFocus value={said} maxLength={200} placeholder={on ? t("Listening… let go to send") : t("Say something to the {name}…", { name })} aria-label={t("Talk to the {name}", { name })} onChange={(e) => setSaid(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} />
      {Api && (
        <button
          type="button"
          className={`mic talk-mic${on ? " on" : ""}`}
          aria-label={on ? t("Listening: let go to send") : t("Hold to talk")}
          title={t("Hold to talk")}
          data-testid="talk-mic"
          // the input keeps its focus, so typing still works after a word or two by voice
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture?.(e.pointerId);
            hold();
          }}
          onPointerUp={release}
          onPointerCancel={release}
          onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !e.repeat && (e.preventDefault(), hold())}
          onKeyUp={(e) => (e.key === " " || e.key === "Enter") && release()}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
            <path d="M3 8a5 5 0 0 0 10 0M8 13v2" />
          </svg>
        </button>
      )}
      {note && (
        <span className="voice-note talk-note" role="status" onClick={() => setNote(null)}>
          {note}
        </span>
      )}
    </form>
  );
}
