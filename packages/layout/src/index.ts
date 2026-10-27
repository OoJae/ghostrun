// The placer: binds the fill's zones to a pack's slots and turns anchors into positions.
// The LLM chooses relations (zone + anchor), never coordinates (Holodeck/LayoutVLM lesson).
import { stream } from "@ghostrun/detmath";
import type { Effect, Entity, Static, Vec3, VerbBinding, WorldBundle, Zone } from "@ghostrun/ir";
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
  notes.push(...repairKits(b), ...repairTriggers(b), ...repairVerbs(b), ...repairWin(b), ...repairExpects(b));
  return { bundle: b, notes };
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
    if (targets.has(e.id) && e.body !== "sensor") {
      notes.push(`${e.id}: body '${e.body}' → 'sensor' (it is the target of an enter/exit trigger)`);
      e.body = "sensor";
      if (e.size[0] === 1 && e.size[1] === 1 && e.size[2] === 1) e.size = [1.6, 1.2, 1.6];
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
    if (!e || bound(e.id) || e.kind === "npc") continue;
    const kit = w.t === "pickup" ? "physics_props.carry" : e.kind === "pickup" ? "puzzle.collect" : "social.inspect";
    const noun = e.noun || e.id.replace(/_/g, " ");
    b.verbs.push(vb(uniqueId(b, `vb_${kit.split(".")[1]}_${e.id}`), kit, e.id, kit === "social.inspect" ? { text: noun.charAt(0).toUpperCase() + noun.slice(1) } : {}));
    notes.push(`${e.id}: added ${kit} (rule ${r.id} waits on a ${w.t} nothing could produce)`);
  }
  // 2. collections: ≥3 same-noun carried pickups that are never delivered anywhere
  const delivered = new Set<string>();
  for (const r of b.rules) {
    if (r.when.t === "enter" || r.when.t === "exit") delivered.add(r.when.a);
    for (const c of r.if) if (c.l.includes(".carrier")) delivered.add(c.l.split(".")[0]!);
  }
  for (const v of b.verbs) if (v.verb === "puzzle.lock" && v.params.key) delivered.add(String(v.params.key));
  // carry and collect on one thing: delivered somewhere → carried; otherwise → collected
  for (const id of new Set(b.verbs.filter((v) => v.verb === "puzzle.collect").map((v) => v.on))) {
    if (!b.verbs.some((v) => v.on === id && v.verb.endsWith(".carry"))) continue;
    const keep = delivered.has(id) ? ".carry" : "puzzle.collect";
    b.verbs = b.verbs.filter((v) => v.on !== id || !(v.verb.endsWith(".carry") || v.verb === "puzzle.collect") || v.verb.endsWith(keep));
    notes.push(`${id}: both carried and collected → ${keep === ".carry" ? "carried (it is delivered somewhere)" : "collected (nothing delivers it)"}`);
  }
  const groups = new Map<string, string[]>();
  for (const v of b.verbs) {
    if (!v.verb.endsWith(".carry") || delivered.has(v.on)) continue;
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
  if (b.rules.some((r) => r.then.some((e) => e.e === "win"))) return notes;
  const goal = b.entities.find((e) => e.kind === "goal" && (e.team === "red" || !e.team));
  if (!goal) return notes;
  b.rules.push({ id: uniqueId(b, "r_win_goal"), src: "template", layer: "gameplay", when: { t: "enter", a: "player", b: goal.id, s: "", n: 0, act: "" }, if: [], then: [fx("win", "player")], once: true, cooldownS: 0, prio: 0 });
  return [...notes, `added r_win_goal: no rule wins, so reaching ${goal.id} does`];
}

/** A verb that needs a particular body (a plate or a coin must be a sensor) gets it. Logged. */
export function repairVerbs(b: WorldBundle): string[] {
  const notes: string[] = [];
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
