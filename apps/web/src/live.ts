// Client for the live fast lane: POST /v1/build streams the intent, then one JSONL fill line per
// SSE event. We parse lines as they land and hand over as soon as the gameplay layer is complete
// (the cosmetic tail never blocks play).
import { FillParser } from "@ghostrun/ir";

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

export type LiveResult =
  | { kind: "world"; fill: string; seed: number; intent: LiveIntent; intentMs: number; gameplayMs: number; lines: number }
  | { kind: "refused"; message: string }
  | { kind: "unavailable"; reason: string };

export async function liveAvailable(): Promise<boolean> {
  try {
    const r = await fetch("/v1/health", { cache: "no-store" });
    return r.ok && Boolean(((await r.json()) as { llm?: boolean }).llm);
  } catch {
    return false;
  }
}

export async function liveBuild(prompt: string, onIntent?: (i: LiveIntent, ms: number) => void, onLine?: (n: number) => void): Promise<LiveResult> {
  const t0 = performance.now();
  const ctl = new AbortController();
  let res: Response;
  try {
    res = await fetch("/v1/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }), signal: ctl.signal });
  } catch (e) {
    return { kind: "unavailable", reason: String(e) };
  }
  if (!res.ok || !res.body) return { kind: "unavailable", reason: `HTTP ${res.status}` };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let fill = "";
  let intent: LiveIntent | null = null;
  let seed = 1;
  let intentMs = 0;
  let lines = 0;
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
          onIntent?.(intent, intentMs);
        } else if (event === "refusal") {
          return { kind: "refused", message: String(payload.message) };
        } else if (event === "error") {
          return { kind: "unavailable", reason: String(payload.message) };
        } else if (event === "op" && parser && intent) {
          const line = String(payload.line);
          fill += `${line}\n`;
          parser.push(`${line}\n`);
          onLine?.(++lines);
          if (parser.gameplayDone) {
            ctl.abort(); // the cosmetic tail is optional; play starts now
            return { kind: "world", fill, seed, intent, intentMs, gameplayMs: Math.round(performance.now() - t0), lines };
          }
        }
      }
    }
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "AbortError")) return { kind: "unavailable", reason: String(e) };
  }
  if (intent && fill) return { kind: "world", fill, seed, intent, intentMs, gameplayMs: Math.round(performance.now() - t0), lines };
  return { kind: "unavailable", reason: "stream ended before the gameplay layer" };
}

/** POST /v1/repair: the proof's issues for a live world → the model's patch lines (JSONL). */
export async function liveRepair(prompt: string, intent: LiveIntent, fill: string, issues: string[], seed: number): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch("/v1/repair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, intent, fill, issues, seed }) });
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
