import { afterEach, describe, expect, it, vi } from "vitest";
import { liveBuild } from "../src/live";
import { ENGINE_HASH } from "../src/pipeline";

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const INTENT = { lang: "en", mode: "play", genre: "ctf", setting: "neon city", role: "runner", goal: "orb home", fail: "lose it", mood: "tense", pack: "city_block", sub: [], safety: "ok", headline: "h" };
const LINES = ['{"op":"meta","pack":"city_block","seed":7}', '{"op":"zone","id":"z_a","slot":"center"}', '{"op":"spawn","id":"sp_red","zone":"z_a","anchor":"","team":"red"}', '{"op":"end","layer":"gameplay"}', '{"op":"dress","id":"d1","noun":"crate","zone":"z_a","anchor":""}'];

function edge(body: string) {
  const asked: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)));
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  });
  return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe("liveBuild", () => {
  it("asks with the engine hash, hands the seed and the growing draft to the hooks, and stops at the gameplay end", async () => {
    const asked = edge(sse("intent", { intent: INTENT, seed: 7, ms: 300 }) + LINES.map((line, i) => sse("op", { i, line })).join("") + sse("done", { lines: 5 }));
    const seen: { seed?: number; lines: number[]; entities: number[] } = { lines: [], entities: [] };
    const r = await liveBuild("capture the flag", { onIntent: (_i, _ms, seed) => (seen.seed = seed), onLine: (n, d) => (seen.lines.push(n), seen.entities.push(d.entities.length)) });
    expect(asked).toEqual([{ prompt: "capture the flag", engine: ENGINE_HASH }]);
    expect(seen).toEqual({ seed: 7, lines: [1, 2, 3, 4], entities: [0, 0, 1, 1] });
    expect(r).toMatchObject({ kind: "world", seed: 7, lines: 4, fallback: null, cached: null });
  });

  it("sends a picture with the words, and hands back the brief and the prompt it made", async () => {
    const brief = { setting: "a rainy neon alley at night", mood: "tense", palette: ["teal"], objects: ["fire escape", "crate"], layout: "", genre: "", goal: "" };
    const prompt = "a heist here. Inspired by a picture of a rainy neon alley at night; mood tense; colours teal; with fire escape, crate.";
    const asked = edge(sse("inspired", { brief, prompt, ms: 900, model: "claude-haiku-5-5" }) + sse("intent", { intent: INTENT, seed: 7, ms: 1300 }) + LINES.map((line, i) => sse("op", { i, line })).join(""));
    const heard: unknown[] = [];
    const r = await liveBuild("a heist here", { image: "data:image/webp;base64,UklGRg==", onInspired: (i) => heard.push(i) });
    expect(asked).toEqual([{ prompt: "a heist here", engine: ENGINE_HASH, image: "data:image/webp;base64,UklGRg==" }]);
    expect(heard).toEqual([{ brief, prompt, ms: 900 }]);
    expect(r).toMatchObject({ kind: "world", inspired: { brief, prompt } });
    // without a picture nothing of the kind is sent or reported
    const plain = edge(sse("intent", { intent: INTENT, seed: 7, ms: 300 }) + LINES.map((line, i) => sse("op", { i, line })).join(""));
    expect(await liveBuild("capture the flag")).toMatchObject({ kind: "world", inspired: null });
    expect(plain[0]).not.toHaveProperty("image");
  });

  it("a replay from the edge's cache says so; fresh asks past it", async () => {
    const cached = { at: "2026-10-28T09:30:00.000Z", intentModel: "qwen-3.8-27b", fillModel: "gpt-oss-120b" };
    edge(sse("cached", cached) + sse("intent", { intent: INTENT, seed: 7, ms: 300 }) + LINES.map((line, i) => sse("op", { i, line })).join(""));
    expect(await liveBuild("capture the flag")).toMatchObject({ kind: "world", cached });
    const asked = edge(sse("intent", { intent: INTENT, seed: 7, ms: 300 }) + LINES.map((line, i) => sse("op", { i, line })).join(""));
    expect(await liveBuild("capture the flag", { fresh: true })).toMatchObject({ kind: "world", cached: null });
    expect(asked).toEqual([{ prompt: "capture the flag", engine: ENGINE_HASH, fresh: true }]);
  });
});
