// What /v1/health says beyond the build lane: whether a client should ask for the cloud proof, and
// how the canaries last did ({at, ok}: the newest run's time, and whether every kind's last run
// passed; null before any has run). Each canary kind keeps its last run in FLAGS (canary.ts).
import type { KvNamespace } from "./cf";
import { proofHealth, type ProofEnv } from "./proof";

export const CANARY_KINDS = ["health", "stored_proof", "fresh_proof", "live_build"] as const;
export type CanaryKind = (typeof CANARY_KINDS)[number];

export interface CanaryRun {
  at: string;
  ok: boolean;
  ms: number;
  detail: string;
  /** When this kind last alerted (it alerts on turning bad, then at most every 6 h while bad). */
  alertedAt?: string;
}

export const canaryKey = (kind: CanaryKind) => `canary:${kind}`;

export async function lastRun(flags: KvNamespace, kind: CanaryKind, cacheTtl?: number): Promise<CanaryRun | null> {
  try {
    const text = await flags.get(canaryKey(kind), cacheTtl ? { cacheTtl } : undefined);
    const r = text ? (JSON.parse(text) as Partial<CanaryRun>) : null;
    return r && typeof r.at === "string" && typeof r.ok === "boolean" ? (r as CanaryRun) : null;
  } catch {
    return null;
  }
}

export async function canaryHealth(env: { FLAGS?: KvNamespace }): Promise<{ at: string; ok: boolean } | null> {
  const flags = env.FLAGS;
  if (!flags) return null;
  const runs = (await Promise.all(CANARY_KINDS.map((k) => lastRun(flags, k, 60)))).filter((r): r is CanaryRun => r !== null);
  if (!runs.length) return null;
  return { at: runs.map((r) => r.at).sort().at(-1)!, ok: runs.every((r) => r.ok) };
}

/** The living world's feature flags (KV keys ff.persona_sliders, ff.team_ai, ff.wander_life): on unless "off". */
export const LIFE_FLAGS = ["persona_sliders", "team_ai", "wander_life"] as const;
export type LifeFlags = Record<(typeof LIFE_FLAGS)[number], boolean>;

export async function lifeFlags(env: { FLAGS?: KvNamespace }): Promise<LifeFlags> {
  const vals = await Promise.all(LIFE_FLAGS.map((f) => env.FLAGS?.get(`ff.${f}`, { cacheTtl: 60 }).catch(() => null) ?? Promise.resolve(null)));
  return Object.fromEntries(LIFE_FLAGS.map((f, i) => [f, vals[i] !== "off"])) as LifeFlags;
}

export async function healthMore(env: ProofEnv): Promise<{ proof: boolean; canary: { at: string; ok: boolean } | null; ff: LifeFlags }> {
  const [p, canary, ff] = await Promise.all([proofHealth(env), canaryHealth(env), lifeFlags(env)]);
  return { ...p, canary, ff };
}
