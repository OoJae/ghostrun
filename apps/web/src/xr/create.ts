// Making worlds from inside the headset, the parts that need no headset: the diorama's fit (the
// whole world as a model on a table in front of you, by scaling the play space up around it), what
// a hand's ray picks out in it, and which ways of saying a world this browser has. No three.js:
// the tests run these in Node.
import { t } from "../i18n";

export type V3 = readonly [number, number, number];

/** The model is about this wide (m) on the table. */
export const TABLE_M = 1.1;
/** And stands this far (m) in front of your eyes, and this far under them. */
const AHEAD_M = 0.55;
const UNDER_M = 0.55;
/** Never less than this many world metres to the play space's one: a small arena is still a model. */
const MIN_SCALE = 4;
/** A ray picks out what lies within this angle of it (rad): about 6°, a few centimetres on the table. */
export const PICK_CONE = 0.1;

/**
 * The play space onto the world, as the rig takes it: world = pos + turn(yaw) · scale · play.
 * The table stands where you look, the world's middle on it, its floor at table height, turned the
 * way you face now.
 */
export interface Diorama {
  scale: number;
  yaw: number;
  pos: [number, number, number];
  /** The table's middle in the play space (a new world of another size is fitted on the same table). */
  table: [number, number, number];
}

/** (x, z) turned by a yaw, as a three.js rotation.y turns it. */
export const turnXZ = (x: number, z: number, yaw: number): [number, number] => [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];

/**
 * Fit a world (its bounds, its floor) on a table in front of the head (`head` in the play space,
 * `headYaw` the head's heading in it); `yaw` is the rig's heading now, kept so the model is the
 * world as you were facing it. `table` refits a new world onto a table that already stands.
 */
export function dioramaFit(bounds: { min: V3; max: V3 }, floorY: number, head: V3, headYaw: number, yaw: number, table?: V3): Diorama {
  const w = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2], 1);
  const scale = Math.max(MIN_SCALE, w / TABLE_M);
  const at: [number, number, number] = table ? [table[0], table[1], table[2]] : [head[0] - Math.sin(headYaw) * AHEAD_M, Math.max(0.6, Math.min(1.05, head[1] - UNDER_M)), head[2] - Math.cos(headYaw) * AHEAD_M];
  const c = [(bounds.min[0] + bounds.max[0]) / 2, floorY, (bounds.min[2] + bounds.max[2]) / 2];
  const [tx, tz] = turnXZ(at[0] * scale, at[2] * scale, yaw);
  return { scale, yaw, pos: [c[0]! - tx, c[1]! - at[1] * scale, c[2]! - tz], table: at };
}

/** A play-space point in the world, through the diorama. */
export function toWorld(d: Diorama, p: V3): [number, number, number] {
  const [x, z] = turnXZ(p[0] * d.scale, p[2] * d.scale, d.yaw);
  return [d.pos[0] + x, d.pos[1] + p[1] * d.scale, d.pos[2] + z];
}

/** A world point in the play space (where the model shows it on the table). */
export function toPlay(d: Diorama, p: V3): [number, number, number] {
  const [x, z] = turnXZ((p[0] - d.pos[0]) / d.scale, (p[2] - d.pos[2]) / d.scale, -d.yaw);
  return [x, (p[1] - d.pos[1]) / d.scale, z];
}

/**
 * Of `points`, the one a ray (origin, unit direction) points at most nearly, within `cone` rad of
 * it and ahead of it; or null. Angles don't change with the diorama's scale, so this works the same
 * in the world's coordinates as in the play space's.
 */
export function aimed<T>(o: V3, d: V3, points: Iterable<{ key: T; at: V3 }>, cone = PICK_CONE): T | null {
  let best: T | null = null;
  let bestA = cone;
  for (const p of points) {
    const v = [p.at[0] - o[0], p.at[1] - o[1], p.at[2] - o[2]];
    const len = Math.hypot(v[0]!, v[1]!, v[2]!);
    if (len < 1e-6) continue;
    const cos = (v[0]! * d[0] + v[1]! * d[1] + v[2]! * d[2]) / len;
    if (cos <= 0) continue;
    const a = Math.acos(Math.min(1, cos));
    if (a < bestA || (a === bestA && best === null)) ((bestA = a), (best = p.key));
  }
  return best;
}

/** Ways this browser can take a world (or an edit) in the headset: speech, the headset's keyboard, and always the starters. */
export interface Ways {
  speech: boolean;
  keyboard: boolean;
}

/**
 * The headset's own keyboard: the Quest browser opens it for a focused text field during a
 * session. Nothing here can check that it did, so it is offered only there, and said as such.
 */
export const keyboardHere = (ua: string): boolean => /OculusBrowser|Quest/.test(ua);

/** The sheet's line under its title, honest about which of the ways this browser has. */
export function waysLine(w: Ways, holdGrip: boolean): string {
  if (w.speech && w.keyboard) return t("Say it (hold the left grip), type it, or pick one:");
  if (w.speech) return holdGrip ? t("Hold the left grip and say it, or pick one:") : t("Say it, or pick one:");
  if (w.keyboard) return t("This browser can't listen: type it (the headset's keyboard, if it opens), or pick one:");
  return t("This browser can't listen. Pick one:");
}

/** The watch's line for an edit: how it can be asked for here. */
export function editWaysLine(w: Ways, live: boolean): string {
  if (!live) return t("Edits in words need the live AI. The diorama still moves things.");
  if (w.speech) return t("Pick one, or hold the left grip and say a change.");
  return t("Pick one (this browser can't listen).");
}
