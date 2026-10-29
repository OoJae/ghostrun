// SimWorld: the deterministic runtime shared by the browser, the edge proof service and the Node
// verifier. Fixed 60 Hz, bodies created in id order, triggers evaluated with plain AABB maths in
// id order, rules in (prio desc, id) order — so the same bundle + seed + inputs give bit-identical
// event logs and state hashes everywhere.
import { hex32, xxh32 } from "@ghostrun/detmath";
import { DRIVE, feelOf, gatesOf, HEALTH, MUZZLE_UP, SHOOT, SHOT_RADIUS, segBody, segBox, TRACK, verb as kitVerb } from "@ghostrun/kits";
import { clampParams, type Bound, type Shot, type VerbCtx, type VerbPlugin } from "@ghostrun/plugin-api";
import type { Effect, Entity, Laws, Rule, Vec3, WorldBundle } from "@ghostrun/ir";
import { clampLaws } from "@ghostrun/ir";
import { launch, PLAYER_HALF_HEIGHT, PLAYER_RADIUS, PlayerController, type Ride } from "./controller";
import type { Rapier } from "./rapier/load";
import { BTN, DT, type InputFrame, type Pose, type Result, type SimEvent } from "./types";

type RigidBody = InstanceType<Rapier["RigidBody"]>;
type Collider = InstanceType<Rapier["Collider"]>;

export interface SimOptions {
  playerTeam?: "red" | "blue";
  /** Override laws (T1/T3 use this to test "would it still work with one jump?"). */
  laws?: Partial<Laws>;
  /** Drives the NPC characters; without one they stand still (T2 forced-state tests). */
  brain?: Brain;
}

/** Called once at the start of every tick, before anything moves; returns each NPC's input. */
export interface Brain {
  think(w: SimWorld): ReadonlyMap<string, InputFrame>;
}

type Kcc = ReturnType<InstanceType<Rapier["World"]>["createCharacterController"]>;

interface RtEnt {
  id: string;
  kind: Entity["kind"] | "player";
  team: string;
  body: RigidBody | null;
  col: Collider | null;
  size: Vec3;
  home: Vec3;
  state: string;
  init: string;
  carrier: string; // id of the agent carrying this, '' if none
  carrying: string; // id of the item this agent carries
  sensor: boolean;
  mover: boolean;
  agent: boolean; // can pick things up
  carryable: boolean;
  destroyed: boolean;
  props: Entity["props"];
  osc: { axis: 0 | 2; travel: number; periodTicks: number } | null;
}

/** A projectile in flight: where it is, the way it goes, and how far it has left. */
export interface Flying extends Shot {
  id: number;
  p: Vec3;
  left: number;
  born: number;
}

/** Logs an event this tick; returns its index in the tick's events (what a later one's cause names). */
type Push = (k: string, a: string, b?: string, v?: number | string, rule?: string, cause?: number) => number;

/** USE held this many ticks (about two thirds of a second) puts down what you carry: a weapon too. */
export const HOLD_TO_DROP = 40;

const byId = <T extends { id: string }>(xs: readonly T[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export class SimWorld {
  readonly R: Rapier;
  readonly world: InstanceType<Rapier["World"]>;
  readonly laws: Laws;
  readonly player: PlayerController;
  /** NPC characters: same capsule and controller as the player, driven by the brain. */
  readonly npcs = new Map<string, PlayerController>();
  readonly ents = new Map<string, RtEnt>();
  readonly order: string[] = []; // deterministic iteration order (sorted ids, player included)
  readonly scores: Record<string, number> = { "team:red": 0, "team:blue": 0 };
  readonly log: SimEvent[] = [];
  tick = 0;
  result: Result = null;
  hash = 0;
  #rules: Rule[];
  #fired = new Set<string>();
  /** How many times each rule fired (a rule whose effects were all no-ops still fired). */
  readonly fires = new Map<string, number>();
  #lastFire = new Map<string, number>();
  #inside = new Map<string, Set<string>>(); // sensor id → movers inside
  #bundle: WorldBundle;
  #brain: Brain | undefined;
  #tagRadius = 0; // > 0 when the world has a tag_drop verb: any agent tags an enemy carrier
  #noPickup = new Map<string, number>(); // agent → first tick it may pick up again (after a tag)
  #putDown = new Map<string, string>(); // item → the agent who put it down by hand (not theirs again until they step away)
  /** Kit verbs bound in this world, in binding-id order. */
  readonly verbs: { plugin: VerbPlugin; bound: Bound }[] = [];
  #ctx!: VerbCtx;
  #emit: (k: string, a: string, b?: string, v?: number | string) => void = () => {};
  #checkpoint = new Map<string, Vec3>();
  #useHeld = new Map<string, number>(); // agent → the tick its USE press began
  #facing = new Map<string, [number, number]>(); // agent → the way it last moved (unit), for USE
  /** Items thrown with combat_sport.throw (and weapons to hold): only the player picks them up. */
  readonly #thrown = new Set<string>();
  /** Weapons to hold (a shoot verb on a pickup). */
  readonly #arms = new Set<string>();
  #agents: string[] = [];
  /** Hit points of everything with combat_sport.health (the player, NPCs, a prop to break). */
  readonly #hp = new Map<string, { hp: number; max: number; respawn: boolean }>();
  /** The HP an hp event's subject had before it: health_lte fires on the way down through n. */
  readonly #hpWas = new WeakMap<SimEvent, number>();
  /** Each character's own weapon (a spell, claws): USE fires it when nothing else is in reach. */
  readonly #innate = new Map<string, { plugin: VerbPlugin; bound: Bound }>();
  /** Projectiles in flight, oldest first (the renderer draws them). */
  readonly shots: Flying[] = [];
  #shotSeq = 0;
  /** The statics, as boxes shots and lines of sight stop at. */
  readonly #walls: { pos: Vec3; size: Vec3 }[];
  /** A world that fights: hit points and shots go into the state hash (others hash as they always did). */
  readonly #combat: boolean;
  #evs: SimEvent[] = [];
  /** Who is at the wheel of what (vehicle.drive); a world with vehicles hashes their headings too. */
  readonly #rides = new Map<string, Ride>();
  readonly #riddenBy = new Map<string, string>();
  readonly #wheels: boolean;
  /** Each drive binding's own params as the fill wrote them (its kind's feel fills the rest). */
  readonly #given = new Map<string, Readonly<Record<string, unknown>>>();
  #push: Push = () => -1;

  constructor(R: Rapier, bundle: WorldBundle, opts: SimOptions = {}) {
    this.R = R;
    this.#bundle = bundle;
    this.laws = clampLaws({ ...bundle.laws, ...opts.laws });
    this.world = new R.World({ x: 0, y: -9.81 * this.laws.gravityScale, z: 0 });
    this.world.timestep = DT;
    this.#brain = opts.brain;
    for (const v of bundle.verbs) if (v.verb.endsWith(".tag_drop")) this.#tagRadius = Math.max(this.#tagRadius, Number(v.params.radius ?? 1.2) || 1.2);

    const fixed = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    for (const s of byId(bundle.statics)) {
      if (s.rotY !== 0) throw new Error(`static ${s.id}: rotated statics not supported yet`);
      this.world.createCollider(R.ColliderDesc.cuboid(s.size[0] / 2, s.size[1] / 2, s.size[2] / 2).setTranslation(s.pos[0], s.pos[1], s.pos[2]), fixed);
    }

    for (const v of byId(bundle.verbs)) {
      const plugin = kitVerb(v.verb);
      if (plugin && (plugin.use || plugin.tick || plugin.init || plugin.initial || plugin.carries)) {
        this.verbs.push({ plugin, bound: { id: v.id, on: v.on, params: clampParams(plugin.params, v.params), mem: {} } });
      }
    }
    const carryable = new Set(bundle.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on));
    const npcIds = new Set(bundle.entities.filter((e) => e.kind === "npc").map((e) => e.id));
    // (nobody carries a character: a weapon bound on one is its own, a spell or claws)
    for (const { plugin, bound } of this.verbs) for (const id of plugin.carries?.(bound) ?? []) if (plugin.id !== SHOOT || !npcIds.has(id)) carryable.add(id);
    const osc = new Map(bundle.verbs.filter((v) => v.verb.endsWith(".oscillate")).map((v) => [v.on, v.params]));

    for (const e of byId(bundle.entities)) {
      const rt = this.#spawnEntity(e, carryable.has(e.id));
      const o = osc.get(e.id);
      if (o) rt.osc = { axis: o.axis === "z" ? 2 : 0, travel: Number(o.travel ?? 4), periodTicks: Math.max(1, Math.round(Number(o.period ?? 3) * 60)) };
      this.ents.set(e.id, rt);
    }

    // The player: kinematic capsule driven by the character controller, at its team's spawn.
    const team = opts.playerTeam ?? "red";
    const spawn = byId(bundle.entities).find((e) => e.kind === "spawn" && e.team === team) ?? byId(bundle.entities).find((e) => e.kind === "spawn");
    const sp: Vec3 = spawn ? spawn.pos : [0, 0, 0];
    const start: Vec3 = [sp[0], sp[1] + PLAYER_HALF_HEIGHT + PLAYER_RADIUS + 0.05, sp[2]];
    const pBody = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(start[0], start[1], start[2]));
    const pCol = this.world.createCollider(R.ColliderDesc.capsule(PLAYER_HALF_HEIGHT, PLAYER_RADIUS), pBody);
    this.player = new PlayerController(pBody, pCol, this.#kcc(), this.laws);
    this.ents.set("player", {
      id: "player", kind: "player", team, body: pBody, col: pCol, size: [PLAYER_RADIUS * 2, 1.8, PLAYER_RADIUS * 2], home: start,
      state: "", init: "", carrier: "", carrying: "", sensor: false, mover: true, agent: true, carryable: false, destroyed: false, props: {}, osc: null,
    });

    this.order.push(...[...this.ents.keys()].sort());
    for (const id of this.order) if (this.ents.get(id)!.sensor) this.#inside.set(id, new Set());
    this.#agents = this.order.filter((id) => id === "player" || this.npcs.has(id));
    this.#rules = [...bundle.rules].sort((a, b) => b.prio - a.prio || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const { plugin, bound } of this.verbs) {
      const e = this.ents.get(bound.on);
      if (e && !e.init && plugin.initial) e.state = e.init = plugin.initial;
    }
    for (const v of bundle.verbs) if (v.verb === "combat_sport.throw" || (v.verb === SHOOT && this.ents.get(v.on)?.carryable)) this.#thrown.add(v.on);
    for (const v of bundle.verbs) if (v.verb === SHOOT && this.ents.get(v.on)?.carryable) this.#arms.add(v.on);
    // hit points (clamped like any verb's params), and the weapons characters have of their own
    const hpSpec = kitVerb(HEALTH)!.params;
    for (const v of byId(bundle.verbs)) {
      if (v.verb !== HEALTH || !this.ents.has(v.on) || this.#hp.has(v.on)) continue;
      const p = clampParams(hpSpec, v.params);
      this.#hp.set(v.on, { hp: Number(p.hp), max: Number(p.hp), respawn: p.respawn === true });
    }
    for (const x of this.verbs) if (x.plugin.id === SHOOT && (x.bound.on === "player" || this.npcs.has(x.bound.on)) && !this.#innate.has(x.bound.on)) this.#innate.set(x.bound.on, x);
    this.#combat = this.#hp.size > 0 || this.verbs.some((x) => x.plugin.id === SHOOT);
    this.#walls = bundle.statics.map((s) => ({ pos: s.pos, size: s.size }));
    this.#ctx = this.#makeCtx();
    for (const { plugin, bound } of this.verbs) plugin.init?.(this.#ctx, bound);
    // vehicles: whoever the world starts at the wheel ("driver") is in it from the first tick
    this.#wheels = this.verbs.some((x) => x.plugin.id === DRIVE);
    for (const v of bundle.verbs) if (v.verb === DRIVE) this.#given.set(v.id, v.params);
    for (const { plugin, bound } of this.verbs) {
      const who = String(bound.params.driver ?? "");
      if (plugin.id === DRIVE && who && (who === "player" || this.npcs.has(who))) this.#mount(who, bound.on);
    }
  }

  #makeCtx(): VerbCtx {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const w = this;
    const ctrl = (id: string) => (id === "player" ? w.player : w.npcs.get(id));
    return {
      get tick() {
        return w.tick;
      },
      laws: w.laws,
      pos: (id) => w.pos(id),
      ent: (id) => w.ents.get(id),
      agents: () => w.#agents,
      near: (a, b, r) => w.#near(a, b, r),
      inside: (m, box) => w.#within(m, box),
      standingOn: (a, box) => {
        const e = w.ents.get(box);
        if (!e || e.destroyed) return false;
        const p = w.pos(a);
        const c = w.pos(box);
        const feet = p[1] - PLAYER_HALF_HEIGHT - PLAYER_RADIUS;
        return Math.abs(feet - (c[1] + e.size[1] / 2)) < 0.15 && Math.abs(p[0] - c[0]) <= e.size[0] / 2 + 0.2 && Math.abs(p[2] - c[2]) <= e.size[2] / 2 + 0.2;
      },
      setState: (id, st) => {
        const e = w.ents.get(id);
        if (!e || e.state === st) return;
        e.state = st;
        w.#emit("state", id, "", st);
      },
      setSolid: (id, on) => w.ents.get(id)?.col?.setEnabled(on),
      emit: (k, a, b = "", v = "") => w.#emit(k, a, b, v),
      destroy: (id) => w.#destroy(id),
      teleport: (id, p) => w.teleport(id, p),
      launch: (id, vy) => {
        const c = ctrl(id);
        if (c) launch(c, vy);
      },
      shove: (id, vx, vz) => {
        const c = ctrl(id);
        if (c) ((c.shoveX += vx), (c.shoveZ += vz));
      },
      respawn: (id) => w.#respawn(id),
      release: (item, p) => {
        const it = w.ents.get(item);
        if (!it?.carrier) return;
        const from = it.carrier;
        it.carrier = "";
        w.ents.get(from)!.carrying = "";
        it.body?.setBodyType(w.R.RigidBodyType.Dynamic, true);
        w.teleport(item, p);
        w.#noPickup.set(from, w.tick + 60);
      },
      setCheckpoint: (id, p) => w.#checkpoint.set(id, p),
      facing: (id) => w.facingOf(id),
      vel: (id) => {
        const c = ctrl(id);
        return c ? [c.vx, c.vz] : [0, 0];
      },
      los: (a, b, ignore) => w.clearShot(a, b, ignore),
      fire: (s) => {
        w.shots.push({ ...s, at: [...s.at], id: ++w.#shotSeq, p: [s.from[0], s.from[1], s.from[2]], left: s.range, born: w.tick });
        w.#emit("shoot", s.by, s.weapon);
      },
      hurt: (id, n, by) => w.#hurt(id, n, by, w.#push),
      ride: (agent, vehicle) => (vehicle ? w.#mount(agent, vehicle) : w.#dismount(agent)),
      riding: (agent) => {
        const r = w.#rides.get(agent);
        return r ? { vehicle: r.vehicle, speed: Math.abs(r.speed) } : { vehicle: "", speed: 0 };
      },
    };
  }

  /** The way a character faces (unit x, z): the way it last pushed the stick. */
  facingOf(id: string): readonly [number, number] {
    const f = this.#facing.get(id);
    if (f) return f;
    // never moved yet: toward the middle of the world from where it started (arenas are centred)
    const h = this.ents.get(id)?.home ?? [0, 0, 0];
    const d = Math.sqrt(h[0] * h[0] + h[2] * h[2]);
    return d > 0.5 ? [-h[0] / d, -h[2] / d] : [0, -1];
  }

  /** Solid in the way of a shot: a closed door, a crate, a platform (not characters, sensors or loose items). */
  #blocks(e: RtEnt): boolean {
    return !e.agent && e.kind !== "player" && !e.sensor && !e.carryable && !e.destroyed && e.col !== null && e.col.isEnabled();
  }

  /**
   * Nothing solid between two points (a static, a closed door, a fixed prop)? Characters don't
   * count, nor does `ignore` (the target itself: a reactor core is solid).
   */
  clearShot(a: Vec3, b: Vec3, ignore = ""): boolean {
    for (const s of this.#walls) if (segBox(a, b, s.pos, s.size) >= 0) return false;
    for (const id of this.order) {
      const e = this.ents.get(id)!;
      if (id !== ignore && this.#blocks(e) && segBox(a, b, this.pos(id), e.size) >= 0) return false;
    }
    return true;
  }

  /** A character's own weapon (claws, a spell), clamped: how far it reaches, ticks between shots. */
  weaponOf(id: string): { range: number; every: number } | null {
    const w = this.#innate.get(id);
    return w ? { range: Number(w.bound.params.range), every: Math.max(1, Math.round(Number(w.bound.params.cooldown) * 60)) } : null;
  }

  /** Where a character's shots leave from: its chest. */
  muzzle(id: string): Vec3 {
    const p = this.pos(id);
    return [p[0], p[1] + MUZZLE_UP, p[2]];
  }

  /** What a character drives right now (its heading and speed), or undefined on foot. */
  ride(id: string): Readonly<Ride> | undefined {
    return this.#rides.get(id);
  }

  /** In a race (a racing.track): the gate a racer heads for next (the line after the last), laps done, gates passed this lap. */
  raceOf(id: string): { next: string; laps: number; passed: number; gates: number } | null {
    const t = this.verbs.find((x) => x.plugin.id === TRACK);
    if (!t) return null;
    const order = [...gatesOf(t.bound).filter((g) => this.ents.has(g)), t.bound.on];
    const passed = Math.min(Number(t.bound.mem[`n:${id}`] ?? 0), order.length - 1);
    return { next: order[passed]!, laps: Number(t.bound.mem[`l:${id}`] ?? 0), passed, gates: order.length };
  }

  /** The racers (the player and every character at a wheel) in race order: most laps, then gates, then nearest the next. */
  standings(): string[] {
    const racers = this.#agents.filter((id) => id === "player" || this.#rides.has(id));
    const key = (id: string) => {
      const r = this.raceOf(id);
      if (!r) return 0;
      const p = this.pos(id);
      const q = this.pos(r.next);
      return (r.laps * r.gates + r.passed) * 100000 - Math.sqrt((p[0] - q[0]) * (p[0] - q[0]) + (p[2] - q[2]) * (p[2] - q[2]));
    };
    return [...racers].sort((x, y) => key(y) - key(x) || (x < y ? -1 : 1));
  }

  /** Who drives a vehicle, or "". */
  driverOf(vehicle: string): string {
    return this.#riddenBy.get(vehicle) ?? "";
  }

  /** Into the driver's seat: the vehicle goes ghost (its collider off) and rides with its driver. */
  #mount(agent: string, vehicle: string): boolean {
    const v = this.ents.get(vehicle);
    const b = this.verbs.find((x) => x.plugin.id === DRIVE && x.bound.on === vehicle);
    if (!v || !b || v.destroyed || this.#rides.has(agent) || this.#riddenBy.has(vehicle) || !(agent === "player" || this.npcs.has(agent))) return false;
    v.col?.setEnabled(false);
    if (v.body && !v.body.isKinematic()) v.body.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
    const p = v.body ? this.pos(vehicle) : v.home;
    this.teleport(agent, [p[0], p[1] - v.size[1] / 2 + PLAYER_HALF_HEIGHT + PLAYER_RADIUS + 0.05, p[2]]);
    // facing the track's first gate when there is one, else the way the driver faced
    const track = this.verbs.find((x) => x.plugin.id === TRACK);
    const first = track ? [...gatesOf(track.bound), track.bound.on].find((id) => this.ents.has(id)) : undefined;
    let [hx, hz] = this.facingOf(agent);
    if (first) {
      const q = this.pos(first);
      const [dx, dz] = [q[0] - p[0], q[2] - p[2]];
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > 0.5) [hx, hz] = [dx / d, dz / d];
    }
    const ctrl = agent === "player" ? this.player : this.npcs.get(agent)!;
    ctrl.vx = ctrl.vz = 0;
    this.#rides.set(agent, { vehicle, feel: feelOf(this.#given.get(b.bound.id) ?? {}, b.bound.params), hx, hz, speed: 0, boostLeft: 0, boostAt: 0 });
    this.#riddenBy.set(vehicle, agent);
    this.#facing.set(agent, [hx, hz]);
    return true;
  }

  /** Out, beside it (the side that is clear), and the vehicle is solid again where it stopped. */
  #dismount(agent: string): boolean {
    const r = this.#rides.get(agent);
    if (!r) return false;
    const v = this.ents.get(r.vehicle)!;
    const p = this.pos(agent);
    const off = Math.max(v.size[0], v.size[2]) / 2 + 0.6;
    const sides: [number, number][] = [[r.hz, -r.hx], [-r.hz, r.hx], [-r.hx, -r.hz]];
    const free = ([ux, uz]: [number, number]) => !this.#walls.some((s) => Math.abs(p[0] + ux * off - s.pos[0]) < s.size[0] / 2 + 0.4 && Math.abs(p[2] + uz * off - s.pos[2]) < s.size[2] / 2 + 0.4 && s.pos[1] + s.size[1] / 2 > p[1] - 0.5);
    const [ux, uz] = sides.find(free) ?? sides[0]!;
    this.#rides.delete(agent);
    this.#riddenBy.delete(r.vehicle);
    this.teleport(agent, [p[0] + ux * off, p[1], p[2] + uz * off]);
    v.col?.setEnabled(true);
    return true;
  }

  /** Hit points now, or null for something without them. */
  hp(id: string): number | null {
    return this.#hp.get(id)?.hp ?? null;
  }

  maxHp(id: string): number | null {
    return this.#hp.get(id)?.max ?? null;
  }

  /** Forced state (T2): set hit points without an event, as if it had always been so. */
  forceHp(id: string, n: number) {
    const h = this.#hp.get(id);
    if (h) h.hp = Math.max(0, Math.min(h.max, n));
  }

  /** Forced state (T2): face a way (x, z) without moving. */
  face(id: string, x: number, z: number) {
    const m = Math.sqrt(x * x + z * z);
    if (m > 1e-9) this.#facing.set(id, [x / m, z / m]);
  }

  /** Hit points down by n (a shot, a damage effect); at 0 it is knocked out. */
  #hurt(id: string, n: number, by: string, push: Push, rule = "", cause = -1) {
    const h = this.#hp.get(id);
    const e = this.ents.get(id);
    if (!h || !e || h.hp <= 0 || !(n > 0) || e.destroyed) return;
    const was = h.hp;
    h.hp = Math.max(0, h.hp - n);
    const i = push("hp", id, by, h.hp, rule, cause);
    this.#hpWas.set(this.#evs[i]!, was);
    if (h.hp > 0) return;
    push("knockout", id, by, "", rule, i);
    const character = id === "player" || this.npcs.has(id);
    if (h.respawn) {
      if (character) this.#respawn(id);
      h.hp = h.max;
    } else if (id !== "player") {
      // down for good: what it carried drops where it fell (a player down stays, for the rules to end it)
      if (e.carrying) {
        const p = this.pos(id);
        this.#ctx.release(e.carrying, [p[0], p[1] - PLAYER_HALF_HEIGHT - PLAYER_RADIUS + Math.max(...this.ents.get(e.carrying)!.size) / 2 + 0.02, p[2]]);
      }
      this.#destroy(id);
    }
  }

  #heal(id: string, n: number, push: Push, rule = "", cause = -1) {
    const h = this.#hp.get(id);
    if (!h || h.hp <= 0 || h.hp >= h.max || !(n > 0)) return; // a knocked-out one stays down
    const was = h.hp;
    h.hp = Math.min(h.max, h.hp + n);
    this.#hpWas.set(this.#evs[push("hp", id, "", h.hp, rule, cause)]!, was);
  }

  /** Shots in flight move their step; each hits the first character, target or solid thing on its line. */
  #fly(push: Push) {
    for (let i = 0; i < this.shots.length; ) {
      const s = this.shots[i]!;
      const len = Math.min(s.speed * DT, s.left);
      const a = s.p;
      const b: Vec3 = [a[0] + s.dir[0] * len, a[1] + s.dir[1] * len, a[2] + s.dir[2] * len];
      let t = 2;
      let what: string | null = null; // "" a wall, else what it hit
      for (const w of this.#walls) {
        const u = segBox(a, b, w.pos, w.size);
        if (u >= 0 && u < t) ((t = u), (what = ""));
      }
      const team = this.ents.get(s.by)?.team ?? "";
      for (const id of this.order) {
        const e = this.ents.get(id)!;
        if (e.destroyed || id === s.by) continue;
        let u = -1;
        let wall = false;
        if (id === "player" || this.npcs.has(id)) {
          if (team && e.team === team) continue; // no friendly fire
          u = segBody(a, b, this.pos(id));
        } else if (s.at.includes(id)) u = segBox(a, b, this.pos(id), e.size, SHOT_RADIUS); // (only what this weapon is meant for: to anyone else a reactor core is cover)
        else if (this.#blocks(e)) ((u = segBox(a, b, this.pos(id), e.size)), (wall = true));
        if (u >= 0 && u < t) ((t = u), (what = wall ? "" : id));
      }
      if (what === null) {
        s.p = b;
        s.left -= len;
        if (s.left <= 1e-9) this.shots.splice(i, 1);
        else i++;
        continue;
      }
      this.shots.splice(i, 1);
      if (what) {
        const hi = push("hit", what, s.weapon);
        this.#hurt(what, s.damage, s.weapon, push, "", hi);
      }
    }
  }

  #destroy(id: string): boolean {
    const e = this.ents.get(id);
    if (!e || e.destroyed) return false;
    e.destroyed = true;
    e.col?.setEnabled(false);
    if (e.carrier) {
      this.ents.get(e.carrier)!.carrying = "";
      e.carrier = "";
    }
    this.#emit("destroy", id);
    return true;
  }

  /** Back to the last checkpoint (or home); whatever it carried goes back to where it started. */
  #respawn(id: string) {
    const e = this.ents.get(id);
    if (!e) return;
    if (e.carrying) {
      const item = this.ents.get(e.carrying)!;
      e.carrying = "";
      item.carrier = "";
      item.body?.setBodyType(this.R.RigidBodyType.Dynamic, true);
      this.teleport(item.id, item.home);
      this.#emit("reset", item.id);
    }
    this.teleport(id, this.#checkpoint.get(id) ?? e.home);
    this.#emit("respawn", id);
  }

  /** The nearest verb this agent could USE right now (the HUD's "F: flip switch"). */
  usable(agent = "player"): { verb: string; on: string; label: string } | null {
    let best: { verb: string; on: string; label: string } | null = null;
    let bestD = Infinity;
    for (const { plugin, bound } of this.verbs) {
      const u = plugin.use;
      const e = this.ents.get(bound.on);
      // never itself (a shove bound on the player is for the rivals to use), nor something being
      // carried (a switch in your hands would take every press meant to put it down)
      // (a ball you throw is used while carried: its verb says it carries the thing)
      if (!u || !e || e.destroyed || bound.on === agent || (e.carrier && !plugin.carries)) continue;
      // a weapon is fired by whoever holds it (one's own, a spell or claws: below)
      if (plugin.id === SHOOT && e.carrier !== agent) continue;
      // (in reach up to its own height: a window above head height is looked at from below; and
      // looking at something reaches further up than a hand: a speaker on the wall, a sign)
      const up = plugin.id === "social.inspect" ? 2 : Math.max(0, e.size[1] / 2 - 0.5);
      if (!this.#near(agent, bound.on, u.radius + Math.max(e.size[0], e.size[2]) / 2, up)) continue;
      const p = this.pos(agent);
      const q = this.pos(bound.on);
      const dx = q[0] - p[0];
      const dz = q[2] - p[2];
      // the nearest, but for things to look at, what you're facing first: a window behind a
      // cushion, and the one you turned toward is the one you meant
      const d = Math.sqrt(dx * dx + dz * dz);
      const f = this.#facing.get(agent);
      // (only for looking: a shove or a throw goes to the nearest body, whichever way you face)
      const facing = plugin.id === "social.inspect" && f && d > 0.05 && (dx * f[0] + dz * f[1]) / d > 0.8;
      // (what you carry comes first: the ball in your hands is what USE throws)
      const score = e.carrier === agent ? -Infinity : d - (facing ? 1.5 : 0);
      if (score < bestD) ((bestD = score), (best = { verb: bound.id, on: bound.on, label: u.label }));
    }
    // nothing else in reach: your own weapon (it fires even with your hands full)
    const own = best ? undefined : this.#innate.get(agent);
    if (own?.plugin.use && !this.ents.get(agent)?.destroyed) best = { verb: own.bound.id, on: agent, label: own.plugin.use.label };
    return best;
  }

  #kcc(): Kcc {
    const kcc = this.world.createCharacterController(0.01);
    kcc.enableAutostep(0.4, 0.2, true);
    kcc.enableSnapToGround(0.3);
    kcc.setMaxSlopeClimbAngle(0.7853981633974483); // 45°
    kcc.setApplyImpulsesToDynamicBodies(true);
    return kcc;
  }

  #spawnEntity(e: Entity, carryable: boolean): RtEnt {
    const R = this.R;
    const [sx, sy, sz] = e.size;
    let body: RigidBody | null = null;
    let col: Collider | null = null;
    let home: Vec3 = e.pos;
    const physical = e.body === "fixed" || e.body === "dynamic" || e.body === "kinematic";
    if (e.kind === "npc" && physical) {
      // feet on the floor the placer put it on, centre where the player's would be
      home = [e.pos[0], e.pos[1] - sy / 2 + PLAYER_HALF_HEIGHT + PLAYER_RADIUS + 0.05, e.pos[2]];
      body = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(home[0], home[1], home[2]));
      col = this.world.createCollider(R.ColliderDesc.capsule(PLAYER_HALF_HEIGHT, PLAYER_RADIUS), body);
      this.npcs.set(e.id, new PlayerController(body, col, this.#kcc(), this.laws));
    } else if (physical) {
      const desc =
        e.body === "dynamic" ? R.RigidBodyDesc.dynamic() : e.body === "kinematic" ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.fixed();
      body = this.world.createRigidBody(desc.setTranslation(e.pos[0], e.pos[1], e.pos[2]));
      const shape =
        e.shape === "sphere"
          ? R.ColliderDesc.ball(Math.max(sx, sy, sz) / 2)
          : e.shape === "capsule"
            ? R.ColliderDesc.capsule(Math.max(0.05, sy / 2 - Math.min(sx, sz) / 2), Math.min(sx, sz) / 2)
            : R.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2);
      col = this.world.createCollider(shape, body);
    }
    return {
      id: e.id, kind: e.kind, team: e.team, body, col, size: e.size, home, state: e.init, init: e.init,
      carrier: "", carrying: "", sensor: e.body === "sensor", mover: e.body === "dynamic" || e.kind === "npc" || e.kind === "vehicle",
      agent: e.kind === "npc", carryable, destroyed: false, props: e.props, osc: null,
    };
  }

  /** World-space centre of an entity this tick. */
  pos(id: string): Vec3 {
    const e = this.ents.get(id);
    if (!e) throw new Error(`no entity ${id}`);
    if (!e.body) return e.home;
    const t = e.body.translation();
    return [t.x, t.y, t.z];
  }

  pose(id: string): Pose {
    const e = this.ents.get(id)!;
    if (!e.body) return { p: e.home, q: [0, 0, 0, 1] };
    const t = e.body.translation();
    const r = e.body.rotation();
    return { p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] };
  }

  entity(id: string): Readonly<RtEnt> | undefined {
    return this.ents.get(id);
  }

  // ---- forced-state helpers (T2) ------------------------------------------------------------
  teleport(id: string, p: Vec3) {
    const e = this.ents.get(id)!;
    if (!e.body) {
      e.home = p;
      return;
    }
    e.body.setTranslation({ x: p[0], y: p[1], z: p[2] }, true);
    if (e.body.isKinematic()) e.body.setNextKinematicTranslation({ x: p[0], y: p[1], z: p[2] });
    e.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    const c = id === "player" ? this.player : this.npcs.get(id);
    if (c) c.vx = c.vy = c.vz = 0;
  }

  attach(itemId: string, carrierId: string) {
    const item = this.ents.get(itemId);
    const carrier = this.ents.get(carrierId);
    if (!item || !carrier) return; // a name the world doesn't have: nothing to hand over
    if (item.carrier) this.ents.get(item.carrier)!.carrying = "";
    item.carrier = carrierId;
    carrier.carrying = itemId;
    item.body?.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
  }

  /** Forced state (T2): set an entity's state without an event, as if it had always been so. */
  forceState(id: string, st: string) {
    const e = this.ents.get(id);
    if (!e) return;
    e.state = st;
    if (e.kind === "door" && (st === "open" || st === "closed")) e.col?.setEnabled(st === "closed");
  }

  setScore(team: string, n: number) {
    this.scores[team] = n;
  }

  // ---- the tick ---------------------------------------------------------------------------
  step(input: InputFrame | null): SimEvent[] {
    if (this.result) return [];
    this.tick++;
    const t = this.tick;
    const evs: SimEvent[] = [];
    const push: Push = (k, a, b = "", v = "", rule = "", cause = -1) => evs.push({ tick: t, k, a, b, v, rule, cause }) - 1;
    this.#evs = evs;
    this.#push = push;

    this.#emit = (k, a, b = "", v = "") => push(k, a, b, v);
    // 0. the cast decides from where everything stood at the end of the last tick
    const npcIn = this.#brain?.think(this);
    // which way each agent faces: the way it last pushed the stick
    const face = (id: string, f: InputFrame | null | undefined) => {
      if (!f) return;
      const m = Math.sqrt(f.wx * f.wx + f.wz * f.wz);
      if (m > 20) this.#facing.set(id, [f.wx / m, f.wz / m]);
    };
    face("player", input);
    if (npcIn) for (const [id, f] of npcIn) face(id, f);
    // (at the wheel, an agent faces where its vehicle points, below)

    // 1. characters move, the player first, then NPCs in id order
    const c = this.#move("player", this.player, input);
    if (c.jumped) push("jump", "player");
    if (c.airJumped) push("air_jump", "player", "", this.player.jumpsUsed);
    if (c.landed) push("land", "player");
    for (const [id, ctrl] of this.npcs) if (!this.ents.get(id)!.destroyed) this.#move(id, ctrl, npcIn?.get(id) ?? null);

    // 2. kinematic motion: carried items follow carriers; oscillating platforms
    for (const id of this.order) {
      const e = this.ents.get(id)!;
      if (e.destroyed || !e.body) continue;
      if (e.carrier) {
        const cp = this.ents.get(e.carrier)!.body!.translation();
        e.body.setNextKinematicTranslation({ x: cp.x, y: cp.y + 1.25, z: cp.z });
      } else if (e.osc) {
        const ph = (t % e.osc.periodTicks) / e.osc.periodTicks;
        const tri = ph < 0.5 ? ph * 4 - 1 : 3 - ph * 4; // −1…1 triangle wave, no trig
        const off = (tri * e.osc.travel) / 2;
        const h = e.home;
        e.body.setNextKinematicTranslation({ x: h[0] + (e.osc.axis === 0 ? off : 0), y: h[1], z: h[2] + (e.osc.axis === 2 ? off : 0) });
      }
    }

    // 3. physics
    this.world.step();

    // 3a. vehicles ride with their drivers, exactly where they are now (and face the way they point)
    for (const [id, r] of this.#rides) {
      const v = this.ents.get(r.vehicle)!;
      const p = this.pos(id);
      if (v.body) v.body.setTranslation({ x: p[0], y: p[1] - PLAYER_HALF_HEIGHT - PLAYER_RADIUS + v.size[1] / 2, z: p[2] }, true);
      else v.home = [p[0], p[1] - PLAYER_HALF_HEIGHT - PLAYER_RADIUS + v.size[1] / 2, p[2]];
      this.#facing.set(id, [r.hx, r.hz]);
    }

    // 3b. anyone who fell out of the world comes back (a pit, or off the edge of a platform)
    for (const id of this.#agents) if (!this.ents.get(id)!.destroyed && this.pos(id)[1] < -20) this.#respawn(id);

    // 3c. USE: a fresh press runs the nearest usable verb in reach; held for HOLD_TO_DROP ticks, it
    // puts down what you carry (a weapon in hand always has a use: firing it)
    for (const id of this.#agents) {
      const btn = id === "player" ? (input?.btn ?? 0) : (npcIn?.get(id)?.btn ?? 0);
      const down = (btn & BTN.USE) !== 0;
      const since = this.#useHeld.get(id);
      if (down && since === undefined) {
        const u = this.usable(id);
        const v = u && this.verbs.find((x) => x.bound.id === u.verb);
        if (v) {
          const before = evs.length;
          const acted = v.plugin.use!.run(this.#ctx, v.bound, id) !== false;
          // "the player used X" is a touch, unless the verb already logged one (inspect, with its text)
          if (acted && !v.plugin.use!.quiet && !evs.slice(before).some((e) => e.k === "touch" && e.b === v.bound.on)) push("touch", id, v.bound.on);
        } else if (this.ents.get(id)!.carrying) this.#setDown(id, push); // nothing to use in reach: put down what you carry (or a wrong pickup would be yours for good)
      } else if (down && t - since! === HOLD_TO_DROP && this.ents.get(id)!.carrying) this.#setDown(id, push);
      if (!down) this.#useHeld.delete(id);
      else if (since === undefined) this.#useHeld.set(id, t);
    }

    // 3d. shots in flight
    if (this.shots.length) this.#fly(push);

    // 4. triggers, in id order. Tags first: an agent within reach of an enemy carrier knocks the
    // item loose on the floor between them, so the tagger can take it this tick.
    if (this.#tagRadius > 0) {
      for (const cid of this.order) {
        const cr = this.ents.get(cid)!;
        if (!cr.carrying || cr.destroyed || !cr.team) continue;
        for (const tid of this.order) {
          const tg = this.ents.get(tid)!;
          if ((!tg.agent && tid !== "player") || tg.destroyed || !tg.team || tg.team === cr.team) continue;
          if (!this.#near(tid, cid, this.#tagRadius)) continue;
          const item = cr.carrying;
          this.#drop(item, cid, tid);
          push("tag", tid, cid);
          push("drop", item, cid);
          break;
        }
      }
    }
    for (const itemId of this.order) {
      const item = this.ents.get(itemId)!;
      if (!item.carryable || item.carrier || item.destroyed) continue;
      for (const agentId of this.order) {
        const ag = this.ents.get(agentId)!;
        // the player and the cast that moves; a guard standing as a sensor has no hands
        if (agentId !== "player" && (!ag.agent || !this.npcs.has(agentId))) continue;
        if (agentId !== "player" && this.#thrown.has(itemId)) continue; // bots don't throw: they'd only hoard the ball
        // a weapon in the player's hands is swapped for another one walked over (the first goes down)
        const swap = agentId === "player" && ag.carrying !== "" && this.#arms.has(ag.carrying) && this.#arms.has(itemId);
        if ((ag.carrying && !swap) || ag.destroyed || (this.#noPickup.get(agentId) ?? 0) > t) continue;
        const touching = this.#touching(agentId, itemId);
        if (this.#putDown.get(itemId) === agentId) {
          if (touching) continue; // put down to free the hands: it stays down while they stand on it
          this.#putDown.delete(itemId);
        }
        if (touching) {
          if (swap) this.#setDown(agentId, push);
          this.attach(itemId, agentId);
          push("pickup", itemId, agentId);
          break;
        }
      }
    }
    for (const sid of this.order) {
      const s = this.ents.get(sid)!;
      if (!s.sensor || s.destroyed) continue;
      const inside = this.#inside.get(sid)!;
      for (const mid of this.order) {
        const m = this.ents.get(mid)!;
        if ((!m.mover && mid !== "player") || m.destroyed) continue;
        const now = this.#within(mid, sid);
        if (now && !inside.has(mid)) {
          inside.add(mid);
          push("enter", mid, sid);
        } else if (!now && inside.has(mid)) {
          inside.delete(mid);
          push("exit", mid, sid);
        }
      }
    }
    for (const r of this.#rules) {
      if (r.when.t === "every" && r.when.n > 0 && t % Math.max(1, Math.round(r.when.n * 60)) === 0) push("every", r.id);
    }
    for (const { plugin, bound } of this.verbs) plugin.tick?.(this.#ctx, bound);

    // 5. rules (events may cascade; score_gte is checked after each pass)
    for (let i = 0; i < evs.length && i < 512; i++) {
      this.#fire(evs[i]!, i, push);
      if (this.result) break;
    }
    const scoredFrom = evs.length;
    for (const r of this.#rules) {
      if (this.result) break;
      if (r.when.t === "score_gte" && (this.scores[r.when.a] ?? 0) >= r.when.n) {
        const idx = evs.length;
        push("score_gte", r.when.a, "", this.scores[r.when.a] ?? 0);
        this.#fire(evs[idx]!, idx, push, r);
      }
    }
    // what a score threshold sets off cascades too (three points open the door, the open door wins);
    // thresholds themselves are checked once per tick, so their own events aren't fired again
    for (let i = scoredFrom; i < evs.length && i < 512 && !this.result; i++) if (evs[i]!.k !== "score_gte") this.#fire(evs[i]!, i, push);

    // 6. state hash over everything that moves or counts
    const buf = new Float64Array(this.order.length * 3 + 4 + (this.#combat ? this.#hp.size + this.shots.length * 3 : 0) + (this.#wheels ? this.#rides.size * 3 : 0));
    let o = 0;
    for (const id of this.order) {
      const p = this.pos(id);
      buf[o++] = p[0] === 0 ? 0 : p[0];
      buf[o++] = p[1] === 0 ? 0 : p[1];
      buf[o++] = p[2] === 0 ? 0 : p[2];
    }
    buf[o++] = this.scores["team:red"] ?? 0;
    buf[o++] = this.scores["team:blue"] ?? 0;
    buf[o++] = this.result === "win" ? 1 : this.result === "lose" ? -1 : 0;
    buf[o++] = t;
    if (this.#combat) {
      for (const id of this.order) {
        const h = this.#hp.get(id);
        if (h) buf[o++] = h.hp;
      }
      for (const s of this.shots) for (const x of s.p) buf[o++] = x === 0 ? 0 : x;
    }
    if (this.#wheels) {
      for (const id of this.#agents) {
        const r = this.#rides.get(id);
        if (r) for (const x of [r.hx, r.hz, r.speed]) buf[o++] = x === 0 ? 0 : x;
      }
    }
    this.hash = xxh32(new Uint8Array(buf.buffer), this.hash);

    this.log.push(...evs);
    return evs;
  }

  /** One character tick; the KCC ignores the item this character carries. */
  #move(id: string, ctrl: PlayerController, input: InputFrame | null) {
    const carry = this.ents.get(id)!.carrying;
    const carriedHandle = carry ? this.ents.get(carry)!.col?.handle : undefined;
    // at the wheel: the arcade vehicle model drives the same capsule through the same KCC
    const ride = this.#rides.get(id);
    if (ride) return ctrl.drive(input, ride, this.tick, (col) => col.handle === carriedHandle);
    // Compare handles only: calling collider methods here would re-borrow Rapier's collider set
    // while the KCC holds it. Sensors have no physics colliders in this world.
    return ctrl.step(
      input,
      (col) => col.handle === carriedHandle,
      (headY, up) => {
        const p = ctrl.body.translation();
        const ray = new this.R.Ray({ x: p.x, y: headY + 0.001, z: p.z }, { x: 0, y: 1, z: 0 });
        return this.world.castRay(ray, up, true, undefined, undefined, ctrl.collider, undefined, (col) => col.handle !== carriedHandle) !== null;
      },
    );
  }

  #near(a: string, b: string, r: number, up = 0): boolean {
    const p = this.pos(a);
    const q = this.pos(b);
    const dx = p[0] - q[0];
    const dz = p[2] - q[2];
    return dx * dx + dz * dz <= r * r && Math.abs(p[1] - q[1]) <= 1.4 + up;
  }

  /** Put down what an agent carries, at its feet: its hands are free at once, and this one stays down while it stands there. */
  #setDown(id: string, push: Push) {
    const item = this.ents.get(id)!.carrying;
    const p = this.pos(id);
    this.#ctx.release(item, [p[0], p[1] - PLAYER_HALF_HEIGHT - PLAYER_RADIUS + Math.max(...this.ents.get(item)!.size) / 2 + 0.02, p[2]]);
    this.#noPickup.delete(id);
    this.#putDown.set(item, id);
    push("drop", item, id);
  }

  #drop(itemId: string, carrierId: string, towardId: string) {
    const item = this.ents.get(itemId)!;
    item.carrier = "";
    this.ents.get(carrierId)!.carrying = "";
    item.body?.setBodyType(this.R.RigidBodyType.Dynamic, true);
    const a = this.pos(carrierId);
    const b = this.pos(towardId);
    const floor = a[1] - PLAYER_HALF_HEIGHT - PLAYER_RADIUS;
    this.teleport(itemId, [(a[0] + b[0]) / 2, floor + Math.max(...item.size) / 2 + 0.02, (a[2] + b[2]) / 2]);
    this.#noPickup.set(carrierId, this.tick + 60); // the one who lost it can't grab it straight back
  }

  #touching(agentId: string, itemId: string): boolean {
    const a = this.pos(agentId);
    const b = this.pos(itemId);
    const ra = this.ents.get(agentId)!.size[0] / 2;
    const rb = Math.max(...this.ents.get(itemId)!.size) / 2;
    const dx = a[0] - b[0];
    const dz = a[2] - b[2];
    const reach = ra + rb + 0.25;
    return dx * dx + dz * dz <= reach * reach && Math.abs(a[1] - b[1]) <= 1.4;
  }

  /** Is the mover's centre inside the sensor's box? */
  #within(moverId: string, sensorId: string): boolean {
    const m = this.pos(moverId);
    const s = this.ents.get(sensorId)!;
    const c = s.home;
    const h = s.size;
    return Math.abs(m[0] - c[0]) <= h[0] / 2 && Math.abs(m[1] - c[1]) <= h[1] / 2 + 0.9 && Math.abs(m[2] - c[2]) <= h[2] / 2;
  }

  #resolve(path: string): string | number | boolean {
    const [head, ...rest] = path.split(".");
    if (head!.startsWith("team:")) return rest[0] === "score" || rest.length === 0 ? (this.scores[head!] ?? 0) : "";
    let e = this.ents.get(head!);
    let val: string | number | boolean = head!;
    for (const field of rest) {
      if (!e) return "";
      if (field === "carrier") {
        val = e.carrier;
        e = this.ents.get(e.carrier);
      } else if (field === "team") val = e.team;
      else if (field === "state") val = e.state;
      else if (field === "carrying") {
        val = e.carrying;
        e = this.ents.get(e.carrying);
      } else if (field === "hp" && this.#hp.has(e.id)) val = this.#hp.get(e.id)!.hp;
      else val = e.props[field] ?? "";
    }
    return val;
  }

  /** A condition's right side may name something too ("team:blue.score", "door_1.state"). */
  #operand(r: Rule["if"][number]["r"]): string | number | boolean {
    if (typeof r !== "string" || !r.includes(".")) return r;
    const head = r.split(".")[0]!;
    return head === "team:red" || head === "team:blue" || this.ents.has(head) ? this.#resolve(r) : r;
  }

  #cond(r: Rule): boolean {
    return r.if.every((c) => {
      const l = this.#resolve(c.l);
      const rv = this.#operand(c.r);
      switch (c.op) {
        case "eq": return l === rv;
        case "ne": return l !== rv;
        case "lt": return Number(l) < Number(rv);
        case "lte": return Number(l) <= Number(rv);
        case "gt": return Number(l) > Number(rv);
        case "gte": return Number(l) >= Number(rv);
        case "has": return String(l).includes(String(rv));
        case "in": return String(rv).split(",").includes(String(l));
      }
    });
  }

  #fire(ev: SimEvent, idx: number, push: Push, only?: Rule) {
    for (const r of only ? [only] : this.#rules) {
      const w = r.when;
      if (w.t === "state_is" ? ev.k !== "state" || String(ev.v) !== w.s : w.t === "health_lte" ? ev.k !== "hp" || !this.#crossed(ev, w.n) : w.t !== ev.k) continue;
      // "team:blue is hit": anyone on that team (a score_gte event names the team itself)
      if (w.t !== "every" && w.a && w.a !== ev.a && !(w.a.startsWith("team:") && this.ents.get(ev.a)?.team === w.a.slice(5))) continue;
      if (w.t === "every" && ev.a !== r.id) continue;
      if (w.t === "lap_done" && w.n > 0 && Number(ev.v) !== w.n) continue; // "3 laps": the third lap, once
      if (w.b && w.b !== ev.b) continue;
      if (r.once && this.#fired.has(r.id)) continue;
      const last = this.#lastFire.get(r.id);
      if (r.cooldownS > 0 && last !== undefined && this.tick - last < r.cooldownS * 60) continue;
      if (!this.#cond(r)) continue;
      this.#fired.add(r.id);
      this.fires.set(r.id, (this.fires.get(r.id) ?? 0) + 1);
      this.#lastFire.set(r.id, this.tick);
      for (const fx of r.then) this.#effect(fx, r.id, idx, push);
      if (this.result) return;
    }
  }

  /** An hp event that took its subject from above n to n or below. */
  #crossed(ev: SimEvent, n: number): boolean {
    const was = this.#hpWas.get(ev);
    return was !== undefined && Number(ev.v) <= n && was > n;
  }

  #effect(fx: Effect, rule: string, cause: number, push: Push) {
    const target = fx.target;
    switch (fx.e) {
      case "score": {
        const n = (this.scores[target] ?? 0) + (fx.n || 1);
        this.scores[target] = n;
        push("score", target, "", n, rule, cause);
        break;
      }
      case "win":
      case "lose":
        if (!this.result) {
          this.result = fx.e;
          push(fx.e, target, "", "", rule, cause);
        }
        break;
      case "reset": {
        const e = this.ents.get(target);
        if (!e) break;
        if (e.carrier) {
          this.ents.get(e.carrier)!.carrying = "";
          e.carrier = "";
          e.body?.setBodyType(this.R.RigidBodyType.Dynamic, true);
        }
        this.teleport(target, e.home);
        e.state = e.init;
        push("reset", target, "", "", rule, cause);
        break;
      }
      case "set_state": {
        const e = this.ents.get(target);
        if (!e) break;
        e.state = String(fx.v);
        // a door said to be open is open: its collider follows the state
        if (e.kind === "door" && (e.state === "open" || e.state === "closed")) e.col?.setEnabled(e.state === "closed");
        push("state", target, "", e.state, rule, cause);
        break;
      }
      case "emit":
        push("emit", target, "", fx.fx, rule, cause);
        break;
      case "destroy": {
        const e = this.ents.get(target);
        if (!e || e.destroyed) break;
        e.destroyed = true;
        e.col?.setEnabled(false);
        if (e.carrier) {
          this.ents.get(e.carrier)!.carrying = "";
          e.carrier = "";
        }
        push("destroy", target, "", "", rule, cause);
        break;
      }
      case "open":
      case "close": {
        const e = this.ents.get(target);
        if (!e) break;
        e.col?.setEnabled(fx.e === "close");
        e.state = fx.e === "open" ? "open" : "closed";
        push("state", target, "", e.state, rule, cause);
        break;
      }
      case "teleport": {
        const dest = this.ents.get(String(fx.v));
        if (dest && this.ents.has(target)) this.teleport(target, dest.home);
        push("teleport", target, String(fx.v), "", rule, cause);
        break;
      }
      case "damage":
      case "heal": {
        // n hit points (25 when the rule gives none); a team means everyone on it with hit points
        const n = fx.n || Number(fx.v) || 25;
        const who = target.startsWith("team:") ? this.order.filter((id) => this.#hp.has(id) && this.ents.get(id)!.team === target.slice(5)) : [target];
        if (!who.some((id) => this.#hp.has(id))) {
          push("unsupported", fx.e, target, "", rule, cause);
          break;
        }
        for (const id of who) {
          if (fx.e === "damage") this.#hurt(id, n, "", push, rule, cause);
          else this.#heal(id, n, push, rule, cause);
        }
        break;
      }
      default:
        push("unsupported", fx.e, target, "", rule, cause);
    }
  }

  stateHash(): string {
    return hex32(this.hash);
  }

  bundle(): WorldBundle {
    return this.#bundle;
  }

  free() {
    // The character controller borrows the collider set; release it before the world.
    this.world.removeCharacterController(this.player.kcc);
    for (const c of this.npcs.values()) this.world.removeCharacterController(c.kcc);
    this.world.free();
  }
}
