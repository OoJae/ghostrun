// Cast brains: every NPC plays the menu option it holds (the fill's default until a mind picks
// another from the same typed menu) as plain steering on navmesh paths. Only arithmetic, sqrt and
// recast queries, so the bots a proof played against are the bots the judge plays against, on
// every runtime.
import { stream } from "@ghostrun/detmath";
import type { Cast, Vec3, WorldBundle } from "@ghostrun/ir";
import type { NavWorld } from "@ghostrun/nav";
import { BTN, type Brain, type InputFrame, type SimWorld } from "@ghostrun/sim";

export type Behaviour = "attack" | "intercept" | "defend" | "follow" | "patrol" | "idle";

// Menu options are free-form `role.verb` strings from the fill; the verb picks the behaviour.
const VERBS: readonly (readonly [RegExp, Behaviour])[] = [
  [/attack|capture|steal|score|raid|chase|hunt|charge/, "attack"],
  [/intercept|mark|press|tackle|block/, "intercept"],
  [/defend|guard|protect|hold|keep/, "defend"],
  [/follow|escort|assist|support|help|accompany/, "follow"],
  [/patrol|wander|roam|walk|sweep|circle/, "patrol"],
];

export function behaviourOf(option: string): Behaviour {
  const verb = option.slice(option.lastIndexOf(".") + 1).toLowerCase();
  return VERBS.find(([re]) => re.test(verb))?.[1] ?? "idle";
}

/** Fraction of the laws' run speed: rivals are a step slower than the player, so they can be beaten. */
const SPEED: Partial<Record<Cast["role"], number>> = { rival: 0.8, teammate: 0.85, guard: 0.7, creature: 0.75 };
const PATROL_SPEED = 0.45;
const REPLAN_TICKS = 30;
const STUCK_TICKS = 45;
const CENTRE_TO_FEET = 0.95;

interface Bot {
  id: string;
  team: string;
  menu: readonly string[];
  option: string;
  beh: Behaviour;
  speed: number;
  rng: () => number;
  path: Vec3[];
  wp: number;
  aim: Vec3 | null;
  replanAt: number;
  best: number;
  progressAt: number;
  last: Vec3 | null;
  dodge: { x: number; z: number; until: number } | null;
  patrol: Vec3[];
  patrolI: number;
}

const d2 = (a: Vec3, b: Vec3) => {
  const dx = a[0] - b[0];
  const dz = a[2] - b[2];
  return dx * dx + dz * dz;
};
const sortById = <T extends { id: string }>(xs: readonly T[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export class CastBrain implements Brain {
  readonly bots: Bot[] = [];
  readonly #nav: NavWorld;
  readonly #item: string;
  readonly #goal = new Map<string, Vec3>();
  readonly #post = new Map<string, Vec3>();
  readonly #out = new Map<string, InputFrame>();

  constructor(nav: NavWorld, b: WorldBundle) {
    this.#nav = nav;
    // the thing to fight over; never a ball that gets thrown (bots don't throw, and crowding one
    // they can't pick up only kicks it into a corner): in a throwing game they go for the player
    const thrown = new Set(b.verbs.filter((v) => v.verb === "combat_sport.throw").map((v) => v.on));
    const carry = new Set(b.verbs.filter((v) => v.verb.endsWith(".carry") && !thrown.has(v.on)).map((v) => v.on));
    const item = sortById(b.entities).find((e) => carry.has(e.id));
    this.#item = item?.id ?? "";
    for (const g of sortById(b.entities)) {
      if (g.kind !== "goal" || !g.team || this.#goal.has(g.team)) continue;
      this.#goal.set(g.team, g.pos);
      // the defender's post: 4 m out from its goal toward where the objective starts and 3 m to
      // the side, so it never body-blocks its own team's run home (mirrored for both teams)
      const to = item?.pos ?? [0, 0, 0];
      const ox = to[0] - g.pos[0];
      const oz = to[2] - g.pos[2];
      const len = Math.sqrt(ox * ox + oz * oz) || 1;
      const [dx, dz] = [ox / len, oz / len];
      const post: Vec3 = [g.pos[0] + dx * 4 - dz * 3, g.pos[1], g.pos[2] + dz * 4 + dx * 3];
      this.#post.set(g.team, nav.nearest(post) ?? post);
    }
    const cast = new Map(b.cast.map((c) => [c.npc, c]));
    for (const e of sortById(b.entities)) {
      if (e.kind !== "npc" || e.body === "none" || e.body === "sensor") continue;
      const c = cast.get(e.id);
      const option = c && c.menu.includes(c.dflt) ? c.dflt : (c?.menu[0] ?? "");
      // patrol: the other things in its zone, then home
      const stops = sortById(b.entities)
        .filter((x) => x.zone === e.zone && x.id !== e.id && x.kind !== "npc")
        .map((x) => nav.nearest(x.pos))
        .filter((p): p is Vec3 => p !== null);
      const home = nav.nearest(e.pos);
      this.bots.push({
        id: e.id, team: e.team, menu: c?.menu ?? [], option, beh: behaviourOf(option), speed: SPEED[c?.role ?? "citizen"] ?? 0.6,
        rng: stream(b.seed, `bot:${e.id}`), path: [], wp: 0, aim: null, replanAt: 0, best: Infinity, progressAt: 0, last: null, dodge: null,
        patrol: home ? [...stops, home] : stops, patrolI: 0,
      });
    }
  }

  /** A mind (or the Director) switching an NPC to another option on its typed menu. */
  choose(id: string, option: string): boolean {
    const bot = this.bots.find((x) => x.id === id);
    if (!bot || !bot.menu.includes(option)) return false;
    bot.option = option;
    bot.beh = behaviourOf(option);
    bot.aim = null;
    return true;
  }

  think(w: SimWorld): ReadonlyMap<string, InputFrame> {
    const tick = w.tick + 1;
    for (const bot of this.bots) {
      const e = w.entity(bot.id);
      if (!e || e.destroyed) {
        this.#out.delete(bot.id);
        continue;
      }
      this.#out.set(bot.id, this.#drive(w, bot, this.#target(w, bot), tick));
    }
    return this.#out;
  }

  #target(w: SimWorld, b: Bot): Vec3 | null {
    const me = w.entity(b.id)!;
    const goal = this.#goal.get(b.team) ?? null;
    if (me.carrying) return goal; // bring it home
    const item = this.#item;
    const carrier = item ? w.entity(item)!.carrier : "";
    const enemyCarrier = carrier && w.entity(carrier)!.team !== b.team ? carrier : "";
    const within = (id: string, p: Vec3, r: number) => d2(w.pos(id), p) < r * r;
    switch (b.beh) {
      case "attack":
        if (carrier) return w.pos(carrier); // chase an enemy carrier, escort a teammate
        if (item) return w.pos(item);
        return b.team && w.entity("player")!.team !== b.team ? w.pos("player") : null;
      case "intercept":
        if (enemyCarrier) return w.pos(enemyCarrier);
        if (item && !carrier) return w.pos(item);
        return item ? w.entity(item)!.home : null;
      case "defend": {
        const post = this.#post.get(b.team) ?? me.home;
        if (enemyCarrier && within(enemyCarrier, post, 12)) return w.pos(enemyCarrier);
        if (item && !carrier && within(item, post, 6)) return w.pos(item);
        return post;
      }
      case "follow": {
        if (enemyCarrier && within(enemyCarrier, w.pos(b.id), 8)) return w.pos(enemyCarrier);
        if (w.entity("player")!.team !== b.team) return null;
        const lead = w.pos("player");
        return within(b.id, lead, 2.5) ? null : lead;
      }
      case "patrol": {
        if (!b.patrol.length) return null;
        if (within(b.id, b.patrol[b.patrolI % b.patrol.length]!, 1)) b.patrolI++;
        return b.patrol[b.patrolI % b.patrol.length]!;
      }
      default:
        return null;
    }
  }

  #drive(w: SimWorld, b: Bot, target: Vec3 | null, tick: number): InputFrame {
    const idle = { tick, wx: 0, wz: 0, btn: 0 };
    const p = w.pos(b.id);
    const jumped = b.last !== null && d2(p, b.last) > 4; // teleported (a reset): plan afresh
    b.last = p;
    if (!target) return idle;
    if (jumped || !b.aim || d2(b.aim, target) > 2.25 || tick >= b.replanAt || b.wp >= b.path.length) {
      const feet: Vec3 = [p[0], p[1] - CENTRE_TO_FEET, p[2]];
      let path = this.#nav.path(feet, target);
      if (!path) {
        const near = this.#nav.nearest(target);
        path = near ? this.#nav.path(feet, near) : null;
      }
      b.path = path ?? [target];
      b.wp = 0;
      b.aim = target;
      b.replanAt = tick + REPLAN_TICKS;
      b.best = Infinity;
      b.progressAt = tick;
    }
    while (b.wp < b.path.length - 1 && d2(p, b.path[b.wp]!) < 0.2) {
      b.wp++;
      b.best = Infinity;
    }
    const wp = b.path[b.wp] ?? target;
    let ux = wp[0] - p[0];
    let uz = wp[2] - p[2];
    const dist2 = ux * ux + uz * uz;
    if (b.wp >= b.path.length - 1 && dist2 < 0.09) return idle; // arrived
    if (dist2 < b.best - 0.01) {
      b.best = dist2;
      b.progressAt = tick;
    }
    let btn = 0;
    if (tick - b.progressAt > STUCK_TICKS) {
      // pinned against something: sidestep for a quarter second and hop, deterministically
      b.dodge = { x: b.rng() - 0.5, z: b.rng() - 0.5, until: tick + 15 };
      b.progressAt = tick;
      b.replanAt = tick + 15;
      btn = BTN.JUMP;
    }
    if (b.dodge && tick < b.dodge.until) {
      ux = b.dodge.x;
      uz = b.dodge.z;
    }
    const len = Math.sqrt(ux * ux + uz * uz);
    if (len < 1e-6) return idle;
    const k = (127 * (b.beh === "patrol" ? PATROL_SPEED : b.speed)) / len;
    return { tick, wx: Math.round(ux * k), wz: Math.round(uz * k), btn };
  }
}

export function castBrain(nav: NavWorld, b: WorldBundle): CastBrain {
  return new CastBrain(nav, b);
}
