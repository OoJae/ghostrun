// The one list of layout packs (and, as kits land, verbs) shared by the edge, the CLI and the web.
import { arena } from "@ghostrun/pack-arena";
import { cityBlock } from "@ghostrun/pack-city-block";
import { course } from "@ghostrun/pack-course";
import { floorPlan } from "@ghostrun/pack-floor-plan";
import { maze } from "@ghostrun/pack-maze";
import { orrery } from "@ghostrun/pack-orrery";
import { outdoor } from "@ghostrun/pack-outdoor";
import { puzzleRooms } from "@ghostrun/pack-puzzle-rooms";
import { serviceVenue } from "@ghostrun/pack-service-venue";
import { stage } from "@ghostrun/pack-stage";
import { volume } from "@ghostrun/pack-volume";
import type { LayoutPack } from "@ghostrun/plugin-api";
import type { LayoutSchema } from "./layout";

export interface PackEntry {
  id: string;
  blurb: string; // shown to the intent call
  subs: string[];
  impl: LayoutPack;
}

// Blurbs steer the intent LLM: each names its layout, then the prompts it fits. Keep them disjoint
// (races against the clock are `course`, not `city_block`; markets outdoors are `outdoor`; a shop
// or café is `service_venue`, a house or gallery `floor_plan`; an escape room is `puzzle_rooms`, a
// maze `maze`). New packs go at the end: the order is the intent schema's enum.
export const PACKS: PackEntry[] = [
  { id: "city_block", blurb: "city streets between two team bases with an optional rooftop lane: capture the flag, team games, street chases, city scenes", subs: ["rooftop"], impl: cityBlock as unknown as LayoutPack },
  { id: "floor_plan", blurb: "single-storey interior at real scale (yard, entrance, main room, 4 side rooms): tours, showrooms, galleries, museums, heists, homes, offices", subs: [], impl: floorPlan as unknown as LayoutPack },
  { id: "arena", blurb: "walled symmetric field with cover, two team bases, hoops and raised side decks: duels, sports, team battles, ball games", subs: [], impl: arena as unknown as LayoutPack },
  { id: "maze", blurb: "seeded maze with a start pad, an exit and dead ends: mazes, labyrinths, escape and chase games", subs: [], impl: maze as unknown as LayoutPack },
  { id: "outdoor", blurb: "open nature terrain with paths from an entrance to a central clearing, a pond, a grove on a knoll, a camp, two side clearings (team bases) and a lookout reached only by jumping: forests (also glowing or bioluminescent), parks, gardens, islands, beaches, campsites, outdoor markets and fairs; exploring, nature walks, find-and-deliver quests, hide and seek, outdoor team games", subs: [], impl: outdoor as unknown as LayoutPack },
  { id: "course", blurb: "linear obstacle course from a start pad through 6 segments (a wall needing every jump, gaps, rising steps, narrow beams, a pit over lava) with checkpoints to a finish pad: parkour, platformers, obbies, obstacle courses, time trials, races against the clock", subs: [], impl: course as unknown as LayoutPack },
  { id: "service_venue", blurb: "a shop, café, restaurant, bar or bank floor at real scale (street, entrance, customer seating with tables, a counter with a till and a flap to the staff side, a back room or kitchen, a storeroom or vault behind it): cafés and coffee shops where you take or serve orders, restaurants, sushi and cocktail bars, bakeries, shops and boutiques with a counter, bank heists, robbing the till", subs: [], impl: serviceVenue as unknown as LayoutPack },
  { id: "puzzle_rooms", blurb: "a chain of 3-6 small rooms joined by doorways (gates and locked doors stand in them), each with a switch, a plate, a lever, a key spot and a chest, from an entrance to an exit: escape rooms, puzzle temples and tombs, lock-and-key and switch puzzles, room-by-room puzzle chains", subs: [], impl: puzzleRooms as unknown as LayoutPack },
  { id: "stage", blurb: "a theatre or concert hall (foyer, rows of seats, a pit, a raised stage with wings, backstage and a lighting rig): concerts and gigs, rock shows, magic shows, plays, ballets, talent shows, opera, comedy clubs, award nights", subs: [], impl: stage as unknown as LayoutPack },
  { id: "orrery", blurb: "the solar system laid out on a planetarium floor at scaled distances (the Sun in the middle, the eight planets on plinths round it, an entrance): solar system tours, planetariums, orreries, astronomy museums, collect-something-from-every-planet games", subs: [], impl: orrery as unknown as LayoutPack },
  { id: "volume", blurb: "worlds crossed through the air or water, not on foot; sub picks the medium: sky (floating islands and clouds, a jetpack), water (a beach, a lagoon and a sunken ship, swimming and diving), space (a station and asteroids in zero-g): flying, jetpacks, soaring, sky races, swimming, diving, underwater treasure, zero-g, spacewalks", subs: ["sky", "water", "space"], impl: volume as unknown as LayoutPack },
];

export function packFor(id: string): LayoutPack {
  return (PACKS.find((p) => p.id === id) ?? PACKS[0]!).impl;
}

export const ALL_SUBS = [...new Set(PACKS.flatMap((p) => p.subs))];

export { clampLayout, customOf, layoutChange, layoutOf, settleLayout, type LayoutSchema } from "./layout";

/** What a structural edit may set on a pack: its parameters and its sub-zones. */
export function schemaFor(id: string): LayoutSchema {
  const p = PACKS.find((x) => x.id === id) ?? PACKS[0]!;
  return { params: p.impl.schema ?? {}, subs: p.subs };
}

/** The edit model's line about a pack's layout op: what each number shapes, its range, and its sub-zones. */
export function layoutLine(id: string, params: Readonly<Record<string, string | number | boolean>>, sub: readonly string[]): string {
  const s = schemaFor(id);
  const nums = Object.entries(s.params).map(([k, sp]) => `${k} ${sp.min}-${sp.max} (now ${String(params[k])}: ${sp.line})`);
  return [...nums, ...(s.subs.length ? [`sub: any of ${s.subs.join(", ")} (now ${JSON.stringify(sub)})`] : [])].join("; ");
}
