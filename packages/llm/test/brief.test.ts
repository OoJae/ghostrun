import { afterEach, describe, expect, it, vi } from "vitest";
import { chatJson } from "../src/cerebras";
import { jsonLanes, lanesFor, resetLaneHealth } from "../src/lanes";
import { BRIEF_MAX_CHARS, briefJsonSchema, inspiredPrompt, settleBrief, visionMessages, type BriefOut } from "../src/prompts";

const KEYS = { cerebras: "csk", anthropic: "ak" };
const IMAGE = { mediaType: "image/webp" as const, data: "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=" };
const BRIEF: BriefOut = { setting: "a rainy neon alley at night", mood: "tense", palette: ["teal", "magenta", "wet black"], objects: ["fire escape", "dumpster", "neon sign", "puddle", "crate"], layout: "a long corridor", genre: "", goal: "", safety: "ok" };

afterEach(() => {
  vi.unstubAllGlobals();
  resetLaneHealth();
});

describe("the vision step", () => {
  it("goes to Haiku alone, with the picture as a base64 image block before the words, and a strict brief schema", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ content: [{ type: "text", text: JSON.stringify(BRIEF) }], stop_reason: "end_turn", usage: { input_tokens: 1300, output_tokens: 140 } });
    });
    const lanes = lanesFor("vision", KEYS, { messages: visionMessages("a heist here", IMAGE), jsonSchema: { name: "brief", schema: briefJsonSchema() }, maxTokens: 500 });
    expect(lanes.map((l) => l.model)).toEqual(["claude-haiku-5-5"]);
    expect(lanesFor("vision", { cerebras: "csk" }, { messages: [] })).toEqual([]); // no Claude key: no way to read a picture
    const r = await jsonLanes<BriefOut>(lanes);
    expect(r).toMatchObject({ value: BRIEF, inTok: 1300, outTok: 140, model: "claude-haiku-5-5" });
    const body = sent[0]!.body as { messages: { role: string; content: unknown }[]; system: string; output_config: { format: { type: string; schema: unknown } }; thinking: unknown };
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/webp", data: IMAGE.data } },
          { type: "text", text: "Their prompt: a heist here" },
        ],
      },
    ]);
    expect(body.system).toContain("never a copy of it");
    expect(body.output_config.format).toEqual({ type: "json_schema", schema: briefJsonSchema() });
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("the fast lane refuses a picture outright rather than dropping it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(chatJson({ apiKey: "k", model: "qwen-3.8-27b", messages: visionMessages("", IMAGE) })).rejects.toMatchObject({ status: 400, retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the brief", () => {
  it("is bounded: one line per field, short nouns, no repeats, at most ten things", () => {
    const b = settleBrief({ ...BRIEF, setting: "  a rainy\nneon   alley\u0007 ", objects: [...Array(14)].map((_, i) => `Crate ${i % 12}`).concat("", "x".repeat(60)), palette: ["Teal", "teal", "magenta"] });
    expect(b.setting).toBe("a rainy neon alley");
    expect(b.objects).toHaveLength(10);
    expect(b.objects[0]).toBe("crate 0");
    expect(b.palette).toEqual(["teal", "magenta"]);
    expect(b).not.toHaveProperty("safety");
  });

  it("follows the person's words, or leads with the game the picture suggested when they typed none", () => {
    const b = settleBrief(BRIEF);
    expect(inspiredPrompt("a heist here", b)).toBe("a heist here. Inspired by a picture of a rainy neon alley at night; mood tense; colours teal, magenta, wet black; with fire escape, dumpster, neon sign, puddle, crate; layout: a long corridor.");
    const none = inspiredPrompt("", settleBrief({ ...BRIEF, genre: "heist", goal: "Steal the neon sign and slip out." }));
    expect(none.startsWith("Heist: Steal the neon sign and slip out. Inspired by a picture of a rainy neon alley at night;")).toBe(true);
    expect(inspiredPrompt("", settleBrief({ ...BRIEF, layout: "" }))).toBe("Inspired by a picture of a rainy neon alley at night; mood tense; colours teal, magenta, wet black; with fire escape, dumpster, neon sign, puddle, crate.");
  });

  it("never adds more than BRIEF_MAX_CHARS to what the person typed", () => {
    const long = settleBrief({ setting: "s".repeat(200), mood: "m".repeat(50), palette: [...Array(8)].map((_, i) => `${i}`.repeat(20)), objects: [...Array(12)].map((_, i) => `${i}`.repeat(30)), layout: "l".repeat(90), genre: "g".repeat(40), goal: "o".repeat(150), safety: "ok" });
    const said = "ű".repeat(500);
    expect(inspiredPrompt(said, long).length).toBeLessThanOrEqual(500 + BRIEF_MAX_CHARS);
    expect(inspiredPrompt("", long).length).toBeLessThanOrEqual(BRIEF_MAX_CHARS);
    expect(inspiredPrompt(said, long).startsWith(said)).toBe(true);
  });
});
