// Voices for a world's characters and its Host, as the HUD sees them: one Speech for the page, its
// language set by each world (the fill's `lang`), muted with the rest of the sound (M, the button,
// B/Y on a VR controller), and the music ducked while anyone talks. ?audio=0 turns it off with
// everything else; a browser without speechSynthesis keeps the lines as subtitles only.
import { useCallback, useEffect, useRef } from "react";
import type { WorldBundle } from "@ghostrun/ir";
import { probe } from "../probe";
import { Speech, type SpeechStats, type SynthLike, type UtteranceLike } from "./speech";
import type { SoundControl } from "./useSound";

export interface SpeechControl {
  /** Lines can be spoken here (a voice engine, and sound not turned off). */
  enabled: boolean;
  /** A world went live: its language, and its cast's roles and personas. */
  world(b: WorldBundle): void;
  /** An NPC's line: a bark of its own, or its reply to the player. */
  npc(npc: string, line: string, reply: boolean): void;
  /** The Host says this (cutting in over anything else). */
  host(text: string): void;
  /** The Host's last line again. */
  again(): void;
  /** Quiet now (the person is about to speak). */
  hush(): void;
  /** The language to listen in when the person talks back. */
  listenLang(): string;
}

const reader = () => (typeof navigator !== "undefined" && navigator.language) || "en-US";
const primary = (l: string) => l.toLowerCase().split(/[-_]/)[0] ?? "";

export function useSpeech(sound: SoundControl): SpeechControl {
  const speech = useRef<Speech | null>(null);
  const bundle = useRef<WorldBundle | null>(null);
  const lastHost = useRef("");
  const voice = useRef(sound.voice);
  voice.current = sound.voice;
  const synth = sound.enabled && typeof window !== "undefined" && "speechSynthesis" in window ? (window.speechSynthesis as unknown as SynthLike) : null;

  if (!speech.current) {
    const stats: SpeechStats = { state: "on", muted: sound.muted, speaking: false, spoken: 0, dropped: 0, voices: 0, lang: "en", lines: [] };
    probe().speech = stats;
    // a line before the first click or key would be refused (and logged): it stays a subtitle
    const allowed = () => (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;
    speech.current = new Speech(synth, { fallback: primary(reader()), onSpeaking: (on) => voice.current(on), allowed, stats });
    if (!sound.enabled) stats.state = "disabled";
    speech.current.setMuted(sound.muted);
  }

  useEffect(() => speech.current?.setMuted(sound.muted), [sound.muted]);

  useEffect(() => {
    // a hidden tab says nothing (and what it had to say is stale by the time it's back)
    const hide = () => document.hidden && speech.current?.hush();
    document.addEventListener("visibilitychange", hide);
    // iOS Safari speaks later lines only once one has started inside a tap: an empty one, on the first
    const opts = { capture: true, passive: true } as const;
    const unlock = () => {
      for (const k of ["pointerdown", "keydown"] as const) window.removeEventListener(k, unlock, opts);
      try {
        if (synth && !speech.current?.speaking) synth.speak(new SpeechSynthesisUtterance("") as unknown as UtteranceLike);
      } catch {
        // no voice engine after all: the lines stay subtitles
      }
    };
    for (const k of ["pointerdown", "keydown"] as const) window.addEventListener(k, unlock, opts);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      for (const k of ["pointerdown", "keydown"] as const) window.removeEventListener(k, unlock, opts);
      speech.current?.hush();
    };
  }, []);

  const world = useCallback((b: WorldBundle) => {
    bundle.current = b;
    lastHost.current = "";
    speech.current?.hush();
    speech.current?.setLang(b.lang);
  }, []);

  const npc = useCallback((id: string, line: string, reply: boolean) => {
    const c = bundle.current?.cast.find((k) => k.npc === id);
    const persona = c ? [c.persona.identity, c.persona.personality].filter(Boolean).join(" ") : "";
    speech.current?.say({ id, role: c?.role ?? "citizen", persona }, line, reply ? "reply" : "bark");
  }, []);

  const host = useCallback((text: string) => {
    lastHost.current = text;
    speech.current?.say({ id: "host", role: "host" }, text, "host");
  }, []);

  const again = useCallback(() => lastHost.current && host(lastHost.current), [host]);
  const hush = useCallback(() => speech.current?.hush(), []);

  const listenLang = useCallback(() => {
    // the world's language; the reader's own locale when it's the same language (en-GB, not en)
    const w = bundle.current?.lang || primary(reader());
    return primary(reader()) === primary(w) ? reader() : w;
  }, []);

  return { enabled: Boolean(synth), world, npc, host, again, hush, listenLang };
}
