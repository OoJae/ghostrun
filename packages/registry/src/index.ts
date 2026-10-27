// The one list of layout packs (and, as kits land, verbs) shared by the edge, the CLI and the web.
import { arena } from "@ghostrun/pack-arena";
import { cityBlock } from "@ghostrun/pack-city-block";
import { floorPlan } from "@ghostrun/pack-floor-plan";
import { maze } from "@ghostrun/pack-maze";
import type { LayoutPack } from "@ghostrun/plugin-api";

export interface PackEntry {
  id: string;
  blurb: string; // shown to the intent call
  subs: string[];
  impl: LayoutPack;
}

export const PACKS: PackEntry[] = [
  { id: "city_block", blurb: "streets between two team bases with an optional rooftop lane: team games, races, chases, city scenes", subs: ["rooftop"], impl: cityBlock as unknown as LayoutPack },
  { id: "floor_plan", blurb: "single-storey interior at real scale (yard, entrance, main room, 4 side rooms): tours, shops, galleries, museums, heists, homes", subs: [], impl: floorPlan as unknown as LayoutPack },
  { id: "arena", blurb: "walled symmetric field with cover, two team bases, hoops and raised side decks: duels, sports, team battles, ball games", subs: [], impl: arena as unknown as LayoutPack },
  { id: "maze", blurb: "seeded maze with a start pad, an exit and dead ends: mazes, labyrinths, escape and chase games", subs: [], impl: maze as unknown as LayoutPack },
];

export function packFor(id: string): LayoutPack {
  return (PACKS.find((p) => p.id === id) ?? PACKS[0]!).impl;
}

export const ALL_SUBS = [...new Set(PACKS.flatMap((p) => p.subs))];
