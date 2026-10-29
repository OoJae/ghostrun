// Sound, as the HUD sees it: the first gesture starts the audio (browsers allow it no sooner), M,
// the HUD button and B/Y on a VR controller mute it (remembered), and ?audio=0 turns it off
// entirely. The synthesis is its own chunk, fetched on that first gesture; the AudioContext itself
// is made inside the gesture, which is what Safari needs before it lets a page play.
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorldBundle } from "@ghostrun/ir";
import type { Engine } from "../engine";
import { probe } from "../probe";
import type { RapierSim } from "../sim/rapier";
import type { Sound } from "./sound";

const MUTED = "gr_muted";
const OFF = new URLSearchParams(window.location.search).get("audio") === "0";
const GESTURES = ["pointerdown", "pointerup", "touchend", "keydown", "click"] as const;

function storedMute(): boolean {
  try {
    return localStorage.getItem(MUTED) === "1";
  } catch {
    return false;
  }
}

function storeMute(m: boolean) {
  try {
    localStorage.setItem(MUTED, m ? "1" : "0");
  } catch {
    // storage blocked: the choice lasts this visit
  }
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);

export interface SoundControl {
  enabled: boolean;
  muted: boolean;
  toggle(): void;
  /** The engine: its frames (footsteps), its camera (panning), its VR buttons (mute). */
  attach(e: Engine): void;
  /** A world went live (or restarted): its place, its music, its events. */
  world(b: WorldBundle, sim: RapierSim | null): void;
}

export function useSound(): SoundControl {
  const [muted, setMuted] = useState(storedMute);
  const mutedRef = useRef(muted);
  const ctx = useRef<AudioContext | null>(null);
  const sound = useRef<Sound | null>(null);
  const engine = useRef<Engine | null>(null);
  const current = useRef<{ b: WorldBundle; sim: RapierSim | null } | null>(null);

  /** Inside a user gesture: make the context (the first time) or wake it. */
  const wake = useCallback(() => {
    if (OFF) return;
    if (!ctx.current) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      let c: AudioContext;
      try {
        c = new Ctor({ latencyHint: "interactive" });
      } catch {
        return;
      }
      ctx.current = c;
      // an empty buffer started inside the gesture unlocks older iOS Safari
      const unlock = c.createBufferSource();
      unlock.buffer = c.createBuffer(1, 1, 22050);
      unlock.connect(c.destination);
      unlock.start(0);
      void import("./sound").then(({ Sound }) => {
        const s = new Sound(c, { muted: mutedRef.current, ear: () => engine.current?.ear() ?? null });
        sound.current = s;
        if (current.current) s.world(current.current.b, current.current.sim);
      });
    }
    if (!mutedRef.current && ctx.current.state !== "running") void ctx.current.resume().catch(() => undefined);
  }, []);

  const toggle = useCallback(() => {
    if (OFF) return;
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    storeMute(next);
    if (sound.current) sound.current.setMuted(next);
    else if (probe().audio) probe().audio!.muted = next;
    if (!next) wake();
  }, [wake]);

  useEffect(() => {
    if (OFF) {
      probe().audio = { state: "disabled", muted: false, played: 0, counts: {} };
      return;
    }
    probe().audio ??= { state: "off", muted: mutedRef.current, played: 0, counts: {} };
    // every gesture checks in: the first one starts the audio, later ones wake it after iOS interrupts it
    const opts = { capture: true, passive: true } as const;
    for (const k of GESTURES) window.addEventListener(k, wake, opts);
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyM" || e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      for (const k of GESTURES) window.removeEventListener(k, wake, opts);
      window.removeEventListener("keydown", onKey);
    };
  }, [wake, toggle]);

  const attach = useCallback(
    (e: Engine) => {
      engine.current = e;
      e.onFrame = (f) => sound.current?.frame(f);
      e.onVrB = toggle;
    },
    [toggle],
  );

  const world = useCallback((b: WorldBundle, sim: RapierSim | null) => {
    current.current = { b, sim };
    sound.current?.world(b, sim);
  }, []);

  return { enabled: !OFF, muted, toggle, attach, world };
}
