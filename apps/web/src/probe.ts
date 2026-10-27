// Test/diagnostic probe on window. The first four fields are the contract the e2e suite reads;
// the rest are optional diagnostics.
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
  /** How long the background shader prewarm took. */
  prewarmMs?: number;
  /** In an immersive VR session. */
  vr?: boolean;
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
