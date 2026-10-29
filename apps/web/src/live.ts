// Client for the live fast lane: POST /v1/build streams the intent, then one JSONL fill line per
// SSE event. We parse lines as they land and hand over as soon as the gameplay layer is complete
// (the cosmetic tail never blocks play). An exact repeat comes back from the edge's cache behind a
// `cached` event (when and by which models it was built live); `fresh` asks for a new build. A
// build with a picture opens with `inspired`: the brief the edge read from it, and the prompt it made.
import { FillParser, splitObjects, type WorldBundle } from "@ghostrun/ir";
import { api } from "./api";
import { ENGINE_HASH } from "./pipeline";

export interface LiveIntent {
  lang: string;
  mode: "play" | "wander";
  genre: string;
  setting: string;
  role: string;
  goal: string;
  fail: string;
  mood: string;
  pack: string;
  sub: string[];
  safety: string;
  headline: string;
}

/** A build the edge replayed from its cache: when it was built live, and by which models. */
export interface LiveCached {
  at: string;
  intentModel: string;
  fillModel: string;
}

/** What the edge's vision step made of a picture: ideas for the world, not a copy of the picture. */
export interface LiveBrief {
  setting: string;
  mood: string;
  palette: string[];
  objects: string[];
  layout: string;
  genre: string;
  goal: string;
}

/** A picture's brief and the prompt it made (the person's words, then the brief): the world is built from that prompt. */
export interface LiveInspired {
  brief: LiveBrief;
  prompt: string;
  ms: number;
}

export type LiveResult =
  | { kind: "world"; fill: string; seed: number; intent: LiveIntent; intentMs: number; gameplayMs: number; lines: number; /** The model that took over when the fast lane was busy. */ fallback: string | null; cached: LiveCached | null; inspired: LiveInspired | null }
  | { kind: "refused"; message: string }
  | { kind: "unavailable"; reason: string };

/** Is the live lane up, and can it read a picture (the Claude lane is configured)? */
export async function liveHealth(): Promise<{ llm: boolean; vision: boolean }> {
  try {
    const r = await fetch("/v1/health", { cache: "no-store" });
    if (!r.ok) return { llm: false, vision: false };
    const h = (await r.json()) as { llm?: boolean; vision?: boolean };
    return { llm: Boolean(h.llm), vision: Boolean(h.llm && h.vision) };
  } catch {
    return { llm: false, vision: false };
  }
}

export const liveAvailable = async (): Promise<boolean> => (await liveHealth()).llm;

export interface BuildHooks {
  /** The intent has landed (with the world's seed): the layout can be drawn before any fill line. */
  onIntent?(i: LiveIntent, ms: number, seed: number): void;
  /** Another fill line parsed: the draft so far (shared and growing; read it, don't keep it). */
  onLine?(n: number, draft: WorldBundle): void;
  /** Skip the edge's cache: a new build, which then replaces the cached one. */
  fresh?: boolean;
  /** A photo or sketch to build from (a data URL, already made small and clean: picture.ts). */
  image?: string;
  /** The edge has read the picture: its brief, and the prompt the world will be built from. */
  onInspired?(i: LiveInspired): void;
}

export async function liveBuild(prompt: string, hooks: BuildHooks = {}): Promise<LiveResult> {
  const { onIntent, onLine, onInspired, fresh, image } = hooks;
  const t0 = performance.now();
  const ctl = new AbortController();
  let res: Response;
  try {
    // the engine hash keys the edge's cache: a world is only replayed to the engine it was built for
    // (a build from a picture is never cached; the picture is read once and not kept)
    res = await api("/v1/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, engine: ENGINE_HASH, ...(fresh ? { fresh: true } : {}), ...(image ? { image } : {}) }), signal: ctl.signal });
  } catch (e) {
    return { kind: "unavailable", reason: String(e) };
  }
  if (!res.ok || !res.body) {
    // the edge says why when it can ("image too large", "builds paused")
    const why = await res.json().then((b: { error?: unknown }) => (typeof b.error === "string" ? b.error : ""), () => "");
    return { kind: "unavailable", reason: `HTTP ${res.status}${why ? `: ${why}` : ""}` };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let fill = "";
  let intent: LiveIntent | null = null;
  let seed = 1;
  let intentMs = 0;
  let lines = 0;
  let fallback: string | null = null;
  let cached: LiveCached | null = null;
  let inspired: LiveInspired | null = null;
  let parser: FillParser | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!event || !data) continue;
        const payload = JSON.parse(data) as Record<string, unknown>;
        if (event === "intent") {
          intent = payload.intent as LiveIntent;
          seed = payload.seed as number;
          intentMs = Math.round(performance.now() - t0);
          parser = new FillParser({ seed });
          onIntent?.(intent, intentMs, seed);
        } else if (event === "inspired") {
          inspired = { brief: payload.brief as LiveBrief, prompt: String(payload.prompt), ms: Number(payload.ms) || 0 };
          onInspired?.(inspired);
        } else if (event === "cached") {
          cached = { at: String(payload.at), intentModel: String(payload.intentModel), fillModel: String(payload.fillModel) };
        } else if (event === "fallback") {
          fallback = String(payload.to);
        } else if (event === "refusal") {
          return { kind: "refused", message: String(payload.message) };
        } else if (event === "error") {
          return { kind: "unavailable", reason: String(payload.message) };
        } else if (event === "op" && parser && intent) {
          const line = String(payload.line);
          fill += splitObjects(line).map((one) => `${one}\n`).join(""); // one object per line, even when glued
          parser.push(`${line}\n`);
          onLine?.(++lines, parser.draft);
          if (parser.gameplayDone) {
            ctl.abort(); // the cosmetic tail is optional; play starts now
            return { kind: "world", fill, seed, intent, intentMs, gameplayMs: Math.round(performance.now() - t0), lines, fallback, cached, inspired };
          }
        }
      }
    }
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "AbortError")) return { kind: "unavailable", reason: String(e) };
  }
  if (intent && fill) return { kind: "world", fill, seed, intent, intentMs, gameplayMs: Math.round(performance.now() - t0), lines, fallback, cached, inspired };
  return { kind: "unavailable", reason: "stream ended before the gameplay layer" };
}

/** A patch route (/v1/repair, /v1/edit) → the model's patch lines (JSONL), or null. */
async function livePatch(path: string, body: unknown): Promise<string | null> {
  let res: Response;
  try {
    res = await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return null;
  }
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let patch = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (!event || !data) continue;
      if (event === "error") return null;
      if (event === "op") patch += `${String((JSON.parse(data) as { line: unknown }).line)}\n`;
    }
  }
  return patch || null;
}

/**
 * POST /v1/repair: the proof's issues for a live world → the model's patch lines (JSONL). `hard`
 * asks the stronger model (Claude Sonnet), after the fast repair couldn't make it better.
 */
export const liveRepair = (prompt: string, intent: LiveIntent, fill: string, issues: string[], seed: number, hard = false) => livePatch("/v1/repair", { prompt, intent, fill, issues, seed, ...(hard ? { hard: true } : {}) });

/** POST /v1/director: the Director's cut of a world that plays (Claude Sonnet) → patch lines (JSONL). */
export const liveDirector = (prompt: string, intent: LiveIntent, fill: string, notes: string[], seed: number) => livePatch("/v1/director", { prompt, intent, fill, notes, seed });

/** POST /v1/edit: the person's change to the world → the model's patch lines (JSONL). */
export const liveEdit = (prompt: string, change: string, intent: LiveIntent, fill: string, seed: number) => livePatch("/v1/edit", { prompt, change, intent, fill, seed });
