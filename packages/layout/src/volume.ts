// The volume pack's media, made real when the fill left them out: the sky is crossed with a
// jetpack (no gap between its islands can be jumped), the lagoon is water you swim in (the zone
// the pack tags "lagoon" fills with a swimmable volume), and space has no gravity (the zero-g
// thrust law). Only for the volume pack; logged like every other placer repair.
import type { Entity, VerbBinding, WorldBundle } from "@ghostrun/ir";
import { FLY, SWIM } from "@ghostrun/kits";
import type { PackLayout, ZoneSpec } from "@ghostrun/plugin-api";

const MEDIA = ["sky", "water", "space"] as const;

/** The medium a volume world is in: its sub-zone (sky when it names none). */
export const volumeMedium = (sub: readonly string[]) => MEDIA.find((m) => sub.includes(m)) ?? "sky";

const ai = { src: "ai", layer: "gameplay" } as const;

export function repairVolume(b: WorldBundle, layout: PackLayout, bound: Map<string, ZoneSpec>): string[] {
  if (layout.packId !== "volume") return [];
  const notes: string[] = [];
  const medium = volumeMedium(b.pack.sub);
  const has = (verb: string, on?: string) => b.verbs.some((v) => v.verb === verb && (on === undefined || v.on === on));
  const fresh = (base: string) => {
    let id = base;
    for (let i = 2; [...b.entities, ...b.verbs, ...b.zones].some((x) => x.id === id); i++) id = `${base}_${i}`;
    return id;
  };
  if (medium === "sky" && !has(FLY, "player")) {
    const v: VerbBinding = { id: fresh("vb_jetpack"), ...ai, verb: FLY, on: "player", params: { kind: "jetpack", climb: 3, fuel: 6 }, signature: false };
    b.verbs.push(v);
    notes.push(`player: a jetpack (${FLY}: no gap between the islands can be jumped)`);
  }
  if (medium === "water") {
    for (const spec of layout.zones.filter((z) => z.tag === "lagoon")) {
      const { min, max } = spec.bounds;
      const centre: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      const wet = b.entities.some((e) => has(SWIM, e.id) && Math.abs(e.pos[0] - centre[0]) < (max[0] - min[0]) / 2 && Math.abs(e.pos[2] - centre[2]) < (max[2] - min[2]) / 2);
      if (wet) continue;
      const zone = [...bound].find(([, s]) => s.slot === spec.slot)?.[0] ?? b.zones[0]?.id ?? "";
      const e: Entity = {
        id: fresh("water"), ...ai, kind: "prop", zone, anchor: "", pos: centre, rotY: 0, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
        noun: "lagoon water", hyper: "water", asset: "", body: "sensor", shape: "box", team: "", tags: [], states: [], init: "", props: {},
      };
      b.entities.push(e);
      b.verbs.push({ id: fresh("vb_swim"), ...ai, verb: SWIM, on: e.id, params: { breath: 20 }, signature: false });
      notes.push(`${e.id}: the ${spec.slot} is water you swim in (${SWIM}, a breath of 20 s)`);
    }
  }
  if (medium === "space" && b.laws.gravityScale >= 0.05) {
    b.laws = { ...b.laws, gravityScale: 0, thrust: b.laws.thrust > 0 ? b.laws.thrust : 4 };
    notes.push("laws: zero-g in space (gravity 0, the thrust law at 4 m/s²)");
  }
  return notes;
}
