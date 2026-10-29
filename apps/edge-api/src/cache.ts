// The exact-repeat cache for /v1/build. A build that ended cleanly is kept in the share store (R2
// binding SHARES) under cache/<key>.json: its intent, its op lines and its done event. A fallback
// event is how the world got written, not part of it, so it is left out. The key hashes the
// normalised prompt, the seed, the template hash (prompt templates, schemas, output budgets and
// model ids) and the engine hash the client builds with, so a change to any of them misses. A
// repeat replays the stored stream at once behind a `cached` event saying when, and by which
// models, it was built live: no hold, no model call, and the client never shows it as live.
import { DEFAULT_LAWS, jcs, sha256Hex, splitObjects } from "@ghostrun/ir";
import { fillMessages, intentJsonSchema, intentMessages, ROUTES, type IntentOut } from "@ghostrun/llm";
import { ALL_SUBS, PACKS } from "@ghostrun/registry";
import { FILL_MAX_OUT, INTENT_MAX_OUT } from "./cost";
import type { BlobStore } from "./share";

/** A stored stream bigger than this is not kept (a whole fill is about 25 KB of events). */
export const MAX_CACHE_BYTES = 128 * 1024;
/** How long a lookup may hold a build up before it goes ahead live: a slow store never stalls a demo. */
export const CACHE_READ_MS = 500;
export const ENGINE_RE = /^[0-9a-f]{64}$/;

export interface CachedEvent {
  event: "intent" | "op" | "done";
  data: unknown;
}

export interface CacheEntry {
  v: 1;
  /** When it was built live (ISO 8601). */
  at: string;
  intentModel: string;
  fillModel: string;
  events: CachedEvent[];
}

/** Trimmed, runs of spaces collapsed, lower case: "A maze  with Ghosts" and "a maze with ghosts" are one entry. */
export const normalisePrompt = (p: string) => p.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * The seed when the caller sends none: from the prompt, so a repeat has the same layout (and can
 * hit the cache) and "Build it fresh" overwrites the entry it bypassed. Same range as before (1..100000).
 */
export async function promptSeed(prompt: string): Promise<number> {
  const hex = await sha256Hex(normalisePrompt(prompt));
  return 1 + (parseInt(hex.slice(0, 8), 16) % 100_000);
}

// Fixed stand-ins the template probe renders every pack's fill prompt with: only the template
// around them is being measured, so their values never matter, only that they never change.
const PROBE_INTENT: IntentOut = {
  lang: "en", mode: "play", genre: "probe", setting: "probe", role: "probe", goal: "probe", fail: "probe", mood: "probe",
  pack: "probe", sub: [], safety: "ok", headline: "probe", nouns: [], moodVec: { valence: 0, arousal: 0, tension: 0 },
};

let template: Promise<string> | undefined;

/**
 * Everything a build sends the models besides the prompt and seed, hashed: the intent prompt and
 * its schema, each pack's fill prompt (world rules, the pack's layout, the example), the output
 * budgets and the model ids of both jobs. Computed once per isolate.
 */
export function templateHash(example: string): Promise<string> {
  template ??= sha256Hex(
    jcs({
      routes: { intent: ROUTES.intent, fill: ROUTES.fill },
      intent: intentMessages("", PACKS),
      schema: intentJsonSchema(PACKS.map((p) => p.id), ALL_SUBS),
      fill: PACKS.map((p) => fillMessages("", { ...PROBE_INTENT, pack: p.id }, p.impl.generate({ seed: 1, params: p.impl.defaults, sub: [], laws: DEFAULT_LAWS, harder: false }), example, 1)),
      maxOut: [INTENT_MAX_OUT, FILL_MAX_OUT],
    }),
  );
  return template;
}

export async function cacheKey(prompt: string, seed: number, template: string, engine: string): Promise<string> {
  return `cache/${await sha256Hex(jcs({ v: 1, prompt: normalisePrompt(prompt), seed, template, engine }))}.json`;
}

const isEntry = (x: unknown): x is CacheEntry => {
  const e = x as Partial<CacheEntry> | null;
  return e?.v === 1 && typeof e.at === "string" && typeof e.intentModel === "string" && typeof e.fillModel === "string" && Array.isArray(e.events) && e.events[0]?.event === "intent";
};

/** The stored stream for this key, or null: a miss, an unreadable entry, or a store too slow to wait for. */
export async function readCache(store: BlobStore, key: string, ms = CACHE_READ_MS): Promise<CacheEntry | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([store.get(key), new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))]);
    if (text === null) return null;
    const e: unknown = JSON.parse(text);
    return isEntry(e) ? e : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Store a clean build (overwriting what was there). False when it is too big to keep. */
export async function writeCache(store: BlobStore, key: string, entry: CacheEntry): Promise<boolean> {
  const text = JSON.stringify(entry);
  if (new TextEncoder().encode(text).length > MAX_CACHE_BYTES) return false;
  await store.put(key, text, { at: entry.at, fillModel: entry.fillModel });
  return true;
}

/** Does this op line (or an object glued onto it) close the gameplay layer? The client plays from that line on. */
export function closesGameplay(line: string): boolean {
  if (!line.includes('"end"')) return false;
  return splitObjects(line).some((one) => {
    try {
      const o = JSON.parse(one) as { op?: unknown; layer?: unknown };
      return o.op === "end" && o.layer === "gameplay";
    } catch {
      return false;
    }
  });
}

/** The stored stream as one SSE body: `cached` first, then the build exactly as it was sent. */
export function replayBody(e: CacheEntry): string {
  const block = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return block("cached", { at: e.at, intentModel: e.intentModel, fillModel: e.fillModel }) + e.events.map((x) => block(x.event, x.data)).join("");
}
