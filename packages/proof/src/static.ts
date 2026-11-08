// The proof's static rungs on their own: T0 (the rule graph) and T1 (the kinematic models) need no
// physics, so they run where the simulation can't (the edge). Their receipt says only what they
// checked: no par and no runners, and a headline only these tiers could speak to (else "not
// checkable yet"). T2 and T3 run wherever the simulation does: the device, or a cloud proof.
import { clampLaws, specHash, type WorldBundle } from "@ghostrun/ir";
import { headlineOf } from "./headline";
import { t0 } from "./t0";
import { t1, t1Drive, t1Range } from "./t1";
import type { Chip, Receipt } from "./types";

export { headlineOf } from "./headline";
export { bandLine, chipLine, clock, fraction, statusWord } from "./labels";
export type { Band, Chip, ChipStatus, Level, Playtest, Receipt, Tier } from "./types";

/** The tiers a static receipt holds. */
export const STATIC_TIERS = ["T0", "T1"] as const;

/** T0 and T1's chips, in the order the full ladder emits them. */
export function staticChips(b: WorldBundle, playerTeam: "red" | "blue" = "red"): Chip[] {
  const laws = clampLaws(b.laws);
  return [...t0(b, playerTeam).chips, ...t1(b, laws), ...t1Range(b, laws, playerTeam), ...t1Drive(b, laws, playerTeam)];
}

export async function staticReceipt(b: WorldBundle, opts: { engine: string; playerTeam?: "red" | "blue"; host?: Receipt["host"] }): Promise<Receipt> {
  const start = globalThis.performance?.now?.() ?? 0;
  const chips = staticChips(b, opts.playerTeam);
  return {
    v: 1,
    spec: await specHash(opts.engine, b),
    engine: opts.engine,
    host: opts.host ?? "edge",
    headline: headlineOf(b, chips),
    chips,
    par: null,
    ms: Math.round((globalThis.performance?.now?.() ?? 0) - start),
  };
}
