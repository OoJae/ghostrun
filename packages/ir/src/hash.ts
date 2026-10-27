// Canonical JSON (RFC 8785 JCS) and the spec hash that binds every proof chip, receipt, replay
// and share link to the exact gameplay layer it was computed on.
import type { WorldBundle } from "./schema";
import { COLLECTIONS } from "./schema";

/** RFC 8785: object keys sorted by UTF-16 code units, ES number serialisation, no whitespace. */
export function jcs(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS: non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(obj[k])}`).join(",")}}`;
  }
  throw new Error(`JCS: unsupported ${typeof value}`);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const byId = <T extends { id: string }>(xs: readonly T[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Canonical form: every collection sorted by id (array order never matters). */
export function canonical(b: WorldBundle): WorldBundle {
  const out = { ...b } as WorldBundle;
  for (const c of COLLECTIONS) (out as Record<string, unknown>)[c] = byId(b[c] as { id: string }[]);
  out.cosmetic = { ...b.cosmetic, dress: byId(b.cosmetic.dress), posters: byId(b.cosmetic.posters) };
  return out;
}

/**
 * The gameplay layer only. Dropped: the cosmetic layer, cosmetic-layer records, display text
 * (zone names, expectation text), resolved asset ids and persona prose. Proofs do not depend on
 * any of these, so changing them must not invalidate a receipt.
 */
export function stripCosmetic(b: WorldBundle) {
  const c = canonical(b);
  const gameplay = <T extends { layer: string }>(xs: T[]) => xs.filter((x) => x.layer === "gameplay");
  return {
    v: c.v,
    seed: c.seed,
    mode: c.mode,
    pack: c.pack,
    laws: c.laws,
    zones: gameplay(c.zones).map(({ name: _n, ...z }) => z),
    statics: gameplay(c.statics),
    entities: gameplay(c.entities).map(({ asset: _a, ...e }) => e),
    verbs: gameplay(c.verbs),
    rules: gameplay(c.rules),
    states: gameplay(c.states),
    cast: gameplay(c.cast).map(({ persona: _p, ...k }) => k),
    expects: gameplay(c.expects).map(({ text: _t, ...x }) => x),
  };
}

/** specHash = SHA-256(JCS({engine, world: stripCosmetic(bundle)})). */
export function specHash(engineHash: string, b: WorldBundle): Promise<string> {
  return sha256Hex(jcs({ engine: engineHash, world: stripCosmetic(b) }));
}
