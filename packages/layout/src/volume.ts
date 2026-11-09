// The volume pack's media, made real when the fill left them out: the sky is crossed with a
// jetpack (no gap between its islands can be jumped), the lagoon is water you swim in (the zone
// the pack tags "lagoon" fills with a swimmable volume), and space has no gravity (the zero-g
// thrust law). Only for the volume pack; logged like every other placer repair.
import type { Entity, VerbBinding, WorldBundle } from "@ghostrun/ir";
import { DRIVE, FLY, SWIM } from "@ghostrun/kits";
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
  // nobody drives here: a vehicle a fill brought (a "jetpack" at the wheel, a boat) is scenery, and a
  // race is flown or swum (on foot, through its gates)
  const wheels = b.verbs.filter((v) => v.verb === DRIVE);
  if (wheels.length) {
    b.verbs = b.verbs.filter((v) => v.verb !== DRIVE);
    for (const e of b.entities) if (e.kind === "vehicle") ((e.kind = "prop"), (e.body = "none"));
    notes.push(`${wheels.map((v) => v.on).join(", ")}: no ${DRIVE} in the ${medium} (you ${medium === "water" ? "swim" : "fly"} the race yourself)`);
  }
  // a "requires jumps" promise means nothing where you fly or swim: it is a place to reach
  for (const x of b.expects.filter((e) => e.prop === "requires")) {
    notes.push(`${x.id}: requires ${x.need.join(", ") || "jumps"} → reachable (the ${medium} is crossed by ${medium === "water" ? "swimming" : "flying"}, not jumping)`);
    x.prop = "reachable";
    x.need = [];
  }
  if (medium === "water") {
    for (const spec of layout.zones.filter((z) => z.tag === "lagoon")) {
      const { min, max } = spec.bounds;
      const centre: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
      const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      // water a fill laid over the lagoon (on its surface anchor, any size): it is the lagoon's water, exactly
      let wet = false;
      for (const e of b.entities) {
        if (!has(SWIM, e.id) || Math.abs(e.pos[0] - centre[0]) > size[0] / 2 + 2 || Math.abs(e.pos[2] - centre[2]) > size[2] / 2 + 2) continue;
        if (e.pos.some((x, i) => Math.abs(x - centre[i]!) > 1e-6) || e.size.some((x, i) => Math.abs(x - size[i]!) > 1e-6)) notes.push(`${e.id}: the water fills the ${spec.slot} (${size.join("×")} m, its surface level with the shore)`);
        e.pos = centre;
        e.size = size;
        e.body = "sensor";
        wet = true;
      }
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
