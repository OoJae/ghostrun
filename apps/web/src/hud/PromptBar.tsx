import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import type { LoadResult } from "../engine";
import { locale, num, t } from "../i18n";
import { imageIn, preparePicture, type Picture } from "../picture";
import { firstVoiceNote, speechApi, transcript, voiceError, type Recognition } from "./listen";
import "./picture.css";

interface Props {
  prompt: string;
  onPrompt(p: string): void;
  onSubmit(p: string): void;
  collapsed: boolean;
  onExpand(): void;
  onCollapse(): void;
  timing: LoadResult | null;
  busy: boolean;
  /** Where the world came from: the live LLM lane, the edge's cache (with a way to build it fresh) or the recorded fixture. */
  source: { label: string; title: string; action?: { label: string; run(): void } };
  /** One-click prompts shown while the bar is focused. */
  suggestions?: readonly { label: string; prompt: string }[];
  /** The bar gained or lost focus (the side cards step aside while a new world is typed). */
  onFocusChange?(focused: boolean): void;
  /** Opens the gallery of recorded worlds (shown in the suggestions). */
  onGallery?(): void;
  galleryCount?: number;
  /** Example prompts the empty bar cycles through as its placeholder; Enter on an empty bar builds the one shown. */
  examples?: readonly string[];
  /** The prompt of the world being played (the pill shows it when the bar is empty). */
  playing?: string;
  /** A photo or sketch the next build is inspired by (shown as a chip); words are optional with one. */
  picture?: Picture | null;
  /** Set or clear the picture; absent, the bar offers no picture (the live lane is needed to read one). */
  onPicture?(p: Picture | null): void;
}

const EXAMPLE_MS = 3000;
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * The empty bar's placeholder: an example that types itself out, a new one every few seconds,
 * holding still once the bar is focused or typed into.
 */
function useExample(examples: readonly string[], idle: boolean): { full: string; shown: string } {
  const [i, setI] = useState(0);
  const [chars, setChars] = useState(0);
  useEffect(() => {
    if (!idle || examples.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % examples.length), EXAMPLE_MS);
    return () => clearInterval(t);
  }, [idle, examples.length]);
  const full = examples[i] ?? "";
  useEffect(() => {
    if (reducedMotion()) return setChars(full.length);
    // by the clock, not by ticks: late timers on a busy frame still finish the line on time
    const t0 = performance.now();
    setChars(0);
    const t = setInterval(() => {
      const n = Math.min(full.length, Math.ceil((performance.now() - t0) / 14));
      setChars(n);
      if (n >= full.length) clearInterval(t);
    }, 28);
    return () => clearInterval(t);
  }, [full]);
  return { full, shown: idle ? full.slice(0, chars) : full };
}

function Stopwatch({ timing, busy }: { timing: LoadResult | null; busy: boolean }) {
  const title = timing ? timing.splits.map((s) => `${t(s.label)} ${num(Math.round(s.ms))} ms`).join(" · ") : t("measuring");
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
          {locale() === "en" ? Math.round(timing.ttffMs).toLocaleString("en-US") : num(Math.round(timing.ttffMs))}
          <small> ms</small>
        </span>
      )}
      <span className="stopwatch-label">{t("to first frame")}</span>
    </span>
  );
}

function Mic({ onText, onDone }: { onText: (t: string) => void; onDone: (t: string) => void }) {
  const [on, setOn] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const Api = speechApi();
  if (!Api) return null;
  const toggle = () => {
    if (on) return rec.current?.stop();
    const first = firstVoiceNote();
    if (first) setNote(first);
    const r = new Api();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false;
    let text = "";
    r.onresult = (e) => {
      text = transcript(e);
      onText(text);
    };
    r.onerror = (e) => setNote(voiceError(e.error, "speak a world"));
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
      <button type="button" className={`mic${on ? " on" : ""}`} onClick={toggle} aria-label={on ? t("Stop listening") : t("Speak a world")} title={on ? t("Listening… click to stop") : t("Speak a world")} data-testid="mic">
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

const coarse = () => window.matchMedia?.("(pointer: coarse)").matches ?? false;

/** The picture controls: a file, the camera on phones, a paste or a drop; and the chip once there is one. */
function usePicture(onPicture: Props["onPicture"]) {
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const take = async (file: File | null | undefined) => {
    if (!file || !onPicture) return;
    setReading(true);
    setNote(null);
    const r = await preparePicture(file);
    setReading(false);
    if (r.ok) onPicture(r.picture);
    else setNote(r.why);
  };
  return { reading, note, clearNote: () => setNote(null), take };
}

/** One button: a file picker on a desktop; on a phone, a choice of the camera or the photo library. */
function PictureButtons({ take }: { take: (f: File | null | undefined) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState(false);
  const phone = coarse();
  const picked = (el: HTMLInputElement) => {
    take(el.files?.[0]);
    el.value = ""; // the same file again is a new pick
  };
  const open = (el: HTMLInputElement | null) => {
    setMenu(false);
    el?.click();
  };
  return (
    <>
      <button
        type="button"
        className="mic picture-btn"
        onClick={() => (phone ? setMenu((m) => !m) : open(file.current))}
        aria-label={t("Build from a photo or sketch")}
        aria-expanded={phone ? menu : undefined}
        title={t("Build from a photo or sketch (or paste or drop one on the bar): the world is inspired by it")}
        data-testid="picture-button"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.5" y="3" width="13" height="10" rx="2" />
          <circle cx="5.5" cy="6.5" r="1.3" />
          <path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" />
        </svg>
      </button>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => picked(e.currentTarget)} data-testid="picture-input" />
      {phone && <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => picked(e.currentTarget)} data-testid="camera-input" />}
      {menu && (
        <span className="picture-menu" role="menu" data-testid="picture-menu">
          <button type="button" role="menuitem" onClick={() => open(camera.current)} data-testid="camera-button">
            {t("Take a photo")}
          </button>
          <button type="button" role="menuitem" onClick={() => open(file.current)}>
            {t("Choose an image")}
          </button>
        </span>
      )}
    </>
  );
}

export function PromptBar({ prompt, onPrompt, onSubmit, collapsed, onExpand, onCollapse, timing, busy, source, suggestions = [], onFocusChange, onGallery, galleryCount, examples = [], playing, picture = null, onPicture }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocusedState] = useState(false);
  const [dropping, setDropping] = useState(false);
  const pic = usePicture(onPicture);
  const example = useExample(examples, !focused && !prompt && !picture);
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
    if (pic.reading) return; // the picture is still being made small: Enter would build without it
    // an empty bar builds the example it shows; with a picture it builds from the picture alone
    const text = prompt.trim() ? prompt : picture ? "" : example.full;
    if (!text && !picture) return;
    input.current?.blur();
    if (text !== prompt) onPrompt(text);
    onSubmit(text);
  };
  const carriesFiles = (e: DragEvent) => Boolean(onPicture) && Array.from(e.dataTransfer.types).includes("Files");

  if (collapsed) {
    return (
      <button className="glass pill" onClick={onExpand} title={t("Edit prompt")} data-testid="prompt-pill">
        <span className="mark" aria-hidden="true" />
        {picture && <img className="pill-picture" src={picture.url} alt="" />}
        <span className="pill-text">{prompt || playing}</span>
        <Stopwatch timing={timing} busy={busy} />
      </button>
    );
  }

  return (
    <form
      className={`glass promptbar${onPicture ? " takes-picture" : ""}${dropping ? " dropping" : ""}${picture ? " has-picture" : ""}`}
      onSubmit={submit}
      data-testid="prompt-bar"
      onDragOver={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault(); // without this the browser would open the dropped file instead
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        setDropping(false);
        void pic.take(imageIn(e.dataTransfer));
      }}
    >
      <span className="mark" aria-hidden="true" />
      <span className="brand">GHOSTRUN</span>
      {/* the permanent AI label (AI Act Art. 50): what's made here is made by AI, and what we keep */}
      <a className="ai-label" href="/privacy" target="_blank" rel="noopener" data-testid="ai-label" title={t("Worlds, characters and answers here are made by AI, then checked by a proof. Privacy and AI: what we keep.")}>
        {t("AI-made")}
      </a>
      {(picture || pic.reading) && (
        <span className="picture-chip" data-testid="picture-chip" title={picture ? t("Your image, {w}×{h}, {kb} KB with its metadata removed. The world takes ideas from it (the place, colours, things); it doesn't rebuild it.", { w: picture.width, h: picture.height, kb: Math.round(picture.bytes / 1024) }) : t("Making the image small…")}>
          {picture ? <img src={picture.url} alt={t("Your image")} /> : <span className="picture-reading" aria-label={t("Making the image small")} />}
          {picture && (
            <button type="button" onClick={() => onPicture?.(null)} aria-label={t("Remove the image")} data-testid="picture-remove">
              ×
            </button>
          )}
        </span>
      )}
      <input
        ref={input}
        value={prompt}
        onChange={(e) => onPrompt(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCollapse();
        }}
        onPaste={(e) => {
          const f = onPicture ? imageIn(e.clipboardData) : null;
          if (!f) return; // words paste as words
          e.preventDefault();
          void pic.take(f);
        }}
        spellCheck={false}
        aria-label={t("Describe a world")}
        placeholder={picture ? t("Add words (“a heist here”), or press Enter to build from the image") : example.full ? t("Try: {example}", { example: example.shown }) : t("Describe a world…")}
      />
      {onPicture && <PictureButtons take={(f) => void pic.take(f)} />}
      {pic.note && (
        <span className="voice-note" role="status" onClick={pic.clearNote} data-testid="picture-note">
          {pic.note}
        </span>
      )}
      <Mic onText={onPrompt} onDone={onSubmit} />
      <span className={`chip${source.action ? " cached" : ""}`} title={t(source.title)} data-testid="source-chip">
        {t(source.label)}
      </span>
      {source.action && (
        <button type="button" className="chip-action" onClick={source.action.run} title={source.title} data-testid="build-fresh">
          {t(source.action.label)}
        </button>
      )}
      <Stopwatch timing={timing} busy={busy} />
      {focused && suggestions.length > 0 && (
        <div className="glass suggest" data-testid="suggest">
          <span className="eyebrow">{t("Try one")}</span>
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
              {t(s.label)}
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
              {t("Gallery: {n} recorded worlds", { n: galleryCount ?? 0 })} <kbd>G</kbd>
            </button>
          )}
        </div>
      )}
    </form>
  );
}
