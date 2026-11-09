// The one list of verbs: the fill LLM sees exactly these lines, the placer repairs bodies from
// them, and the simulation runs them. Core verbs (jump, carry, oscillate, tag_drop) live in the
// sim and have no hooks here.
import type { VerbPlugin } from "@ghostrun/plugin-api";
import { COMBAT } from "./combat";
import { FLIGHT } from "./flight";
import { HAZARDS } from "./hazards";
import { MOVEMENT } from "./movement";
import { PUZZLE } from "./puzzle";
import { VEHICLES } from "./vehicles";

const CORE: VerbPlugin[] = [
  { id: "locomotion.jump", line: 'player jump; params {"jumpsMax":1-3}; also set the law line', on: ["player"], params: { jumpsMax: { def: 1, min: 1, max: 3 } } },
  { id: "physics_props.carry", line: "on an item entity: an agent picks it up by touching it and carries it", on: ["pickup", "prop"], params: {} },
  { id: "motion_hazards.oscillate", line: 'on a platform: moves back and forth; params {"axis":"x"|"z","travel":metres,"period":seconds}', on: ["platform", "hazard", "prop"], params: { axis: { def: "x", one: ["x", "z"] }, travel: { def: 4, min: 0.5, max: 20 }, period: { def: 3, min: 0.5, max: 20 } } },
  { id: "combat_sport.tag_drop", line: 'on "player": touching an enemy carrier knocks the item loose; params {"radius":0.5-3}', on: ["player"], params: { radius: { def: 1.2, min: 0.5, max: 3 } } },
];

export const VERBS: readonly VerbPlugin[] = [...CORE, ...PUZZLE, ...HAZARDS, ...MOVEMENT, ...COMBAT, ...VEHICLES, ...FLIGHT];

const byId = new Map(VERBS.map((v) => [v.id, v]));

export function verb(id: string): VerbPlugin | undefined {
  return byId.get(id);
}

export { COMBAT, FLIGHT, HAZARDS, MOVEMENT, PUZZLE, VEHICLES };
export { DIVE, diveNeed, FLOAT_DEPTH, flightNeed, flightOf, FLY, FLY_K, HEAD_UP, SINK, SWIM, SWIM_DOWN, SWIM_K, SWIM_SPEED, SWIM_UP, waterAt, watersOf, zeroG, type Flight, type Water } from "./flight";
export { DRIVE, FEEL, feelOf, gatesOf, progress, TRACK, VEHICLE_KINDS, type Feel, type VehicleKind } from "./vehicles";
export { aim, BODY_HALF, BODY_RADIUS, HEALTH, MUZZLE_UP, segBody, segBox, SHOOT, SHOT_RADIUS } from "./combat";
