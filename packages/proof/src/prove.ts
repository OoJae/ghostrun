// Runs the proof ladder T0 → T1 → T2 → T3 on one compiled world and assembles the receipt.
import { clampLaws, specHash, type WorldBundle } from "@ghostrun/ir";
import { buildNav } from "@ghostrun/nav";
import type { Rapier } from "@ghostrun/sim";
import { headlineOf } from "./headline";
import { playtest } from "./playtest";
import { t0 } from "./t0";
import { t1, t1Drive, t1Range } from "./t1";
import { t2 } from "./t2";
import { t3, tour, type Played } from "./t3";
import type { Chip, Receipt } from "./types";

export interface ProveOptions {
  engine: string;
  runs?: number; // T3 witness runs (default 12)
  playerTeam?: "red" | "blue";
  host?: Receipt["host"];
  onChip?: (c: Chip) => void; // streamed as each chip lands
  /**
   * Then the playtest: novice and average runners (the difficulty band, what the runners
   * revealed). The receipt goes to onReceipt first, exactly as it is without them, so it is
   * out as soon as it is today; the one returned carries the playtest too.
   */
  playtest?: boolean;
  onReceipt?: (r: Receipt) => void;
  /** Runners per lower level in the playtest (default 6; a candidate race bands with fewer). */
  skillRuns?: number;
  /**
   * Runs and jump attempts played elsewhere already (a cloud proof's shards: see witnesses()),
   * awaited after T2. T3 and the playtest take each as it came and play only what is missing.
   */
  played?: Played | Promise<Played>;
  /** The playtest's runs played elsewhere, awaited once the receipt is out (default: played). */
  playtestPlayed?: Played | Promise<Played>;
}

export async function prove(R: Rapier, b: WorldBundle, opts: ProveOptions): Promise<Receipt> {
  const start = globalThis.performance?.now?.() ?? 0;
  const team = opts.playerTeam ?? "red";
  const chips: Chip[] = [];
  const emit = (cs: Chip[]) => {
    for (const c of cs) {
      chips.push(c);
      opts.onChip?.(c);
    }
  };
  const laws = clampLaws(b.laws);

  const s0 = t0(b, team);
  emit(s0.chips);
  emit(t1(b, laws));
  emit(t1Range(b, laws, team));
  emit(t1Drive(b, laws, team));
  emit(t2(R, b, team));
  const nav = buildNav(b);
  try {
    // (the navmesh first: built here while the shards play)
    const played = opts.played ? await opts.played : undefined;
    const s3 = t3(R, b, nav, s0.chain, opts.runs ?? 12, team, s0.openers, played);
    emit(s3.chips);
    if (b.mode === "wander") {
      const t = tour(R, b, nav, s0.openers);
      if (t) emit([t]);
    }
    const headline = headlineOf(b, chips);
    const receipt: Receipt = {
      v: 1,
      spec: await specHash(opts.engine, b),
      engine: opts.engine,
      host: opts.host ?? "node",
      headline,
      chips,
      par: s3.par,
      ms: Math.round((globalThis.performance?.now?.() ?? 0) - start),
      ...(s3.trails.length ? { trails: s3.trails } : {}),
      ...(s3.ghost ? { ghost: s3.ghost } : {}),
      ...(s3.failRun ? { failRun: s3.failRun } : {}),
    };
    if (!opts.playtest) return receipt;
    opts.onReceipt?.(receipt);
    const later = opts.playtestPlayed ? await opts.playtestPlayed : played;
    const pt = playtest(R, b, nav, s0.chain, receipt, team, s0.openers, opts.skillRuns, later);
    return pt ? { ...receipt, playtest: pt } : receipt;
  } finally {
    nav.destroy();
  }
}
