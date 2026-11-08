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
  /** The camera taken for a shot (the Host flying to a moment): the place, where the camera is, and whether it got there. */
  shot?: { kind: "fly"; to: [number, number, number]; cam: [number, number, number]; arrived: boolean };
  /** Red/green playing: its clock (ticks), whether they have parted, the caption, both ghosts and the camera. */
  redgreen?: { tick: number; parted: boolean; caption: string; green: [number, number, number]; red: [number, number, number]; cam: [number, number, number] };
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
  /** Models swapped in over the primitives so far (absent with ?models=0). */
  models?: { tier: "full" | "lite"; characters: number; props: number; failed: number; player?: string };
  /** In a VR session (refreshed ten times a second): the panels, the pointer, the comfort options. */
  xr?: XrProbe;
}

export interface XrProbe {
  /** Each panel: shown now, how often its canvas has been painted, and the words on it. */
  panels: Record<string, { shown: boolean; draws: number; words: string[] }>;
  /** Every button on a shown panel: its centre in the play space (the reference space the controllers move in). */
  buttons: Record<string, [number, number, number]>;
  /** The button a controller points at. */
  hover: string | null;
  move: "smooth" | "teleport";
  vignette: boolean;
  teleport: { aiming: boolean; valid: boolean; target: [number, number, number] | null; walking: boolean };
  /** The pickup a grab is walking you to, and what you carry ("" for nothing). */
  grab: string | null;
  carrying: string;
  /** At the wheel: the vehicle, and the seat's heading. */
  seat: { vehicle: string; yaw: number } | null;
  /** Where a character's line is shown: over their head, or in front of you while they're out of sight. */
  bark: "head" | "front" | null;
  listening: boolean;
  /** A world is being built: you stand where its reveal is watched from. */
  watching: boolean;
  /** The prompt sheet (chips, or the voice prompt) is open. */
  sheet: boolean;
  /** Main-thread time of the VR layer's own work per frame (ms). */
  cpu: { p50: number; p95: number };
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
