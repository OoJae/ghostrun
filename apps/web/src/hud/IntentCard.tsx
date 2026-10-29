import type { Intent } from "../pipeline";
import "./picture.css";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function castLine(cast: Intent["cast"]): string {
  const counts = new Map<string, number>();
  for (const k of cast) counts.set(k.role, (counts.get(k.role) ?? 0) + 1);
  return [...counts].map(([role, n]) => plural(n, role)).join(" · ") || "none";
}

/** A world built from a picture says so plainly: inspired by it (its place and the things in it), never rebuilt from it. */
export interface Inspired {
  setting: string;
  objects: string[];
}

export function IntentCard({ intent, specHash, note, inspired }: { intent: Intent; specHash: string | undefined; note?: string | null; inspired?: Inspired | null }) {
  return (
    <aside className="glass intent" data-testid="intent-card">
      <header>
        <span className="eyebrow">Intent</span>
        <span className="mode">{intent.mode}</span>
      </header>
      {inspired && (
        <p className="inspired" data-testid="inspired-note" title="Your image suggested the place, the mood, the colours and the things in it; the world was written from those words, so it is inspired by the image, not a copy of it">
          Inspired by your image: {inspired.setting}
          {inspired.objects.length > 0 && <span className="dim"> · {inspired.objects.join(", ")}</span>}
        </p>
      )}
      {note && (
        <p className="subst" data-testid="subst-note" title="The prompt asked for something no world can do yet; this is what you get instead">
          {note}
        </p>
      )}
      {intent.live && (
        <dl className="card10">
          <dt>You are</dt>
          <dd>{intent.live.role}</dd>
          <dt>Goal</dt>
          <dd>{intent.live.goal}</dd>
          {intent.live.fail && (
            <>
              <dt>Fail</dt>
              <dd>{intent.live.fail}</dd>
            </>
          )}
          <dt>Cast</dt>
          <dd>{castLine(intent.cast)}</dd>
        </dl>
      )}
      <dl className={intent.live ? "tech" : ""}>
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
