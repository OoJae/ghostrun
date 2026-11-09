// One world proved twice, in the cloud and on this device, and compared. The simulation is
// bit-exact on every engine, so everything the two receipts say must match: only how long each
// took, and where it ran, may differ.
import { jcs, sha256Hex } from "@ghostrun/ir";
import type { Receipt } from "./types";

/**
 * A receipt as two proofs of one world must agree on it: no timings, no host, and through JSON
 * (the cloud's came that way; the device's came by structured clone, which keeps a -0 JSON drops).
 */
export function comparable(r: Receipt): unknown {
  const { host: _host, ms: _ms, playtest, ...rest } = r;
  // (T3h's chips and T4's model, on the playtest, carry timings too)
  const pt = playtest ? { ...playtest, ms: 0, ...(playtest.human ? { human: playtest.human.map(({ ms: _h, ...c }) => c) } : {}), ...(playtest.model ? { model: { ...playtest.model, ms: 0 } } : {}) } : null;
  const same = { ...rest, chips: r.chips.map(({ ms: _c, ...c }) => c), ...(pt ? { playtest: pt } : {}) };
  return JSON.parse(JSON.stringify(same)) as unknown;
}

/** The comparable receipt's SHA-256: equal for two proofs of one world that agree to the bit. */
export const receiptHash = (r: Receipt): Promise<string> => sha256Hex(jcs(comparable(r)));
