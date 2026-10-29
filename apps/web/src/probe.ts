// Test/diagnostic probe on window. The first four fields are the contract the e2e suite reads;
// the rest are optional diagnostics.
import type { SpeechStats } from "./audio/speech";

export interface GhostrunProbe {
  ready: boolean;
  fps: number;
  backend: "webgpu" | "webgl2";
  specHash?: string;
  ttffMs?: number;
  tick?: number;
  player?: [number, number, number];
  drawCalls?: number;
  pixelRatio?: number;
  splits?: Record<string, number>;
  sim?: "rapier" | "stub";
  proof?: { headline: string; chips: number };
  /** NPC ground positions [x, z], refreshed twice a second. */
  cast?: Record<string, [number, number]>;
  /** The current world's look (and variant). */
  look?: string;
  /** How long the background shader prewarm took. */
  prewarmMs?: number;
  /** In an immersive VR session. */
  vr?: boolean;
  /** The ghost being raced (absent when there is none): where it is drawn this frame, by tick. */
  ghost?: { shown: boolean; tick: number; p: [number, number, number]; finished: boolean };
  /** The runners' overview while it is shown: route ribbons and heat-map tiles drawn. */
  overview?: { routes: number; heat: number };
  /** The sound: "off" until the first gesture starts it, "disabled" with ?audio=0. */
  audio?: AudioProbe;
  /** Spoken lines (NPCs and the Host): "unsupported" without speechSynthesis, "disabled" with ?audio=0. */
  speech?: SpeechStats;
  /** The build preview on screen (absent when there is none): statics risen and entities popped in so far. */
  materialise?: { statics: number; entities: number };
  /** The run's clip recorder: "disabled" with ?clip=0 (and on phones), "unsupported" where the browser can't record a canvas. */
  clip?: { state: "disabled" | "unsupported" | "failed" | "off" | "paused" | "rolling" | "held" | "take"; segments: number; bytes: number; type: string };
}

export interface AudioProbe {
  state: "off" | "disabled" | AudioContextState;
  muted: boolean;
  /** Effects played so far (none while muted), in all and by name. */
  played: number;
  counts: Record<string, number>;
  last?: string;
  music?: { key: string; bpm: number };
  /** The music and ambience are ducked under a voice. */
  ducked?: boolean;
}

declare global {
  interface Window {
    __GHOSTRUN__: GhostrunProbe;
  }
}

export function probe(): GhostrunProbe {
  window.__GHOSTRUN__ ??= { ready: false, fps: 0, backend: "webgl2" };
  return window.__GHOSTRUN__;
}
