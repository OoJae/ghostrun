// The placer: binds the fill's zones to a pack's slots and turns anchors into positions.
// The LLM chooses relations (zone + anchor), never coordinates (Holodeck/LayoutVLM lesson).
import { stream } from "@ghostrun/detmath";
import { groupMembers, type Effect, type Entity, type Rule, type Static, type Vec3, type VerbBinding, type WorldBundle, type Zone } from "@ghostrun/ir";
import { verb } from "@ghostrun/kits";
import type { PackLayout, ZoneSpec } from "@ghostrun/plugin-api";

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

const isDefaultSize = (s: Vec3) => s[0] === 1 && s[1] === 1 && s[2] === 1;

function bindZones(zones: Zone[], layout: PackLayout): Map<string, ZoneSpec> {
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

/** Pure and deterministic: positions depend only on the bundle, the layout and the world seed. */
export function placeWorld(input: WorldBundle, layout: PackLayout): PlaceResult {
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
    if (e.kind === "door" && (!e.anchor.startsWith("doorway_") || !spec.anchors[e.anchor])) {
      const doors = Object.keys(spec.anchors).filter((k) => k.startsWith("doorway_")).sort();
      const side = /^wall_([nsew])$/.exec(e.anchor)?.[1];
      const pick = (side && spec.anchors[`doorway_${side}`] ? `doorway_${side}` : undefined) ?? doors[0];
      if (pick) {
        notes.push(`${e.id}: door moved from '${e.anchor || "zone"}' to '${pick}' (doors stand in doorways)`);
        e.anchor = pick;
        base = spec.anchors[pick];
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
    if (!base) {
      // no such anchor: a seeded spot in the zone on open floor (never inside a wall or a pillar)
      const r = stream(b.seed, `place:${e.id}`);
      const { min, max } = spec.bounds;
      const solid = layout.statics.filter((st) => st.pos[1] + st.size[1] / 2 > spec.floorY + 0.3);
      const open = (x: number, z: number) => !solid.some((st) => Math.abs(x - st.pos[0]) < st.size[0] / 2 + 0.6 && Math.abs(z - st.pos[2]) < st.size[2] / 2 + 0.6);
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
    // a door in an east/west wall's doorway turns to fill the gap across z
    if (e.kind === "door" && /^doorway_[ew]$/.test(e.anchor) && e.size[0] > e.size[2]) e.size = [e.size[2], e.size[1], e.size[0]];
  }
  // wins first: a win rule the repairs add (reach the goal) gets the same trigger and verb repairs
  notes.push(...repairSpawnRefs(b), ...repairGroups(b), ...repairRingOut(b, bound), ...repairAreas(b, bound), ...repairKits(b), ...repairConditions(b), ...repairWin(b), ...repairTriggers(b), ...repairVerbs(b), ...repairExpects(b));
  notes.push(...addRivals(b), ...repairDeliveries(b, layout, bound), ...addSecrets(b, layout, bound));
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
  // someone a rule waits to see leave a place (knocked out of a ring) starts inside it
  let k = 0;
  for (const r of b.rules) {
    if (r.when.t !== "exit") continue;
    const who = b.entities.find((e) => e.id === r.when.a && e.kind === "npc");
    const place = b.entities.find((e) => e.id === r.when.b);
    if (!who || !place || inside(who.pos, place)) continue;
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
    const used = new Set(b.entities.map((e) => `${e.zone}/${e.anchor}`));
    let best: { zone: string; anchor: string; pos: Vec3; d: number } | null = null;
    for (const z of b.zones) {
      const spec = bound.get(z.id);
      if (!spec) continue;
      for (const [anchor, pos] of Object.entries(spec.anchors)) {
        if (used.has(`${z.id}/${anchor}`) || /^(doorway|spawn|goal)/.test(anchor) || !standable(pos) || inside(pos, place)) continue;
        const d = (pos[0] - item.pos[0]) * (pos[0] - item.pos[0]) + (pos[2] - item.pos[2]) * (pos[2] - item.pos[2]);
        if (!best || d < best.d || (d === best.d && z.id + anchor < best.zone + best.anchor)) best = { zone: z.id, anchor, pos, d };
      }
    }
    if (!best) continue;
    notes.push(`${item.id}: started inside ${place.id}, where it must be carried: moved to ${best.zone}:${best.anchor}`);
    item.zone = best.zone;
    item.anchor = best.anchor;
    item.pos = [best.pos[0], best.pos[1] + item.size[1] / 2, best.pos[2]];
  }
  return notes;
}

/**
 * A throwing game with no one to throw at (a snowball fight whose fill forgot the other team)
 * gets two rivals at the rival spawn, playing the usual rival options. Logged.
 */
export function addRivals(b: WorldBundle): string[] {
  if (b.mode !== "play" || !b.verbs.some((v) => v.verb === "combat_sport.throw")) return [];
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
    added.push(id);
  }
  return [`added ${added.join(" and ")} on the ${them} side: a throwing game needs someone to throw at`];
}

/** What a secret is called in each pack (cosmetic: the rule and the count are the same everywhere). */
const SECRET_NOUN: Record<string, string> = { city_block: "neon shard", outdoor: "glow seed", floor_plan: "gold coin", arena: "star token", maze: "rune stone", course: "time gem" };

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
      const z = b.zones.find((x) => RING.test(said(x))) ?? b.zones.find((x) => x.id === s.zone);
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
    const side = members(r.when.a).length ? "a" : members(r.when.b).length ? "b" : null;
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
      const m = /^([a-z][a-z0-9_]*)\.state$/.exec(c.l);
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
  // 1e. a rival a rule waits to see knocked into or out of something can be shoved
  for (const r of b.rules) {
    if (r.when.t !== "enter" && r.when.t !== "exit") continue;
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
  if (ring) {
    const force = Math.max(4, Math.min(12, Math.round(Math.min(ring.size[0], ring.size[2]) * 1.2)));
    const shoves = b.verbs.filter((v) => v.verb === "combat_sport.shove" && v.params.force === undefined);
    for (const v of shoves) v.params = { ...v.params, force };
    if (shoves.length && force < 10) notes.push(`${ring.id}: shoves knock ${force < 10 ? "less far" : ""} (force ${force}) in a ${Math.min(ring.size[0], ring.size[2])} m ring`);
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
  // a thrown ball is carried, never collected (collecting it would destroy it)
  for (const id of new Set(b.verbs.filter((v) => v.verb === "combat_sport.throw").map((v) => v.on))) {
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
  const thrown = new Set(b.verbs.filter((v) => v.verb === "combat_sport.throw").map((v) => v.on));
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
    if (ids.length < 3 && noun !== "scoring pickup") continue;
    if (noun !== "scoring pickup") for (const [k, v] of groups) if (k !== noun) groups.set(k, v.filter((x) => !ids.includes(x)));
    b.verbs = b.verbs.filter((v) => !(v.verb.endsWith(".carry") && ids.includes(v.on)));
    for (const id of ids) if (!bound(id, "puzzle.collect")) b.verbs.push(vb(uniqueId(b, `vb_collect_${id}`), "puzzle.collect", id));
    notes.push(`${ids.length} × ${noun}: carried but never delivered → collected (touch to collect)`);
  }
  // 3. nothing that must be carried is also collected
  const carried = new Set(b.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on));
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
  const goal = b.entities.find((e) => e.kind === "goal" && (e.team === "red" || !e.team));
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
