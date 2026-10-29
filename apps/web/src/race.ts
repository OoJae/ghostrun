// Racing a ghost: where it is at any moment of the run, which way it faces, and how far ahead or
// behind the player is. Cosmetic: nothing here reaches the simulation (the trigonometry lives here,
// on the client, for that reason).
import { fraction, Progress, type Ghost, type ProgressSim } from "@ghostrun/proof/light";
import { FIXTURE_PROMPTS, FIXTURES, type World } from "./pipeline";

/** Who the ghost beside the player is, and what backs its time. */
export interface Rival {
  /** The proof's par runner, or a person's stored run. */
  kind: "ai" | "run";
  /** As the HUD names it: "AI", a nickname, or "Their run". */
  name: string;
  ghost: Ghost;
  /** What backs it, said plainly (the HUD's hover text). */
  how: string;
}

/** A ghost ready to draw: positions by tick, with a facing for every sample. */
export class GhostTrack {
  readonly ghost: Ghost;
  readonly #yaw: Float64Array;

  constructor(g: Ghost) {
    this.ghost = g;
    const n = g.prog.length;
    this.#yaw = new Float64Array(n);
    // a sample with no push yet faces the way the run first went
    const k = g.prog.findIndex((_, i) => g.dir[i * 2] || g.dir[i * 2 + 1]);
    let yaw = k >= 0 ? Math.atan2(-g.dir[k * 2]!, -g.dir[k * 2 + 1]!) : 0;
    for (let i = 0; i < n; i++) {
      const wx = g.dir[i * 2]!;
      const wz = g.dir[i * 2 + 1]!;
      if (wx || wz) yaw = Math.atan2(-wx, -wz); // three.js yaw 0 looks down −z, as the player's facing
      this.#yaw[i] = yaw;
    }
  }

  get ticks(): number {
    return this.ghost.ticks;
  }

  /** The tick sample i was taken on (the last one is the winning moment). */
  tickOf(i: number): number {
    return i >= this.ghost.prog.length - 1 ? this.ghost.ticks : i * this.ghost.every;
  }

  /** Where it was at this (fractional) tick, held at the finish once it has won. */
  pose(tick: number): { p: [number, number, number]; yaw: number } {
    const g = this.ghost;
    const n = g.prog.length;
    const t = Math.max(0, Math.min(tick, g.ticks));
    const i = Math.max(0, Math.min(n - 2, Math.floor(t / g.every)));
    if (n < 2) return { p: [g.xyz[0]!, g.xyz[1]!, g.xyz[2]!], yaw: this.#yaw[0]! };
    const t0 = this.tickOf(i);
    const t1 = this.tickOf(i + 1);
    const f = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 1;
    const lerp = (k: number) => g.xyz[i * 3 + k]! + (g.xyz[(i + 1) * 3 + k]! - g.xyz[i * 3 + k]!) * f;
    let d = this.#yaw[i + 1]! - this.#yaw[i]!;
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; // the short way round
    return { p: [lerp(0), lerp(1), lerp(2)], yaw: this.#yaw[i]! + d * f };
  }
}

/** Farther than this from the ghost's route at your stage of the win, a delta would mean nothing. */
const OFF_ROUTE_M = 8;

const stageOf = (p: number) => ({ score: Math.floor(p / 512), used: Math.floor((p % 512) / 2), carrying: p % 2 });

/**
 * Ahead or behind, live: find where the ghost was when it was at your stage of the win (same score,
 * same hands, the nearest count of things used) and nearest to where you are now; you are as far
 * behind as the time between then and now. Once the ghost has finished you are at least that far
 * behind. Read it a few times a second; it remembers your last match to break ties forward.
 */
export class RaceTracker {
  readonly track: GhostTrack;
  readonly #progress: Progress;
  #at = 0;

  constructor(track: GhostTrack, secrets: ReadonlySet<string>) {
    this.track = track;
    this.#progress = new Progress(secrets);
  }

  /** Seconds behind (+) or ahead (−) at this moment, or null off the ghost's route. */
  delta(sim: ProgressSim): number | null {
    const g = this.track.ghost;
    const me = stageOf(this.#progress.read(sim));
    const p = sim.pos("player");
    const n = g.prog.length;
    // the ghost's samples at your stage: same score and hands, the nearest count of things used
    let gap = Infinity;
    for (let i = 0; i < n; i++) {
      const s = stageOf(g.prog[i]!);
      if (s.score === me.score && s.carrying === me.carrying) gap = Math.min(gap, Math.abs(s.used - me.used));
    }
    const fits = (i: number) => {
      const s = stageOf(g.prog[i]!);
      return Number.isFinite(gap) ? s.score === me.score && s.carrying === me.carrying && Math.abs(s.used - me.used) === gap : s.score === me.score;
    };
    const d2 = new Float64Array(n).fill(Infinity);
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (!fits(i)) continue;
      const dx = g.xyz[i * 3]! - p[0];
      const dy = g.xyz[i * 3 + 1]! - p[1];
      const dz = g.xyz[i * 3 + 2]! - p[2];
      d2[i] = dx * dx + dy * dy + dz * dz;
      bestD = Math.min(bestD, d2[i]!);
    }
    const floor = sim.tick > g.ticks ? (sim.tick - g.ticks) / 60 : null;
    if (bestD > OFF_ROUTE_M * OFF_ROUTE_M) return floor;
    // a route that crosses itself passes near you more than once: of the passes about as near as
    // the nearest (each pass is a local minimum), take the one closest to where you were matched
    let best = -1;
    for (let i = 0; i < n; i++) {
      const d = d2[i]!;
      if (d > bestD + 0.25 || d > (d2[i - 1] ?? Infinity) || d > (d2[i + 1] ?? Infinity)) continue;
      if (best < 0 || Math.abs(i - this.#at) < Math.abs(best - this.#at)) best = i;
    }
    this.#at = best;
    const d = (sim.tick - this.#tickAt(best, p, d2)) / 60;
    return floor === null ? d : Math.max(d, floor);
  }

  /** The ghost's tick at your point along its route: sample i, slid along the nearer segment beside it. */
  #tickAt(i: number, p: readonly number[], d2: Float64Array): number {
    const g = this.track.ghost;
    const j = (d2[i - 1] ?? Infinity) < (d2[i + 1] ?? Infinity) ? i - 1 : i + 1;
    if (j < 0 || j >= g.prog.length || !Number.isFinite(d2[j]!)) return this.track.tickOf(i);
    const [a, b] = j < i ? [j, i] : [i, j];
    const ab = [0, 1, 2].map((k) => g.xyz[b * 3 + k]! - g.xyz[a * 3 + k]!);
    const ap = [0, 1, 2].map((k) => p[k]! - g.xyz[a * 3 + k]!);
    const len = ab[0]! * ab[0]! + ab[1]! * ab[1]! + ab[2]! * ab[2]!;
    const f = len > 1e-9 ? Math.max(0, Math.min(1, (ap[0]! * ab[0]! + ap[1]! * ab[1]! + ap[2]! * ab[2]!) / len)) : 0;
    return this.track.tickOf(a) + (this.track.tickOf(b) - this.track.tickOf(a)) * f;
  }
}

/** m:ss.t (a race is won by tenths). */
export function raceClock(ticks: number): string {
  const tenths = Math.round(ticks / 6);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}

/** "−1.2 s" ahead, "+1.2 s" behind (a racing split). */
export function split(seconds: number): string {
  const r = Math.round(seconds * 10) / 10;
  return r === 0 ? "±0.0 s" : `${r < 0 ? "−" : "+"}${Math.abs(r).toFixed(1)} s`;
}

const GENRES: Record<string, string> = { ctf: "capture-the-flag" };
const FIXTURE_TITLES: Record<string, string> = { ctf: "capture-the-flag", "coin-rush": "coin rush", forest: "forest climb", parkour: "parkour time trial", heist: "museum heist", vault: "museum heist" };

/** Prompt-bar text that isn't a prompt (a shared run's world arrives without one). */
const NOT_PROMPTS = new Set(["", "Shared run"]);

/**
 * A world in a few words for the result card: the live intent's genre, a recorded world's name
 * (by its prompt or its fill), the prompt's first words, or else the world's own headline.
 */
export function worldTitle(w: Pick<World, "fill" | "intent">, prompt: string): string {
  const genre = w.intent.live?.genre;
  if (genre) return GENRES[genre] ?? genre.toLowerCase();
  const fixture = Object.keys(FIXTURES).find((k) => FIXTURE_PROMPTS[k] === prompt || FIXTURES[k] === w.fill);
  if (fixture) return FIXTURE_TITLES[fixture] ?? fixture;
  const words = (NOT_PROMPTS.has(prompt.trim()) ? w.intent.headline : prompt).trim().split(/\s+/).slice(0, 5).join(" ");
  return words.length > 40 ? `${words.slice(0, 39)}…` : words || "a world";
}

/**
 * The Wordle-style card: one line to paste anywhere. Every number is one the receipt or the run
 * states, labelled the receipt's way ("12 of 12 AI runners won"); a link appears once it exists.
 */
export function resultCard(o: { title: string; won: { k: number; n: number } | null; me: { ticks: number; won: boolean }; aiTicks: number | null; rival?: { name: string; ticks: number } | null; link: string | null }): string {
  const parts = ["GHOSTRUN", o.title];
  if (o.won) parts.push(`${fraction(o.won.k, o.won.n)} AI runners won`);
  parts.push(o.me.won ? `me ${raceClock(o.me.ticks)}` : `me out at ${raceClock(o.me.ticks)}`);
  if (o.rival) parts.push(`${o.rival.name} ${raceClock(o.rival.ticks)}`);
  if (o.aiTicks !== null) parts.push(`AI ${raceClock(o.aiTicks)}`);
  if (o.link) parts.push(`${o.me.won ? "beat it" : "try it"}: ${o.link}`);
  return parts.join(" · ");
}

const GHOST_KEY = "gr_ghost_hidden";

/** Whether this viewer hid the ghost (a per-viewer convenience: storage may be unavailable). */
export function ghostHidden(): boolean {
  try {
    return localStorage.getItem(GHOST_KEY) === "1";
  } catch {
    return false;
  }
}

export function setGhostHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(GHOST_KEY, "1");
    else localStorage.removeItem(GHOST_KEY);
  } catch {
    // storage blocked: the toggle still holds for this page
  }
}
