// Looks: how a world is dressed and lit, picked from what the AI wrote about it (render/pick.ts).
// Each look is an art direction: a sky, a fog, the light, what drifts in the air, and (in
// render/dressing) the materials and props its statics are dressed as. Cosmetic only: no look ever
// changes a collider, a rule or the spec hash.
import type { WorldBundle } from "@ghostrun/ir";
import type { Floor } from "../audio/voices";
import { Color } from "three/webgpu";
import { PALETTE } from "./materials";
import { cueOf, pickLook, type Cue, type LookId, type Pick } from "./pick";

export type { LookId } from "./pick";

/** What drifts in the air: one instanced draw (render/particles.ts). */
export type Drift = "" | "snow" | "dust" | "sandstorm" | "embers" | "motes" | "sparkles" | "bubbles" | "fireflies" | "ash" | "spores";

/** The floor the player's steps sound on (audio/voices.ts). */
export type Footing = Floor;

export interface SkyStyle {
  zenith: string;
  horizon: string;
  glow: string;
  glowScale: number;
  /** The sun (or the moon): its colour and HDR strength on the disc, its size and halo. */
  sun?: { color: string; scale: number; size: number; halo: number };
  stars?: number;
  aurora?: number;
  nebula?: number;
  clouds?: number;
  cloudColor?: string;
}

export interface LookStyle {
  id: LookId;
  variant: string;
  phase: Pick["phase"];
  night: boolean;
  sky: SkyStyle;
  fog: { color: string; near: number; far: number };
  hemi: { sky: string; ground: string; intensity: number };
  /** The directional light, from where the sky's sun (or moon) is. */
  sun: { color: string; intensity: number; elevation: number; azimuth: number };
  bloom: number;
  exposure: number;
  env: number;
  /** The reflection map's light sources (hex, HDR scale): what glossy floors and metal pick up. */
  envLights: readonly (readonly [string, number])[];
  rain: boolean;
  storm: boolean;
  drift: Drift;
  /** Walls drawn to waist height and the camera looking down over them (rooms, not streets). */
  cutaway: boolean;
  /** The weather stays outside the building's walls. */
  indoor: boolean;
  footing: Footing;
  /** What a plain prop (a box the kits don't draw) is made of here: navy in the city, wood in a cabin. */
  prop: string;
  pick: Pick;
}

const mixHex = (a: string, b: string, t: number) => `#${new Color(a).lerp(new Color(b), t).getHexString()}`;

type Base = Omit<LookStyle, "id" | "variant" | "phase" | "night" | "rain" | "storm" | "cutaway" | "indoor" | "pick" | "drift" | "footing" | "prop"> & { drift?: Drift };

/** Where the first three looks always lit from (a light at -20, 40, 18): kept, so they look as before. */
const CLASSIC = { elevation: 0.9734, azimuth: 2.4088 };
const DAY_SUN = { elevation: 0.75, azimuth: -2.4 };
const DUSK_SUN = { elevation: 0.12, azimuth: -2.2 };
const MOON = { elevation: 0.6, azimuth: 2.3 };

/** A look's palettes by time of day; a variant may replace any of them. */
interface Palettes {
  day: Base;
  dusk?: Base;
  night: Base;
}

const NEON: Palettes = {
  night: {
    sky: { zenith: PALETTE.sky, horizon: PALETTE.horizon, glow: PALETTE.magenta, glowScale: 0.075 },
    fog: { color: "", near: 14, far: 100 },
    hemi: { sky: "#5560a8", ground: "#1a0f22", intensity: 4 },
    sun: { color: "#9fb2ff", intensity: 1.4, ...CLASSIC },
    bloom: 0.85, exposure: 1.05, env: 0.8, envLights: [],
  },
  dusk: {
    // the skyline against the last of the sunset, windows already lit
    sky: { zenith: "#170f3a", horizon: "#ff7d5a", glow: "#ff3d8f", glowScale: 0.12, sun: { color: "#ffb070", scale: 9, size: 0.035, halo: 0.6 } },
    fog: { color: "#56304f", near: 16, far: 110 },
    hemi: { sky: "#9a78c0", ground: "#2a1426", intensity: 3.4 },
    sun: { color: "#ffb27a", intensity: 2.4, ...DUSK_SUN },
    bloom: 0.75, exposure: 1.05, env: 0.8, envLights: [],
  },
  get day() {
    return NEON.night;
  },
};

const GROVE: Palettes = {
  day: {
    sky: { zenith: "#4f97d6", horizon: "#d3e9ee", glow: "#fff1c4", glowScale: 0.12, sun: { color: "#fff4d6", scale: 22, size: 0.03, halo: 0.5 }, clouds: 0.35, cloudColor: "#ffffff" },
    fog: { color: "#c9dfe2", near: 28, far: 150 },
    hemi: { sky: "#bfdcff", ground: "#4a5a2c", intensity: 2.2 },
    sun: { color: "#fff0d2", intensity: 3.2, ...CLASSIC },
    bloom: 0.2, exposure: 1.0, env: 0.6, envLights: [["#fff4d6", 2]],
  },
  dusk: {
    sky: { zenith: "#3a4f8a", horizon: "#f2a86a", glow: "#ffc27a", glowScale: 0.16, sun: { color: "#ffb070", scale: 10, size: 0.04, halo: 0.7 }, clouds: 0.3, cloudColor: "#ffb894" },
    fog: { color: "#d8a07a", near: 24, far: 130 },
    hemi: { sky: "#c9a4ff", ground: "#4a3a2c", intensity: 2.0 },
    sun: { color: "#ffb070", intensity: 2.6, ...DUSK_SUN },
    bloom: 0.35, exposure: 1.0, env: 0.5, envLights: [["#ffb070", 2]],
  },
  night: {
    sky: { zenith: "#01070c", horizon: "#0a2a2c", glow: "#2dffc4", glowScale: 0.06, stars: 0.6, sun: { color: "#d8f0ff", scale: 3, size: 0.02, halo: 0.25 } },
    fog: { color: "#0a2427", near: 9, far: 70 },
    hemi: { sky: "#4a86a0", ground: "#12261d", intensity: 3.4 },
    sun: { color: "#9fd6ff", intensity: 0.9, ...CLASSIC },
    bloom: 0.75, exposure: 1.1, env: 0.35, envLights: [["#2dffc4", 1.5]],
  },
};

const GALLERY: Palettes = {
  day: {
    sky: { zenith: "#cfd8e3", horizon: "#f3efe7", glow: "#ffffff", glowScale: 0.05, clouds: 0.2, cloudColor: "#ffffff" },
    fog: { color: "#ece8e0", near: 45, far: 200 },
    hemi: { sky: "#f4f6ff", ground: "#7d766b", intensity: 2.4 },
    sun: { color: "#fff3e0", intensity: 2.0, ...CLASSIC },
    bloom: 0.1, exposure: 0.85, env: 0.7, envLights: [["#ffffff", 1.4], ["#ffd9a8", 1.0]],
  },
  dusk: {
    sky: { zenith: "#2e3a66", horizon: "#f0a27a", glow: "#ffb48a", glowScale: 0.1, sun: { color: "#ffa070", scale: 8, size: 0.035, halo: 0.6 } },
    fog: { color: "#c49a8a", near: 40, far: 180 },
    hemi: { sky: "#e0c8d8", ground: "#6d6058", intensity: 2.3 },
    sun: { color: "#ffb48a", intensity: 1.4, ...DUSK_SUN },
    bloom: 0.2, exposure: 0.95, env: 0.7, envLights: [["#ffd9a8", 2]],
  },
  night: {
    sky: { zenith: "#0d1018", horizon: "#2a2c38", glow: "#ffd9a8", glowScale: 0.05, stars: 0.5 },
    fog: { color: "#1e2029", near: 40, far: 180 },
    hemi: { sky: "#8a8fa8", ground: "#7d766b", intensity: 2.2 },
    sun: { color: "#fff3e0", intensity: 0.6, ...CLASSIC },
    bloom: 0.1, exposure: 1.0, env: 0.7, envLights: [["#ffd9a8", 2]],
  },
};

/** Under the sea: the light comes from above in shifting blue, and bubbles rise. */
const UNDERWATER: Base = {
  sky: { zenith: "#023148", horizon: "#0c6f80", glow: "#7ff0ff", glowScale: 0.12, sun: { color: "#c8fbff", scale: 4, size: 0.08, halo: 1.2 } },
  fog: { color: "#0b5866", near: 8, far: 62 },
  hemi: { sky: "#7fe0ff", ground: "#1a4a50", intensity: 2.6 },
  sun: { color: "#c8fbff", intensity: 1.8, elevation: 1.35, azimuth: 0 },
  bloom: 0.5, exposure: 1.0, env: 0.5, envLights: [["#7ff0ff", 2]], drift: "bubbles",
};

const DESERT: Palettes = {
  day: {
    sky: { zenith: "#2f72c4", horizon: "#f4d7a8", glow: "#fff0c4", glowScale: 0.16, sun: { color: "#fff4d6", scale: 30, size: 0.035, halo: 0.8 }, clouds: 0.08, cloudColor: "#fff8ee" },
    fog: { color: "#ead2a6", near: 35, far: 190 },
    hemi: { sky: "#bfd8ff", ground: "#c79a5e", intensity: 2.3 },
    sun: { color: "#fff0d0", intensity: 3.6, ...DAY_SUN },
    bloom: 0.22, exposure: 1.0, env: 0.35, envLights: [["#fff0c4", 2]], drift: "dust",
  },
  dusk: {
    sky: { zenith: "#28305e", horizon: "#ff9a52", glow: "#ff7a3a", glowScale: 0.2, sun: { color: "#ff9a52", scale: 12, size: 0.045, halo: 1 } },
    fog: { color: "#d98c5c", near: 30, far: 160 },
    hemi: { sky: "#ffb38a", ground: "#6a3a28", intensity: 2.0 },
    sun: { color: "#ff9a5a", intensity: 2.8, ...DUSK_SUN },
    bloom: 0.35, exposure: 1.0, env: 0.35, envLights: [["#ff9a52", 2]], drift: "dust",
  },
  night: {
    sky: { zenith: "#050816", horizon: "#1c2442", glow: "#5a6aa0", glowScale: 0.05, stars: 1, sun: { color: "#e8eeff", scale: 3, size: 0.025, halo: 0.35 } },
    fog: { color: "#141a30", near: 20, far: 120 },
    hemi: { sky: "#6a7ab8", ground: "#2a2030", intensity: 1.8 },
    sun: { color: "#9fb6ff", intensity: 0.9, ...MOON },
    bloom: 0.6, exposure: 1.05, env: 0.3, envLights: [["#9fb6ff", 1.5]],
  },
};

const BEACH: Palettes = {
  day: {
    sky: { zenith: "#2a8ad6", horizon: "#c2eaf0", glow: "#ffffff", glowScale: 0.1, sun: { color: "#fff8e8", scale: 26, size: 0.032, halo: 0.6 }, clouds: 0.3, cloudColor: "#ffffff" },
    fog: { color: "#cdeaee", near: 50, far: 230 },
    hemi: { sky: "#cfe8ff", ground: "#c8a878", intensity: 2.0 },
    sun: { color: "#fff6e0", intensity: 3.2, ...DAY_SUN },
    bloom: 0.2, exposure: 0.88, env: 0.5, envLights: [["#ffffff", 2]],
  },
  dusk: DESERT.dusk!,
  night: DESERT.night,
};

const SNOW: Palettes = {
  day: {
    sky: { zenith: "#5f8fc8", horizon: "#e6eef6", glow: "#ffffff", glowScale: 0.12, sun: { color: "#fff6ea", scale: 20, size: 0.03, halo: 0.6 }, clouds: 0.2, cloudColor: "#ffffff" },
    fog: { color: "#d6e0ec", near: 34, far: 170 },
    hemi: { sky: "#c8dcf8", ground: "#7a8aa0", intensity: 1.9 },
    sun: { color: "#fff4e8", intensity: 2.5, elevation: 0.45, azimuth: -2.4 },
    bloom: 0.25, exposure: 0.85, env: 0.5, envLights: [["#ffffff", 2]],
  },
  dusk: {
    // alpenglow: the snow goes pink
    sky: { zenith: "#3a4a86", horizon: "#ffb4a0", glow: "#ff9aa8", glowScale: 0.16, sun: { color: "#ffa080", scale: 10, size: 0.04, halo: 0.8 } },
    fog: { color: "#d8aab8", near: 28, far: 140 },
    hemi: { sky: "#ffc8d8", ground: "#6a6a90", intensity: 2.4 },
    sun: { color: "#ffa080", intensity: 2.2, ...DUSK_SUN },
    bloom: 0.35, exposure: 0.95, env: 0.5, envLights: [["#ffb4a0", 2]],
  },
  night: {
    sky: { zenith: "#030812", horizon: "#16264a", glow: "#3dffb0", glowScale: 0.03, stars: 1, aurora: 1, sun: { color: "#e0ecff", scale: 3, size: 0.022, halo: 0.3 } },
    fog: { color: "#0e1a30", near: 20, far: 120 },
    hemi: { sky: "#7aa0ff", ground: "#2a3a5a", intensity: 2.2 },
    sun: { color: "#b0c8ff", intensity: 1.0, ...MOON },
    bloom: 0.7, exposure: 1.05, env: 0.45, envLights: [["#3dffb0", 1.2], ["#9fc0ff", 1.5]],
  },
};

const CAVE: Base = {
  sky: { zenith: "#02060c", horizon: "#0a1a2a", glow: "#4fd8ff", glowScale: 0.06, stars: 0.3 },
  fog: { color: "#06121e", near: 8, far: 55 },
  hemi: { sky: "#6fb8ff", ground: "#10202e", intensity: 2.2 },
  sun: { color: "#9fd8ff", intensity: 0.6, ...MOON },
  bloom: 0.85, exposure: 1.1, env: 0.5, envLights: [["#4fd8ff", 2.5]], drift: "motes",
};

const SPACE: Palettes = {
  night: {
    sky: { zenith: "#000005", horizon: "#060a1c", glow: "#4a6cff", glowScale: 0.04, stars: 1.4, nebula: 1, sun: { color: "#f0f4ff", scale: 40, size: 0.012, halo: 1.6 } },
    fog: { color: "#05070f", near: 50, far: 260 },
    hemi: { sky: "#9ab0d8", ground: "#2a2e38", intensity: 2.6 },
    sun: { color: "#e8f0ff", intensity: 2.4, elevation: 0.35, azimuth: -2.0 },
    bloom: 0.6, exposure: 1.0, env: 0.65, envLights: [["#ffffff", 3], ["#4fd8ff", 2]], drift: "motes",
  },
  get day() {
    return SPACE.night;
  },
};

const MOONSCAPE: Base = {
  sky: { zenith: "#000003", horizon: "#03040a", glow: "#5a6aa0", glowScale: 0.02, stars: 1.3, nebula: 0.35, sun: { color: "#ffffff", scale: 40, size: 0.014, halo: 1.2 } },
  fog: { color: "#020308", near: 60, far: 300 },
  hemi: { sky: "#6a7080", ground: "#3a3a3c", intensity: 1.4 },
  sun: { color: "#ffffff", intensity: 3.4, elevation: 0.3, azimuth: -2.0 },
  bloom: 0.5, exposure: 1.0, env: 0.4, envLights: [["#ffffff", 2]], drift: "",
};

const HAUNTED: Palettes = {
  night: {
    sky: { zenith: "#05040c", horizon: "#2a2440", glow: "#8a7ab8", glowScale: 0.07, stars: 0.45, clouds: 0.3, cloudColor: "#24202e", sun: { color: "#eceaff", scale: 6, size: 0.07, halo: 1.4 } },
    fog: { color: "#221f30", near: 7, far: 58 },
    hemi: { sky: "#6a7aaa", ground: "#2a2028", intensity: 2.6 },
    sun: { color: "#a8b8ff", intensity: 1.8, elevation: 0.42, azimuth: 2.3 },
    bloom: 0.7, exposure: 1.1, env: 0.25, envLights: [["#9fb0ff", 1.5], ["#ff9a3a", 1]], drift: "ash",
  },
  dusk: {
    // a blood-red sunset going down behind the dead trees
    sky: { zenith: "#1a1030", horizon: "#8a3a3a", glow: "#ff5a3a", glowScale: 0.1, sun: { color: "#ff6a3a", scale: 6, size: 0.05, halo: 0.8 }, clouds: 0.35, cloudColor: "#3a2030" },
    fog: { color: "#3a2028", near: 8, far: 60 },
    hemi: { sky: "#a06a8a", ground: "#2a1418", intensity: 1.9 },
    sun: { color: "#ff7a4a", intensity: 1.6, ...DUSK_SUN },
    bloom: 0.6, exposure: 1.05, env: 0.25, envLights: [["#ff6a3a", 1.5]], drift: "ash",
  },
  get day() {
    return HAUNTED.night;
  },
};

const MEDIEVAL: Palettes = {
  day: {
    sky: { zenith: "#4f86cc", horizon: "#e8dcc4", glow: "#fff0d0", glowScale: 0.1, sun: { color: "#fff4d6", scale: 22, size: 0.03, halo: 0.5 }, clouds: 0.45, cloudColor: "#ffffff" },
    fog: { color: "#d6cdb8", near: 32, far: 170 },
    hemi: { sky: "#cfe0ff", ground: "#6a5a40", intensity: 2.3 },
    sun: { color: "#fff0d4", intensity: 3.2, ...DAY_SUN },
    bloom: 0.25, exposure: 1.0, env: 0.3, envLights: [["#fff0d0", 2]], drift: "motes",
  },
  dusk: {
    sky: { zenith: "#2c3466", horizon: "#ff9a5a", glow: "#ff8a4a", glowScale: 0.16, sun: { color: "#ff9a5a", scale: 10, size: 0.04, halo: 0.8 }, clouds: 0.35, cloudColor: "#ffaa80" },
    fog: { color: "#c8906a", near: 28, far: 150 },
    hemi: { sky: "#ffb08a", ground: "#4a3424", intensity: 2.0 },
    sun: { color: "#ff9a5a", intensity: 2.6, ...DUSK_SUN },
    bloom: 0.45, exposure: 1.0, env: 0.3, envLights: [["#ff9a5a", 2]], drift: "embers",
  },
  night: {
    sky: { zenith: "#03050e", horizon: "#141c34", glow: "#ff9a4a", glowScale: 0.03, stars: 0.9, sun: { color: "#e8eeff", scale: 3, size: 0.025, halo: 0.35 } },
    fog: { color: "#0e1424", near: 18, far: 110 },
    hemi: { sky: "#5a6aa8", ground: "#2a1e18", intensity: 1.7 },
    sun: { color: "#9fb0ff", intensity: 0.8, ...MOON },
    bloom: 0.8, exposure: 1.1, env: 0.3, envLights: [["#ff9a4a", 2]], drift: "embers",
  },
};

const MAGIC: Palettes = {
  day: {
    sky: { zenith: "#5a4ab0", horizon: "#f0d4f4", glow: "#ffe0ff", glowScale: 0.12, sun: { color: "#fff0ff", scale: 18, size: 0.03, halo: 0.6 }, clouds: 0.4, cloudColor: "#fff0ff", nebula: 0.15 },
    fog: { color: "#c8b4dc", near: 30, far: 160 },
    hemi: { sky: "#d8c4ff", ground: "#4a3a58", intensity: 1.7 },
    sun: { color: "#fff0f8", intensity: 2.3, ...DAY_SUN },
    bloom: 0.45, exposure: 0.85, env: 0.4, envLights: [["#c08aff", 2]], drift: "sparkles",
  },
  night: {
    sky: { zenith: "#0a0420", horizon: "#3a2060", glow: "#b07aff", glowScale: 0.06, stars: 1.2, nebula: 0.5, sun: { color: "#f0e8ff", scale: 4, size: 0.03, halo: 0.5 } },
    fog: { color: "#1c1030", near: 18, far: 110 },
    hemi: { sky: "#9a7ae0", ground: "#2a1a30", intensity: 2.0 },
    sun: { color: "#c0a8ff", intensity: 1.0, ...MOON },
    bloom: 0.85, exposure: 1.1, env: 0.4, envLights: [["#c08aff", 2], ["#ffb070", 1.5]], drift: "sparkles",
  },
};

const CANDY: Palettes = {
  day: {
    sky: { zenith: "#ff9ad5", horizon: "#ffeacc", glow: "#ffffff", glowScale: 0.15, sun: { color: "#fff8e0", scale: 12, size: 0.04, halo: 1 }, clouds: 0.65, cloudColor: "#fff4fb" },
    fog: { color: "#f8c4de", near: 38, far: 160 },
    hemi: { sky: "#ffe0f4", ground: "#9a70e0", intensity: 1.9 },
    sun: { color: "#fff4f0", intensity: 2.3, ...DAY_SUN },
    bloom: 0.3, exposure: 0.82, env: 0.6, envLights: [["#ffffff", 2.5], ["#ff9ad5", 2]], drift: "sparkles",
  },
  dusk: {
    sky: { zenith: "#7a5ad0", horizon: "#ffb08a", glow: "#ff8ad0", glowScale: 0.16, sun: { color: "#ffb08a", scale: 9, size: 0.045, halo: 1 }, clouds: 0.5, cloudColor: "#ffc0d8" },
    fog: { color: "#e8a0c0", near: 28, far: 140 },
    hemi: { sky: "#ffc0e8", ground: "#8a5ac8", intensity: 2.6 },
    sun: { color: "#ffb08a", intensity: 2.2, ...DUSK_SUN },
    bloom: 0.45, exposure: 1.0, env: 0.6, envLights: [["#ffb08a", 2]], drift: "sparkles",
  },
  night: {
    sky: { zenith: "#1a0a40", horizon: "#c04aa0", glow: "#ff9ae0", glowScale: 0.1, stars: 1, sun: { color: "#fff0ff", scale: 4, size: 0.03, halo: 0.5 } },
    fog: { color: "#3a1a5a", near: 22, far: 120 },
    hemi: { sky: "#c08aff", ground: "#3a1a4a", intensity: 2.4 },
    sun: { color: "#c8b0ff", intensity: 1.2, ...MOON },
    bloom: 0.8, exposure: 1.05, env: 0.6, envLights: [["#ff9ae0", 2]], drift: "sparkles",
  },
};

const JUNGLE: Palettes = {
  day: {
    sky: { zenith: "#5f9fb8", horizon: "#d8ecc8", glow: "#fff8c8", glowScale: 0.18, sun: { color: "#fff8d8", scale: 16, size: 0.035, halo: 0.9 }, clouds: 0.3, cloudColor: "#f4fff0" },
    fog: { color: "#b4d0a4", near: 14, far: 95 },
    hemi: { sky: "#d0f0c0", ground: "#3a4a20", intensity: 2.4 },
    sun: { color: "#fff2c0", intensity: 3.0, ...DAY_SUN },
    bloom: 0.3, exposure: 1.0, env: 0.3, envLights: [["#fff8c8", 2]], drift: "spores",
  },
  dusk: {
    sky: { zenith: "#3a4a6a", horizon: "#ffb070", glow: "#ffd08a", glowScale: 0.18, sun: { color: "#ffb070", scale: 10, size: 0.045, halo: 1 } },
    fog: { color: "#a8946a", near: 12, far: 85 },
    hemi: { sky: "#e0c890", ground: "#2a3018", intensity: 2.1 },
    sun: { color: "#ffb070", intensity: 2.4, ...DUSK_SUN },
    bloom: 0.4, exposure: 1.0, env: 0.3, envLights: [["#ffb070", 2]], drift: "spores",
  },
  night: {
    sky: { zenith: "#02080a", horizon: "#0a2420", glow: "#7dff9a", glowScale: 0.04, stars: 0.5, sun: { color: "#e0ffe8", scale: 3, size: 0.022, halo: 0.3 } },
    fog: { color: "#0a1e1a", near: 8, far: 60 },
    hemi: { sky: "#4a8a7a", ground: "#0a1a10", intensity: 2.4 },
    sun: { color: "#a0e0c0", intensity: 0.8, ...MOON },
    bloom: 0.8, exposure: 1.1, env: 0.3, envLights: [["#7dff9a", 1.5]], drift: "fireflies",
  },
};

const HOME: Palettes = {
  day: {
    sky: { zenith: "#9ec4e8", horizon: "#f6efe2", glow: "#fff4d8", glowScale: 0.08, sun: { color: "#fff6e0", scale: 18, size: 0.03, halo: 0.5 }, clouds: 0.3, cloudColor: "#ffffff" },
    fog: { color: "#efe2cc", near: 45, far: 210 },
    hemi: { sky: "#ffe8d0", ground: "#7a5a3a", intensity: 2.1 },
    sun: { color: "#ffe8c8", intensity: 2.4, ...DAY_SUN },
    bloom: 0.2, exposure: 0.88, env: 0.45, envLights: [["#fff4d8", 2.5], ["#ffd08a", 1.5]], drift: "motes",
  },
  dusk: {
    sky: { zenith: "#3a4a80", horizon: "#ffb48a", glow: "#ffc89a", glowScale: 0.12, sun: { color: "#ffa070", scale: 9, size: 0.04, halo: 0.7 } },
    fog: { color: "#d8b09a", near: 40, far: 190 },
    hemi: { sky: "#ffd0b0", ground: "#5a4030", intensity: 2.2 },
    sun: { color: "#ffb48a", intensity: 1.8, ...DUSK_SUN },
    bloom: 0.4, exposure: 1.0, env: 0.45, envLights: [["#ffc080", 2]], drift: "motes",
  },
  night: {
    sky: { zenith: "#050a18", horizon: "#1a2440", glow: "#ffc080", glowScale: 0.03, stars: 0.8, sun: { color: "#e8eeff", scale: 3, size: 0.025, halo: 0.3 } },
    fog: { color: "#141c2c", near: 30, far: 160 },
    hemi: { sky: "#7a80b0", ground: "#3a2a1a", intensity: 1.8 },
    sun: { color: "#a0b4ff", intensity: 0.7, ...MOON },
    bloom: 0.6, exposure: 1.05, env: 0.45, envLights: [["#ffc080", 2.5]], drift: "",
  },
};

function palettes(p: Pick): Palettes {
  switch (p.id) {
    case "neon": return NEON;
    case "grove": return GROVE;
    case "gallery": return p.variant === "underwater" ? { day: UNDERWATER, night: UNDERWATER } : GALLERY;
    case "desert": return p.variant === "underwater" ? { day: UNDERWATER, night: UNDERWATER } : p.variant === "beach" ? BEACH : DESERT;
    case "snow": return p.variant === "cave" ? { day: CAVE, night: CAVE } : SNOW;
    case "space": return p.variant === "moon" ? { day: MOONSCAPE, night: MOONSCAPE } : SPACE;
    case "haunted": return HAUNTED;
    case "medieval": return p.variant === "magic" ? MAGIC : MEDIEVAL;
    case "candy": return CANDY;
    case "jungle": return JUNGLE;
    case "home": return HOME;
  }
}

/** Each look's plain props. */
const PROP: Record<LookId, string> = {
  neon: "#22243a", grove: "#5a4632", gallery: "#2c2b30", desert: "#a8744a", snow: "#7a5a3e", space: "#4a5462",
  haunted: "#3a3036", medieval: "#7a5232", candy: "#ff8ac0", jungle: "#6a5a40", home: "#8a5a36",
};

/** Each look's floor underfoot. */
const FOOTING: Record<LookId, Footing> = {
  neon: "street", grove: "soft", gallery: "hard", desert: "sand", snow: "snow", space: "metal",
  haunted: "leaves", medieval: "stone", candy: "candy", jungle: "leaves", home: "wood",
};

/**
 * Bad weather over any look but the neon city's (whose rain is part of the look): a greyer sky,
 * the sun behind cloud, the fog drawn in; snow, dust and fog each thicken the air their own way.
 */
function weathered(s: Base, p: Pick): Base {
  const out = structuredClone(s) as Base;
  const grey = p.storm ? 0.72 : p.rain ? 0.55 : p.overcast ? 0.5 : 0;
  if (grey > 0) {
    const g = p.phase === "night" ? "#10141c" : p.phase === "dusk" ? "#5a5260" : "#8a929c";
    out.sky.zenith = mixHex(s.sky.zenith, g, grey);
    out.sky.horizon = mixHex(s.sky.horizon, g, grey * 0.8);
    out.sky.glowScale *= 0.5;
    out.sky.clouds = Math.max(s.sky.clouds ?? 0, 0.85);
    out.sky.cloudColor = mixHex(g, "#ffffff", p.phase === "night" ? 0.05 : 0.3);
    out.sky.stars = (s.sky.stars ?? 0) * 0.2;
    out.sky.aurora = 0;
    if (out.sky.sun) out.sky.sun = { ...out.sky.sun, scale: out.sky.sun.scale * 0.15, halo: out.sky.sun.halo * 0.5 };
    out.fog = { color: mixHex(s.fog.color || "#808080", g, grey * 0.7), near: s.fog.near * 0.6, far: s.fog.far * 0.62 };
    out.sun = { ...s.sun, intensity: s.sun.intensity * 0.45 };
    out.hemi = { ...s.hemi, sky: mixHex(s.hemi.sky, g, grey * 0.5) };
  }
  if (p.fog) out.fog = { ...out.fog, near: Math.max(4, out.fog.near * 0.35), far: Math.max(32, out.fog.far * 0.45) };
  if (p.snow) {
    out.fog = { color: mixHex(out.fog.color, p.phase === "night" ? "#1a2438" : "#c8d4e2", 0.5), near: out.fog.near * 0.5, far: out.fog.far * 0.55 };
    out.drift = "snow";
  }
  if (p.dust) {
    const sand = p.phase === "night" ? "#2a2018" : "#c99561";
    out.sky.zenith = mixHex(out.sky.zenith, sand, 0.7);
    out.sky.horizon = mixHex(out.sky.horizon, sand, 0.85);
    out.sky.clouds = 0;
    if (out.sky.sun) out.sky.sun = { ...out.sky.sun, scale: out.sky.sun.scale * 0.25 };
    out.fog = { color: sand, near: 4, far: 52 };
    out.sun = { ...out.sun, intensity: out.sun.intensity * 0.6 };
    out.drift = "sandstorm";
  }
  return out;
}

/** A world's look: what it is, lit for its time of day and weather. */
export function lookOf(b: WorldBundle, cue: Cue = cueOf(b)): LookStyle {
  const p = pickLook(cue);
  const set = palettes(p);
  let base = p.phase === "night" ? set.night : p.phase === "dusk" ? (set.dusk ?? set.day) : set.day;
  if (p.id !== "neon") base = weathered(base, p);
  else if (p.snow) base = { ...base, drift: "snow" };
  const indoor = p.indoor && p.id !== "neon";
  return {
    ...base,
    id: p.id,
    variant: p.variant,
    phase: p.phase,
    night: p.phase === "night",
    rain: p.rain,
    storm: p.storm,
    drift: base.drift ?? "",
    cutaway: indoor || p.id === "gallery", // the gallery has always looked down over its walls
    indoor,
    footing: p.rain && (p.id === "neon" || !indoor) && FOOTING[p.id] !== "metal" ? "wet" : p.variant === "underwater" ? "sand" : FOOTING[p.id],
    prop: PROP[p.id],
    pick: p,
  };
}
