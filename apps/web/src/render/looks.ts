// Looks: how a world is dressed, picked from the fill's look word (and the pack when the word says
// nothing). Cosmetic only: no look ever changes a collider, a rule or the spec hash.
import type { WorldBundle } from "@ghostrun/ir";
import { PALETTE } from "./materials";

export type LookId = "neon" | "grove" | "gallery";

export interface LookStyle {
  id: LookId;
  night: boolean;
  sky: { zenith: string; horizon: string; glow: string; glowScale: number };
  fog: { color: string; near: number; far: number };
  hemi: { sky: string; ground: string; intensity: number };
  sun: { color: string; intensity: number };
  bloom: number;
  exposure: number;
  env: number;
  rain: boolean;
}

const WORDS: readonly (readonly [RegExp, LookId])[] = [
  [/forest|grove|jungle|garden|park|nature|biolumin|wood|meadow|island|beach|camp|swamp|mushroom|fairy|valley|glade|lake|river|mountain/, "grove"],
  [/museum|galler|showroom|minimal|modern|villa|home|house|office|clean|luxury|boutique|interior|apartment|shop|store|studio|hotel|lobby/, "gallery"],
  [/neon|cyber|city|synth|arcade|street|urban|tokyo|noir|retro/, "neon"],
];

const PACK_LOOK: Record<string, LookId> = { outdoor: "grove", floor_plan: "gallery" };

export function lookOf(b: WorldBundle): LookStyle {
  const word = b.cosmetic.look.toLowerCase();
  const id = WORDS.find(([re]) => re.test(word))?.[1] ?? PACK_LOOK[b.pack.id] ?? "neon";
  const h = b.cosmetic.timeOfDay;
  const night = /night|moon|biolumin|neon|glow/.test(word) || h >= 19 || h < 6;
  const rain = b.cosmetic.weather === "rain" || b.cosmetic.weather === "storm";
  switch (id) {
    case "grove":
      return night
        ? {
            id, night, rain,
            sky: { zenith: "#01070c", horizon: "#0a2a2c", glow: "#2dffc4", glowScale: 0.06 },
            fog: { color: "#0a2427", near: 9, far: 70 },
            hemi: { sky: "#4a86a0", ground: "#12261d", intensity: 3.4 },
            sun: { color: "#9fd6ff", intensity: 0.9 },
            bloom: 0.75, exposure: 1.1, env: 0.35,
          }
        : {
            id, night, rain,
            sky: { zenith: "#4f97d6", horizon: "#d3e9ee", glow: "#fff1c4", glowScale: 0.12 },
            fog: { color: "#c9dfe2", near: 28, far: 150 },
            hemi: { sky: "#bfdcff", ground: "#4a5a2c", intensity: 2.2 },
            sun: { color: "#fff0d2", intensity: 3.2 },
            bloom: 0.2, exposure: 1.0, env: 0.6,
          };
    case "gallery":
      return {
        id, night, rain: false,
        sky: night ? { zenith: "#0d1018", horizon: "#2a2c38", glow: "#ffd9a8", glowScale: 0.05 } : { zenith: "#cfd8e3", horizon: "#f3efe7", glow: "#ffffff", glowScale: 0.05 },
        fog: night ? { color: "#1e2029", near: 40, far: 180 } : { color: "#ece8e0", near: 45, far: 200 },
        hemi: { sky: night ? "#8a8fa8" : "#f4f6ff", ground: "#7d766b", intensity: night ? 2.2 : 2.4 },
        sun: { color: "#fff3e0", intensity: night ? 0.6 : 2.0 },
        bloom: 0.1, exposure: night ? 1.0 : 0.85, env: 0.7,
      };
    default:
      return {
        id: "neon", night: true, rain,
        sky: { zenith: PALETTE.sky, horizon: PALETTE.horizon, glow: PALETTE.magenta, glowScale: 0.075 },
        fog: { color: "", near: 14, far: 100 },
        hemi: { sky: "#5560a8", ground: "#1a0f22", intensity: 4 },
        sun: { color: "#9fb2ff", intensity: 1.4 },
        bloom: 0.85, exposure: 1.05, env: 0.8,
      };
  }
}
