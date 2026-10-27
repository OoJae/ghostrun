// The one list of layout packs (and, as kits land, verbs) shared by the edge, the CLI and the web.
import { arena } from "@ghostrun/pack-arena";
import { cityBlock } from "@ghostrun/pack-city-block";
import { course } from "@ghostrun/pack-course";
import { floorPlan } from "@ghostrun/pack-floor-plan";
import { maze } from "@ghostrun/pack-maze";
import { outdoor } from "@ghostrun/pack-outdoor";
import type { LayoutPack } from "@ghostrun/plugin-api";

export interface PackEntry {
  id: string;
  blurb: string; // shown to the intent call
  subs: string[];
  impl: LayoutPack;
}

// Blurbs steer the intent LLM: each names its layout, then the prompts it fits. Keep them disjoint
// (races against the clock are `course`, not `city_block`; markets outdoors are `outdoor`).
export const PACKS: PackEntry[] = [
  { id: "city_block", blurb: "city streets between two team bases with an optional rooftop lane: capture the flag, team games, street chases, city scenes", subs: ["rooftop"], impl: cityBlock as unknown as LayoutPack },
  { id: "floor_plan", blurb: "single-storey interior at real scale (yard, entrance, main room, 4 side rooms): tours, indoor shops, galleries, museums, heists, homes", subs: [], impl: floorPlan as unknown as LayoutPack },
  { id: "arena", blurb: "walled symmetric field with cover, two team bases, hoops and raised side decks: duels, sports, team battles, ball games", subs: [], impl: arena as unknown as LayoutPack },
  { id: "maze", blurb: "seeded maze with a start pad, an exit and dead ends: mazes, labyrinths, escape and chase games", subs: [], impl: maze as unknown as LayoutPack },
  { id: "outdoor", blurb: "open nature terrain with paths from an entrance to a central clearing, a pond, a grove on a knoll, a camp, two side clearings (team bases) and a lookout reached only by jumping: forests (also glowing or bioluminescent), parks, gardens, islands, beaches, campsites, outdoor markets and fairs; exploring, nature walks, find-and-deliver quests, hide and seek, outdoor team games", subs: [], impl: outdoor as unknown as LayoutPack },
  { id: "course", blurb: "linear obstacle course from a start pad through 6 segments (a wall needing every jump, gaps, rising steps, narrow beams, a pit over lava) with checkpoints to a finish pad: parkour, platformers, obbies, obstacle courses, time trials, races against the clock", subs: [], impl: course as unknown as LayoutPack },
];

export function packFor(id: string): LayoutPack {
  return (PACKS.find((p) => p.id === id) ?? PACKS[0]!).impl;
}

export const ALL_SUBS = [...new Set(PACKS.flatMap((p) => p.subs))];
