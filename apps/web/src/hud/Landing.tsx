// The first ten seconds: what this is in one line, and worlds to start from in one click. Shown on
// first load only; it goes once the person builds, moves or opens the gallery.
import { GALLERY } from "./Gallery";

/**
 * The empty prompt bar's rotating examples: prompts the live AI has built (offline, Enter on one
 * opens its recorded world), short enough to read at a glance, in more than one language.
 */
export const EXAMPLES: readonly string[] = [
  "a-garden-hedge-maze-with-a-minotaur-hunt",
  "a-ninja-dojo-sneak-past-the-guards-and-r",
  "jump-across-floating-islands-in-the-clou",
  "collect-seashells-on-a-sunny-beach-befor",
  "a-sumo-ring-on-a-mountain-top-push-both",
  "catch-the-last-train-get-your-ticket-and",
  "a-circus-big-top-bounce-on-the-trampolin",
  "sammle-alle-kristalle-in-der-eish-hle-un",
].flatMap((slug) => GALLERY.find((g) => g.slug === slug)?.prompt ?? []);

export interface Starter {
  label: string;
  /** null: picked when clicked ("Surprise me"). */
  prompt: string | null;
  kind?: "brief" | "surprise";
}

export function Landing({ starters, ready, onPick }: { starters: readonly Starter[]; ready: boolean; onPick(s: Starter): void }) {
  return (
    <div className="landing" data-testid="landing">
      <p className="identity">Type any world. It's playable in seconds, and AI runners prove it's beatable.</p>
      <div className="starters" role="group" aria-label="Start with">
        {starters.map((s) => (
          <button type="button" key={s.label} className={`glass starter${s.kind ? ` ${s.kind}` : ""}`} disabled={!ready} title={s.prompt ?? "A random world from the suggestions"} onClick={() => onPick(s)}>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
