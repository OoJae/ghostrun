// A place's life contract (Wander worlds): at least three creatures or passers-by that react to the
// player, chosen by the world's look and setting, with spatial ambience.
//   forest   fireflies drift to you and circle, a deer startles and bolts, an owl turns its head, then flies
//   museum   an attendant nods as you pass, visitors stroll between the exhibits and step aside
//   city     pigeons scatter when you come close, passers-by step aside and glance at you
//   space    maintenance drones turn to you, come to scan you, and drift back to their rounds
// Cosmetic only: none of it is in the world's bundle, so none of it is in the spec hash or the proof,
// and nothing here collides with or touches the simulation (it reads where the player is, nothing
// more). Pure and three-free, so it is tested headless (test/life.test.ts); render/life.ts draws it.
import type { Vec3, WorldBundle } from "@ghostrun/ir";
import type { LookId } from "./render/pick";
import { tn } from "./i18n";

export type Setting = "forest" | "museum" | "city" | "space";
export type Kind = "firefly" | "deer" | "owl" | "attendant" | "visitor" | "pigeon" | "passerby" | "drone";
export type Mood = "idle" | "flock" | "startled" | "watch" | "fly" | "nod" | "aside" | "scatter" | "scan" | "home";

export interface Creature {
  id: number;
  kind: Kind;
  /** Where it lives (its perch, its patch of grass, its exhibit, its post), floor height. */
  home: Vec3;
  /** Other homes it walks between (visitors, passers-by), its own first. */
  route: Vec3[];
  leg: number;
  p: Vec3;
  /** Facing (radians, three's convention: 0 looks down −z). */
  yaw: number;
  mood: Mood;
  /** Seconds into its mood. */
  t: number;
  /** Times it has reacted to the player (a startle, a nod, a scatter, a scan). */
  reacted: number;
  phase: number;
}

export interface LifeEvent {
  kind: Kind;
  mood: Mood;
  at: Vec3;
}

/** Each setting's creatures (how many of each), its reaction words, and its ambience. */
export const CAST: Record<Setting, readonly (readonly [Kind, number])[]> = {
  forest: [["firefly", 16], ["deer", 2], ["owl", 2]],
  museum: [["attendant", 1], ["visitor", 3]],
  city: [["pigeon", 6], ["passerby", 3]],
  space: [["drone", 3]],
};

/** A count of a kind in the HUD's words ("3 visitors"). */
export function kindCount(kind: Kind, n: number): string {
  switch (kind) {
    case "firefly": return tn(n, "{n} firefly", "{n} fireflies");
    case "deer": return tn(n, "{n} deer", "{n} deer");
    case "owl": return tn(n, "{n} owl", "{n} owls");
    case "attendant": return tn(n, "{n} attendant", "{n} attendants");
    case "visitor": return tn(n, "{n} visitor", "{n} visitors");
    case "pigeon": return tn(n, "{n} pigeon", "{n} pigeons");
    case "passerby": return tn(n, "{n} passer-by", "{n} passers-by");
    case "drone": return tn(n, "{n} drone", "{n} drones");
  }
}

const FOREST: readonly LookId[] = ["grove", "jungle", "candy", "snow"];
const MUSEUM: readonly LookId[] = ["gallery", "home", "medieval", "haunted"];

/** Which life a place gets: by its look, then by its words (a museum written in neon is still a museum). */
export function settingOf(b: WorldBundle, look: LookId): Setting {
  const words = `${b.cosmetic.look} ${b.zones.map((z) => z.name).join(" ")}`.toLowerCase();
  if (look === "space" || /\b(space|station|orbit|moon|mars|asteroid|spaceship|starship)\b/.test(words)) return "space";
  if (/\b(museum|gallery|exhibit|exhibition|villa|mansion|palace|library|showroom|castle)\b/.test(words)) return "museum";
  if (/\b(forest|woods?|glade|grove|jungle|garden|park|meadow|bioluminescent|swamp)\b/.test(words)) return "forest";
  if (MUSEUM.includes(look)) return "museum";
  if (FOREST.includes(look)) return "forest";
  return "city";
}

/** A small seeded random stream (cosmetic only, so not detmath; seeded so a place looks the same each visit). */
function rng(seed: number): () => number {
  let s = (seed ^ 0x9e3779b9) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

const d2 = (a: Vec3, b: Vec3) => (a[0] - b[0]) * (a[0] - b[0]) + (a[2] - b[2]) * (a[2] - b[2]);

/** Floor points to live on: the place's things (its exhibits, signs, trees) and its spawn, by zone. */
function anchors(b: WorldBundle): { p: Vec3; zone: string }[] {
  const out: { p: Vec3; zone: string }[] = [];
  for (const e of [...b.entities].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    if (e.kind === "hazard" || e.kind === "npc" || e.kind === "portal" || e.kind === "vehicle") continue;
    out.push({ p: [e.pos[0], e.pos[1] - e.size[1] / 2, e.pos[2]], zone: e.zone });
  }
  return out;
}

/**
 * The place's creatures, placed: nobody within 3 m of where the player starts, each near one of the
 * place's things (a visitor's route is the things in its room).
 */
export function lifeOf(b: WorldBundle, setting: Setting): Creature[] {
  const r = rng(b.seed * 7919 + 17);
  const spawn = b.entities.find((e) => e.kind === "spawn")?.pos ?? [0, 0, 0];
  const spots = anchors(b).filter((a) => d2(a.p, spawn) > 9);
  const pool = spots.length ? spots : [{ p: [spawn[0] + 5, spawn[1], spawn[2] + 5] as Vec3, zone: "" }];
  const out: Creature[] = [];
  let i = 0;
  for (const [kind, n] of CAST[setting]) {
    for (let j = 0; j < n; j++) {
      // a flock shares a few homes; the rest spread out over the place
      const a = pool[kind === "firefly" ? Math.floor(j / 6) % pool.length : (i * 3 + j * 5 + Math.floor(r() * pool.length)) % pool.length]!;
      const off = kind === "firefly" ? 2.5 : kind === "pigeon" ? 1.2 : 1.8;
      const ang = r() * Math.PI * 2;
      const home: Vec3 = [a.p[0] + Math.cos(ang) * off, a.p[1] + (kind === "owl" ? 3.2 : kind === "firefly" ? 1.2 + r() * 1.4 : kind === "drone" ? 2.4 : 0), a.p[2] + Math.sin(ang) * off];
      const room = pool.filter((x) => x.zone === a.zone).map((x) => [x.p[0] + 1.2, x.p[1], x.p[2] + 1.2] as Vec3);
      const route = kind === "visitor" || kind === "passerby" ? [home, ...room.filter((x) => d2(x, home) > 4).slice(0, 3)] : [home];
      out.push({ id: i++, kind, home, route, leg: 0, p: [...home], yaw: r() * Math.PI * 2, mood: "idle", t: r() * 3, reacted: 0, phase: r() * Math.PI * 2 });
    }
  }
  return out;
}

/** How near (m) the player must come before each kind reacts. */
export const NOTICE: Record<Kind, number> = { firefly: 9, deer: 7, owl: 8, attendant: 4.5, visitor: 2.2, pigeon: 4, passerby: 2.2, drone: 9 };
const SPEED: Record<Kind, number> = { firefly: 2.2, deer: 6, owl: 5, attendant: 0, visitor: 0.9, pigeon: 5, passerby: 1.3, drone: 2.4 };

const face = (c: Creature, dx: number, dz: number, k = 1) => {
  if (dx * dx + dz * dz < 1e-6) return;
  const want = Math.atan2(-dx, -dz);
  let d = want - c.yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  c.yaw += d * Math.min(1, k);
};

function toward(c: Creature, to: Vec3, speed: number, dt: number, keepY = true): number {
  const dx = to[0] - c.p[0];
  const dz = to[2] - c.p[2];
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d > 1e-3) {
    const step = Math.min(d, speed * dt);
    c.p[0] += (dx / d) * step;
    c.p[2] += (dz / d) * step;
    face(c, dx, dz, dt * 8);
  }
  if (!keepY) c.p[1] += (to[1] - c.p[1]) * Math.min(1, dt * 2);
  return d;
}

/** One frame of life: each creature notices the player (or not) and does what its kind does. Returns what it reacted with. */
export function stepLife(cs: Creature[], dt: number, player: Vec3, time: number): LifeEvent[] {
  const evs: LifeEvent[] = [];
  const react = (c: Creature, mood: Mood) => {
    c.mood = mood;
    c.t = 0;
    c.reacted++;
    evs.push({ kind: c.kind, mood, at: [...c.p] });
  };
  for (const c of cs) {
    c.t += dt;
    const dx = player[0] - c.p[0];
    const dz = player[2] - c.p[2];
    const near = Math.sqrt(dx * dx + dz * dz);
    const noticed = near < NOTICE[c.kind] && Math.abs(player[1] - c.home[1]) < 6;
    switch (c.kind) {
      case "firefly": {
        // drawn to the player: they gather and circle you, a little above head height
        if (noticed && c.mood !== "flock") react(c, "flock");
        else if (!noticed && c.mood === "flock" && near > NOTICE.firefly + 3) c.mood = "home";
        const a = time * 0.9 + c.phase;
        const to: Vec3 = c.mood === "flock" ? [player[0] + Math.cos(a) * 1.8, player[1] + 0.9 + Math.sin(a * 1.7) * 0.4, player[2] + Math.sin(a) * 1.8] : [c.home[0] + Math.cos(a * 0.5) * 1.5, c.home[1] + Math.sin(a * 0.8) * 0.5, c.home[2] + Math.sin(a * 0.6) * 1.5];
        toward(c, to, SPEED.firefly, dt, false);
        break;
      }
      case "deer": {
        if (c.mood === "startled") {
          // bolts away from you for a second and a half, then stops to watch
          if (near > 0.01) toward(c, [c.p[0] - (dx / near) * 4, c.p[1], c.p[2] - (dz / near) * 4], SPEED.deer, dt);
          if (c.t > 1.5) ((c.mood = "watch"), (c.t = 0));
        } else if (c.mood === "watch") {
          face(c, dx, dz, dt * 4);
          if (near < NOTICE.deer - 1.5) react(c, "startled");
          else if (near > NOTICE.deer + 4 && c.t > 2) c.mood = "home";
        } else if (noticed) react(c, "startled");
        else if (toward(c, c.home, 1.2, dt) < 0.2) c.mood = "idle";
        break;
      }
      case "owl": {
        if (c.mood === "fly") {
          // off to another branch, away from you, and back to its perch when you've gone
          const a = c.phase + c.reacted;
          toward(c, [c.home[0] + Math.cos(a) * 6, c.home[1] + 1.5, c.home[2] + Math.sin(a) * 6], SPEED.owl, dt, false);
          if (c.t > 2.5 && near > NOTICE.owl) ((c.mood = "home"), (c.t = 0));
        } else if (noticed && near < 3.5) react(c, "fly");
        else if (noticed) {
          if (c.mood !== "watch") react(c, "watch");
          face(c, dx, dz, dt * 3); // turns its head to follow you
        } else {
          c.mood = toward(c, c.home, 2, dt, false) < 0.2 ? "idle" : "home";
        }
        break;
      }
      case "attendant": {
        // stands at its post, turns to you and nods as you come by (once each time you come near)
        if (noticed) {
          face(c, dx, dz, dt * 4);
          if (c.mood !== "nod" && c.mood !== "watch") react(c, "nod");
          else if (c.mood === "nod" && c.t > 1.2) c.mood = "watch";
        } else c.mood = "idle";
        break;
      }
      case "visitor":
      case "passerby": {
        // walks between things; you come close, it steps aside, glances at you, and goes on
        if (noticed && c.mood !== "aside") react(c, "aside");
        if (c.mood === "aside") {
          if (near > 0.01 && c.t < 0.8) toward(c, [c.p[0] - (dz / near) * 2, c.p[1], c.p[2] + (dx / near) * 2], SPEED[c.kind] * 1.4, dt);
          else face(c, dx, dz, dt * 4);
          if (c.t > 2.2 && !noticed) c.mood = "idle";
          break;
        }
        const goal = c.route[c.leg % c.route.length]!;
        if (toward(c, goal, SPEED[c.kind], dt) < 0.3) {
          // a pause at each thing, then the next
          if (c.mood !== "idle") ((c.mood = "idle"), (c.t = 0));
          else if (c.t > 3) ((c.leg = (c.leg + 1) % c.route.length), (c.mood = "home"));
        } else c.mood = "home";
        break;
      }
      case "pigeon": {
        if (c.mood === "scatter") {
          // up and away, then down again somewhere else nearby
          const away: Vec3 = near > 0.01 ? [c.home[0] - (dx / near) * 6, c.home[1] + (c.t < 1.2 ? 3 : 0), c.home[2] - (dz / near) * 6] : c.home;
          toward(c, away, SPEED.pigeon, dt, false);
          if (c.t > 2.5 && near > NOTICE.pigeon + 2) ((c.mood = "home"), (c.t = 0));
        } else if (noticed) react(c, "scatter");
        else {
          // pecking about at home
          const to: Vec3 = [c.home[0] + Math.cos(time * 0.3 + c.phase) * 0.6, c.home[1], c.home[2] + Math.sin(time * 0.4 + c.phase) * 0.6];
          c.mood = toward(c, to, 0.5, dt, false) < 0.8 ? "idle" : "home";
        }
        break;
      }
      case "drone": {
        // its rounds about its post; you come near, it turns to you and comes to scan you, then goes back
        if (noticed) {
          if (c.mood !== "scan") react(c, "scan");
          const back = near > 0.01 ? 3 / near : 0;
          toward(c, [player[0] - dx * back, player[1] + 1.4, player[2] - dz * back], SPEED.drone, dt, false);
          face(c, dx, dz, dt * 6);
        } else {
          const a = time * 0.35 + c.phase;
          c.mood = "idle";
          toward(c, [c.home[0] + Math.cos(a) * 2.5, c.home[1] + Math.sin(a * 2) * 0.3, c.home[2] + Math.sin(a) * 2.5], 1.2, dt, false);
        }
        break;
      }
    }
  }
  return evs;
}
