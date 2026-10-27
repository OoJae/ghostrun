import type { Intent } from "../pipeline";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function castLine(cast: Intent["cast"]): string {
  const counts = new Map<string, number>();
  for (const k of cast) counts.set(k.role, (counts.get(k.role) ?? 0) + 1);
  return [...counts].map(([role, n]) => plural(n, role)).join(" · ") || "none";
}

export function IntentCard({ intent, specHash }: { intent: Intent; specHash: string | undefined }) {
  return (
    <aside className="glass intent" data-testid="intent-card">
      <header>
        <span className="eyebrow">Intent</span>
        <span className="mode">{intent.mode}</span>
      </header>
      <dl>
        <dt>Pack</dt>
        <dd>
          {intent.pack}
          {intent.sub.length > 0 && <span className="dim"> + {intent.sub.join(", ")}</span>}
        </dd>
        <dt>Zones</dt>
        <dd>
          {intent.zones.length}
          <span className="dim"> · {intent.zones.map((z) => z.name).join(" · ")}</span>
        </dd>
        <dt>Rules</dt>
        <dd>{intent.rules}</dd>
        <dt>Cast</dt>
        <dd>{castLine(intent.cast)}</dd>
        <dt>Jumps</dt>
        <dd>{intent.jumpsMax > 1 ? `double jump (×${intent.jumpsMax})` : plural(intent.jumpsMax, "jump")}</dd>
        <dt>Look</dt>
        <dd>
          {intent.look} <span className="dim">· {intent.weather}</span>
        </dd>
      </dl>
      {intent.live && (
        <p className="dim live-intent">
          {intent.live.role} · goal: {intent.live.goal}
        </p>
      )}
      {intent.headline && (
        <div className="headline">
          <span className="eyebrow">Headline expectation</span>
          <p>{intent.headline}</p>
        </div>
      )}
      <footer className="dim" title={specHash}>
        spec {specHash ? `${specHash.slice(0, 12)}…` : "hashing…"}
      </footer>
    </aside>
  );
}
