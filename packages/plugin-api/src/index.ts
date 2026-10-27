// Plugin contracts (draft; freezes Thu 29 18:00 once the testkit is green on jump, double jump and
// city-block). Only the lead session edits this file.
import type { Laws, Static, Vec3 } from "@ghostrun/ir";

export type Params = Record<string, string | number | boolean>;

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** One addressable region of a pack: the fill names it by `slot`, entities name an `anchor` in it. */
export interface ZoneSpec {
  slot: string;
  tag: string;
  bounds: Aabb;
  floorY: number;
  anchors: Record<string, Vec3>;
}

/** Pack geometry before it is bound to the fill's zone ids. */
export type PackStatic = Omit<Static, "id" | "src" | "layer" | "zone"> & { zoneSlot: string };

export interface PackLayout {
  packId: string;
  version: string;
  zones: ZoneSpec[];
  statics: PackStatic[];
  cameraBounds: Aabb;
  notes: string[]; // e.g. "orrery: distances scaled"
}

export interface GenerateInput<P extends Params = Params> {
  seed: number;
  params: P;
  sub: string[]; // requested sub-zone packs, e.g. ["rooftop"]
  laws: Laws;
  harder: boolean; // relaxes the 0.8 × max-jump gap rule
}

export interface LayoutPack<P extends Params = Params> {
  id: string;
  version: string;
  modes: ("play" | "wander")[];
  defaults: P;
  /** Pure and deterministic: same input → same layout on every runtime. No trig, no Math.random. */
  generate(input: GenerateInput<P>): PackLayout;
  ci: { seeds: number[] };
}
