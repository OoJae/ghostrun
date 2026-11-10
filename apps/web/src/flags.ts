// The living world's feature flags: persona sliders, commandable teammates, a place's ambient life.
// They ship dark: each is off unless the edge says "on" (/v1/health's ff, read from KV once a minute:
// deploy-free) or the page's ?ff= turns it on ("?ff=team_ai,wander_life", for tests and comparisons).
export const FLAGS = ["persona_sliders", "team_ai", "wander_life"] as const;
export type Flag = (typeof FLAGS)[number];

const off = new Set<Flag>(FLAGS);
const pinned = new Set<Flag>();

/** The page's own choices (?ff=-team_ai switches team AI off; ?ff=team_ai keeps it on whatever the edge says). */
export function readUrlFlags(search: string) {
  const v = new URLSearchParams(search).get("ff") ?? "";
  for (const raw of v.split(",")) {
    const name = raw.trim().replace(/^[-+]/, "") as Flag;
    if (!FLAGS.includes(name)) continue;
    pinned.add(name);
    if (raw.trim().startsWith("-")) off.add(name);
    else off.delete(name);
  }
}
if (typeof window !== "undefined") readUrlFlags(window.location.search);

/** What /v1/health said ({ team_ai: false, … }); a flag the page pinned keeps its value. */
export function applyHealthFlags(ff: unknown) {
  if (!ff || typeof ff !== "object") return;
  for (const f of FLAGS) {
    if (pinned.has(f)) continue;
    const v = (ff as Record<string, unknown>)[f];
    if (v === false) off.add(f);
    else if (v === true) off.delete(f);
  }
}

export const flagOn = (f: Flag): boolean => !off.has(f);

/** For tests: every flag back to its default (off), nothing pinned. */
export function resetFlags() {
  off.clear();
  for (const f of FLAGS) off.add(f);
  pinned.clear();
}
