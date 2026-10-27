// Per-isolate fixed-window counters: the cheap first line in front of the governor, the per-IP
// limit on the share/report endpoints, and the judge-token fallback when the governor is silent.
// Each isolate counts on its own, so these bound bursts, not totals; the governor bounds totals.
export const WINDOW_MS = 10 * 60 * 1000;

export class Buckets {
  private readonly m = new Map<string, { n: number; since: number }>();

  constructor(private readonly windowMs = WINDOW_MS) {}

  allow(key: string, limit: number, now = Date.now()): boolean {
    const b = this.m.get(key);
    if (!b || now - b.since > this.windowMs) {
      if (this.m.size >= 10_000) for (const [k, old] of this.m) if (now - old.since > this.windowMs) this.m.delete(k);
      this.m.set(key, { n: 1, since: now });
      return limit >= 1;
    }
    if (b.n >= limit) return false;
    b.n++;
    return true;
  }
}

export function intVar(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}
