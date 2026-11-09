// The placer: binds the fill's zones to a pack's slots and turns anchors into positions.
// The LLM chooses relations (zone + anchor), never coordinates (Holodeck/LayoutVLM lesson).
import { stream } from "@ghostrun/detmath";
import { groupMembers, type Effect, type Entity, type Rule, type Static, type Vec3, type VerbBinding, type WorldBundle, type Zone } from "@ghostrun/ir";
import { DRIVE, feelOf, HEALTH, SHOOT, TRACK, verb } from "@ghostrun/kits";
import type { PackLayout, ZoneSpec } from "@ghostrun/plugin-api";
import { repairFengShui } from "./fengshui";

export {
  ELEMENTS, FENG_SHUI_RULES, FENG_SHUI_SCHOOL, FENG_SHUI_SCHOOL_SOURCE, asksFengShui, elementsOf, fengShui, isCommanding, isMirror, repairFengShui, saysFengShui,
  type Element, type FengShuiFinding, type FengShuiFix, type FengShuiRule, type FengShuiRuleId, type FengShuiSection, type FengShuiSource, type FengShuiVars, type FengShuiVerdict,
} from "./fengshui";

/** Default physical sizes per entity kind, used when the fill gives none (all metres). */
export const KIND_SIZE: Partial<Record<Entity["kind"], Vec3>> = {
  spawn: [1.2, 0.1, 1.2],
  goal: [3, 3, 3],
  checkpoint: [3, 3, 3],
  plate: [1.5, 0.2, 1.5],
  pickup: [0.5, 0.5, 0.5],
  npc: [0.7, 1.8, 0.7],
  door: [1, 2.1, 0.2],
  switch: [0.4, 0.4, 0.2],
  platform: [2.4, 0.3, 2.4],
  sign: [3, 1.5, 0.2],
  vehicle: [2, 1.2, 4],
};

/** Packs whose anchors are named for one place each (a planet, the till): one a zone lacks is found in another. */
const NAMED_ANCHORS: ReadonlySet<string> = new Set(["service_venue", "puzzle_rooms", "stage", "orrery"]);

const isDefaultSize = (s: Vec3) => s[0] === 1 && s[1] === 1 && s[2] === 1;

/** Which of the pack's slots each of the fill's zones stands in: its own slot, else one with its tag, else any free one. */
export function bindZones(zones: Zone[], layout: PackLayout): Map<string, ZoneSpec> {
  const bound = new Map<string, ZoneSpec>();
  const used = new Set<string>();
  // exact slot match first, then tag match, then any unused spec
  for (const z of zones) {
    const spec = layout.zones.find((s) => s.slot === z.slot && !used.has(s.slot));
    if (spec) {
      bound.set(z.id, spec);
      used.add(spec.slot);
    }
  }
  for (const z of zones) {
    if (bound.has(z.id)) continue;
    const spec = layout.zones.find((s) => s.tag === z.tag && !used.has(s.slot)) ?? layout.zones.find((s) => !used.has(s.slot)) ?? layout.zones[0]!;
    bound.set(z.id, spec);
    used.add(spec.slot);
  }
  return bound;
}

export interface PlaceResult {
  bundle: WorldBundle;
  notes: string[];
}

/**
 * Pure and deterministic: positions depend only on the bundle, the layout and the world seed.
 * `reach`: a fresh fill nobody wrote laws for (lawsUnwritten), where a jump the win needs may be
 * allowed; never for laws someone wrote, an edit or a patch.
 */
export function placeWorld(input: WorldBundle, layout: PackLayout, opts: { reach?: boolean } = {}): PlaceResult {
  const b = structuredClone(input);
  const notes = [...layout.notes];
  const bound = bindZones(b.zones, layout);

  for (const z of b.zones) {
    const spec = bound.get(z.id)!;
    if (spec.slot !== z.slot) notes.push(`zone ${z.id}: slot '${z.slot}' not in ${layout.packId}, using '${spec.slot}'`);
    z.pack = layout.packId;
    z.slot = spec.slot;
  }
  b.pack = { ...b.pack, id: layout.packId, version: layout.version };

  // Statics: every pack static belongs to the fill zone bound to its slot, else the first zone.
  const zoneBySlot = new Map([...bound].map(([id, s]) => [s.slot, id]));
  const fallbackZone = b.zones[0]?.id ?? "z_root";
  b.statics = layout.statics.map((s, i): Static => ({
    id: `st_${String(i).padStart(3, "0")}`,
    src: "template",
    layer: "gameplay",
    zone: zoneBySlot.get(s.zoneSlot) ?? fallbackZone,
    shape: s.shape,
    pos: s.pos,
    rotY: s.rotY,
    size: s.size,
    surf: s.surf,
  }));

  // Entities: anchor → position; several entities on one anchor fan out across the line from the
  // anchor to the world centre (a teammate on the spawn pad must not stand in the player's way).
  const taken = new Map<string, number>();
  for (const e of b.entities) {
    if (isDefaultSize(e.size)) e.size = KIND_SIZE[e.kind] ?? e.size;
    const spec = bound.get(e.zone);
    if (!spec) continue;
    let base = spec.anchors[e.anchor];
    // a door is meant to guard a way through: "the gate in the east wall" stands in that doorway
    // (a robot's head slot made a door only so a part can unlock it stays where it was put)
    const doorish = /door|gate|hatch|portcullis|grate|shutter|entrance|exit|barrier|vault/.test(`${e.id} ${e.noun} ${e.hyper}`.toLowerCase());
    if (e.kind === "door" && doorish && (!e.anchor.startsWith("doorway_") || !spec.anchors[e.anchor])) {
      const doors = Object.keys(spec.anchors).filter((k) => k.startsWith("doorway_")).sort();
      const side = /^wall_([nsew])$/.exec(e.anchor)?.[1];
      const pick = (side && spec.anchors[`doorway_${side}`] ? `doorway_${side}` : undefined) ?? doors[0];
      if (pick) {
        notes.push(`${e.id}: door moved from '${e.anchor || "zone"}' to '${pick}' (doors stand in doorways)`);
        e.anchor = pick;
        base = spec.anchors[pick];
      }
    }
    // on a course, a hazard (thin ice, lava) anchored on a lane platform it nearly fills leaves no
    // way across: it goes below the walkway with the rest of the pit hazards
    if (base && e.kind === "hazard" && layout.packId === "course") {
      const [x, y, z] = base;
      const under = layout.statics.find((st) => st.surf !== "wall" && Math.abs(x - st.pos[0]) <= st.size[0] / 2 && Math.abs(z - st.pos[2]) <= st.size[2] / 2 && Math.abs(st.pos[1] + st.size[1] / 2 - y) < 0.3);
      if (under && under.pos[1] + under.size[1] / 2 > spec.floorY - 0.5 && Math.max(e.size[0], e.size[2]) >= 0.6 * Math.min(under.size[0], under.size[2])) {
        notes.push(`${e.id}: covers the lane platform it stood on (no way across), so it lies below the walkway`);
        base = undefined;
      }
    }
    if (!base && e.kind === "hazard") {
      // a hazard with no such anchor lies low: on a floor below this zone's walkway (a course's lava
      // under its platforms), never dropped across the way the route must go
      const { min, max } = spec.bounds;
      const [cx, cz] = [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2];
      const top = (st: (typeof layout.statics)[number]) => st.pos[1] + st.size[1] / 2;
      const below = layout.statics
        .filter((st) => (st.surf === "floor" || st.surf === "hazard") && top(st) < spec.floorY - 0.5 && Math.abs(cx - st.pos[0]) <= st.size[0] / 2 && Math.abs(cz - st.pos[2]) <= st.size[2] / 2)
        .sort((p, q) => top(p) - top(q) || p.pos[0] - q.pos[0] || p.pos[2] - q.pos[2])[0];
      if (below) {
        // on that floor, the nearest spot no pillar stands on (a course's platforms rise from it)
        const y = top(below);
        // too big to fit beside the pillars: it shrinks (2 m, then 1 m) rather than landing on the way
        let spot: [number, number] | null = null;
        for (const w of [Math.max(e.size[0], e.size[2]), 2, 1]) {
          const [sx, sz] = [Math.min(e.size[0], w), Math.min(e.size[2], w)];
          const [hx, hz] = [sx / 2 + 0.3, sz / 2 + 0.3];
          const clear = (x: number, z: number) =>
            Math.abs(x - below.pos[0]) <= below.size[0] / 2 - hx && Math.abs(z - below.pos[2]) <= below.size[2] / 2 - hz &&
            !layout.statics.some((st) => st !== below && st.pos[1] - st.size[1] / 2 < y + 0.5 && Math.abs(x - st.pos[0]) < st.size[0] / 2 + hx && Math.abs(z - st.pos[2]) < st.size[2] / 2 + hz);
          spot = clear(cx, cz) ? [cx, cz] : null;
          for (let ring = 1; ring <= 24 && !spot; ring++) {
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
              if (clear(cx + dx * ring * 0.5, cz + dz * ring * 0.5)) {
                spot = [cx + dx * ring * 0.5, cz + dz * ring * 0.5];
                break;
              }
            }
          }
          if (spot) {
            if (sx < e.size[0] || sz < e.size[2]) e.size = [sx, e.size[1], sz];
            break;
          }
        }
        if (spot) {
          base = [spot[0], y, spot[1]];
          notes.push(`${e.id}: anchor '${e.anchor || "zone"}' not in slot '${spec.slot}', laid on the floor below the walkway`);
        }
      }
    }
    // on the newer packs, an anchor the zone lacks that names one place in the whole layout (Saturn's
    // plinth put in an "outer planets" zone that stands on Jupiter's slot) is that place
    if (!base && e.anchor && NAMED_ANCHORS.has(layout.packId)) {
      const owners = layout.zones.filter((z) => z.anchors[e.anchor]);
      if (owners.length === 1) {
        base = owners[0]!.anchors[e.anchor];
        notes.push(`${e.id}: anchor '${e.anchor}' not in slot '${spec.slot}', placed at ${owners[0]!.slot}'s`);
      }
    }
    if (!base) {
      // no such anchor: a seeded spot in the zone on open floor (never inside a wall or a pillar)
      const r = stream(b.seed, `place:${e.id}`);
      const { min, max } = spec.bounds;
      const solid = layout.statics.filter((st) => st.pos[1] + st.size[1] / 2 > spec.floorY + 0.3);
      // (on the orrery's walkways in space, also somewhere with a walkway under it, not the void beside it)
      const grounded = layout.packId === "orrery";
      const ground = (x: number, z: number) => layout.statics.some((st) => (st.surf === "floor" || st.surf === "ledge") && Math.abs(st.pos[1] + st.size[1] / 2 - spec.floorY) < 0.35 && Math.abs(x - st.pos[0]) < st.size[0] / 2 - 0.6 && Math.abs(z - st.pos[2]) < st.size[2] / 2 - 0.6);
      const open = (x: number, z: number) => !solid.some((st) => Math.abs(x - st.pos[0]) < st.size[0] / 2 + 0.6 && Math.abs(z - st.pos[2]) < st.size[2] / 2 + 0.6) && (!grounded || ground(x, z));
      let pick: Vec3 | undefined;
      for (let k = 0; k < 40 && !pick; k++) {
        const x = min[0] + 1 + r() * (max[0] - min[0] - 2);
        const z = min[2] + 1 + r() * (max[2] - min[2] - 2);
        if (open(x, z)) pick = [x, spec.floorY, z];
      }
      base = pick ?? [(min[0] + max[0]) / 2, spec.floorY, (min[2] + max[2]) / 2];
      if (e.anchor) notes.push(`${e.id}: anchor '${e.anchor}' not in slot '${spec.slot}', placed in zone`);
    }
    // a standing hazard in a doorway (a laser grid across it) seals the room: under the lintel no
    // jump clears it. It stands just inside its own room instead, in front of the doorway, where it
    // can be jumped or walked around
    if (e.kind === "hazard" && e.anchor.startsWith("doorway_") && spec.anchors[e.anchor]) {
      const { min, max } = spec.bounds;
      const [cx, cz] = [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2];
      const [hx, hz] = [(max[0] - min[0]) / 2 || 1, (max[2] - min[2]) / 2 || 1];
      const ax = Math.abs(base[0] - cx) / hx >= Math.abs(base[2] - cz) / hz ? 0 : 2;
      const inward = Math.sign((ax === 0 ? cx : cz) - base[ax]) || 1;
      const moved: Vec3 = [base[0], base[1], base[2]];
      moved[ax] += inward * (e.size[ax] / 2 + 1.8); // room past the lintel for a run-up
      base = moved;
      notes.push(`${e.id}: moved off ${e.anchor} just inside ${e.zone} (in the doorway, the lintel leaves no room to jump it)`);
    }
    const key = `${spec.slot}/${e.anchor}`;
    const k = taken.get(key) ?? 0;
    taken.set(key, k + 1);
    const offset = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 1.6;
    const alongZ = Math.abs(base[0]) >= Math.abs(base[2]);
    // doors stand on the zone's floor even when the fill names a wall-height anchor
    if (e.kind === "door") base = [base[0], spec.floorY, base[2]];
    // places the player walks into stand on what's under them (a goal named after a wall-height
    // anchor such as a scoreboard would float out of reach); a ledge or rooftop keeps its height
    if ((e.kind === "goal" || e.kind === "checkpoint" || e.kind === "plate") && base[1] > spec.floorY + 0.05) {
      const [x, y, z] = base;
      const under = layout.statics.filter((st) => st.surf !== "wall" && Math.abs(x - st.pos[0]) <= st.size[0] / 2 && Math.abs(z - st.pos[2]) <= st.size[2] / 2 && st.pos[1] + st.size[1] / 2 <= y + 0.05);
      const top = Math.max(spec.floorY, ...under.map((st) => st.pos[1] + st.size[1] / 2));
      if (top < y - 0.05) {
        notes.push(`${e.id}: ${e.kind} lowered from ${Math.round(y * 10) / 10} m to ${Math.round(top * 10) / 10} m (it stood on nothing)`);
        base = [x, top, z];
      }
    }
    const solid = e.body === "fixed" || e.body === "kinematic" || e.body === "dynamic";
    // a course is built from its own pads, steps and gaps: a solid box a fill puts on the way only
    // blocks the jumps it was laid out for (moving platforms keep their collider and their verb)
    if (layout.packId === "course" && (e.kind === "platform" || e.kind === "prop") && solid && !b.verbs.some((v) => v.on === e.id && /oscillate|crumble|carry|jump_pad/.test(v.verb))) {
      e.body = "none";
      notes.push(`${e.id}: decor on the course (a solid ${e.kind} would block its jumps)`);
    }
    // signs are decor unless a rule needs to touch them; inspecting works by proximity
    if (e.kind === "sign" && solid && !b.rules.some((r) => r.when.b === e.id || r.when.a === e.id)) {
      e.body = "none";
      notes.push(`${e.id}: sign has no collider (decor)`);
    }
    // a solid prop never seals a corridor: clamp its footprint to what the pack allows
    if (layout.maxProp && e.kind !== "door" && e.kind !== "npc" && e.body !== "none" && e.body !== "sensor" && Math.max(e.size[0], e.size[2]) > layout.maxProp) {
      const k = layout.maxProp / Math.max(e.size[0], e.size[2]);
      e.size = [e.size[0] * k, e.size[1], e.size[2] * k];
      notes.push(`${e.id}: footprint shrunk to ${layout.maxProp} m (it would block a corridor)`);
    }
    // a slab lying on the floor stays low enough to step onto
    if ((e.kind === "platform" || e.kind === "plate") && e.body !== "kinematic" && !e.anchor.startsWith("gap") && base[1] <= spec.floorY + 0.01 && e.size[1] > 0.3) {
      e.size = [e.size[0], 0.3, e.size[2]];
      notes.push(`${e.id}: floor slab lowered to 0.3 m (walkable)`);
    }
    // Sensors and spawns sit on the floor; bodies rest with their centre half their height up.
    const lift = e.kind === "spawn" ? 0 : e.size[1] / 2;
    e.pos = alongZ ? [base[0], base[1] + lift, base[2] + offset] : [base[0] + offset, base[1] + lift, base[2]];
    // a door in an east/west wall's doorway turns to fill the gap across z (a doorway named for its
    // way, not its side, as the puzzle rooms' doorway_in and doorway_out: its lintel says which way the wall runs)
    if (e.kind === "door" && e.size[0] > e.size[2] && (/^doorway_[ew]$/.test(e.anchor) || (!/^doorway_[ns]$/.test(e.anchor) && e.anchor.startsWith("doorway_") && lintelAlongZ(layout, base)))) e.size = [e.size[2], e.size[1], e.size[0]];
    // a place you walk (or carry things) into stands clear of walls and ledges: a goal anchored
    // to a scoreboard hangs half in the wall beside a deck, and the only ground "in" it is the deck
    // top, too high to carry a flag in. It moves toward the zone's middle until nothing solid
    // overlaps it
    if ((e.kind === "goal" || e.kind === "checkpoint" || e.kind === "plate") && e.body === "sensor" && !e.anchor.startsWith("gap")) {
      const floor = e.pos[1] - e.size[1] / 2;
      const blocks = (x: number, z: number) =>
        layout.statics.some((st) => st.pos[1] + st.size[1] / 2 > floor + 0.5 && st.pos[1] - st.size[1] / 2 < floor + 2 && Math.abs(x - st.pos[0]) < (st.size[0] + e.size[0]) / 2 + 0.1 && Math.abs(z - st.pos[2]) < (st.size[2] + e.size[2]) / 2 + 0.1);
      if (blocks(e.pos[0], e.pos[2])) {
        const { min, max } = spec.bounds;
        const [cx, cz] = [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2];
        const len = Math.sqrt((cx - e.pos[0]) * (cx - e.pos[0]) + (cz - e.pos[2]) * (cz - e.pos[2])) || 1;
        let k = 1;
        for (; k <= 40 && blocks(e.pos[0] + ((cx - e.pos[0]) / len) * k * 0.5, e.pos[2] + ((cz - e.pos[2]) / len) * k * 0.5); k++);
        if (k <= 40) {
          e.pos = [e.pos[0] + ((cx - e.pos[0]) / len) * k * 0.5, e.pos[1], e.pos[2] + ((cz - e.pos[2]) / len) * k * 0.5];
          notes.push(`${e.id}: moved ${k * 0.5} m off the wall (a wall or ledge stood in it)`);
        }
      }
    }
  }
  // a world that says it is Feng Shui follows the Form School's room rules where moving decor can
  notes.push(...repairFengShui(b, layout.zones, bound));
  // wins first: a win rule the repairs add (reach the goal) gets the same trigger and verb repairs
  notes.push(...repairDoubleDoors(b), ...repairSpawnRefs(b), ...repairGroups(b), ...repairRingOut(b, bound), ...repairAreas(b, bound), ...repairCombat(b), ...repairSentries(b), ...repairKits(b), ...repairConditions(b), ...repairRace(b, layout), ...repairRiders(b), ...repairWin(b), ...(opts.reach ? repairReach(b) : []), ...repairTriggers(b), ...repairVerbs(b), ...repairExpects(b));
  notes.push(...addRivals(b), ...placeRace(b, layout, bound), ...repairDeliveries(b, layout, bound), ...addSecrets(b, layout, bound));
  return { bundle: b, notes };
}

/**
 * Something you must carry into a place never starts inside it (the chest on the goal's own anchor:
 * no "enter" ever happens). It moves to the nearest free anchor something stands on, outside the
 * place. Logged.
 */
export function repairDeliveries(b: WorldBundle, layout: PackLayout, bound: Map<string, ZoneSpec>): string[] {
  const notes: string[] = [];
  const inside = (p: Vec3, s: Entity) => Math.abs(p[0] - s.pos[0]) < s.size[0] / 2 + 0.5 && Math.abs(p[2] - s.pos[2]) < s.size[2] / 2 + 0.5 && Math.abs(p[1] - s.pos[1]) < s.size[1] / 2 + 1;
  const standable = (p: Vec3) => layout.statics.some((st) => st.surf !== "wall" && Math.abs(p[0] - st.pos[0]) <= st.size[0] / 2 && Math.abs(p[2] - st.pos[2]) <= st.size[2] / 2 && Math.abs(st.pos[1] + st.size[1] / 2 - p[1]) < 0.3);
  // you lose leaving a place (the bridge, the ring): you start inside it
  for (const r of b.rules) {
    if (r.when.t !== "exit" || r.when.a !== "player" || !r.then.some((e) => e.e === "lose")) continue;
    const place = b.entities.find((e) => e.id === r.when.b);
    const sp = b.entities.find((e) => e.kind === "spawn" && e.team === (b.entities.some((x) => x.kind === "spawn" && x.team === "red") ? "red" : e.team));
    if (!place || !sp || inside([sp.pos[0], sp.pos[1] + 0.9, sp.pos[2]], place)) continue;
    sp.pos = [place.pos[0], place.pos[1] - place.size[1] / 2, place.pos[2]];
    sp.zone = place.zone;
    notes.push(`${sp.id}: you lose leaving ${place.id}, so you start inside it`);
  }
  // someone a rule waits to see leave a place (knocked out of a ring) starts inside it
  let k = 0;
  for (const r of b.rules) {
    if (r.when.t !== "exit") continue;
    const who = b.entities.find((e) => e.id === r.when.a && e.kind === "npc");
    const place = b.entities.find((e) => e.id === r.when.b);
    // well inside (a rival 0.1 m past the edge was never in it, so it can never leave)
    const wellIn = (p: Vec3, s: Entity) => Math.abs(p[0] - s.pos[0]) < s.size[0] / 2 - 0.4 && Math.abs(p[2] - s.pos[2]) < s.size[2] / 2 - 0.4 && Math.abs(p[1] - s.pos[1]) < s.size[1] / 2 + 1;
    if (!who || !place || wellIn(who.pos, place)) continue;
    const off = ((k++ % 3) - 1) * Math.min(1.6, place.size[0] / 4);
    who.pos = [place.pos[0] + off, place.pos[1] - place.size[1] / 2 + who.size[1] / 2, place.pos[2] + (k % 2 ? 1 : -1) * Math.min(1.6, place.size[2] / 4)];
    who.zone = place.zone;
    notes.push(`${who.id}: must be able to leave ${place.id}, so it starts inside it`);
  }
  for (const r of b.rules) {
    if (r.when.t !== "enter" || r.when.a === "player") continue;
    const item = b.entities.find((e) => e.id === r.when.a);
    const place = b.entities.find((e) => e.id === r.when.b);
    if (!item || !place || item.kind === "npc" || !inside(item.pos, place)) continue;
    const best = freeAnchor(item, (p) => inside(p, place));
    if (!best) continue;
    notes.push(`${item.id}: started inside ${place.id}, where it must be carried: moved to ${best.zone}:${best.anchor}`);
    moveTo(item, best);
  }
  // a hazard you lose by touching (a lake bank, a spike strip) that covers a place the win needs you
  // to reach (the finish, a gate, a buoy to pass) shrinks round its centre until it no longer does
  // (something to pick up or use is moved instead, below)
  const wanted = winNeeds(b);
  const needs = b.entities.filter((e) => (e.kind === "goal" || e.kind === "checkpoint") && wanted.has(e.id));
  for (const h of b.entities.filter((e) => e.kind === "hazard" && e.body === "sensor")) {
    if (!b.rules.some((r) => (r.when.t === "hit" || r.when.t === "enter") && r.when.b === h.id && (r.when.a === "player" || !r.when.a) && r.then.some((e) => e.e === "lose"))) continue;
    const covers = () => needs.filter((n) => n !== h && Math.abs(n.pos[0] - h.pos[0]) < (n.size[0] + h.size[0]) / 2 && Math.abs(n.pos[2] - h.pos[2]) < (n.size[2] + h.size[2]) / 2);
    const under = covers();
    if (!under.length) continue;
    const was = h.size;
    for (let k = 0; k < 6 && covers().length && Math.max(h.size[0], h.size[2]) > 0.6; k++) h.size = [Math.max(0.6, h.size[0] / 2), h.size[1], Math.max(0.6, h.size[2] / 2)];
    notes.push(`${h.id}: shrunk from ${was[0]}×${was[2]} m to ${h.size[0]}×${h.size[2]} m (it covered ${under.map((n) => n.id).join(", ")}, which the win needs)`);
  }
  // something you need (a pickup, something to use) never starts inside a place you lose by entering
  // (the only wand in the middle of the fall zone): it moves to the nearest free anchor outside them all
  const losing = b.entities.filter((s) => s.body === "sensor" && b.rules.some((r) => r.when.t === "enter" && r.when.a === "player" && r.when.b === s.id && r.then.some((e) => e.e === "lose")));
  for (const item of losing.length ? b.entities : []) {
    const needed = item.kind === "pickup" || b.verbs.some((v) => v.on === item.id && verb(v.verb)?.use);
    const zone = needed && item.kind !== "npc" && !losing.includes(item) ? losing.find((s) => inside(item.pos, s)) : undefined;
    if (!zone) continue;
    const best = freeAnchor(item, (p) => losing.some((s) => inside(p, s)));
    if (!best) continue;
    notes.push(`${item.id}: started inside ${zone.id}, where you lose: moved to ${best.zone}:${best.anchor}`);
    moveTo(item, best);
  }
  return notes;

  /** The free standable anchor nearest the item (never a doorway, spawn or goal) that isn't to be avoided. */
  function freeAnchor(item: Entity, avoid: (p: Vec3) => boolean): { zone: string; anchor: string; pos: Vec3 } | null {
    const used = new Set(b.entities.map((e) => `${e.zone}/${e.anchor}`));
    let best: { zone: string; anchor: string; pos: Vec3; d: number } | null = null;
    for (const z of b.zones) {
      const spec = bound.get(z.id);
      if (!spec) continue;
      for (const [anchor, pos] of Object.entries(spec.anchors)) {
        if (used.has(`${z.id}/${anchor}`) || /^(doorway|spawn|goal)/.test(anchor) || !standable(pos) || avoid(pos)) continue;
        const d = (pos[0] - item.pos[0]) * (pos[0] - item.pos[0]) + (pos[2] - item.pos[2]) * (pos[2] - item.pos[2]);
        if (!best || d < best.d || (d === best.d && z.id + anchor < best.zone + best.anchor)) best = { zone: z.id, anchor, pos, d };
      }
    }
    return best;
  }
  function moveTo(item: Entity, at: { zone: string; anchor: string; pos: Vec3 }) {
    item.zone = at.zone;
    item.anchor = at.anchor;
    item.pos = [at.pos[0], at.pos[1] + item.size[1] / 2, at.pos[2]];
  }
}

/** Weapons someone holds (on a thing to pick up, not "player" or a character's own). */
const heldWeapons = (b: WorldBundle) => new Set(b.verbs.filter((v) => v.verb === SHOOT && b.entities.some((e) => e.id === v.on && e.kind !== "npc")).map((v) => v.on));

/**
 * Fights, wired so they can be won and lost (each repair logged):
 * - a weapon or hit points bound on a team or a group ("team:blue", "zombies") is one per member;
 * - a character with props.hp has those hit points; anything a rule wears down, damages or heals
 *   gets 100 if it has none;
 * - "the player hits rival_1" (no hazard, no weapon of its own) with the player armed means
 *   rival_1 is hit by the player's shot (before the kits read it as tagging them); with a weapon of
 *   its own, a loss is its shot hitting you;
 * - a hit "by" a team is someone hit, on the side the rule's effect says;
 * - knock-outs that lead nowhere beside a win for one more knock-out: the win needs them all;
 * - a player who can be knocked out for good, with no rule for it, loses then (unless any hit
 *   already loses).
 */
/**
 * An armed character written with no menu (the castle's archers, the bandits on the street) is a
 * sentry: the bots have it fire back from where it stands, at half its weapon's rate, holding fire
 * on a player down to a quarter of their hit points; here its shot is capped at a quarter of the
 * player's hit points, so no one shot from a sentry decides the game. Logged.
 */
export function repairSentries(b: WorldBundle): string[] {
  const mine = b.verbs.find((v) => v.verb === HEALTH && v.on === "player");
  if (!mine) return [];
  const yours = Math.min(1000, Math.max(1, Number(mine.params.hp ?? 100) || 100));
  const menu = new Set(b.cast.filter((c) => c.menu.length).map((c) => c.npc));
  const notes: string[] = [];
  for (const v of b.verbs) {
    const e = b.entities.find((x) => x.id === v.on);
    if (v.verb !== SHOOT || !e || e.kind !== "npc" || menu.has(e.id)) continue;
    const dmg = Number(v.params.damage ?? 25);
    if (!(dmg > yours / 4)) continue;
    v.params = { ...v.params, damage: Math.floor(yours / 4) };
    notes.push(`${e.id}: a sentry (armed, no menu), its shot capped at ${Math.floor(yours / 4)} of your ${yours} hit points`);
  }
  return notes;
}

export function repairCombat(b: WorldBundle): string[] {
  const notes: string[] = [];
  const spawnOf = (t: string) => b.entities.some((e) => e.kind === "spawn" && e.team === t);
  const mine = !spawnOf("red") && spawnOf("blue") ? "blue" : "red";
  const npcsOn = (team: string) => b.entities.filter((e) => e.kind === "npc" && e.team === team).map((e) => e.id);
  const members = (ref: string): string[] => {
    if (ref.startsWith("team:")) return [...(ref === `team:${mine}` ? ["player"] : []), ...npcsOn(ref.slice(5))];
    if (ref === "player" || b.entities.some((e) => e.id === ref)) return [ref];
    return groupMembers(ref, b.entities);
  };
  // one per member
  for (const v of [...b.verbs]) {
    if ((v.verb !== SHOOT && v.verb !== HEALTH) || v.on === "player" || b.entities.some((e) => e.id === v.on)) continue;
    const ms = members(v.on);
    if (!ms.length) continue;
    b.verbs.splice(b.verbs.indexOf(v), 1);
    for (const m of ms) if (!b.verbs.some((x) => x.verb === v.verb && x.on === m)) b.verbs.push({ ...structuredClone(v), id: uniqueId(b, `${v.id}_${m}`), on: m });
    notes.push(`${v.id}: ${v.verb} on '${v.on}' means each of ${ms.join(", ")}`);
  }
  const hasHp = (id: string) => b.verbs.some((v) => v.verb === HEALTH && v.on === id);
  for (const e of b.entities) {
    const n = Number(e.props.hp ?? e.props.health ?? Number.NaN);
    if (!["npc", "prop", "vehicle"].includes(e.kind) || !(n > 0) || hasHp(e.id)) continue;
    b.verbs.push(vb(uniqueId(b, `vb_hp_${e.id}`), HEALTH, e.id, { hp: n }));
    notes.push(`${e.id}: props.hp ${n} → combat_sport.health`);
  }
  const need = new Set<string>();
  for (const r of b.rules) {
    if (r.when.t === "health_lte" && r.when.a) need.add(r.when.a);
    for (const e of r.then) if (e.e === "damage" || e.e === "heal") need.add(e.target);
    for (const c of r.if) if (/^[a-z][a-z0-9_]*\.hp$/.test(c.l)) need.add(c.l.split(".")[0]!);
  }
  for (const ref of [...need].sort()) {
    const ms = members(ref).filter((id) => !hasHp(id));
    for (const id of ms) b.verbs.push(vb(uniqueId(b, `vb_hp_${id}`), HEALTH, id));
    if (ms.length) notes.push(`${ms.join(", ")}: a rule wears ${ref} down, so ${ms.length > 1 ? "they have" : "it has"} 100 hit points`);
  }
  // something a rule wants shot (a reactor core, a training dummy) is something to aim at
  const held = heldWeapons(b);
  const guns = b.verbs.filter((v) => v.verb === SHOOT && (v.on === "player" || held.has(v.on)));
  // (and one a rule wants worn down is something to throw the stars at)
  const stars = b.verbs.filter((v) => v.verb === "combat_sport.throw");
  // (never one a rule you lose by wears down: your own ship, the crystal you defend)
  for (const r of b.rules) {
    const e = (r.when.t === "hit" || r.when.t === "health_lte") && (!r.when.b || guns.some((g) => g.on === r.when.b)) && !r.then.some((x) => x.e === "lose") ? b.entities.find((x) => x.id === r.when.a && x.kind !== "npc") : undefined;
    if (!e) continue;
    for (const g of [...guns, ...(r.when.t === "health_lte" ? stars : [])]) {
      const at = String(g.params.at ?? "").split(",").filter(Boolean);
      if (at.includes(e.id)) continue;
      g.params = { ...g.params, at: [...at, e.id].join(",") };
      notes.push(`${e.id}: something to ${g.verb === SHOOT ? "shoot" : "throw"} at with ${g.on === "player" ? "your weapon" : g.on} (rule ${r.id} waits for it to be ${r.when.t === "hit" ? "hit" : "worn down"})`);
    }
  }
  const them = mine === "red" ? "blue" : "red";
  // "red scores when the player hits team:blue" (a team where the weapon goes): models name the shooter
  // and the side shot either way round, so the rule's effect says who was hit: a point or a win for
  // your side is a rival hit, anything else is your side hit (you, for a loss)
  for (const r of b.rules) {
    const w = r.when;
    if (w.t !== "hit" || !/^team:(red|blue)$/.test(w.b)) continue;
    const ours = r.then.some((e) => (e.e === "score" && e.target === `team:${mine}`) || e.e === "win");
    const hit = ours ? `team:${them}` : r.then.some((e) => e.e === "lose") ? "player" : `team:${mine}`;
    notes.push(`rule ${r.id}: '${w.a || "anyone"} hits ${w.b}' names a team where the weapon goes; it means ${hit === "player" ? "you" : hit} hit (hit a=${hit})`);
    [w.a, w.b] = [hit, ""];
  }
  // "red scores when the player hits with gun_blue" (hit a=player b=a weapon you fire): your own shot
  // never hits you, so a point (or a win) for your side means a rival hit (by whichever weapon you
  // have: models mix up whose gun is whose), and one for the other side means you were hit
  const own = new Set(guns.map((g) => g.on));
  // (rivals on the other team, or none yet: the ones added for a shooting game are; else teamless ones)
  const rivals = b.entities.some((e) => e.kind === "npc" && e.team === them) || !b.entities.some((e) => e.kind === "npc" && e.team !== mine) ? `team:${them}` : "";
  for (const r of b.rules) {
    const w = r.when;
    if (w.t !== "hit" || w.a !== "player" || !own.has(w.b)) continue;
    const ours = r.then.some((e) => (e.e === "score" && e.target === `team:${mine}`) || e.e === "win");
    notes.push(`rule ${r.id}: the player 'hit' by ${w.b}, a weapon you fire, means ${ours ? `a rival hit by your shot (hit a=${rivals || "anyone"})` : "you hit by a rival's shot (hit a=player)"}`);
    [w.a, w.b] = ours ? [rivals, ""] : ["player", ""];
  }
  // "blue scores when blue is hit" (in a shooting game, a team scoring for its own people being hit):
  // the model swapped who hit whom; it means the other side hit, by anything
  for (const r of guns.length ? b.rules : []) {
    const w = r.when;
    const side = w.t !== "hit" || (w.b && !own.has(w.b)) ? "" : w.a.startsWith("team:") ? w.a.slice(5) : (b.entities.find((e) => e.id === w.a && e.kind === "npc")?.team ?? "");
    const pts = r.then.filter((e) => e.e === "score");
    if (!side || !pts.length || !pts.every((e) => e.target === `team:${side}`)) continue;
    const other = side === "red" ? "blue" : "red";
    notes.push(`rule ${r.id}: ${side} scoring when its own are hit means ${other} hit (hit a=team:${other})`);
    [w.a, w.b] = [`team:${other}`, ""];
  }
  // "knock out three dummies, then beat the sensei", "outdraw three bandits", written as knock-outs
  // that lead nowhere (they only mark or remove who went down, and nothing reads that) beside a
  // win for knocking out one more: the win is for knocking them all out, whoever goes down last
  // (one copy of the win per member, each needing the others down: no order to get wrong)
  const someone = (id: string) => id !== "player" && b.entities.some((e) => e.id === id);
  const reads = (id: string) => b.rules.some((r) => (r.when.t === "state_is" && r.when.a === id) || r.if.some((c) => c.l.startsWith(`${id}.`)));
  const win = b.rules.find((r) => r.when.t === "health_lte" && r.when.n <= 0 && someone(r.when.a) && !r.if.length && r.then.some((e) => e.e === "win"));
  const nowhere = win ? b.rules.filter((r) => r !== win && r.when.t === "health_lte" && r.when.n <= 0 && someone(r.when.a) && r.when.a !== win.when.a && hasHp(r.when.a) && !reads(r.when.a) && r.then.every((e) => e.e === "emit" || ((e.e === "set_state" || e.e === "destroy") && e.target === r.when.a))) : [];
  const downs = [...new Set(nowhere.map((r) => r.when.a))].sort();
  if (win && downs.length && downs.length <= 4) {
    const all = [win.when.a, ...downs];
    const others = (id: string) => all.filter((x) => x !== id).map((x) => ({ l: `${x}.hp`, op: "lte" as const, r: 0, forS: 0 }));
    for (const id of downs) b.rules.push({ ...structuredClone(win), id: uniqueId(b, `${win.id}_${id}`), when: { ...win.when, a: id }, if: others(id) });
    win.if = others(win.when.a);
    notes.push(`rule ${win.id}: knocking out ${downs.join(", ")} leads nowhere, so the win is for knocking out all of ${all.join(", ")}, whoever goes down last (${all.length} rules)`);
  }
  // "IF the archer's hp is 0": it stays down (a knock-out it comes back from never meets that)
  for (const r of b.rules) {
    for (const c of r.if) {
      const id = /^([a-z][a-z0-9_]*)\.hp$/.exec(c.l)?.[1];
      const v = id && (c.op === "eq" || c.op === "lte") && Number(c.r) <= 0 ? b.verbs.find((x) => x.verb === HEALTH && x.on === id) : undefined;
      if (!v || v.params.respawn === false || v.params.respawn === "false") continue;
      v.params = { ...v.params, respawn: false };
      notes.push(`${id}: rule ${r.id} needs it down (hp ${c.op} ${String(c.r)}), so it doesn't come back`);
    }
  }
  // "the player hits rival_1": rival_1 shot by the player (when rival_1 shoots back, only a rule
  // that is good for you: otherwise it is rival_1's shot hitting you, as written)
  const armed = guns.length > 0;
  for (const r of b.rules) {
    const w = r.when;
    const npc = armed && w.t === "hit" && w.a === "player" ? b.entities.find((e) => e.id === w.b && e.kind === "npc") : undefined;
    const good = r.then.some((e) => e.e === "win" || (e.e === "score" && e.target === `team:${mine}`) || (e.e === "damage" && e.target === npc?.id));
    if (!npc || b.verbs.some((v) => v.on === npc.id && v.verb === "motion_hazards.hazard") || (b.verbs.some((v) => v.on === npc.id && v.verb === SHOOT) && !good)) continue;
    [w.a, w.b] = [npc.id, ""];
    notes.push(`rule ${r.id}: the player hitting ${npc.id} means shooting them (hit a=${npc.id})`);
  }
  // knocked out for good with nothing said about it: that's the end of the run
  const hp = b.verbs.find((v) => v.verb === HEALTH && v.on === "player");
  const forGood = hp && (hp.params.respawn === false || hp.params.respawn === "false");
  const said = b.rules.some((r) => r.when.t === "health_lte" && (r.when.a === "player" || r.when.a === `team:${mine}`) && r.then.some((e) => e.e === "lose" || e.e === "reset" || e.e === "heal"));
  // (nor when any hit from anyone who can hurt you already loses: a knock-out never comes first)
  const losesOnHit = (id: string) => b.rules.some((r) => r.when.t === "hit" && (r.when.a === "player" || r.when.a === `team:${mine}`) && (!r.when.b || r.when.b === id) && !r.if.length && r.then.some((e) => e.e === "lose"));
  const hurters = b.entities.filter((e) => e.kind === "npc" && e.team !== mine && b.verbs.some((v) => v.on === e.id && v.verb === SHOOT)).map((e) => e.id);
  const hurt = b.rules.some((r) => r.then.some((e) => e.e === "damage" && (e.target === "player" || e.target === `team:${mine}`)));
  const first = hurters.length > 0 && !hurt && hurters.every(losesOnHit);
  if (b.mode === "play" && forGood && !said && !first) {
    b.rules.push({ id: uniqueId(b, "r_knocked_out"), src: "template", layer: "gameplay", when: { t: "health_lte", a: "player", b: "", s: "", n: 0, act: "" }, if: [], then: [fx("lose", "player")], once: true, cooldownS: 0, prio: 0 });
    notes.push("added r_knocked_out: you can be knocked out for good, so that loses");
  }
  return notes;
}

/**
 * A throwing or shooting game with no one to throw at or shoot (a snowball fight whose fill forgot
 * the other team) gets two rivals at the rival spawn, playing the usual rival options; in a
 * shooting game they are armed (half the player's damage, a third as often: the two together fire less than you) and have hit points.
 * Logged.
 */
export function addRivals(b: WorldBundle): string[] {
  // a throwing game with nothing to throw at needs rivals; one with pins or cans to hit doesn't
  const held = heldWeapons(b);
  const guns = b.verbs.filter((v) => v.verb === SHOOT && (v.on === "player" || held.has(v.on)));
  const throws = [...b.verbs.filter((v) => v.verb === "combat_sport.throw"), ...guns];
  // (a "things to hit" list counts only for things in the world: "at":"player_blue" names nobody)
  if (b.mode !== "play" || !throws.length || throws.every((v) => String(v.params.at ?? "").split(",").some((id) => b.entities.some((e) => e.id === id)))) return [];
  const spawnOf = (t: string) => b.entities.find((e) => e.kind === "spawn" && e.team === t);
  const mine = !spawnOf("red") && spawnOf("blue") ? "blue" : "red";
  const them = mine === "red" ? "blue" : "red";
  if (b.entities.some((e) => e.kind === "npc" && e.team !== mine)) return [];
  const at = spawnOf(them) ?? b.entities.find((e) => e.kind === "spawn" && e.team !== mine);
  const home = at?.pos ?? [0, 0, 0];
  const menu = ["rival.attack", "rival.defend", "rival.intercept"];
  const added: string[] = [];
  for (const [k, dz] of [[1, -1.5], [2, 1.5]] as const) {
    const id = uniqueId(b, `rival_${k}`);
    b.entities.push({ id, src: "template", layer: "gameplay", kind: "npc", zone: at?.zone ?? b.zones[0]?.id ?? "", anchor: at?.anchor ?? "", pos: [home[0], home[1] + 0.9, home[2] + dz], rotY: 0, size: [0.7, 1.8, 0.7], noun: `rival ${k}`, hyper: "person", asset: "", body: "kinematic", shape: "capsule", team: them, tags: [], states: [], init: "", props: {} });
    b.cast.push({ id: uniqueId(b, `k_${id}`), src: "template", layer: "gameplay", npc: id, role: "rival", minded: false, persona: { identity: "", personality: "", knowledge: "", replyStyle: "", tools: [], safety: "" }, coneDeg: 70, rangeM: 12, hearM: 8, menu, dflt: k === 1 ? "rival.attack" : "rival.defend", utility: {}, memory: 0 });
    const g = guns[0];
    if (g) {
      const spec = verb(SHOOT)!.params;
      const num = (key: string) => Number(g.params[key] ?? spec[key]!.def);
      b.verbs.push(vb(uniqueId(b, `vb_shoot_${id}`), SHOOT, id, { range: num("range"), speed: num("speed"), damage: Math.round(num("damage") / 2), cooldown: Math.round(num("cooldown") * 3 * 100) / 100 }));
      b.verbs.push(vb(uniqueId(b, `vb_hp_${id}`), HEALTH, id));
    }
    added.push(id);
  }
  return [`added ${added.join(" and ")} on the ${them} side: a ${guns.length ? "shooting" : "throwing"} game needs someone to ${guns.length ? "shoot" : "throw at"}`];
}

/** Does the wall over a doorway at `p` run along z (a lintel there longer across z than x)? */
function lintelAlongZ(layout: PackLayout, p: Vec3): boolean {
  const lintel = layout.statics.find((s) => s.surf === "wall" && s.pos[1] - s.size[1] / 2 > p[1] + 1.5 && Math.abs(p[0] - s.pos[0]) <= s.size[0] / 2 + 0.01 && Math.abs(p[2] - s.pos[2]) <= s.size[2] / 2 + 0.01);
  return !!lintel && lintel.size[2] > lintel.size[0];
}

/** What a race clears off its road: low cover and small things (a kiosk, a crate stack, a tree, a rock), never a wall or a ledge. */
export function clearedByRace(s: { surf: string; size: Vec3 }): boolean {
  const foot = Math.max(s.size[0], s.size[2]);
  return s.surf === "wall" && ((s.size[1] <= 2.5 && foot <= 6) || foot <= 1.6);
}

/**
 * Where a pack's race loop can't be driven (empty when it can): every half metre along it there is
 * ground within a 0.4 m climb, and nothing a race leaves standing comes within `clear` metres of the
 * line (a car's capsule is 0.85 m in radius).
 */
export function raceLoopProblems(layout: PackLayout, clear = 1.2): string[] {
  const loop = layout.track;
  if (!loop || loop.points.length < 3) return ["no race loop"];
  const statics = [...layout.statics, ...(loop.ground ?? [])];
  const out: string[] = [];
  const pts = loop.points;
  for (let i = 0; i < pts.length && out.length < 3; i++) {
    const [a, c] = [pts[i]!, pts[(i + 1) % pts.length]!];
    const n = Math.max(1, Math.ceil(Math.sqrt((c[0] - a[0]) * (c[0] - a[0]) + (c[2] - a[2]) * (c[2] - a[2])) / 0.5));
    for (let k = 0; k <= n; k++) {
      const [x, y, z] = [a[0] + ((c[0] - a[0]) * k) / n, a[1] + ((c[1] - a[1]) * k) / n, a[2] + ((c[2] - a[2]) * k) / n];
      const at = `(${x.toFixed(1)}, ${z.toFixed(1)})`;
      const ground = statics.some((s) => s.surf !== "wall" && Math.abs(x - s.pos[0]) <= s.size[0] / 2 && Math.abs(z - s.pos[2]) <= s.size[2] / 2 && Math.abs(s.pos[1] + s.size[1] / 2 - y) <= 0.45);
      if (!ground) {
        out.push(`no ground at ${at}`);
        break;
      }
      const block = statics.find((s) => s.surf !== "floor" && s.surf !== "water" && !clearedByRace(s) && s.pos[1] - s.size[1] / 2 < y + 1.8 && s.pos[1] + s.size[1] / 2 > y + 0.41 && Math.abs(x - s.pos[0]) < s.size[0] / 2 + clear && Math.abs(z - s.pos[2]) < s.size[2] / 2 + clear);
      if (block) {
        out.push(`a ${block.surf} ${block.size.map((v) => v.toFixed(1)).join("×")} at (${block.pos[0].toFixed(1)}, ${block.pos[2].toFixed(1)}) stands within ${clear} m of the line at ${at}`);
        break;
      }
    }
  }
  return out;
}

/** A vehicle's kind from what it is called, and how big it is parked. */
const RIDE_WORDS: [RegExp, string][] = [
  [/go-?kart|\bkart/, "kart"], [/snowmobile|\bsled|skidoo/, "snowmobile"], [/hovercraft/, "hovercraft"], [/boat|jet ?ski|canoe|kayak|raft/, "boat"],
  [/\bhorse|pony|steed|camel/, "horse"], [/truck|lorry/, "truck"], [/\bvan\b|delivery/, "van"], [/buggy|dune/, "buggy"], [/\bbike|motorbike|motorcycle|scooter|moped/, "bike"],
];
const RIDE_SIZE: Record<string, Vec3> = {
  kart: [1.3, 0.7, 1.9], car: [1.8, 1.2, 3.6], buggy: [1.7, 1.1, 2.8], truck: [2.2, 2, 5], van: [2, 2, 4.4], boat: [1.8, 1, 3.8],
  snowmobile: [1.1, 1, 2.6], hovercraft: [2, 1, 3], bike: [0.6, 1.1, 1.9], horse: [0.8, 1.6, 2.2],
};
const rideKind = (e: Entity) => RIDE_WORDS.find(([re]) => re.test(`${e.id} ${e.noun} ${e.hyper}`.toLowerCase().replace(/_/g, " ")))?.[1] ?? "car";

/**
 * Races (a racing.track, or a rule waiting on lap_done), wired so they can be won and lost (each
 * repair logged):
 * - laps with no track get one: on the line (a checkpoint or goal named like a finish, else the
 *   first checkpoint, else a new one on the pack's race loop), the other checkpoints its gates;
 * - a track's gates are things in the world; with fewer than two and a race loop in the pack, the
 *   loop gets gates of its own;
 * - every vehicle can be driven (its kind from what it's called); the player starts at the wheel
 *   of the first one, each rival racer at the wheel of its own (a copy of yours);
 * - a race with no rivals gets two; with no win, finishing the laps wins; with rivals and no loss,
 *   a rival finishing them first loses.
 */
export function repairRace(b: WorldBundle, layout: PackLayout): string[] {
  if (b.mode !== "play" || !(b.verbs.some((v) => v.verb === TRACK) || b.rules.some((r) => r.when.t === "lap_done"))) return [];
  const notes: string[] = [];
  const spawnOf = (t: string) => b.entities.some((e) => e.kind === "spawn" && e.team === t);
  const mine = !spawnOf("red") && spawnOf("blue") ? "blue" : "red";
  const them = mine === "red" ? "blue" : "red";
  const zone = b.zones[0]?.id ?? "";
  const thing = (id: string, kind: Entity["kind"], noun: string, size: Vec3, body: Entity["body"], team: Entity["team"] = ""): Entity => ({
    id, src: "template", layer: "gameplay", kind, zone, anchor: "", pos: [0, 0, 0], rotY: 0, size, noun, hyper: kind, asset: "", body, shape: kind === "npc" ? "capsule" : "box", team, tags: [], states: [], init: "", props: {},
  });
  const laps = b.rules.find((r) => r.when.t === "lap_done" && (r.when.a === "player" || r.when.a === `team:${mine}`) && r.then.some((e) => e.e === "win"))?.when.n || 3;
  // the track: the line and its gates
  let track = b.verbs.find((v) => v.verb === TRACK && b.entities.some((e) => e.id === v.on));
  if (!track) {
    const lines = b.entities.filter((e) => (e.kind === "checkpoint" || e.kind === "goal") && e.body === "sensor").sort((x, y) => (x.id < y.id ? -1 : 1));
    let line = lines.find((e) => /finish|start|line/.test(`${e.id} ${e.noun}`)) ?? lines.find((e) => e.kind === "checkpoint");
    if (!line && layout.track) {
      line = thing(uniqueId(b, "finish_line"), "checkpoint", "finish line", [layout.track.width, 3, layout.track.width], "sensor");
      b.entities.push(line);
    }
    if (!line) return notes;
    const gates = b.entities.filter((e) => e.kind === "checkpoint" && e !== line).map((e) => e.id).sort();
    track = vb(uniqueId(b, "vb_track"), TRACK, line.id, { gates: gates.join(","), laps });
    b.verbs = b.verbs.filter((v) => !(v.on === line.id && v.verb === "puzzle.checkpoint"));
    b.verbs.push(track);
    notes.push(`${line.id}: the race's line, its gates ${gates.join(", ") || "none yet"} (rules wait on laps, and no track was bound)`);
  }
  const gates = String(track.params.gates ?? "").split(",").map((s) => s.trim()).filter((id) => id && id !== track.on && b.entities.some((e) => e.id === id));
  if (gates.length < 2 && layout.track) {
    for (let k = gates.length; k < Math.min(4, layout.track.points.length - 1); k++) {
      const g = thing(uniqueId(b, `gate_${k + 1}`), "checkpoint", `gate ${k + 1}`, [layout.track.width, 3, layout.track.width], "sensor");
      b.entities.push(g);
      gates.push(g.id);
    }
    notes.push(`${track.on}: the race loop gets gates ${gates.join(", ")}`);
  }
  track.params = { ...track.params, gates: gates.join(","), laps: Number(track.params.laps ?? laps) || laps };
  // vehicles: every one can be driven, the player's first
  const rides = new Map(b.verbs.filter((v) => v.verb === DRIVE).map((v) => [v.on, v]));
  for (const e of b.entities.filter((x) => x.kind === "vehicle" && !rides.has(x.id))) {
    const v = vb(uniqueId(b, `vb_drive_${e.id}`), DRIVE, e.id, { kind: rideKind(e) });
    b.verbs.push(v);
    rides.set(e.id, v);
    notes.push(`${e.id}: added ${DRIVE} (a ${String(v.params.kind)} in a race)`);
  }
  for (const [id, v] of rides) {
    const e = b.entities.find((x) => x.id === id)!;
    const kind = String(v.params.kind ?? rideKind(e));
    if (e.size[0] === 2 && e.size[1] === 1.2 && e.size[2] === 4) e.size = RIDE_SIZE[kind] ?? e.size; // the default vehicle box: this kind's own
  }
  // a driver that names nobody ("npc", "team:blue", "rival") marks a rival's ride: kept for a rival
  // racer below; one player at one wheel
  const agents = new Set(b.entities.filter((e) => e.kind === "npc").map((e) => e.id));
  const spare: VerbBinding[] = [];
  let mineSeen = false;
  for (const v of rides.values()) {
    const who = v.params.driver === undefined ? "" : String(v.params.driver);
    if (who === "player" && !mineSeen) mineSeen = true;
    else if (who && !agents.has(who)) {
      const { driver: _gone, ...rest } = v.params;
      v.params = rest;
      if (who !== "player") spare.push(v);
      notes.push(`${v.on}: '${who}' is nobody in this world, so a rival racer drives it`);
    }
  }
  const driven = (who: string) => [...rides.values()].some((v) => v.params.driver === who);
  const mineRide = [...rides.values()].find((v) => !v.params.driver && !spare.includes(v));
  if (!driven("player") && mineRide) {
    mineRide.params = { ...mineRide.params, driver: "player" };
    notes.push(`player: starts at the wheel of ${mineRide.on}`);
  }
  // rivals: the other side's characters, or added ones (two, or one for each rival's ride); each at
  // the wheel of a rival's ride, else of a copy of yours
  let racers = b.entities.filter((e) => e.kind === "npc" && e.team !== mine && e.body !== "none" && e.body !== "sensor");
  if (!racers.length) {
    for (let k = 1; k <= Math.max(2, Math.min(3, spare.length)); k++) {
      const n = thing(uniqueId(b, `racer_${k}`), "npc", `racer ${k}`, [0.7, 1.8, 0.7], "kinematic", them);
      b.entities.push(n);
      b.cast.push({ id: uniqueId(b, `k_${n.id}`), src: "template", layer: "gameplay", npc: n.id, role: "rival", minded: false, persona: { identity: "", personality: "", knowledge: "", replyStyle: "", tools: [], safety: "" }, coneDeg: 70, rangeM: 12, hearM: 8, menu: ["racer.race", "racer.block", "racer.draft"], dflt: "racer.race", utility: {}, memory: 0 });
    }
    racers = b.entities.filter((e) => e.kind === "npc" && e.team === them);
    notes.push(`added ${racers.map((r) => r.id).join(" and ")}: a race needs someone to race`);
  }
  const yours = [...rides.values()].find((v) => v.params.driver === "player");
  // (a copy of yours tops out a tenth slower: rivals that drive the line well still leave a
  // player who drives it well the race)
  const yourTop = yours ? Math.min(30, Math.max(4, Number(yours.params.speed ?? feelOf({}, yours.params).speed) || 4)) : 0;
  for (const r of racers) {
    const c = b.cast.find((k) => k.npc === r.id);
    if (c && !c.menu.length) ((c.menu = ["racer.race", "racer.block"]), (c.dflt = "racer.race"));
    if (driven(r.id)) continue;
    const theirs = spare.shift();
    if (theirs) {
      theirs.params = { ...theirs.params, driver: r.id };
      const e = b.entities.find((x) => x.id === theirs.on);
      if (e && !e.team) e.team = r.team;
      notes.push(`${r.id}: races at the wheel of ${theirs.on}`);
      continue;
    }
    if (!yours) continue;
    const mineE = b.entities.find((e) => e.id === yours.on)!;
    const ride = { ...structuredClone(mineE), id: uniqueId(b, `${r.id}_ride`), src: "template" as const, noun: mineE.noun || String(yours.params.kind), team: r.team, anchor: "" };
    b.entities.push(ride);
    b.verbs.push(vb(uniqueId(b, `vb_drive_${ride.id}`), DRIVE, ride.id, { ...yours.params, speed: Math.round(yourTop * 0.9 * 10) / 10, driver: r.id }));
    notes.push(`${r.id}: races at the wheel of ${ride.id}`);
  }
  // a way to win, and one to lose
  if (!b.rules.some((r) => r.then.some((e) => e.e === "win"))) {
    b.rules.push({ id: uniqueId(b, "r_win_laps"), src: "template", layer: "gameplay", when: { t: "lap_done", a: "player", b: "", s: "", n: laps, act: "" }, if: [], then: [fx("win", "player")], once: true, cooldownS: 0, prio: 0 });
    notes.push(`added r_win_laps: no rule wins, so finishing ${laps} laps does`);
  }
  if (!b.rules.some((r) => r.then.some((e) => e.e === "lose"))) {
    const rival = racers.every((r) => r.team === them) ? `team:${them}` : racers[0]!.id;
    b.rules.push({ id: uniqueId(b, "r_lose_laps"), src: "template", layer: "gameplay", when: { t: "lap_done", a: rival, b: "", s: "", n: laps, act: "" }, if: [], then: [fx("lose", "player")], once: true, cooldownS: 0, prio: 0 });
    notes.push(`added r_lose_laps: a rival finishing ${laps} laps first loses`);
  }
  return notes;
}

/**
 * Where a race runs: on the pack's race loop when it has one (the line at its start, the gates
 * spread round it, each nudged clear of anything standing there), else where the fill put them,
 * each gate at least a lane wide; the grid behind the line, the player's vehicle first. Logged.
 */
export function placeRace(b: WorldBundle, layout: PackLayout, bound: Map<string, ZoneSpec>): string[] {
  const track = b.verbs.find((v) => v.verb === TRACK);
  const line = track && b.entities.find((e) => e.id === track.on);
  if (!track || !line || b.mode !== "play") return [];
  const notes: string[] = [];
  const gates = String(track.params.gates ?? "").split(",").filter(Boolean).map((id) => b.entities.find((e) => e.id === id)).filter((e): e is Entity => Boolean(e));
  const loop = layout.track;
  const width = loop?.width ?? 6;
  const solid = layout.statics.filter((s) => s.surf !== "floor" && s.surf !== "water");
  const floors = [...layout.statics, ...(loop?.ground ?? [])].filter((s) => s.surf !== "wall");
  // clear: nothing standing within r of (x, z) between a climb and head height above y
  const clear = (x: number, z: number, r: number, y: number) => !solid.some((s) => Math.abs(x - s.pos[0]) < s.size[0] / 2 + r && Math.abs(z - s.pos[2]) < s.size[2] / 2 + r && s.pos[1] - s.size[1] / 2 < y + 1.5 && s.pos[1] + s.size[1] / 2 > y + 0.41);
  const grounded = (x: number, z: number, y: number) => floors.some((s) => Math.abs(x - s.pos[0]) <= s.size[0] / 2 && Math.abs(z - s.pos[2]) <= s.size[2] / 2 && Math.abs(s.pos[1] + s.size[1] / 2 - y) <= 0.45);
  // (never onto no ground: past a wall, off the world)
  const nudge = (p: Vec3, r = 1.5): Vec3 => {
    if (clear(p[0], p[2], r, p[1])) return p;
    for (let ring = 1; ring <= 12; ring++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]] as const) {
      const q: Vec3 = [p[0] + dx * ring * 0.5, p[1], p[2] + dz * ring * 0.5];
      if (clear(q[0], q[2], r, q[1]) && grounded(q[0], q[2], q[1])) return q;
    }
    return p;
  };
  const zoneAt = (p: Vec3) => [...bound].find(([, s]) => p[0] >= s.bounds.min[0] && p[0] <= s.bounds.max[0] && p[2] >= s.bounds.min[2] && p[2] <= s.bounds.max[2])?.[0] ?? line.zone;
  const put = (e: Entity, p: Vec3) => {
    e.pos = [p[0], p[1] + e.size[1] / 2, p[2]];
    e.zone = zoneAt(p);
  };
  let into: Vec3 | null = null; // where the race comes into the line from
  let road: Vec3[] = [];
  if (loop && loop.points.length >= 3) {
    // ground the race needs that the layout doesn't have (a drive round the house, a ring road
    // round the maze), laid only for a race
    if (loop.ground?.length) {
      const zoneOf = new Map([...bound].map(([id, s]) => [s.slot, id]));
      loop.ground.forEach((s, i) => {
        const st = { id: `st_race_${String(i).padStart(2, "0")}`, src: "template" as const, layer: "gameplay" as const, zone: zoneOf.get(s.zoneSlot) ?? b.zones[0]?.id ?? "z_root", shape: s.shape, pos: s.pos, rotY: s.rotY, size: s.size, surf: s.surf };
        b.statics.push(st);
        if (s.surf !== "floor" && s.surf !== "water") solid.push(s);
      });
      notes.push(`race: ${loop.ground.length} pieces of ground laid for the ${layout.packId} race loop`);
    }
    // the line on the loop's first point, the gates spread evenly round it (midpoints too)
    const spots: Vec3[] = loop.points.flatMap((p, i) => {
      const q = loop.points[(i + 1) % loop.points.length]!;
      return [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2] as Vec3];
    });
    road = spots;
    // the loop is a road: low cover standing on it (a kiosk, a crate stack, a tree, a rock) is
    // cleared away; walls and ledges (anything long or high and wide) stay
    const half = width / 2 + 0.6;
    const onRoad = (s: (typeof b.statics)[number]) => {
      for (let i = 0; i < spots.length; i++) {
        const [a, c] = [spots[i]!, spots[(i + 1) % spots.length]!];
        const n = Math.max(1, Math.ceil(Math.sqrt((c[0] - a[0]) * (c[0] - a[0]) + (c[2] - a[2]) * (c[2] - a[2])) / 0.5));
        for (let k = 0; k <= n; k++) {
          const [x, z] = [a[0] + ((c[0] - a[0]) * k) / n, a[2] + ((c[2] - a[2]) * k) / n];
          if (Math.abs(x - s.pos[0]) < s.size[0] / 2 + half && Math.abs(z - s.pos[2]) < s.size[2] / 2 + half) return true;
        }
      }
      return false;
    };
    const cleared = b.statics.filter((s) => clearedByRace(s) && onRoad(s));
    if (cleared.length) {
      b.statics = b.statics.filter((s) => !cleared.includes(s));
      for (const s of cleared) solid.splice(solid.findIndex((x) => x.pos[0] === s.pos[0] && x.pos[1] === s.pos[1] && x.pos[2] === s.pos[2] && x.size[0] === s.size[0]), 1);
      notes.push(`race: ${cleared.length} low block${cleared.length > 1 ? "s" : ""} of cover cleared off the ${layout.packId} race loop`);
    }
    for (const e of [line, ...gates]) e.size = [Math.max(width, e.size[0]), Math.max(3, e.size[1]), Math.max(width, e.size[2])];
    // (as clear as the loop is tested to be: a car fits through anything 1.2 m off the line)
    put(line, nudge(spots[0]!, 1.2));
    gates.forEach((g, i) => put(g, nudge(spots[Math.max(1, Math.round(((i + 1) * spots.length) / (gates.length + 1))) % spots.length]!, 1.2)));
    into = spots[spots.length - 1]!;
    notes.push(`race: ${line.id} and ${gates.length} gates (${gates.map((g) => g.id).join(", ")}) round the ${layout.packId} race loop`);
  } else {
    for (const e of [line, ...gates]) {
      if (e.size[0] >= 5 && e.size[2] >= 5) continue;
      e.size = [Math.max(5, e.size[0]), Math.max(3, e.size[1]), Math.max(5, e.size[2])];
      e.pos = [e.pos[0], e.pos[1] - e.size[1] / 2 + 1.5, e.pos[2]];
      notes.push(`${e.id}: a gate a lane wide (5 m)`);
    }
  }
  // the grid: behind the line, the way the race comes into it; the player on pole, the rivals in
  // pairs behind
  into ??= gates.length ? gates[gates.length - 1]!.pos : [line.pos[0] - 1, line.pos[1], line.pos[2]];
  let [dx, dz] = [line.pos[0] - into[0], line.pos[2] - into[2]];
  const dl = Math.sqrt(dx * dx + dz * dz) || 1;
  [dx, dz] = [dx / dl, dz / dl];
  const floor = line.pos[1] - line.size[1] / 2;
  const rides = b.verbs.filter((v) => v.verb === DRIVE && v.params.driver).sort((x, y) => (x.params.driver === "player" ? -1 : y.params.driver === "player" ? 1 : x.id < y.id ? -1 : 1));
  // (spaced by the biggest vehicle on it, room to spare: each starts turned toward the first gate)
  let [wide, long] = [0, 0];
  for (const v of rides) {
    const e = b.entities.find((x) => x.id === v.on);
    if (e) [wide, long] = [Math.max(wide, e.size[0]), Math.max(long, e.size[2])];
  }
  rides.forEach((v, i) => {
    const e = b.entities.find((x) => x.id === v.on);
    if (!e) return;
    const back = line.size[0] / 2 + 2 + (i === 0 ? 0 : (long + 1.4) * (1 + Math.floor((i - 1) / 2)));
    const side = i === 0 ? 0 : (i % 2 ? 1 : -1) * (wide + 0.6);
    put(e, nudge([line.pos[0] - dx * back - dz * side, floor, line.pos[2] - dz * back + dx * side]));
    const driver = v.params.driver === "player" ? b.entities.find((s) => s.kind === "spawn" && s.team === (b.entities.some((x) => x.kind === "spawn" && x.team === "red") ? "red" : s.team)) : b.entities.find((x) => x.id === v.params.driver);
    if (driver) driver.pos = driver.kind === "spawn" ? [e.pos[0], floor, e.pos[2]] : [e.pos[0], floor + driver.size[1] / 2, e.pos[2]];
  });
  if (rides.length) notes.push(`race: the grid behind ${line.id}: ${rides.map((v) => `${String(v.params.driver)} in ${v.on}`).join(", ")}`);
  // off the road: a vehicle nobody drives, a hazard, and anything you lose by entering or touching
  // (a police car parked across it) standing on it: the race goes round them, not through them
  if (road.length) {
    const course = new Set([line.id, ...gates.map((g) => g.id)]);
    const loses = (e: Entity) => !course.has(e.id) && e.body === "sensor" && b.rules.some((r) => (r.when.t === "enter" || r.when.t === "hit") && r.when.b === e.id && (r.when.a === "player" || !r.when.a) && r.then.some((x) => x.e === "lose"));
    const nearest = (x: number, z: number) => {
      let best = { d: Infinity, nx: 0, nz: 0 };
      for (let i = 0; i < road.length; i++) {
        const [a, c] = [road[i]!, road[(i + 1) % road.length]!];
        const [ux, uz] = [c[0] - a[0], c[2] - a[2]];
        const l2 = ux * ux + uz * uz || 1;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * ux + (z - a[2]) * uz) / l2));
        const [px, pz] = [x - (a[0] + ux * t), z - (a[2] + uz * t)];
        const d = Math.sqrt(px * px + pz * pz);
        if (d < best.d) best = d > 1e-6 ? { d, nx: px / d, nz: pz / d } : { d, nx: -uz / Math.sqrt(l2), nz: ux / Math.sqrt(l2) };
      }
      return best;
    };
    const parked = b.verbs.filter((v) => v.verb === DRIVE && !v.params.driver).map((v) => b.entities.find((e) => e.id === v.on));
    const hazards = b.entities.filter((e) => (e.kind === "hazard" || loses(e)) && Math.max(e.size[0], e.size[2]) <= width);
    const moved: string[] = [];
    for (const e of [...parked, ...hazards]) {
      if (!e) continue;
      const r = Math.max(e.size[0], e.size[2]) / 2;
      const n = nearest(e.pos[0], e.pos[2]);
      const need = width / 2 + r + 0.6;
      if (n.d >= need) continue;
      const [x, z] = [e.pos[0] + n.nx * (need - n.d + 0.4), e.pos[2] + n.nz * (need - n.d + 0.4)];
      const q = nudge([x, e.pos[1] - e.size[1] / 2, z]);
      put(e, nearest(q[0], q[2]).d >= need ? q : [x, e.pos[1] - e.size[1] / 2, z]);
      moved.push(e.id);
    }
    if (moved.length) notes.push(`race: ${moved.join(", ")} moved off the road`);
  }
  return notes;
}

/** What a secret is called in each pack (cosmetic: the rule and the count are the same everywhere). */
const SECRET_NOUN: Record<string, string> = { city_block: "neon shard", outdoor: "glow seed", floor_plan: "gold coin", arena: "star token", maze: "rune stone", course: "time gem", service_venue: "lucky coin", puzzle_rooms: "rune stone", stage: "gold ticket", orrery: "star fragment" };

/**
 * A play world with few things to touch gets secrets: themed bonus collectibles on anchors nothing
 * else uses, high and far ones first (a reason to climb the rooftop lane). They never touch the
 * win: each one only sparkles and counts toward its own tally ("★ 2/5"), and the proof force-tests
 * their rules like any other. Logged.
 */
export function addSecrets(b: WorldBundle, layout: PackLayout, bound: Map<string, ZoneSpec>, want = 10): string[] {
  if (b.mode !== "play") return [];
  // a rule that fires on touching (or picking up) anything would count a secret toward the win
  if (b.rules.some((r) => (r.when.t === "touch" || r.when.t === "pickup") && !(r.when.t === "touch" ? r.when.b : r.when.a))) return [];
  const using = new Set(b.verbs.filter((v) => v.on !== "player").map((v) => v.on));
  for (const c of b.cast) using.add(c.npc);
  const need = Math.min(6, want - using.size);
  if (need <= 0) return [];
  const used = new Set(b.entities.map((e) => `${e.zone}/${e.anchor}`));
  const spawn = b.entities.find((e) => e.kind === "spawn" && e.team === "red") ?? b.entities.find((e) => e.kind === "spawn");
  // only anchors something stands on (never a wall-height spot)
  const standable = (p: Vec3) => layout.statics.some((st) => st.surf !== "wall" && Math.abs(p[0] - st.pos[0]) <= st.size[0] / 2 && Math.abs(p[2] - st.pos[2]) <= st.size[2] / 2 && Math.abs(st.pos[1] + st.size[1] / 2 - p[1]) < 0.3);
  const cands: { zone: string; anchor: string; pos: Vec3; score: number }[] = [];
  for (const z of b.zones) {
    const spec = bound.get(z.id);
    if (!spec) continue;
    for (const [anchor, pos] of Object.entries(spec.anchors)) {
      if (used.has(`${z.id}/${anchor}`) || /^(doorway|spawn|goal)/.test(anchor) || !standable(pos)) continue;
      const far = spawn ? Math.sqrt((pos[0] - spawn.pos[0]) * (pos[0] - spawn.pos[0]) + (pos[2] - spawn.pos[2]) * (pos[2] - spawn.pos[2])) : 0;
      cands.push({ zone: z.id, anchor, pos, score: (pos[1] - spec.floorY) * 8 + far });
    }
  }
  cands.sort((p, q) => q.score - p.score || (p.zone + p.anchor < q.zone + q.anchor ? -1 : 1));
  const noun = SECRET_NOUN[layout.packId] ?? "bonus gem";
  const picked = cands.slice(0, need);
  for (const c of picked) {
    const id = uniqueId(b, `secret_${c.anchor}`);
    b.entities.push({ id, src: "template", layer: "gameplay", kind: "pickup", zone: c.zone, anchor: c.anchor, pos: [c.pos[0], c.pos[1] + 0.6, c.pos[2]], rotY: 0, size: [0.4, 0.4, 0.4], noun, hyper: "gem", asset: "", body: "sensor", shape: "sphere", team: "", tags: ["bonus"], states: [], init: "", props: {} });
    b.verbs.push(vb(uniqueId(b, `vb_collect_${id}`), "puzzle.collect", id));
    b.rules.push({ id: uniqueId(b, `r_${id}`), src: "template", layer: "gameplay", when: { t: "touch", a: "player", b: id, s: "", n: 0, act: "" }, if: [], then: [{ e: "emit", target: id, v: "", n: 0, fx: "sparkle" }], once: true, cooldownS: 0, prio: 0 });
  }
  return picked.length ? [`added ${picked.length} secret ${noun}s on unused anchors (the world had ${using.size} things to use; they count apart from the win)`] : [];
}

/**
 * Rules that name a spawn point as the one moving ("sp_red enters the gate", "sp_rival1 leaves
 * the ring") mean whoever starts there: the player's spawn is the player, another spawn the NPC
 * named after it (sp_rival1 → rival1 / rival_1) or the one standing on it. Logged.
 */
/**
 * Two doors placed in the same doorway (one from each room's side) are one door: the second goes,
 * and everything that named it names the first, so either lever opens it. Logged.
 */
export function repairDoubleDoors(b: WorldBundle): string[] {
  const notes: string[] = [];
  const doors = b.entities.filter((e) => e.kind === "door");
  for (const d of doors) {
    if (!b.entities.includes(d)) continue;
    const twin = doors.find((o) => o !== d && b.entities.includes(o) && Math.abs(o.pos[0] - d.pos[0]) < 0.3 && Math.abs(o.pos[2] - d.pos[2]) < 0.3 && Math.abs(o.pos[1] - d.pos[1]) < 0.5);
    if (!twin) continue;
    b.entities.splice(b.entities.indexOf(twin), 1);
    const re = (x: string) => (x === twin.id ? d.id : x.startsWith(`${twin.id}.`) ? `${d.id}${x.slice(twin.id.length)}` : x);
    for (const r of b.rules) {
      r.when = { ...r.when, a: re(r.when.a), b: re(r.when.b) };
      r.if = r.if.map((c) => ({ ...c, l: re(c.l) }));
      r.then = r.then.map((e) => ({ ...e, target: re(e.target) }));
    }
    // its own lock (if any) goes: the door it shares is opened by whatever opened either
    b.verbs = b.verbs.filter((v) => v.on !== twin.id);
    for (const x of b.expects) ((x.a = re(x.a)), (x.b = re(x.b)));
    notes.push(`${twin.id}: stood in the same doorway as ${d.id}; they are one door now`);
  }
  return notes;
}

export function repairSpawnRefs(b: WorldBundle): string[] {
  const notes: string[] = [];
  const spawns = b.entities.filter((e) => e.kind === "spawn");
  if (!spawns.length) return notes;
  const spawnOf = (t: string) => spawns.some((e) => e.team === t);
  const mine = !spawnOf("red") && spawnOf("blue") ? "blue" : "red";
  const playerSpawn = spawns.find((e) => e.team === mine) ?? spawns[0]!;
  const npcs = b.entities.filter((e) => e.kind === "npc");
  const who = new Map<string, string>();
  for (const sp of spawns) {
    if (sp.id === playerSpawn.id) {
      who.set(sp.id, "player");
      continue;
    }
    const stem = sp.id.replace(/^(sp|spawn)_?/, "").replace(/_?(sp|spawn)$/, "");
    const flat = (s: string) => s.replace(/_/g, "");
    const named = npcs.find((n) => flat(n.id) === flat(stem)) ?? npcs.find((n) => stem && flat(n.id).includes(flat(stem)));
    const standing = npcs.find((n) => n.zone === sp.zone && n.anchor === sp.anchor);
    const id = named?.id ?? standing?.id;
    if (id) who.set(sp.id, id);
  }
  for (const r of b.rules) {
    // only the one moving: a spawn as the destination ("carry the chest back to sp_red") is a place
    const to = who.get(r.when.a);
    if (to) {
      notes.push(`rule ${r.id}: '${r.when.a}' is a spawn point; it means ${to === "player" ? "the player" : to}`);
      r.when.a = to;
    }
    for (const c of r.if) {
      const head = c.l.split(".")[0]!;
      const to = who.get(head);
      if (to) c.l = [to, ...c.l.split(".").slice(1)].join(".");
    }
  }
  return notes;
}

/**
 * "Push them out of bounds" in a ring game: a sensor standing for everywhere off the ring (an
 * out_of_bounds box at the arena's edge, 20 m from anyone) means leaving the ring. Rules that move
 * something into it fire on leaving an invisible sensor over the ring instead (the mat or platform
 * named like one, else the ring's zone), and the marker goes unless something else needs it. Logged.
 */
export function repairRingOut(b: WorldBundle, bound: Map<string, ZoneSpec>): string[] {
  const notes: string[] = [];
  const said = (x: { id: string; noun?: string; hyper?: string; name?: string }) => `${x.id} ${x.noun ?? ""} ${x.hyper ?? ""} ${x.name ?? ""}`.toLowerCase().replace(/_/g, " ");
  const OUT = /\bout ?of ?(the )?(bounds|ring|arena)\b|\boob\b|\boff ?(the )?(ring|mat|edge|platform)\b|\bring ?out\b/;
  const RING = /\b(ring|dohyo|mat|arena|platform|circle|stage|island)\b/;
  for (const s of [...b.entities]) {
    if (s.body !== "sensor" || !OUT.test(said(s))) continue;
    const into = b.rules.filter((r) => r.when.t === "enter" && r.when.b === s.id && r.when.a);
    if (!into.length) continue;
    const mat = b.entities
      .filter((e) => e !== s && e.kind !== "npc" && e.kind !== "spawn" && RING.test(said(e)) && !OUT.test(said(e)) && e.size[0] >= 2 && e.size[2] >= 2)
      .sort((x, y) => y.size[0] * y.size[2] - x.size[0] * x.size[2] || (x.id < y.id ? -1 : 1))[0];
    let pos: Vec3;
    let size: Vec3;
    let zone: string;
    if (mat) {
      const top = mat.pos[1] + mat.size[1] / 2;
      [pos, size, zone] = [[mat.pos[0], top + 1.5, mat.pos[2]], [mat.size[0], 3, mat.size[2]], mat.zone];
    } else {
      // a zone named as the ring; with no ring at all it isn't a ring game (a "miss" box beside a goal)
      const z = b.zones.find((x) => RING.test(said(x)));
      const spec = z && bound.get(z.id);
      if (!z || !spec) continue;
      const { min, max } = spec.bounds;
      [pos, size, zone] = [[(min[0] + max[0]) / 2, spec.floorY + 1.5, (min[2] + max[2]) / 2], [max[0] - min[0], 3, max[2] - min[2]], z.id];
    }
    const id = uniqueId(b, "area_ring");
    b.entities.push({ id, src: "template", layer: "gameplay", kind: "goal", zone, anchor: "", pos, rotY: 0, size, noun: mat?.noun || "ring", hyper: "area", asset: "", body: "sensor", shape: "box", team: "", tags: ["area"], states: [], init: "", props: {} });
    for (const r of into) r.when = { ...r.when, t: "exit", b: id };
    const needed = b.rules.some((r) => r.when.a === s.id || r.when.b === s.id || r.if.some((c) => c.l.startsWith(`${s.id}.`))) || b.verbs.some((v) => v.on === s.id) || b.expects.some((x) => x.a === s.id || x.b === s.id);
    if (!needed) b.entities.splice(b.entities.indexOf(s), 1);
    notes.push(`${s.id}: pushed into '${s.noun || s.id}' means out of the ring, so ${into.map((r) => r.id).join(", ")} fire on leaving ${id} over ${mat?.id ?? zone}${needed ? "" : ` (the marker goes)`}`);
  }
  return notes;
}

/**
 * A rule about a group by its plural ("when the puppies reach home" with pup_1..pup_5 placed, or
 * "when a star is touched" with star_1..star_3) means each of them: one copy of the rule per
 * member. Only when the name is nothing in the world and at least two things answer to it. Logged.
 */
export function repairGroups(b: WorldBundle): string[] {
  const notes: string[] = [];
  const members = (name: string) => groupMembers(name, b.entities);
  const out: Rule[] = [];
  const taken = new Set([...b.rules.map((r) => r.id), ...b.entities.map((e) => e.id), ...b.verbs.map((v) => v.id)]);
  const fresh = (base: string) => {
    let id = base;
    for (let k = 2; taken.has(id); k++) id = `${base}_${k}`;
    taken.add(id);
    return id;
  };
  for (const r of b.rules) {
    // (what an act hands over is counted, not a group: "offered 20 coins" is never one rule per coin)
    const side = members(r.when.a).length ? "a" : r.when.t !== "spoken" && members(r.when.b).length ? "b" : null;
    if (!side) {
      out.push(r);
      continue;
    }
    const group = r.when[side];
    const ms = members(group);
    for (const [i, m] of ms.entries()) out.push({ ...structuredClone(r), id: i === 0 ? r.id : fresh(`${r.id}_${m}`), when: { ...r.when, [side]: m } });
    notes.push(`rule ${r.id}: '${group}' isn't one thing; it means each of ${ms.join(", ")} (${ms.length} rules)`);
  }
  b.rules.splice(0, b.rules.length, ...out);
  return notes;
}

/**
 * A condition on a state nothing in the world can give ("IF the gate is open" with no lock or rule
 * to open it, "IF the departure timer is running" on a prop with no timer) can never hold. With an
 * unused key in the world it means holding the key; a "running" condition with a countdown
 * elsewhere is what the countdown already enforces, so it goes. Otherwise it stays (and the proof
 * says the rule can't fire). Logged.
 */
export function repairConditions(b: WorldBundle): string[] {
  const notes: string[] = [];
  const canBe = (id: string, st: string): boolean => {
    const e = b.entities.find((x) => x.id === id);
    if (!e) return true; // not an entity (a zone, a team): not ours to judge
    if (e.init === st) return true; // a state it merely lists isn't one anything gives it
    for (const v of b.verbs) {
      if (v.on !== id) continue;
      const p = verb(v.verb);
      if (p?.initial === st || p?.produces?.({ id: v.id, on: v.on, params: v.params, mem: {} }).some((x) => x.k === "state" && x.s === st)) return true;
    }
    return b.rules.some((r) => r.then.some((x) => (x.e === "set_state" && x.target === id && String(x.v) === st) || (x.e === "open" && x.target === id && st === "open") || (x.e === "close" && x.target === id && st === "closed")));
  };
  const used = new Set([...b.verbs.filter((v) => v.verb === "puzzle.lock").map((v) => String(v.params.key)), ...b.rules.flatMap((r) => [r.when.a, r.when.b, ...r.if.map((c) => c.l.split(".")[0]!)])]);
  const carryable = new Set(b.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on));
  const key = b.entities.find((e) => carryable.has(e.id) && !used.has(e.id) && /key|klíč|clef|schlüssel|llave|card|ticket|pass/i.test(`${e.id} ${e.noun} ${e.hyper}`));
  const countdown = b.verbs.some((v) => v.verb === "puzzle.timer");
  const mine = b.entities.some((e) => e.kind === "spawn" && e.team === "red") || !b.entities.some((e) => e.kind === "spawn" && e.team === "blue") ? "red" : "blue";
  const at = (id: string) => b.entities.find((x) => x.id === id);
  // "IF player.carry_count is 4" with things to collect: how many you've collected, kept as your
  // team's score (each one collected scores), unless the score already means something else
  const collectible = b.verbs.filter((v) => v.verb === "puzzle.collect").map((v) => v.on);
  const COUNT = /^(player|team:(?:red|blue))\.(carry_?count|carried|collected|collected_count|count|items|item_count|inventory|[a-z]+_count|num_[a-z_]+)$/;
  const scoresElse = b.rules.some((r) => r.then.some((e) => e.e === "score" && e.target === `team:${mine}`) && !(r.when.t === "touch" && collectible.includes(r.when.b)));
  for (const r of b.rules) {
    for (const [i, c] of r.if.entries()) {
      const n = typeof c.r === "number" ? c.r : Number(c.r);
      if (!COUNT.test(c.l) || !Number.isFinite(n) || n < 1 || collectible.length < n || scoresElse || !["eq", "gte", "gt"].includes(c.op)) continue;
      r.if[i] = { ...c, l: `team:${mine}.score`, op: "gte", r: c.op === "gt" ? n + 1 : n };
      for (const id of collectible) {
        if (b.rules.some((x) => x.when.t === "touch" && x.when.b === id && x.then.some((e) => e.e === "score"))) continue;
        b.rules.push({ id: uniqueId(b, `r_collect_${id}`), src: "template", layer: "gameplay", when: { t: "touch", a: "player", b: id, s: "", n: 0, act: "" }, if: [], then: [fx("score", `team:${mine}`, 1)], once: true, cooldownS: 0, prio: 0 });
      }
      notes.push(`rule ${r.id}: '${c.l} ${c.op} ${String(c.r)}' counts what you collect: ${mine} scores for each of ${collectible.length} and needs ${c.op === "gt" ? n + 1 : n}`);
    }
  }
  for (const r of b.rules) {
    r.if = r.if.flatMap((c) => {
      // "<x>.carrier.id eq null": the sim's carrier is an id already, and nobody is ""
      if (/\.carrier\.id$/.test(c.l)) {
        c = { ...c, l: c.l.replace(/\.id$/, "") };
        notes.push(`rule ${r.id}: '${c.l}.id' is '${c.l}'`);
      }
      if (/\.carrier$/.test(c.l) && typeof c.r === "string" && /^(null|none|nobody|nothing|undefined|empty)$/i.test(c.r)) c = { ...c, r: "" };
      // "<a>.zone eq Z" on a rule about entering (or touching) something that stands in Z: entering
      // it is being there (the sim keeps no zone for movers, so as written it never holds)
      const z = /^([a-z][a-z0-9_]*)\.zone$/.exec(c.l);
      if (z && c.op === "eq" && (z[1] === r.when.a || z[1] === "player") && at(r.when.b)?.zone === String(c.r)) {
        notes.push(`rule ${r.id}: dropped '${c.l} is ${String(c.r)}' (${r.when.b} stands in ${String(c.r)}, so reaching it is being there)`);
        return [];
      }
      // "if player.path is left": a property of the player nothing ever sets can never hold (what
      // a rule gives or takes, "player.coins", is counted)
      const pp = /^player\.([a-z_]+)$/.exec(c.l)?.[1];
      const counted = (w: string) => b.rules.some((x) => x.then.some((e) => (e.e === "give" || e.e === "take") && String(e.v) === w));
      if (pp && !["team", "carrier", "carrying", "state", "zone", "score"].includes(pp) && !counted(pp) && !b.rules.some((x) => x.then.some((e) => e.target === "player" && e.e === "set_state"))) {
        notes.push(`rule ${r.id}: dropped '${c.l} ${c.op} ${String(c.r)}' (nothing ever sets the player's ${pp})`);
        return [];
      }
      const m = /^([a-z][a-z0-9_]*)\.state$/.exec(c.l);
      // "if the beaker is at stage 0" on a beaker with no starting state, that rules move 0 → 1 → 2:
      // a starting-state name is where it starts
      const thing = m ? at(m[1]!) : undefined;
      if (m && c.op === "eq" && thing && !thing.init && /^(0|idle|off|closed|start|empty|ready|none|initial|waiting|stage_?0|step_?0)$/.test(String(c.r)) && b.rules.some((x) => x.then.some((e) => e.e === "set_state" && e.target === thing.id))) {
        thing.init = String(c.r);
        notes.push(`${thing.id}: rule ${r.id} needs it '${String(c.r)}' and it has no starting state: it starts '${String(c.r)}'`);
        return [c];
      }
      if (!m || c.op !== "eq" || canBe(m[1]!, String(c.r))) return [c];
      // "the gym exit is open" where nothing opens the exit, but a door beside it can be: that door
      const self = at(m[1]!);
      const doors = b.entities.filter((d) => d.kind === "door" && d.id !== m[1] && canBe(d.id, String(c.r)) && b.verbs.some((v) => v.on === d.id));
      const door = self ? (doors.filter((d) => d.zone === self.zone).length === 1 ? doors.find((d) => d.zone === self.zone) : doors.length === 1 ? doors[0] : undefined) : undefined;
      if (door) {
        notes.push(`rule ${r.id}: nothing can make ${m[1]} '${String(c.r)}'; it means ${door.id} beside it`);
        return [{ ...c, l: `${door.id}.state` }];
      }
      if (key && String(c.r) !== "running") {
        notes.push(`rule ${r.id}: nothing can make ${m[1]} '${String(c.r)}'; with the ${key.noun || key.id} lying unused, it means holding it`);
        return [{ ...c, l: `${key.id}.carrier.team`, r: mine }];
      }
      if (countdown && /running|active|ticking|on/.test(String(c.r))) {
        notes.push(`rule ${r.id}: dropped '${m[1]} is ${String(c.r)}' (nothing gives it that state; the countdown already ends the game)`);
        return [];
      }
      return [c];
    });
  }
  return notes;
}

/**
 * "When you enter the vault", "when a rival leaves the ring": an enter/exit rule naming a ZONE gets
 * an invisible sensor covering that zone, and the rule is pointed at it (only entities can be
 * entered or left). Logged.
 */
export function repairAreas(b: WorldBundle, bound: Map<string, ZoneSpec>): string[] {
  const notes: string[] = [];
  const zones = new Set(b.zones.map((z) => z.id));
  const made = new Map<string, string>();
  for (const r of b.rules) {
    const w = r.when;
    if ((w.t !== "enter" && w.t !== "exit") || !zones.has(w.b) || b.entities.some((e) => e.id === w.b)) continue;
    let id = made.get(w.b);
    if (!id) {
      const spec = bound.get(w.b);
      if (!spec) continue;
      const { min, max } = spec.bounds;
      id = uniqueId(b, `area_${w.b.replace(/^z_/, "")}`);
      const zone = b.zones.find((z) => z.id === w.b)!;
      b.entities.push({ id, src: "template", layer: "gameplay", kind: "goal", zone: w.b, anchor: "", pos: [(min[0] + max[0]) / 2, spec.floorY + 1.5, (min[2] + max[2]) / 2], rotY: 0, size: [max[0] - min[0], 3, max[2] - min[2]], noun: zone.name || w.b.replace(/_/g, " "), hyper: "area", asset: "", body: "sensor", shape: "box", team: "", tags: ["area"], states: [], init: "", props: {} });
      made.set(w.b, id);
      notes.push(`${w.b}: a rule enters or leaves the zone itself, so it got an invisible sensor '${id}' covering it`);
    }
    w.b = id;
  }
  return notes;
}

/** What the win needs: what its rules name, then what the rules that change those name, and so on (a race's line and gates too). */
export function winNeeds(b: WorldBundle): Set<string> {
  const wanted = new Set<string>();
  for (const v of b.verbs.filter((x) => x.verb === TRACK)) for (const id of [v.on, ...String(v.params.gates ?? "").split(",")]) wanted.add(id.trim());
  const named = (r: Rule) => [r.when.a, r.when.b, ...r.if.map((c) => c.l.split(".")[0]!)];
  for (const r of b.rules) if (r.then.some((e) => e.e === "win")) for (const id of named(r)) wanted.add(id);
  for (let grew = true, k = 0; grew && k < 8; k++) {
    grew = false;
    for (const r of b.rules) {
      if (!r.then.some((e) => wanted.has(e.target))) continue;
      for (const id of named(r)) if (id && !wanted.has(id)) ((grew = true), wanted.add(id));
    }
  }
  return wanted;
}

/**
 * Something the win needs that stands up where the laws' jumps can't reach (a spray can on an
 * arena deck, two jumps up, with one jump allowed): the laws allow the jumps it takes (up to
 * three). Reach is a climb over the layout's surfaces from the spawn (a course's platforms step up
 * a jump at a time, so its finish is in reach however high it stands). Logged.
 */
export function repairReach(b: WorldBundle): string[] {
  if (b.mode !== "play" || b.laws.gravityScale < 0.05 || b.laws.jumpH <= 0) return [];
  const sp = b.entities.find((e) => e.kind === "spawn" && e.team === "red") ?? b.entities.find((e) => e.kind === "spawn");
  if (!sp) return [];
  const apex = (n: number) => n * b.laws.jumpH * 0.94;
  // (walls are no footing: the proof's runners don't climb on cover)
  const tops = b.statics.filter((s) => s.surf !== "wall").map((s) => ({ s, top: s.pos[1] + s.size[1] / 2 }));
  const under = (x: number, z: number, y: number) => {
    let best = -1;
    tops.forEach((t, i) => {
      if (Math.abs(x - t.s.pos[0]) <= t.s.size[0] / 2 && Math.abs(z - t.s.pos[2]) <= t.s.size[2] / 2 && t.top <= y + 0.3 && (best < 0 || t.top > tops[best]!.top)) best = i;
    });
    return best;
  };
  const gap = (i: number, j: number) => {
    const [p, q] = [tops[i]!.s, tops[j]!.s];
    const dx = Math.max(0, Math.abs(p.pos[0] - q.pos[0]) - (p.size[0] + q.size[0]) / 2);
    const dz = Math.max(0, Math.abs(p.pos[2] - q.pos[2]) - (p.size[2] + q.size[2]) / 2);
    return Math.sqrt(dx * dx + dz * dz);
  };
  // how far across a hop of n jumps carries you while ending `rise` higher (the course's own model)
  const across = (n: number, rise: number) => {
    if (n <= 0) return 0.05;
    const gr = 9.81 * Math.max(0.05, b.laws.gravityScale);
    const H = b.laws.jumpH * 0.94;
    const v = Math.sqrt(2 * gr * H);
    const disc = v * v + 2 * gr * ((n - 1) * H - Math.max(rise, -3));
    return disc < 0 ? -1 : b.laws.speed * ((((n - 1) * v) / gr + (v + Math.sqrt(disc)) / gr) * 0.85);
  };
  // every surface you can climb to from the spawn's with n jumps (a hop as far across as the jump
  // carries, up to the apex; down a drop)
  const reach = (n: number) => {
    const from = under(sp.pos[0], sp.pos[2], sp.pos[1] + 0.1);
    const seen = new Set<number>(from >= 0 ? [from] : []);
    const todo = [...seen];
    while (todo.length) {
      const i = todo.pop()!;
      for (let j = 0; j < tops.length; j++) {
        if (seen.has(j)) continue;
        const [rise, g] = [tops[j]!.top - tops[i]!.top, gap(i, j)];
        if ((rise <= 0.41 && g <= 0.05) || (rise <= (n > 0 ? apex(n) - 0.1 : 0.41) && g <= across(n, rise) + 0.3)) ((seen.add(j)), todo.push(j));
      }
    }
    return seen;
  };
  const wanted = winNeeds(b);
  const spots = b.entities.filter((e) => wanted.has(e.id) && e.kind !== "npc" && e.kind !== "spawn").map((e) => ({ e, at: under(e.pos[0], e.pos[2], e.pos[1] - e.size[1] / 2) })).filter((x) => x.at >= 0);
  const missing = (n: number) => {
    const r = reach(n);
    return spots.filter((x) => !r.has(x.at));
  };
  const now = missing(b.laws.jumpsMax);
  if (!now.length) return [];
  for (let n = b.laws.jumpsMax + 1; n <= 3; n++) {
    if (missing(n).length) continue;
    const was = b.laws.jumpsMax;
    b.laws = { ...b.laws, jumpsMax: n };
    const x = now[0]!;
    return [`laws: ${x.e.id} stands ${Math.round((tops[x.at]!.top - sp.pos[1]) * 10) / 10} m up where ${was} jump${was === 1 ? "" : "s"} can't climb, and the win needs it, so ${n} jumps`];
  }
  return [];
}

/**
 * Anything a rule's enter/exit trigger targets must be a sensor: a solid "spike trap" can never
 * be entered, so its lose rule would be unreachable in play while a forced-state test (which
 * teleports inside) still passed. Logged, never silent.
 */
export function repairTriggers(b: WorldBundle): string[] {
  const notes: string[] = [];
  const targets = new Set(b.rules.filter((r) => r.when.t === "enter" || r.when.t === "exit").map((r) => r.when.b));
  for (const e of b.entities) {
    if (!targets.has(e.id)) continue;
    if (e.body !== "sensor") {
      notes.push(`${e.id}: body '${e.body}' → 'sensor' (it is the target of an enter/exit trigger)`);
      e.body = "sensor";
      if (e.size[0] === 1 && e.size[1] === 1 && e.size[2] === 1) e.size = [1.6, 1.2, 1.6];
    }
    // somewhere you walk into is at least a stride across (a 0.5 m "goal" can hardly be entered)
    if (e.kind !== "npc" && (e.size[0] < 1.6 || e.size[2] < 1.6)) {
      e.size = [Math.max(1.6, e.size[0]), Math.max(1.2, e.size[1]), Math.max(1.6, e.size[2])];
      notes.push(`${e.id}: grown to ${e.size[0]} × ${e.size[2]} m (too small to walk into)`);
    }
    // something carried in rides above the carrier's head: the place is tall enough to take it in
    const carriedIn = b.rules.some((r) => (r.when.t === "enter" || r.when.t === "exit") && r.when.b === e.id && r.when.a !== "player" && b.entities.find((x) => x.id === r.when.a)?.kind !== "npc");
    // (a spawn point stays where the player starts: its box grows both ways from the floor instead)
    if (e.kind !== "npc" && carriedIn && (e.kind === "spawn" ? e.size[1] / 2 : e.size[1]) < 2.6) {
      if (e.kind === "spawn") e.size = [e.size[0], 5.2, e.size[2]];
      else {
        const floor = e.pos[1] - e.size[1] / 2;
        e.size = [e.size[0], 2.6, e.size[2]];
        e.pos = [e.pos[0], floor + 1.3, e.pos[2]];
      }
      notes.push(`${e.id}: made 2.6 m tall (things are carried into it overhead)`);
    } else if (e.kind === "spawn" && e.size[1] < 2.4) {
      e.size = [e.size[0], 2.4, e.size[2]];
    }
  }
  return notes;
}

const vb = (id: string, verb: string, on: string, params: VerbBinding["params"] = {}): VerbBinding => ({ id, src: "template", layer: "gameplay", verb, on, params, signature: false });
const fx = (e: Effect["e"], target: string, n = 0): Effect => ({ e, target, v: "", n, fx: "" });
const uniqueId = (b: WorldBundle, base: string) => {
  const taken = new Set([...b.verbs.map((v) => v.id), ...b.rules.map((r) => r.id), ...b.entities.map((e) => e.id)]);
  let id = base.slice(0, 32);
  for (let k = 2; taken.has(id); k++) id = `${base.slice(0, 28)}_${k}`;
  return id;
};

/**
 * Deterministic repairs of the kit wiring LLM fills get wrong, each logged (seen in live fills):
 * kinds with no verb get the obvious one; a set of same-noun carried pickups nobody delivers is a
 * collection; nothing you must carry is also "collected" (that destroys it); triggers match the
 * verb (pickup for carried things, touch for collected ones); plates used together latch.
 */
export function repairKits(b: WorldBundle): string[] {
  const notes: string[] = [];
  const bound = (id: string, kit?: string) => b.verbs.some((v) => v.on === id && (!kit || v.verb === kit));
  // 1. kinds that imply a verb
  const IMPLIED: Partial<Record<Entity["kind"], string>> = { switch: "puzzle.switch", plate: "puzzle.plate", checkpoint: "puzzle.checkpoint", hazard: "motion_hazards.hazard" };
  for (const e of b.entities) {
    const kit = IMPLIED[e.kind];
    if (kit && !bound(e.id)) {
      b.verbs.push(vb(uniqueId(b, `vb_${e.id}`), kit, e.id, kit === "motion_hazards.hazard" ? { respawn: true } : {}));
      notes.push(`${e.id}: added ${kit} (a ${e.kind} with no verb)`);
    }
    // a door nothing opens (no lock, no rule; at most a line to inspect) would be a wall across the
    // way: it opens with USE (the inspect line goes: USE can only do one thing)
    const opens = (v: VerbBinding) => v.on === e.id && v.verb !== "social.inspect";
    if (e.kind === "door" && !b.verbs.some(opens) && !b.rules.some((r) => r.then.some((x) => (x.e === "open" || (x.e === "set_state" && String(x.v) === "open")) && x.target === e.id))) {
      b.verbs = b.verbs.filter((v) => v.on !== e.id);
      b.verbs.push(vb(uniqueId(b, `vb_${e.id}`), "puzzle.lock", e.id, { key: "" }));
      notes.push(`${e.id}: a door nothing opens; it opens with USE`);
    }
    if ((e.kind === "platform" || e.kind === "prop") && /crumbl|collaps|fragile|breakable|cracked/.test(`${e.noun} ${e.hyper} ${e.id}`) && !bound(e.id)) {
      b.verbs.push(vb(uniqueId(b, `vb_${e.id}`), "motion_hazards.crumble", e.id));
      notes.push(`${e.id}: added motion_hazards.crumble (it is described as crumbling)`);
    }
  }
  // 1b. a place to explore is never inert: named things with no verb can be looked at
  if (b.mode === "wander") {
    let added = 0;
    for (const e of b.entities) {
      if (!["prop", "sign", "vehicle", "pickup"].includes(e.kind) || bound(e.id) || !e.noun) continue;
      b.verbs.push(vb(uniqueId(b, `vb_look_${e.id}`), "social.inspect", e.id, { text: e.noun.charAt(0).toUpperCase() + e.noun.slice(1) }));
      added++;
    }
    if (added) notes.push(`${added} named thing(s) made inspectable (a place to explore)`);
  }
  // 1a'. a wind (current, conveyor) stronger than you can walk against is a wall, not a challenge
  const speed = b.laws.speed;
  for (const v of b.verbs) {
    if (v.verb !== "motion_hazards.wind") continue;
    const [x, z] = [Number(v.params.x ?? 4), Number(v.params.z ?? 0)];
    const m = Math.sqrt(x * x + z * z);
    const cap = Math.round(speed * 0.6 * 10) / 10;
    if (m <= cap) continue;
    v.params = { ...v.params, x: Math.round((x / m) * cap * 10) / 10, z: Math.round((z / m) * cap * 10) / 10 };
    notes.push(`${v.on}: wind eased from ${Math.round(m * 10) / 10} to ${cap} m/s (you walk at ${speed} m/s; any stronger and nobody gets across)`);
  }
  // 1a''. a pressure plate is something to stand on: one under 1.2 m across is pressed only by
  // luck (it counts the moment your centre is over it)
  for (const v of b.verbs) {
    if (v.verb !== "puzzle.plate") continue;
    const e = b.entities.find((x) => x.id === v.on);
    if (!e || (e.size[0] >= 1.2 && e.size[2] >= 1.2)) continue;
    e.size = [Math.max(1.2, e.size[0]), e.size[1], Math.max(1.2, e.size[2])];
    notes.push(`${e.id}: plate grown to ${e.size[0]} × ${e.size[2]} m (something to stand on)`);
  }
  // 1b'. triggers that can't mean what they say:
  for (const r of b.rules) {
    const w = r.when;
    // "the beacon enters the beacon": reaching it
    if (w.t === "enter" && w.a && w.a === w.b) {
      w.a = "player";
      notes.push(`rule ${r.id}: '${w.b} enters ${w.b}' means the player reaching it`);
    }
    // "the player hits blue_1" (not a hazard, not a thrown ball): tagging them, USE next to them
    // (one with a weapon of its own is its shot hitting you: hit a=player b=it, as written)
    const npc = w.t === "hit" && w.a === "player" ? b.entities.find((e) => e.id === w.b && e.kind === "npc") : undefined;
    if (npc && !b.verbs.some((v) => v.on === npc.id && (v.verb === "motion_hazards.hazard" || v.verb === SHOOT))) {
      w.t = "touch";
      notes.push(`rule ${r.id}: the player hitting ${npc.id} means tagging them (USE next to them)`);
    }
    // "the download terminal enters the server room": a fixed thing can't move; it means you
    // reaching that room (a condition that it's carried, which it can't be, goes with it)
    // (never a spawn point, which means whoever spawns there, and never a rule you lose by: reaching
    // the place yourself would then be the loss)
    const fixedMover = w.t === "enter" && !r.then.some((e) => e.e === "lose") ? b.entities.find((e) => e.id === w.a && e.kind !== "spawn" && (e.body === "fixed" || e.body === "none" || e.body === "sensor") && e.kind !== "npc" && !b.verbs.some((v) => v.on === e.id && (v.verb.endsWith(".carry") || v.verb.endsWith(".oscillate")))) : undefined;
    if (fixedMover && w.b) {
      r.if = r.if.filter((c) => !c.l.startsWith(`${fixedMover.id}.carrier`));
      w.a = "player";
      notes.push(`rule ${r.id}: the ${fixedMover.noun || fixedMover.id} can't move; '${fixedMover.id} enters ${w.b}' means you reaching it`);
    }
    // a countdown nobody started: "until sunrise" with no timer on sunrise_timer
    const clock = w.t === "timer_end" ? b.entities.find((e) => e.id === w.a) : undefined;
    if (clock && !b.verbs.some((v) => v.on === clock.id && v.verb === "puzzle.timer")) {
      b.verbs.push(vb(uniqueId(b, `vb_timer_${clock.id}`), "puzzle.timer", clock.id, { seconds: 60 }));
      notes.push(`${clock.id}: rule ${r.id} waits for it to run out, so it is a 60 s countdown`);
    }
  }
  // 1b''. "when fire1 is destroyed" (state_is fire1 destroyed): destroying something sets no state,
  // so whatever destroys it (a rule, or touching it to collect it) now says so first
  const GONE = /^(destroyed|gone|dead|out|extinguished|put_?out|collected|removed|broken|defeated)$/;
  for (const r of [...b.rules]) {
    const w = r.when;
    if (w.t !== "state_is" || !GONE.test(w.s) || !b.entities.some((e) => e.id === w.a)) continue;
    const st = w.s;
    const setsIt = (x: Rule) => x.then.some((e) => e.e === "set_state" && e.target === w.a && String(e.v) === st);
    if (b.rules.some(setsIt)) continue;
    let n = 0;
    for (const x of b.rules) {
      const i = x.then.findIndex((e) => e.e === "destroy" && e.target === w.a);
      if (i < 0) continue;
      x.then.splice(i, 0, { ...fx("set_state", w.a), v: st });
      n++;
    }
    if (b.verbs.some((v) => v.on === w.a && v.verb === "puzzle.collect")) {
      b.rules.push({ id: uniqueId(b, `r_${st}_${w.a}`), src: "template", layer: "gameplay", when: { t: "touch", a: "player", b: w.a, s: "", n: 0, act: "" }, if: [], then: [{ ...fx("set_state", w.a), v: st }], once: true, cooldownS: 0, prio: 0 });
      n++;
    }
    if (n) notes.push(`rule ${r.id}: '${w.a} is ${st}' happens when it is destroyed; ${n} way${n > 1 ? "s" : ""} of destroying it now say so`);
  }
  // "when the snitch is carried" (state_is snitch carried): picking something up sets no state; it
  // means the moment it's picked up
  const carriedNow = new Set([...b.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on)]);
  for (const r of b.rules) {
    const w = r.when;
    if (w.t !== "state_is" || !carriedNow.has(w.a) || !/^(carried|held|picked_?up|grabbed|caught|taken|in_hand)$/.test(w.s)) continue;
    notes.push(`rule ${r.id}: '${w.a} is ${w.s}' is the moment it's picked up`);
    r.when = { ...w, t: "pickup", b: "", s: "" };
  }
  // 1c. a rule waiting on an event nothing could produce: what it touches is collected (or, if
  // not a pickup, inspected); what it picks up is carried
  for (const r of b.rules) {
    const w = r.when;
    const id = w.t === "touch" ? w.b : w.t === "pickup" ? w.a : "";
    const e = id ? b.entities.find((x) => x.id === id) : undefined;
    if (!e || bound(e.id) || (e.kind === "npc" && w.t !== "touch")) continue;
    // touching an npc means catching them (USE next to them); a pickup is collected; the rest inspected
    const kit = w.t === "pickup" ? "physics_props.carry" : e.kind === "npc" ? "combat_sport.catch" : e.kind === "pickup" ? "puzzle.collect" : "social.inspect";
    const noun = e.noun || e.id.replace(/_/g, " ");
    b.verbs.push(vb(uniqueId(b, `vb_${kit.split(".")[1]}_${e.id}`), kit, e.id, kit === "social.inspect" ? { text: noun.charAt(0).toUpperCase() + noun.slice(1) } : {}));
    notes.push(`${e.id}: added ${kit} (rule ${r.id} waits on a ${w.t} nothing could produce)`);
  }
  // 1e. a rival a rule waits to see knocked into or out of something can be shoved (only where that
  // is the player's doing: a fox reaching the coop on its own is a loss, not a target)
  for (const r of b.rules) {
    if ((r.when.t !== "enter" && r.when.t !== "exit") || r.then.some((x) => x.e === "lose")) continue;
    const e = b.entities.find((x) => x.id === r.when.a && x.kind === "npc");
    if (!e || b.verbs.some((v) => v.on === e.id && v.verb === "combat_sport.shove")) continue;
    b.verbs.push(vb(uniqueId(b, `vb_shove_${e.id}`), "combat_sport.shove", e.id));
    notes.push(`${e.id}: added combat_sport.shove (rule ${r.id} waits for it to be knocked ${r.when.t === "exit" ? "out of" : "into"} ${r.when.b})`);
  }
  // 1e'. a ring game (rivals to shove out, and you lose leaving it) goes both ways: they shove back
  const ringOut = b.rules.some((r) => r.when.t === "exit" && r.when.a === "player" && r.then.some((x) => x.e === "lose"));
  if (ringOut && b.verbs.some((v) => v.verb === "combat_sport.shove" && v.on !== "player") && !b.verbs.some((v) => v.verb === "combat_sport.shove" && v.on === "player")) {
    b.verbs.push(vb(uniqueId(b, "vb_shove_player"), "combat_sport.shove", "player"));
    notes.push("player: the rivals can shove you too (you lose leaving the ring)");
  }
  // in a small ring a full shove (~4 m) clears it from anywhere: scaled so it takes working them
  // to the edge (about a third of the way across per shove)
  const ring = ringOut ? b.entities.find((e) => b.rules.some((r) => r.when.t === "exit" && r.when.a === "player" && r.when.b === e.id)) : undefined;
  // the ring (the bridge, the mat) you must stay on isn't also a hazard: stepping onto it would
  // send you back, which is leaving it
  if (ring && b.verbs.some((v) => v.on === ring.id && v.verb === "motion_hazards.hazard")) {
    b.verbs = b.verbs.filter((v) => !(v.on === ring.id && v.verb === "motion_hazards.hazard"));
    notes.push(`${ring.id}: you must stay in it, so it isn't a hazard too`);
  }
  if (ring) {
    const force = Math.max(4, Math.min(12, Math.round(Math.min(ring.size[0], ring.size[2]) * 1.2)));
    const shoves = b.verbs.filter((v) => v.verb === "combat_sport.shove" && v.params.force === undefined);
    for (const v of shoves) v.params = { ...v.params, force };
    if (shoves.length && force < 10) notes.push(`${ring.id}: shoves knock ${force < 10 ? "less far" : ""} (force ${force}) in a ${Math.min(ring.size[0], ring.size[2])} m ring`);
  }
  // 1c''. a lock whose key is something you can't carry (a switch: "the rope switch opens the rope
  // door"): with a rule that opens the door, the lock goes; without one, the door opens on USE
  for (const v of [...b.verbs]) {
    if (v.verb !== "puzzle.lock" || !v.params.key) continue;
    const k = b.entities.find((e) => e.id === String(v.params.key));
    if (!k || k.kind === "pickup" || b.verbs.some((x) => x.on === k.id && x.verb.endsWith(".carry"))) continue;
    const opened = b.rules.some((r) => r.then.some((e) => (e.e === "open" || (e.e === "set_state" && String(e.v) === "open")) && e.target === v.on));
    if (opened) b.verbs.splice(b.verbs.indexOf(v), 1);
    else v.params = { ...v.params, key: "" };
    notes.push(`${v.on}: its 'key' ${k.id} is a ${k.kind}, not something to carry; ${opened ? "a rule opens the door, so the lock goes" : "the door opens with USE"}`);
  }
  // 1c'. a lock whose key names nothing in the world: the one unused key-like pickup is that key;
  // with none, the door opens on USE (a key nobody can find would lock it forever)
  const ids = new Set(b.entities.map((e) => e.id));
  for (const v of b.verbs) {
    if (v.verb !== "puzzle.lock" || !v.params.key || ids.has(String(v.params.key))) continue;
    const named = String(v.params.key);
    const taken = new Set(b.verbs.filter((x) => x.verb === "puzzle.lock").map((x) => String(x.params.key)));
    const keys = b.entities.filter((e) => e.kind === "pickup" && !taken.has(e.id) && /key|card|pass|badge/.test(`${e.id} ${e.noun}`));
    const near = keys.filter((e) => e.id.includes(named) || named.includes(e.id));
    const k = near.length === 1 ? near[0] : keys.length === 1 ? keys[0] : undefined;
    if (k) {
      v.params = { ...v.params, key: k.id };
      if (!bound(k.id, "physics_props.carry")) b.verbs.push(vb(uniqueId(b, `vb_${k.id}`), "physics_props.carry", k.id));
      notes.push(`${v.on}: its key "${named}" isn't in the world; ${k.id} opens it`);
    } else {
      v.params = { ...v.params, key: "" };
      notes.push(`${v.on}: its key "${named}" isn't in the world, so it opens with USE`);
    }
  }
  // 1d. one key for several locks: it opens them all (a lock using it up would leave the next
  // door locked forever)
  const byKey = new Map<string, VerbBinding[]>();
  for (const v of b.verbs) if (v.verb === "puzzle.lock" && v.params.key) byKey.set(String(v.params.key), [...(byKey.get(String(v.params.key)) ?? []), v]);
  for (const [key, locks] of byKey) {
    // still needed after the door: delivered somewhere, or something a rule wants you holding
    const later = b.rules.some((r) => r.when.a === key || r.if.some((c) => c.l.startsWith(`${key}.`)));
    if ((locks.length < 2 && !later) || locks.every((v) => v.params.keep === true)) continue;
    for (const v of locks) v.params = { ...v.params, keep: true };
    notes.push(locks.length > 1 ? `${key}: opens ${locks.length} locks, so it is kept, not used up` : `${key}: opens a lock but is needed afterwards, so it is kept, not used up`);
  }
  // 2. collections: ≥3 same-noun carried pickups that are never delivered anywhere
  const delivered = new Set<string>();
  for (const r of b.rules) {
    if (r.when.t === "enter" || r.when.t === "exit") delivered.add(r.when.a);
    for (const c of r.if) if (c.l.includes(".carrier")) delivered.add(c.l.split(".")[0]!);
  }
  for (const v of b.verbs) if (v.verb === "puzzle.lock" && v.params.key) delivered.add(String(v.params.key));
  // "player hits the snowball IF it's carried by red": a hit by a thrown ball means anyone it hits
  // (the player is never hit by their own throw)
  const throwable = new Set(b.verbs.filter((v) => v.verb === "combat_sport.throw").map((v) => v.on));
  for (const r of b.rules) {
    if (r.when.t === "hit" && r.when.a === "player" && throwable.has(r.when.b)) {
      r.when.a = "";
      notes.push(`rule ${r.id}: a hit by the thrown ${r.when.b} means anyone it hits`);
    }
    // "the ball touches pin_3" (or "pin_3 is hit by the ball"): pin_3 is something to throw it at
    const tv = throwable.has(r.when.b) || throwable.has(r.when.a) ? b.verbs.find((v) => v.verb === "combat_sport.throw" && (v.on === r.when.a || v.on === r.when.b)) : undefined;
    if (tv && r.when.t === "touch" && r.when.a === tv.on && r.when.b) [r.when.t, r.when.a, r.when.b] = ["hit", r.when.b, tv.on];
    const thing = tv && r.when.t === "hit" && r.when.b === tv.on ? b.entities.find((e) => e.id === r.when.a && e.kind !== "npc") : undefined;
    if (tv && thing) {
      const at = String(tv.params.at ?? "").split(",").filter(Boolean);
      if (!at.includes(thing.id)) {
        tv.params = { ...tv.params, at: [...at, thing.id].join(",") };
        notes.push(`${thing.id}: something to throw the ${tv.on} at (rule ${r.id} waits for it to be hit)`);
      }
    }
    // "a hit by the ball blue threw scores for red": the thrower's team scores, never the one hit
    if (r.when.t === "hit" && throwable.has(r.when.b)) {
      const thrower = r.if.find((c) => c.l === `${r.when.b}.carrier.team` && c.op === "eq" && (c.r === "red" || c.r === "blue"))?.r;
      for (const e of r.then) {
        if (!thrower || e.e !== "score" || !/^team:(red|blue)$/.test(e.target) || e.target === `team:${thrower}`) continue;
        notes.push(`rule ${r.id}: a hit by a ball ${thrower} threw scores for ${thrower}, not ${e.target.slice(5)}`);
        e.target = `team:${thrower}`;
      }
    }
  }
  // a thrown ball (or a weapon to hold) is carried, never collected (collecting it would destroy it)
  const held = heldWeapons(b);
  for (const id of new Set([...b.verbs.filter((v) => v.verb === "combat_sport.throw").map((v) => v.on), ...held])) {
    const n = b.verbs.length;
    b.verbs = b.verbs.filter((v) => !(v.on === id && v.verb === "puzzle.collect"));
    if (b.verbs.length < n) notes.push(`${id}: dropped puzzle.collect (it is thrown, so it is carried)`);
  }
  // carry and collect on one thing: delivered somewhere → carried; otherwise → collected
  for (const id of new Set(b.verbs.filter((v) => v.verb === "puzzle.collect").map((v) => v.on))) {
    if (!b.verbs.some((v) => v.on === id && v.verb.endsWith(".carry"))) continue;
    const keep = delivered.has(id) ? ".carry" : "puzzle.collect";
    b.verbs = b.verbs.filter((v) => v.on !== id || !(v.verb.endsWith(".carry") || v.verb === "puzzle.collect") || v.verb.endsWith(keep));
    notes.push(`${id}: both carried and collected → ${keep === ".carry" ? "carried (it is delivered somewhere)" : "collected (nothing delivers it)"}`);
  }
  const groups = new Map<string, string[]>();
  const thrown = new Set([...b.verbs.filter((v) => v.verb === "combat_sport.throw").map((v) => v.on), ...held]);
  for (const v of b.verbs) {
    if (!v.verb.endsWith(".carry") || delivered.has(v.on) || thrown.has(v.on)) continue; // a ball you throw is carried, not collected
    const e = b.entities.find((x) => x.id === v.on);
    if (!e) continue;
    const key = e.noun || e.hyper || "item";
    groups.set(key, [...(groups.get(key) ?? []), e.id]);
  }
  // …and any of them whose pickup scores points is counted, not carried (one hand can't hold four clues)
  const scoring = new Set(b.rules.filter((r) => (r.when.t === "pickup" || r.when.t === "touch") && r.then.some((e) => e.e === "score")).map((r) => (r.when.t === "pickup" ? r.when.a : r.when.b)));
  const scored = [...groups.values()].flat().filter((id) => scoring.has(id));
  if (scored.length) groups.set("scoring pickup", [...new Set([...(groups.get("scoring pickup") ?? []), ...scored])]);
  for (const [noun, ids] of groups) {
    if ((ids.length < 3 && noun !== "scoring pickup") || !ids.length) continue;
    if (noun !== "scoring pickup") for (const [k, v] of groups) if (k !== noun) groups.set(k, v.filter((x) => !ids.includes(x)));
    b.verbs = b.verbs.filter((v) => !(v.verb.endsWith(".carry") && ids.includes(v.on)));
    for (const id of ids) if (!bound(id, "puzzle.collect")) b.verbs.push(vb(uniqueId(b, `vb_collect_${id}`), "puzzle.collect", id));
    notes.push(`${ids.length} × ${noun}: carried but never delivered → collected (touch to collect)`);
  }
  // 3. nothing that must be carried is also collected
  const carried = new Set([...b.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on), ...held]);
  for (const v of b.verbs) if (v.verb === "puzzle.lock" && v.params.key) carried.add(String(v.params.key));
  const before = b.verbs.length;
  b.verbs = b.verbs.filter((v) => !(v.verb === "puzzle.collect" && carried.has(v.on)));
  if (b.verbs.length < before) notes.push(`dropped puzzle.collect on ${before - b.verbs.length} carried item(s) (collecting destroys them)`);
  // 3b. "<x>.carrier.team" where nothing can carry x (an NPC, a fixed prop) can never hold: the
  // condition goes (a "catch the thief" rule keeps its trigger), logged
  const canCarry = new Set([...b.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on), ...b.verbs.filter((v) => v.verb === "puzzle.lock" && v.params.key).map((v) => String(v.params.key))]);
  for (const r of b.rules) {
    const kept = r.if.filter((c) => {
      const x = /^([a-z][a-z0-9_]*)\.carrier\.team$/.exec(c.l)?.[1];
      return !x || canCarry.has(x) || !b.entities.some((e) => e.id === x);
    });
    if (kept.length < r.if.length) {
      notes.push(`rule ${r.id}: dropped a 'carried by' condition on something nothing can carry`);
      r.if = kept;
    }
  }
  // 4. triggers that match the verb
  const collected = new Set(b.verbs.filter((v) => v.verb === "puzzle.collect").map((v) => v.on));
  for (const r of b.rules) {
    const w = r.when;
    if (w.t === "pickup" && collected.has(w.a)) {
      notes.push(`rule ${r.id}: pickup of collected ${w.a} → touch`);
      [w.t, w.a, w.b] = ["touch", "player", w.a];
    } else if (w.t === "touch" && carried.has(w.b) && (w.a === "player" || !w.a)) {
      notes.push(`rule ${r.id}: touch of carried ${w.b} → pickup`);
      [w.t, w.a, w.b] = ["pickup", w.b, "player"];
    }
  }
  // 2b. a score goal with nothing that scores: each thing the player collects scores a point, for
  // the player's own team only (the rivals' points never come from what the player does)
  const spawnOf = (t: string) => b.entities.some((e) => e.kind === "spawn" && e.team === t);
  const mine = `team:${!spawnOf("red") && spawnOf("blue") ? "blue" : "red"}`;
  for (const g of b.rules.filter((r) => r.when.t === "score_gte")) {
    const team = g.when.a;
    if (team.startsWith("team:") && team !== mine) continue;
    if (b.rules.some((r) => r.then.some((e) => e.e === "score" && e.target === team))) continue;
    const touchRules = b.rules.filter((r) => r.when.t === "touch" && collected.has(r.when.b));
    if (touchRules.length) {
      for (const r of touchRules) if (r.then.length < 4) r.then.push(fx("score", team, 1));
      notes.push(`${team}: nothing scored toward ${g.id}; each collect now scores 1`);
    } else if (collected.size) {
      b.rules.push({ id: uniqueId(b, "r_collect_score"), src: "template", layer: "gameplay", when: { t: "touch", a: "player", b: "", s: "", n: 0, act: "" }, if: [], then: [fx("score", team, 1)], once: false, cooldownS: 0, prio: 0 });
      notes.push(`${team}: nothing scored toward ${g.id}; added a collect-scores-1 rule`);
    }
  }
  // 4b. scoring a carried item into a goal sends it home (or one delivery scores forever after)
  for (const r of b.rules) {
    if (r.when.t !== "enter" || !carried.has(r.when.a) || !r.then.some((e) => e.e === "score")) continue;
    if (r.then.some((e) => (e.e === "reset" || e.e === "destroy" || e.e === "teleport") && e.target === r.when.a) || r.then.length >= 4) continue;
    r.then.push(fx("reset", r.when.a));
    notes.push(`rule ${r.id}: scoring ${r.when.a} now sends it back to its start`);
  }
  // 4c. a score goal can't be met by once-only scoring rules that add up to less than it
  for (const g of b.rules.filter((r) => r.when.t === "score_gte")) {
    const scorers = b.rules.filter((r) => r.then.some((e) => e.e === "score" && e.target === g.when.a));
    const total = scorers.reduce((n, r) => n + (r.once ? r.then.filter((e) => e.e === "score" && e.target === g.when.a).reduce((m, e) => m + (e.n || 1), 0) : Infinity), 0);
    if (total >= g.when.n) continue;
    for (const r of scorers.filter((x) => x.once)) {
      r.once = false;
      notes.push(`rule ${r.id}: no longer once-only (${g.id} needs ${g.when.a} to reach ${g.when.n})`);
    }
  }
  // 4e. a score goal past every point the world can give (four drones knocked out for good, a point
  // each, and a goal of 15) is lowered to that many: each scorer fires at most once when its trigger
  // can only happen once (a knock-out with no respawn, a collectible touched)
  const healthOf = new Map(b.verbs.filter((v) => v.verb === HEALTH).map((v) => [v.on, v]));
  const onlyOnce = (r: Rule) => r.once || (r.when.t === "health_lte" && healthOf.get(r.when.a)?.params.respawn === false) || (r.when.t === "touch" && collected.has(r.when.b));
  for (const g of b.rules.filter((r) => r.when.t === "score_gte" && r.then.some((e) => e.e === "win"))) {
    const scorers = b.rules.filter((r) => r.then.some((e) => e.e === "score" && e.target === g.when.a));
    if (!scorers.length || !scorers.every(onlyOnce)) continue;
    const most = scorers.reduce((n, r) => n + r.then.filter((e) => e.e === "score" && e.target === g.when.a).reduce((m, e) => m + (e.n || 1), 0), 0);
    if (most <= 0 || most >= g.when.n) continue;
    notes.push(`rule ${g.id}: ${g.when.a} can score at most ${most}, so its goal of ${g.when.n} is ${most}`);
    g.when = { ...g.when, n: most };
  }
  // 4d. a timer's finished state is "done", whatever word the rules used for it
  const timers = new Set(b.verbs.filter((v) => v.verb === "puzzle.timer").map((v) => v.on));
  for (const r of b.rules) {
    for (const c of r.if) {
      const id = c.l.endsWith(".state") ? c.l.slice(0, -6) : "";
      if (timers.has(id) && c.op === "eq" && /^(finished|ended|expired|over|complete|completed|timeout|timed_out|stopped|zero)$/.test(String(c.r))) {
        notes.push(`rule ${r.id}: ${id}.state '${String(c.r)}' → 'done' (the timer's finished state)`);
        c.r = "done";
      }
    }
  }
  // 5. plates that must be down together latch, or a solo player could never hold them all
  for (const r of b.rules) {
    const plates = r.if.filter((c) => c.op === "eq" && c.r === "down").map((c) => c.l.split(".")[0]!);
    if (plates.length < 2) continue;
    for (const v of b.verbs) {
      if (v.verb === "puzzle.plate" && plates.includes(v.on) && v.params.latch !== true) {
        v.params = { ...v.params, latch: true };
        notes.push(`${v.on}: plate latches (rule ${r.id} needs ${plates.length} plates down at once)`);
      }
    }
  }
  return notes;
}

/**
 * A rule about your vehicle is about you: "the boat enters the buoy" or "the kart hits the oil" is
 * the player at its wheel doing it (the vehicle rides where its driver is; a hazard hits whoever
 * drives into it). Logged.
 */
export function repairRiders(b: WorldBundle): string[] {
  const mine = new Set(b.verbs.filter((v) => v.verb === DRIVE && v.params.driver === "player").map((v) => v.on));
  if (!mine.size) return [];
  const notes: string[] = [];
  for (const r of b.rules) {
    if (!["enter", "exit", "hit", "touch"].includes(r.when.t) || !mine.has(r.when.a)) continue;
    notes.push(`${r.id}: '${r.when.a}' in the trigger is the player at its wheel`);
    r.when = { ...r.when, a: "player" };
  }
  return notes;
}

/**
 * Wins that can't be right, repaired and logged: the rival team reaching its score is the
 * player's loss (fills sometimes write "win" for both teams); a play world with no way to win at
 * all gets the obvious one, reaching the goal.
 */
export function repairWin(b: WorldBundle): string[] {
  if (b.mode !== "play") return [];
  const notes: string[] = [];
  // the rivals reaching their score is the player's loss, never their win (the player plays red)
  const spawnOf = (t: string) => b.entities.some((e) => e.kind === "spawn" && e.team === t);
  const mine = !spawnOf("red") && spawnOf("blue") ? "blue" : "red";
  for (const r of b.rules) {
    const w = r.when;
    if (w.t !== "score_gte" || !w.a.startsWith("team:") || w.a === `team:${mine}`) continue;
    const win = r.then.find((e) => e.e === "win" && (e.target === "player" || !e.target));
    if (!win || r.then.some((e) => e.e === "lose")) continue;
    win.e = "lose";
    notes.push(`rule ${r.id}: ${w.a.slice(5)} reaching ${w.n} made you win → you lose (you play ${mine})`);
  }
  // "blue wins" (a win for the other team or one of its people) is your loss
  for (const r of b.rules) {
    for (const e of r.then) {
      const side = e.e !== "win" ? undefined : e.target.startsWith("team:") ? e.target.slice(5) : b.entities.find((x) => x.id === e.target && x.kind === "npc")?.team;
      if (!side || side === mine) continue;
      notes.push(`rule ${r.id}: a win for ${e.target} is your loss (you play ${mine})`);
      e.e = "lose";
      e.target = "player";
    }
  }
  // "when time runs out: win if all three zones are red; lose" (the same moment, one with
  // conditions): the one with conditions is the exception, so it goes first (the first win or
  // loss of a tick is the one that counts)
  const same = (x: Rule["when"], y: Rule["when"]) => x.t === y.t && x.a === y.a && x.b === y.b && x.s === y.s && x.n === y.n;
  const ends = (r: Rule) => r.then.some((e) => e.e === "win" || e.e === "lose");
  for (const r of b.rules) {
    if (!ends(r) || !r.if.length) continue;
    const other = b.rules.filter((o) => o !== r && ends(o) && same(o.when, r.when) && o.if.length < r.if.length && o.then.some((e) => e.e === "win") !== r.then.some((e) => e.e === "win"));
    if (!other.length) continue;
    const top = Math.max(...other.map((o) => o.prio));
    if (r.prio > top) continue;
    r.prio = top + 1;
    notes.push(`rule ${r.id}: the exception to ${other.map((o) => o.id).join(", ")} at the same moment, so it is checked first`);
  }
  // "reach the coop holding all three chickens": one pair of hands holds one, so it means bringing
  // each of them in (then as below: each goes in, the last one in wins)
  const carriable = new Set(b.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on));
  for (const r of [...b.rules]) {
    const held = r.if.filter((c) => c.op === "eq" && c.r === mine && /^([a-z][a-z0-9_]*)\.carrier\.team$/.test(c.l) && carriable.has(c.l.split(".")[0]!));
    // (the player reaching it, or one of the things being brought in: "fuel cell 3 enters the ship
    // while all three cells are carried")
    if (r.when.t !== "enter" || (r.when.a !== "player" && !held.some((c) => c.l.split(".")[0] === r.when.a)) || held.length < 2 || !r.then.some((e) => e.e === "win")) continue;
    const rest = r.if.filter((c) => !held.includes(c));
    b.rules.splice(b.rules.indexOf(r), 1);
    for (const c of held) {
      const item = c.l.split(".")[0]!;
      b.rules.push({ ...structuredClone(r), id: uniqueId(b, `${r.id}_${item}`), when: { ...r.when, a: item }, if: [...structuredClone(rest), { ...c }] });
    }
    notes.push(`rule ${r.id}: reaching ${r.when.b} holding ${held.length} things at once can't happen (one pair of hands); it means bringing each of them in`);
  }
  // "win when the three wires are off" with switches that start off: nothing to do, so the model
  // means making them off: those switches start on (cutting each one is the job)
  for (const r of b.rules) {
    if (!r.then.some((e) => e.e === "win")) continue;
    for (const c of r.if) {
      const m = /^([a-z][a-z0-9_]*)\.state$/.exec(c.l);
      const sw = m && c.op === "eq" ? b.entities.find((e) => e.id === m[1] && b.verbs.some((v) => v.on === e.id && v.verb === "puzzle.switch")) : undefined;
      if (!sw || (sw.init || "off") !== String(c.r) || !["on", "off"].includes(String(c.r))) continue;
      sw.init = String(c.r) === "off" ? "on" : "off";
      notes.push(`${sw.id}: rule ${r.id} wins once it is ${String(c.r)}, which it already was; it starts ${sw.init}, so flipping it is the job`);
    }
  }
  // several rules each winning when a different thing is brought to the same place ("brew the
  // potion from three ingredients": the root into the cauldron wins, the scale into the cauldron
  // wins…) mean bringing all of them: each one goes in (used up), and the last one in wins
  const into = new Map<string, Rule[]>();
  for (const r of b.rules) {
    const w = r.when;
    if (w.t !== "enter" || !w.a || w.a === "player" || !b.entities.some((e) => e.id === w.a) || !r.then.some((e) => e.e === "win") || r.then.some((e) => e.e === "lose")) continue;
    into.set(w.b, [...(into.get(w.b) ?? []), r]);
  }
  for (const [place, rs] of into) {
    const items = [...new Set(rs.map((r) => r.when.a))];
    if (items.length < 2) continue;
    for (const r of rs) {
      const item = r.when.a;
      r.then = [...r.then.filter((e) => e.e !== "win"), { ...fx("set_state", item), v: "in" }, fx("destroy", item)];
      r.once = true;
      const others = items.filter((x) => x !== item);
      b.rules.push({ id: uniqueId(b, `${r.id}_all`), src: "template", layer: "gameplay", when: { ...r.when }, if: others.map((o) => ({ l: `${o}.state`, op: "eq" as const, r: "in", forS: 0 })), then: [fx("win", "player")], once: true, cooldownS: 0, prio: 0 });
    }
    notes.push(`${place}: ${items.length} rules each won when a different thing was brought in (${items.join(", ")}); it takes all of them, so each one goes in and the last one wins`);
  }
  if (b.rules.some((r) => r.then.some((e) => e.e === "win"))) return notes;
  // a world that scores for your team is a race on points: first to the rivals' target (else 10)
  if (b.rules.some((r) => r.then.some((e) => e.e === "score" && e.target === `team:${mine}`))) {
    const n = b.rules.find((r) => r.when.t === "score_gte" && r.when.a !== `team:${mine}` && r.then.some((e) => e.e === "lose"))?.when.n || 10;
    b.rules.push({ id: uniqueId(b, "r_win_score"), src: "template", layer: "gameplay", when: { t: "score_gte", a: `team:${mine}`, b: "", s: "", n, act: "" }, if: [], then: [fx("win", "player")], once: true, cooldownS: 0, prio: 0 });
    return [...notes, `added r_win_score: no rule wins and the world scores for ${mine}, so ${mine} reaching ${n} does`];
  }
  // else collecting everything there is to collect (six spray cans and no word on winning): each
  // one scores a point, and all of them wins
  const loot = b.verbs.filter((v) => v.verb === "puzzle.collect" && b.entities.some((e) => e.id === v.on)).map((v) => v.on);
  if (loot.length >= 2 && !b.entities.some((e) => e.kind === "goal" && (e.team === mine || !e.team))) {
    for (const id of loot) b.rules.push({ id: uniqueId(b, `r_got_${id}`), src: "template", layer: "gameplay", when: { t: "touch", a: "player", b: id, s: "", n: 0, act: "" }, if: [], then: [fx("score", `team:${mine}`, 1)], once: true, cooldownS: 0, prio: 0 });
    b.rules.push({ id: uniqueId(b, "r_win_all"), src: "template", layer: "gameplay", when: { t: "score_gte", a: `team:${mine}`, b: "", s: "", n: loot.length, act: "" }, if: [], then: [fx("win", "player")], once: true, cooldownS: 0, prio: 0 });
    return [...notes, `added r_win_all: no rule wins, so collecting all ${loot.length} (${loot.join(", ")}) does, a point each`];
  }
  // else reaching a goal, never one right by the spawn (your own base: that wins in a step)
  const sp = b.entities.find((e) => e.kind === "spawn" && e.team === mine) ?? b.entities.find((e) => e.kind === "spawn");
  const far = (e: Entity) => !sp || (e.pos[0] - sp.pos[0]) * (e.pos[0] - sp.pos[0]) + (e.pos[2] - sp.pos[2]) * (e.pos[2] - sp.pos[2]) > 8 * 8;
  const goals = b.entities.filter((e) => e.kind === "goal" && (e.team === mine || !e.team));
  const goal = goals.find(far);
  if (!goal) return notes;
  b.rules.push({ id: uniqueId(b, "r_win_goal"), src: "template", layer: "gameplay", when: { t: "enter", a: "player", b: goal.id, s: "", n: 0, act: "" }, if: [], then: [fx("win", "player")], once: true, cooldownS: 0, prio: 0 });
  return [...notes, `added r_win_goal: no rule wins, so reaching ${goal.id} does`];
}

/** A verb that needs a particular body (a plate or a coin must be a sensor) gets it. Logged. */
export function repairVerbs(b: WorldBundle): string[] {
  const notes: string[] = [];
  // something a rule waits for you to walk into stays a sensor: a verb that needs it solid (a lock
  // on the goal itself) goes, or the repairs would flip it back and the win could never fire
  const entered = new Set(b.rules.filter((r) => r.when.t === "enter" || r.when.t === "exit").map((r) => r.when.b));
  const mine = b.entities.some((e) => e.kind === "spawn" && e.team === "red") || !b.entities.some((e) => e.kind === "spawn" && e.team === "blue") ? "red" : "blue";
  b.verbs = b.verbs.filter((vb) => {
    const need = verb(vb.verb)?.body;
    if (!need || need === "sensor" || !entered.has(vb.on)) return true;
    notes.push(`${vb.on}: dropped ${vb.verb} (it needs a solid body, and ${vb.on} is a place you walk into)`);
    // a lock's meaning carries over: "IF the gate is open" becomes "IF you hold its key"
    if (vb.verb === "puzzle.lock") {
      const key = String(vb.params.key ?? "");
      for (const r of b.rules) {
        r.if = r.if.flatMap((c) => (c.l === `${vb.on}.state` && c.op === "eq" && String(c.r) === "open" ? (key ? [{ ...c, l: `${key}.carrier.team`, r: mine }] : []) : [c]));
      }
    }
    return false;
  });
  for (const vb of b.verbs) {
    const need = verb(vb.verb)?.body;
    const e = b.entities.find((x) => x.id === vb.on);
    if (!need || !e || e.body === need) continue;
    notes.push(`${e.id}: body '${e.body}' → '${need}' (${vb.verb} needs it)`);
    e.body = need;
  }
  return notes;
}

/**
 * Deterministic repair of expectation references the LLM got wrong (logged, never silent):
 * - a: "player" → the red (else first) spawn;
 * - requires jumps≥k with b not a zone → the zone with the highest walkable surface.
 */
export function repairExpects(b: WorldBundle): string[] {
  const notes: string[] = [];
  const zoneIds = new Set(b.zones.map((z) => z.id));
  const spawn = b.entities.find((e) => e.kind === "spawn" && e.team === "red") ?? b.entities.find((e) => e.kind === "spawn");
  const top = (zid: string) => Math.max(-Infinity, ...b.statics.filter((s) => s.zone === zid && s.surf !== "wall").map((s) => s.pos[1] + s.size[1] / 2));
  for (const x of b.expects) {
    if (x.a === "player" && spawn) {
      notes.push(`expect ${x.id}: a 'player' → spawn '${spawn.id}'`);
      x.a = spawn.id;
    }
    if (x.prop === "requires" && x.need.some((n) => /^jumps>=/.test(n.replace(/\s/g, ""))) && !zoneIds.has(x.b) && b.zones.length) {
      const highest = [...b.zones].sort((p, q) => top(q.id) - top(p.id) || (p.id < q.id ? -1 : 1))[0]!;
      notes.push(`expect ${x.id}: b '${x.b}' is not a zone → '${highest.id}' (highest walkable area)`);
      x.b = highest.id;
    }
  }
  // a place leads its receipt with its tour: every exhibit can be walked to and inspected
  if (b.mode === "wander" && !b.expects.some((x) => x.headline) && spawn) {
    b.expects.push({ id: "x_tour", src: "template", layer: "gameplay", prop: "reachable", a: spawn.id, b: "", need: [], lo: 0, hi: 0, headline: true, text: "Every exhibit can be reached" });
    notes.push("expect x_tour: added as headline (a place: the tour is what gets checked)");
  }
  // every play world leads its receipt with something: promote a win check, or add one
  if (b.mode === "play" && !b.expects.some((x) => x.headline)) {
    const win = b.expects.find((x) => x.prop === "win_reachable");
    if (win) {
      win.headline = true;
      notes.push(`expect ${win.id}: promoted to headline (the fill gave none)`);
    } else if (spawn) {
      b.expects.push({ id: "x_win_auto", src: "template", layer: "gameplay", prop: "win_reachable", a: spawn.id, b: "", need: [], lo: 0, hi: 0, headline: true, text: "You can win this" });
      notes.push("expect x_win_auto: added as headline (the fill gave none)");
    }
  }
  return notes;
}

export { reanchor, type Reanchored } from "./reanchor";
