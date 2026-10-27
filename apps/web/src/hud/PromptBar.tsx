import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LoadResult } from "../engine";

interface Props {
  prompt: string;
  onPrompt(p: string): void;
  onSubmit(p: string): void;
  collapsed: boolean;
  onExpand(): void;
  onCollapse(): void;
  timing: LoadResult | null;
  busy: boolean;
  /** Where the world came from: the live LLM lane or the recorded fixture. */
  source: { label: string; title: string };
  /** One-click prompts shown while the bar is focused. */
  suggestions?: readonly { label: string; prompt: string }[];
  /** The bar gained or lost focus (the side cards step aside while a new world is typed). */
  onFocusChange?(focused: boolean): void;
  /** Opens the gallery of recorded worlds (shown in the suggestions). */
  onGallery?(): void;
  galleryCount?: number;
}

function Stopwatch({ timing, busy }: { timing: LoadResult | null; busy: boolean }) {
  const title = timing ? timing.splits.map((s) => `${s.label} ${Math.round(s.ms)} ms`).join(" · ") : "measuring";
  return (
    <span className="stopwatch" title={title} data-testid="stopwatch">
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="9" r="5.5" />
        <path d="M8 9V6M6.5 1.8h3M12.2 4.4l1-1" />
      </svg>
      {busy || !timing ? (
        <span className="stopwatch-val muted">…</span>
      ) : (
        <span className="stopwatch-val">
          {Math.round(timing.ttffMs).toLocaleString("en-US")}
          <small> ms</small>
        </span>
      )}
      <span className="stopwatch-label">to first frame</span>
    </span>
  );
}

// The browser's own speech recognition (Chrome and Safari ship one); no audio passes through us.
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;
const speechApi = (): RecognitionCtor | undefined => {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
};
const VOICE_NOTE = "gr_voice_note";

function Mic({ onText, onDone }: { onText: (t: string) => void; onDone: (t: string) => void }) {
  const [on, setOn] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const Api = speechApi();
  if (!Api) return null;
  const toggle = () => {
    if (on) return rec.current?.stop();
    try {
      if (!localStorage.getItem(VOICE_NOTE)) {
        setNote("Voice uses your browser's speech service (Google in Chrome, Apple in Safari); GHOSTRUN only receives the text.");
        localStorage.setItem(VOICE_NOTE, "1");
      }
    } catch {
      // storage blocked: the note shows each time, which is fine
    }
    const r = new Api();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    let text = "";
    r.onresult = (e) => {
      text = Array.from(e.results, (x) => x[0]?.transcript ?? "").join(" ").trim();
      onText(text);
    };
    r.onerror = (e) => setNote(e.error === "not-allowed" ? "Microphone blocked: allow it in the address bar to speak a world." : `Voice stopped (${e.error}).`);
    r.onend = () => {
      setOn(false);
      if (text) onDone(text);
    };
    rec.current = r;
    r.start();
    setOn(true);
  };
  return (
    <>
      <button type="button" className={`mic${on ? " on" : ""}`} onClick={toggle} aria-label={on ? "Stop listening" : "Speak a world"} title={on ? "Listening… click to stop" : "Speak a world"} data-testid="mic">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
          <path d="M3 8a5 5 0 0 0 10 0M8 13v2" />
        </svg>
      </button>
      {note && (
        <span className="voice-note" role="status" onClick={() => setNote(null)}>
          {note}
        </span>
      )}
    </>
  );
}

export function PromptBar({ prompt, onPrompt, onSubmit, collapsed, onExpand, onCollapse, timing, busy, source, suggestions = [], onFocusChange, onGallery, galleryCount }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocusedState] = useState(false);
  const setFocused = (f: boolean) => {
    setFocusedState(f);
    onFocusChange?.(f);
  };

  useEffect(() => {
    if (!collapsed) return;
    input.current?.blur();
  }, [collapsed]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    input.current?.blur();
    onSubmit(prompt);
  };

  if (collapsed) {
    return (
      <button className="glass pill" onClick={onExpand} title="Edit prompt" data-testid="prompt-pill">
        <span className="mark" aria-hidden="true" />
        <span className="pill-text">{prompt}</span>
        <Stopwatch timing={timing} busy={busy} />
      </button>
    );
  }

  return (
    <form className="glass promptbar" onSubmit={submit} data-testid="prompt-bar">
      <span className="mark" aria-hidden="true" />
      <span className="brand">GHOSTRUN</span>
      <input
        ref={input}
        value={prompt}
        onChange={(e) => onPrompt(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCollapse();
        }}
        spellCheck={false}
        aria-label="Describe a world"
        placeholder="Describe a world…"
      />
      <Mic onText={onPrompt} onDone={onSubmit} />
      <span className="chip" title={source.title}>
        {source.label}
      </span>
      <Stopwatch timing={timing} busy={busy} />
      {focused && suggestions.length > 0 && (
        <div className="glass suggest" data-testid="suggest">
          <span className="eyebrow">Try one</span>
          {suggestions.map((s) => (
            <button
              type="button"
              key={s.label}
              title={s.prompt}
              // mousedown, so it lands before the input's blur closes this panel
              onMouseDown={(e) => {
                e.preventDefault();
                onPrompt(s.prompt);
                input.current?.blur();
                onSubmit(s.prompt);
              }}
            >
              {s.label}
            </button>
          ))}
          {onGallery && (
            <button
              type="button"
              className="suggest-gallery"
              data-testid="open-gallery"
              onMouseDown={(e) => {
                e.preventDefault();
                input.current?.blur();
                onGallery();
              }}
            >
              Gallery: {galleryCount} recorded worlds <kbd>G</kbd>
            </button>
          )}
        </div>
      )}
    </form>
  );
}
