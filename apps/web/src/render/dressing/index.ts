// Each newer look's dressing: its statics' materials, its props and its horizon.
import type { WorldBundle } from "@ghostrun/ir";
import type { LookId, LookStyle } from "../looks";
import { dressCandy } from "./candy";
import type { Ctx, Dressed } from "./common";
import { dressDesert } from "./desert";
import { dressHaunted } from "./haunted";
import { dressHome } from "./home";
import { dressJungle } from "./jungle";
import { dressMedieval } from "./medieval";
import { dressSnow } from "./snow";
import { dressSpace } from "./space";

export const DRESS: Record<Exclude<LookId, "neon" | "grove" | "gallery">, (b: WorldBundle, look: LookStyle, c: Ctx) => Dressed> = {
  desert: dressDesert,
  snow: dressSnow,
  space: dressSpace,
  haunted: dressHaunted,
  medieval: dressMedieval,
  candy: dressCandy,
  jungle: dressJungle,
  home: dressHome,
};
