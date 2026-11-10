// How a world moves you beyond walking, read from the bundle: a jetpack (or wings, a suit) on the
// player, water to swim in, or zero-g. The HUD shows the up and down controls only in such worlds,
// the touch controls add a dive button, and the bars read the sim's live fuel and breath.
import type { WorldBundle } from "@ghostrun/ir";
import { flightOf, watersOf, zeroG } from "@ghostrun/kits";
import { k } from "./i18n";

export interface WorldMoves {
  /** The player's own flight verb (jetpack, wings, suit), or "" for none. */
  fly: string;
  swim: boolean;
  zeroG: boolean;
}

/** What the world lets the player do beyond walking (null: an ordinary world, no extra controls). */
export function movesOf(b: Pick<WorldBundle, "verbs" | "entities" | "laws"> | null | undefined): WorldMoves | null {
  if (!b) return null;
  const f = flightOf(b, "player");
  const m: WorldMoves = { fly: f && f.id ? f.kind : "", swim: watersOf(b).length > 0, zeroG: zeroG(b.laws) };
  return m.fly || m.swim || m.zeroG ? m : null;
}

/** What Space and C do here, as keys the HUD translates: zero-g's thrust, else flight, else swimming. */
export function upDown(m: WorldMoves): { up: string; down: string } {
  if (m.zeroG) return { up: k("up"), down: k("down") };
  return { up: m.fly ? k("fly up") : k("swim up"), down: k("dive") };
}

/** The sim's live moves (SimWorld.moves). */
export interface LiveMoves {
  mode: "walk" | "fly" | "float" | "swim";
  kind: string;
  fuel: number;
  fuelMax: number;
  breath: number;
  breathMax: number;
}

/**
 * The bars to draw, each a share 0…1 (absent: no bar). Fuel shows while flying on a tank and until it
 * has filled again after a landing; breath only with the head under water where a breath runs out.
 */
export function meters(m: LiveMoves | null): { fuel?: number; breath?: number } {
  if (!m) return {};
  const out: { fuel?: number; breath?: number } = {};
  if (m.fuelMax > 0 && Number.isFinite(m.fuelMax) && (m.mode === "fly" || m.mode === "float" || m.fuel < m.fuelMax - 1e-6)) out.fuel = clamp01(m.fuel / m.fuelMax);
  if (m.mode === "swim" && m.breathMax > 0 && m.breath < m.breathMax - 1e-6) out.breath = clamp01(m.breath / m.breathMax);
  return out;
}

const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
