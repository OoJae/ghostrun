// Runs the proof ladder T0 → T1 → T2 → T3 on one compiled world and assembles the receipt.
import { clampLaws, specHash, type WorldBundle } from "@ghostrun/ir";
import { buildNav } from "@ghostrun/nav";
import type { Rapier } from "@ghostrun/sim";
import { t0 } from "./t0";
import { t1, t1Range } from "./t1";
import { t2 } from "./t2";
import { t3, tour } from "./t3";
import type { Chip, ChipStatus, Receipt } from "./types";

export interface ProveOptions {
  engine: string;
  runs?: number; // T3 witness runs (default 12)
  playerTeam?: "red" | "blue";
  host?: Receipt["host"];
  onChip?: (c: Chip) => void; // streamed as each chip lands
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
  emit(t2(R, b, team));
  const nav = buildNav(b);
  try {
    const s3 = t3(R, b, nav, s0.chain, opts.runs ?? 12, team, s0.openers);
    emit(s3.chips);
    if (b.mode === "wander") {
      const t = tour(R, b, nav, s0.openers);
      if (t) emit([t]);
    }
    const headlineExpect = b.expects.find((x) => x.headline);
    let headline: Receipt["headline"] = null;
    if (headlineExpect) {
      const mine = chips.filter(
        (c) => c.subject.id === headlineExpect.id || (headlineExpect.prop === "win_reachable" && c.subject.id === "win_reachable") || (b.mode === "wander" && headlineExpect.prop === "reachable" && !headlineExpect.b && c.subject.id === "tour"),
      );
      const status: ChipStatus = mine.some((c) => c.status === "counterexample")
        ? "counterexample"
        : mine.some((c) => c.status === "verified")
          ? "verified"
          : mine.some((c) => c.status === "played")
            ? "played"
            : "not_checkable";
      headline = { expect: headlineExpect.id, text: headlineExpect.text, status, method: mine.map((c) => c.method).join(" + ") || "none" };
    }
    return {
      v: 1,
      spec: await specHash(opts.engine, b),
      engine: opts.engine,
      host: opts.host ?? "node",
      headline,
      chips,
      par: s3.par,
      ms: Math.round((globalThis.performance?.now?.() ?? 0) - start),
      ...(s3.trails.length ? { trails: s3.trails } : {}),
    };
  } finally {
    nav.destroy();
  }
}
