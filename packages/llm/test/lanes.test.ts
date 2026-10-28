import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeSchema } from "../src/anthropic";
import { jsonLanes, lanesFor, streamLanes } from "../src/lanes";
import type { StreamEvent } from "../src/wire";

const KEYS = { cerebras: "csk", anthropic: "ak" };
const busy = () => new Response("we're experiencing high traffic", { status: 429, headers: { "retry-after": "0.01" } });
const sse = (events: unknown[]) => new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200 });
const claudeStream = (text: string[], extra: unknown[] = []) =>
  sse([
    { type: "message_start", message: { usage: { input_tokens: 900, cache_read_input_tokens: 100 } } },
    ...text.map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })),
    ...extra,
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
    { type: "message_stop" },
  ]);
const cerebrasStream = (text: string[]) => sse([...text.map((t) => ({ choices: [{ delta: { content: t } }] })), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }]);

/** Route a stubbed fetch by provider; each side answers from its own queue. */
function providers(cerebras: (() => Response)[], anthropic: (() => Response)[]) {
  const calls: { provider: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const provider = url.includes("anthropic") ? "anthropic" : "cerebras";
    calls.push({ provider, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const next = (provider === "anthropic" ? anthropic : cerebras).shift();
    if (!next) throw new Error(`unexpected ${provider} call`);
    return next();
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

const drain = async (it: AsyncGenerator<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
};
const textOf = (evs: StreamEvent[]) => evs.map((e) => (e.type === "text" ? e.delta : "")).join("");

afterEach(() => vi.unstubAllGlobals());

describe("the fallback rung", () => {
  it("a busy fast lane hands the fill to Haiku before it has said a word, and says so", async () => {
    const calls = providers([busy, busy], [() => claudeStream(['{"op":"spawn"}\n', '{"op":"end"}\n'])]);
    const evs = await drain(streamLanes(lanesFor("fill", KEYS, { messages: [{ role: "system", content: "rules" }, { role: "user", content: "a maze" }], maxTokens: 6000 })));
    expect(calls.map((c) => c.provider)).toEqual(["cerebras", "cerebras", "anthropic"]); // one quick retry, then over
    expect(evs.find((e) => e.type === "fallback")).toEqual({ type: "fallback", from: "gpt-oss-120b", to: "claude-haiku-5-5", status: 429 });
    expect(textOf(evs)).toBe('{"op":"spawn"}\n{"op":"end"}\n');
    expect(evs.find((e) => e.type === "usage")).toEqual({ type: "usage", inTok: 1000, outTok: 42, model: "claude-haiku-5-5" });
    // the Messages API request: system lifted out, thinking off at low effort for the fast job, current version
    const req = calls[2]!;
    expect(req.headers).toMatchObject({ "x-api-key": "ak", "anthropic-version": "2026-10-21" });
    expect(req.body).toMatchObject({ model: "claude-haiku-5-5", system: "rules", max_tokens: 6000, stream: true, thinking: { type: "disabled" }, output_config: { effort: "low" } });
    expect(req.body.messages).toEqual([{ role: "user", content: "a maze" }]);
    expect(req.body).not.toHaveProperty("temperature");
  });

  it("once text has streamed, a failure is final: the client already placed those lines", async () => {
    providers([], [() => claudeStream(['{"op":"spawn"}\n'], [{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }])]);
    const lanes = lanesFor("fill", KEYS, { primary: "anthropic", messages: [{ role: "user", content: "x" }] });
    expect(lanes.map((l) => l.provider)).toEqual(["anthropic", "cerebras"]);
    await expect(drain(streamLanes(lanes))).rejects.toMatchObject({ status: 200, retryable: true });
  });

  it("a bad request never fails over (it would fail the same way, and cost twice)", async () => {
    const calls = providers([() => new Response("bad schema", { status: 400 })], []);
    await expect(drain(streamLanes(lanesFor("fill", KEYS, { messages: [{ role: "user", content: "x" }] })))).rejects.toMatchObject({ status: 400, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("a JSON job falls back with the schema cut to what structured outputs accept", async () => {
    const calls = providers([() => new Response("down", { status: 503 }), () => new Response("down", { status: 503 })], [
      () => new Response(JSON.stringify({ content: [{ type: "text", text: '{"answer":"You fell at 0:12.","cites":[2]}' }], stop_reason: "end_turn", usage: { input_tokens: 300, output_tokens: 20 } }), { status: 200 }),
    ]);
    const schema = { type: "object", additionalProperties: false, required: ["answer", "cites"], properties: { answer: { type: "string", maxLength: 280 }, cites: { type: "array", maxItems: 4, items: { type: "integer", minimum: 1, maximum: 9 } } } };
    const r = await jsonLanes<{ answer: string; cites: number[] }>(lanesFor("host", KEYS, { messages: [{ role: "user", content: "why?" }], maxTokens: 200, jsonSchema: { name: "host", schema } }));
    expect(r).toMatchObject({ value: { answer: "You fell at 0:12.", cites: [2] }, model: "claude-haiku-5-5", fellBack: true, inTok: 300, outTok: 20 });
    expect((calls[2]!.body.output_config as { format: unknown }).format).toEqual({
      type: "json_schema",
      schema: { type: "object", additionalProperties: false, required: ["answer", "cites"], properties: { answer: { type: "string" }, cites: { type: "array", items: { type: "integer" } } } },
    });
  });

  it("with one key there is one lane, and it keeps its own retries", async () => {
    const lanes = lanesFor("intent", { cerebras: "csk" }, { messages: [] });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).not.toHaveProperty("retryMs");
    expect(lanesFor("intent", {}, { messages: [] })).toEqual([]);
    await expect(jsonLanes([])).rejects.toMatchObject({ status: 503 });
  });

  it("a refusal is an answer, not an outage: it doesn't fail over", async () => {
    const calls = providers([], [() => new Response(JSON.stringify({ content: [], stop_reason: "refusal", usage: {} }), { status: 200 })]);
    await expect(jsonLanes(lanesFor("mind", KEYS, { primary: "anthropic", messages: [{ role: "user", content: "x" }] }))).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("the fast lane still answers first when it's well", async () => {
    const calls = providers([() => cerebrasStream(["a", "b"])], []);
    const evs = await drain(streamLanes(lanesFor("patch", KEYS, { messages: [{ role: "user", content: "x" }] })));
    expect(textOf(evs)).toBe("ab");
    expect(evs.some((e) => e.type === "fallback")).toBe(false);
    expect(evs.find((e) => e.type === "usage")).toMatchObject({ model: "gpt-oss-120b" });
    expect(calls).toHaveLength(1);
  });
});

describe("claudeSchema", () => {
  it("drops the bounds structured outputs reject, but not a property that happens to share their name", () => {
    expect(claudeSchema({ type: "object", properties: { maximum: { type: "number", minimum: 0 }, tags: { type: "array", minItems: 2, items: { type: "string", enum: ["a", "b"] } } }, required: ["maximum"] })).toEqual({
      type: "object",
      properties: { maximum: { type: "number" }, tags: { type: "array", items: { type: "string", enum: ["a", "b"] } } },
      required: ["maximum"],
    });
  });
});
