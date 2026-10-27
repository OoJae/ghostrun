import { afterEach, describe, expect, it, vi } from "vitest";
import { chatJson, LlmError } from "../src/cerebras";

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
const busy = () => new Response("we're experiencing high traffic", { status: 429, headers: { "retry-after": "0.01" } });

afterEach(() => vi.unstubAllGlobals());

describe("a busy provider", () => {
  it("a 429 is retried after a short wait instead of losing the world; a third one gives up", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(busy()).mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetch);
    const r = await chatJson<{ a: number }>({ apiKey: "k", model: "m", messages: [] });
    expect(r.value).toEqual({ a: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => busy()));
    await expect(chatJson({ apiKey: "k", model: "m", messages: [] })).rejects.toBeInstanceOf(LlmError);

    // a client error is not retried
    const bad = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", bad);
    await expect(chatJson({ apiKey: "k", model: "m", messages: [] })).rejects.toMatchObject({ status: 400, retryable: false });
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
