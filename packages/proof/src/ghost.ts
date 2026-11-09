// Ghosts: one run sampled for racing (the best winning AI runner, or a person's shared run), or for
// showing where a run went wrong (red/green). Where the runner was every few ticks, the way it was
// pushing, and how far along the win it was, so a client can draw it beside the player and say who
// is ahead. Recording only reads the simulation; nothing goes back in, so a proof with a ghost
// proves exactly what it proved without one.
// No runtime imports: the web shell's light chunk reads progress with this too.
import type { InputFrame, SimEvent } from "@ghostrun/sim";

/** Ticks between samples: 15 a second, close enough to draw a jump's arc by straight lines. */
export const GHOST_EVERY = 4;

export interface Ghost {
  /** Ticks between samples: sample i is tick i × every (the last one is the moment it ended). */
  every: number;
  /** The tick the run won on (or, for a run that didn't win, where it ended). */
  ticks: number;
  /** The capsule centre per sample: x, y, z triples (0.01 m), the same point the player's pose is. */
  xyz: number[];
  /** The move it last pushed per sample (wx, wz pairs, int8): the way it faced. */
  dir: number[];
  /** How far along the win it was per sample (see Progress): the live ahead/behind matches on it. */
  prog: number[];
}

/** The parts of a SimWorld progress reads (structural, so this module stays free of the simulation). */
export interface ProgressSim {
  readonly tick: number;
  readonly log: readonly SimEvent[];
  readonly scores: Readonly<Record<string, number>>;
  entity(id: string): { readonly team: string; readonly carrying: string } | undefined;
  pos(id: string): [number, number, number];
}

/**
 * How far along the win a player is, as one number that only a step toward the win changes: its
 * team's score first, then the distinct things it has used or collected, then whether it carries
 * something (score × 512 + used × 2 + carrying). Two runs with the same number are at the same
 * stage, so comparing where they are says who is ahead. Secrets (bonus things) don't count: they
 * are off the win's path. Fed the same simulation every time it is read (it scans new log entries).
 */
export class Progress {
  #seen = 0;
  readonly #used = new Set<string>();
  readonly #secrets: ReadonlySet<string>;

  constructor(secrets: ReadonlySet<string> = new Set()) {
    this.#secrets = secrets;
  }

  read(sim: ProgressSim): number {
    for (; this.#seen < sim.log.length; this.#seen++) {
      const e = sim.log[this.#seen]!;
      if (e.k === "touch" && e.a === "player" && e.b && !this.#secrets.has(e.b)) this.#used.add(e.b);
    }
    const me = sim.entity("player");
    const score = me ? (sim.scores[`team:${me.team}`] ?? 0) : 0;
    return score * 512 + Math.min(this.#used.size, 255) * 2 + (me?.carrying ? 1 : 0);
  }
}

/** A world's secrets: bonus things progress doesn't count. */
export const secretsOf = (b: { entities: readonly { id: string; tags: readonly string[] }[] }): Set<string> => new Set(b.entities.filter((e) => e.tags.includes("bonus")).map((e) => e.id));

const c2 = (x: number) => Math.round(x * 100) / 100;

/** Records a run's ghost as it plays: call step() after every tick with the input that tick used. */
export class GhostRecorder {
  readonly #g: Ghost = { every: GHOST_EVERY, ticks: 0, xyz: [], dir: [], prog: [] };
  readonly #progress: Progress;
  #wx = 0;
  #wz = 0;

  constructor(sim: ProgressSim, secrets: ReadonlySet<string> = new Set()) {
    this.#progress = new Progress(secrets);
    this.#sample(sim);
  }

  step(sim: ProgressSim, input: Pick<InputFrame, "wx" | "wz"> | null) {
    if (input && (input.wx !== 0 || input.wz !== 0)) ((this.#wx = input.wx), (this.#wz = input.wz));
    if (sim.tick % GHOST_EVERY === 0) this.#sample(sim);
  }

  /** The ghost of a run that ended on this tick (the sim as it stands is the winning moment, or where it stopped). */
  finish(sim: ProgressSim): Ghost {
    if (sim.tick % GHOST_EVERY !== 0) this.#sample(sim);
    return { ...this.#g, ticks: sim.tick };
  }

  #sample(sim: ProgressSim) {
    const p = sim.pos("player");
    this.#g.xyz.push(c2(p[0]), c2(p[1]), c2(p[2]));
    this.#g.dir.push(this.#wx, this.#wz);
    this.#g.prog.push(this.#progress.read(sim));
  }
}

/**
 * A long ghost with at most `max` samples (every k-th one, and the last): a failing run can play
 * the whole of a ten-minute countdown, and the receipt keeps it small. A ghost that fits is returned as it is.
 */
export function thin(g: Ghost, max: number): Ghost {
  const n = g.prog.length;
  if (n <= max) return g;
  const k = Math.ceil((n - 1) / Math.max(1, max - 1));
  const keep = Array.from({ length: Math.floor((n - 2) / k) + 1 }, (_, j) => j * k);
  keep.push(n - 1);
  return {
    every: g.every * k,
    ticks: g.ticks,
    xyz: keep.flatMap((i) => [g.xyz[i * 3]!, g.xyz[i * 3 + 1]!, g.xyz[i * 3 + 2]!]),
    dir: keep.flatMap((i) => [g.dir[i * 2]!, g.dir[i * 2 + 1]!]),
    prog: keep.map((i) => g.prog[i]!),
  };
}
