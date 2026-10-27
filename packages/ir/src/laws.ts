import type { Laws } from "./schema";

export const DEFAULT_LAWS: Laws = {
  gravityScale: 1,
  jumpH: 1.6,
  speed: 6,
  jumpsMax: 1,
  airControl: 0.6,
  coyoteMs: 120,
  bufferMs: 100,
  thrust: 0,
};

/** Below this gravity scale the world switches to the zero-g thrust law (no jump arcs). */
export const ZERO_G_BELOW = 0.05;

const clamp = (x: number, lo: number, hi: number, dflt: number) =>
  Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;

/**
 * Laws clamp, never reject: any edit ("turn gravity off", "jump 100 m") yields a playable,
 * provable world. NaN/±Inf fall back to the defaults.
 */
export function clampLaws(l: Laws): Laws {
  const gravityScale = clamp(l.gravityScale, 0, 3, DEFAULT_LAWS.gravityScale);
  const zeroG = gravityScale < ZERO_G_BELOW;
  return {
    gravityScale: zeroG ? 0 : gravityScale,
    jumpH: clamp(l.jumpH, 0.3, 4, DEFAULT_LAWS.jumpH),
    speed: clamp(l.speed, 1, 12, DEFAULT_LAWS.speed),
    jumpsMax: Math.round(clamp(l.jumpsMax, 0, 3, DEFAULT_LAWS.jumpsMax)),
    airControl: clamp(l.airControl, 0, 1, DEFAULT_LAWS.airControl),
    coyoteMs: clamp(l.coyoteMs, 0, 250, DEFAULT_LAWS.coyoteMs),
    bufferMs: clamp(l.bufferMs, 0, 250, DEFAULT_LAWS.bufferMs),
    // Zero-g worlds need thrust to move at all.
    thrust: zeroG ? clamp(l.thrust || 4, 1, 12, 4) : clamp(l.thrust, 0, 12, 0),
  };
}

export const isZeroG = (l: Laws) => l.gravityScale < ZERO_G_BELOW;
