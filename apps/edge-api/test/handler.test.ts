import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FillParser } from "@ghostrun/ir";
import { handle } from "../src/handler";

function key(): string | undefined {
  const f = new URL("../../../.dev.vars", import.meta.url);
  if (!existsSync(f)) return undefined;
  return /^CEREBRAS_API_KEY=(.+)$/m.exec(readFileSync(f, "utf8"))?.[1];
}

async function readSse(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text.split("\n\n").filter(Boolean).map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1] ?? "";
    const data = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "null");
    return { event, data };
  });
}

describe("edge API", () => {
  it("health and input validation", async () => {
    const h = await handle(new Request("http://x/v1/health"), { CEREBRAS_API_KEY: "k" });
    expect(await h.json()).toMatchObject({ ok: true, llm: true });
    const empty = await handle(new Request("http://x/v1/build", { method: "POST", body: JSON.stringify({ prompt: "  " }) }), { CEREBRAS_API_KEY: "k" });
    expect(empty.status).toBe(400);
  });

  // Live LLM test: opt-in (LIVE=1) so the default suite stays free and deterministic.
  it.skipIf(!key() || !process.env.LIVE)("streams intent then fill ops that parse into a world (live Cerebras)", async () => {
    const res = await handle(
      new Request("http://x/v1/build", { method: "POST", body: JSON.stringify({ prompt: "a maze with ghosts and a key that opens the exit", seed: 11 }) }),
      { CEREBRAS_API_KEY: key()! },
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const events = await readSse(res);
    expect(events[0]!.event).toBe("intent");
    const ops = events.filter((e) => e.event === "op");
    expect(ops.length).toBeGreaterThan(8);
    const p = new FillParser({ seed: 11 });
    for (const o of ops) p.push(`${o.data.line}\n`);
    p.end();
    expect(p.stats.invalid / Math.max(1, p.stats.lines)).toBeLessThan(0.1);
    expect(p.draft.zones.length).toBeGreaterThan(0);
    expect(events.at(-1)!.event).toBe("done");
  }, 60_000);
});
