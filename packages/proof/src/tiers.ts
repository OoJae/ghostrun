// The two later tiers' switches: T3h (the player's controls and camera) and T4 (the route model).
// Each runs after the playtest, on the device and in the cloud alike, when its flag is on (ff.t3h
// and ff.t4 in the edge's FLAGS; /v1/health tells clients, so both proofs of a world run the same
// tiers and their receipts still compare to the bit). These are the defaults when nothing says.
export interface Tiers {
  t3h: boolean;
  t4: boolean;
}

/** On by default: each passed its gate (T3h: no flags on 20 clean bench worlds, every planted case caught; T4: its calibration measured on 112 held-out bench worlds). */
export const TIERS: Tiers = { t3h: true, t4: true };

/** A flag's word ("on", "off", or nothing) over its default. */
export const flagOn = (word: string | null | undefined, dflt: boolean) => (word === "off" ? false : word === "on" ? true : dflt);
