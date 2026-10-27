// SimWorld: the deterministic runtime shared by the browser, the edge proof service and the Node
// verifier. Fixed 60 Hz, bodies created in id order, triggers evaluated with plain AABB maths in
// id order, rules in (prio desc, id) order — so the same bundle + seed + inputs give bit-identical
// event logs and state hashes everywhere.
import { hex32, xxh32 } from "@ghostrun/detmath";
import type { Effect, Entity, Laws, Rule, Vec3, WorldBundle } from "@ghostrun/ir";
import { clampLaws } from "@ghostrun/ir";
import { PLAYER_HALF_HEIGHT, PLAYER_RADIUS, PlayerController } from "./controller";
import type { Rapier } from "./rapier/load";
import { DT, type InputFrame, type Pose, type Result, type SimEvent } from "./types";

type RigidBody = InstanceType<Rapier["RigidBody"]>;
type Collider = InstanceType<Rapier["Collider"]>;

export interface SimOptions {
  playerTeam?: "red" | "blue";
  /** Override laws (T1/T3 use this to test "would it still work with one jump?"). */
  laws?: Partial<Laws>;
}

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

const byId = <T extends { id: string }>(xs: readonly T[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export class SimWorld {
  readonly R: Rapier;
  readonly world: InstanceType<Rapier["World"]>;
  readonly laws: Laws;
  readonly player: PlayerController;
  readonly ents = new Map<string, RtEnt>();
  readonly order: string[] = []; // deterministic iteration order (sorted ids, player included)
  readonly scores: Record<string, number> = { "team:red": 0, "team:blue": 0 };
  readonly log: SimEvent[] = [];
  tick = 0;
  result: Result = null;
  hash = 0;
  #rules: Rule[];
  #fired = new Set<string>();
  #lastFire = new Map<string, number>();
  #inside = new Map<string, Set<string>>(); // sensor id → movers inside
  #bundle: WorldBundle;

  constructor(R: Rapier, bundle: WorldBundle, opts: SimOptions = {}) {
    this.R = R;
    this.#bundle = bundle;
    this.laws = clampLaws({ ...bundle.laws, ...opts.laws });
    this.world = new R.World({ x: 0, y: -9.81 * this.laws.gravityScale, z: 0 });
    this.world.timestep = DT;

    const fixed = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    for (const s of byId(bundle.statics)) {
      if (s.rotY !== 0) throw new Error(`static ${s.id}: rotated statics not supported yet`);
      this.world.createCollider(R.ColliderDesc.cuboid(s.size[0] / 2, s.size[1] / 2, s.size[2] / 2).setTranslation(s.pos[0], s.pos[1], s.pos[2]), fixed);
    }

    const carryable = new Set(bundle.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on));
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
    const kcc = this.world.createCharacterController(0.01);
    kcc.enableAutostep(0.4, 0.2, true);
    kcc.enableSnapToGround(0.3);
    kcc.setMaxSlopeClimbAngle(0.7853981633974483); // 45°
    kcc.setApplyImpulsesToDynamicBodies(true);
    this.player = new PlayerController(pBody, pCol, kcc, this.laws);
    this.ents.set("player", {
      id: "player", kind: "player", team, body: pBody, col: pCol, size: [PLAYER_RADIUS * 2, 1.8, PLAYER_RADIUS * 2], home: start,
      state: "", init: "", carrier: "", carrying: "", sensor: false, mover: true, agent: true, carryable: false, destroyed: false, props: {}, osc: null,
    });

    this.order.push(...[...this.ents.keys()].sort());
    for (const id of this.order) if (this.ents.get(id)!.sensor) this.#inside.set(id, new Set());
    this.#rules = [...bundle.rules].sort((a, b) => b.prio - a.prio || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  #spawnEntity(e: Entity, carryable: boolean): RtEnt {
    const R = this.R;
    const [sx, sy, sz] = e.size;
    let body: RigidBody | null = null;
    let col: Collider | null = null;
    const physical = e.body === "fixed" || e.body === "dynamic" || e.body === "kinematic";
    if (physical) {
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
      id: e.id, kind: e.kind, team: e.team, body, col, size: e.size, home: e.pos, state: e.init, init: e.init,
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
  }

  attach(itemId: string, carrierId: string) {
    const item = this.ents.get(itemId)!;
    const carrier = this.ents.get(carrierId)!;
    if (item.carrier) this.ents.get(item.carrier)!.carrying = "";
    item.carrier = carrierId;
    carrier.carrying = itemId;
    item.body?.setBodyType(this.R.RigidBodyType.KinematicPositionBased, true);
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
    const push = (k: string, a: string, b = "", v: number | string = "", rule = "", cause = -1) => {
      evs.push({ tick: t, k, a, b, v, rule, cause });
    };

    // 1. player movement (ignores the item it carries)
    const playerCarry = this.ents.get("player")!.carrying;
    const carriedHandle = playerCarry ? this.ents.get(playerCarry)!.col?.handle : undefined;
    // Compare handles only: calling collider methods here would re-borrow Rapier's collider set
    // while the KCC holds it. Sensors have no physics colliders in this world.
    const pc = this.ents.get("player")!.col!;
    const c = this.player.step(
      input,
      (col) => col.handle === carriedHandle,
      (headY, up) => {
        const p = this.player.body.translation();
        const ray = new this.R.Ray({ x: p.x, y: headY + 0.001, z: p.z }, { x: 0, y: 1, z: 0 });
        return this.world.castRay(ray, up, true, undefined, undefined, pc, undefined, (col) => col.handle !== carriedHandle) !== null;
      },
    );
    if (c.jumped) push("jump", "player");
    if (c.airJumped) push("air_jump", "player", "", this.player.jumpsUsed);
    if (c.landed) push("land", "player");

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

    // 4. triggers, in id order
    for (const itemId of this.order) {
      const item = this.ents.get(itemId)!;
      if (!item.carryable || item.carrier || item.destroyed) continue;
      for (const agentId of this.order) {
        const ag = this.ents.get(agentId)!;
        if (!ag.agent && agentId !== "player") continue;
        if (ag.carrying || ag.destroyed) continue;
        if (this.#touching(agentId, itemId)) {
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

    // 5. rules (events may cascade; score_gte is checked after each pass)
    for (let i = 0; i < evs.length && i < 512; i++) {
      this.#fire(evs[i]!, i, push);
      if (this.result) break;
    }
    for (const r of this.#rules) {
      if (this.result) break;
      if (r.when.t === "score_gte" && (this.scores[r.when.a] ?? 0) >= r.when.n) {
        const idx = evs.length;
        push("score_gte", r.when.a, "", this.scores[r.when.a] ?? 0);
        this.#fire(evs[idx]!, idx, push, r);
      }
    }

    // 6. state hash over everything that moves or counts
    const buf = new Float64Array(this.order.length * 3 + 4);
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
    this.hash = xxh32(new Uint8Array(buf.buffer), this.hash);

    this.log.push(...evs);
    return evs;
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
      } else val = e.props[field] ?? "";
    }
    return val;
  }

  #cond(r: Rule): boolean {
    return r.if.every((c) => {
      const l = this.#resolve(c.l);
      const rv = c.r;
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

  #fire(ev: SimEvent, idx: number, push: (k: string, a: string, b?: string, v?: number | string, rule?: string, cause?: number) => void, only?: Rule) {
    for (const r of only ? [only] : this.#rules) {
      const w = r.when;
      if (w.t !== ev.k) continue;
      if (w.t !== "every" && w.a && w.a !== ev.a) continue;
      if (w.t === "every" && ev.a !== r.id) continue;
      if (w.b && w.b !== ev.b) continue;
      if (r.once && this.#fired.has(r.id)) continue;
      const last = this.#lastFire.get(r.id);
      if (r.cooldownS > 0 && last !== undefined && this.tick - last < r.cooldownS * 60) continue;
      if (!this.#cond(r)) continue;
      this.#fired.add(r.id);
      this.#lastFire.set(r.id, this.tick);
      for (const fx of r.then) this.#effect(fx, r.id, idx, push);
      if (this.result) return;
    }
  }

  #effect(fx: Effect, rule: string, cause: number, push: (k: string, a: string, b?: string, v?: number | string, rule?: string, cause?: number) => void) {
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
    this.world.free();
  }
}
