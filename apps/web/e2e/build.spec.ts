// The live build path with the edge stubbed: a slow stream shows the world materialising from its
// intent before it plays, and a cached build says it is cached and offers to build it fresh.
// GR_SHOTS=<dir> saves the reveal's frames there (and runs it on two more looks).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (rel: string) => readFileSync(resolve(here, "../../../", rel), "utf8");
const gameplay = (fill: string) => {
  const lines = fill.split("\n").filter(Boolean);
  return lines.slice(0, lines.findIndex((l) => l.includes('"layer":"gameplay"')) + 1);
};
const intentOf = (pack: string, setting: string, headline: string, sub: string[] = []) => ({ lang: "en", mode: "play", genre: "game", setting, role: "runner", goal: "win", fail: "lose", mood: "tense", pack, sub, safety: "ok", headline, nouns: [], moodVec: { valence: 0, arousal: 0.5, tension: 0.5 } });

const WORLDS = {
  vault: { fill: fixture("packages/ir/fixtures/vault-heist.jsonl"), seed: 5, intent: intentOf("floor_plan", "a museum at night", "The gem can be stolen before the alarm"), prompt: "A museum at night: steal the star sapphire before the alarm" },
  ctf: { fill: fixture("packages/ir/fixtures/ctf-neon.jsonl"), seed: 7, intent: intentOf("city_block", "neon city at night", "Rooftop lane needs double jump", ["rooftop"]), prompt: "Capture the flag on neon rooftops" },
  forest: { fill: fixture("packages/packs/outdoor/test/fixtures/glow-forest.jsonl"), seed: 7, intent: intentOf("outdoor", "bioluminescent forest", "Owl lookout needs double jump"), prompt: "A glowing forest: climb to the owl lookout" },
};
const SHOTS = process.env.GR_SHOTS;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => r.status() === 404 && errors.push(`404 ${r.url()}`));
  return errors;
}

const probe = (page: Page) => page.evaluate(() => ({ ...window.__GHOSTRUN__ }));
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function liveLane(page: Page) {
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  for (const path of ["repair", "director"]) await page.route(`**/v1/${path}`, (r) => r.fulfill({ contentType: "text/event-stream", body: sse("error", { message: "off in this test" }) }));
}

for (const name of SHOTS ? (["vault", "ctf", "forest"] as const) : (["vault"] as const)) {
  test(`materialise: a slow build rises from its intent, entities pop in as lines land, then the real world swaps in (${name})`, async ({ page }) => {
    const errors = collectErrors(page);
    const w = WORLDS[name];
    await liveLane(page);
    // a stream that takes its time, as the Haiku lane does: the intent at once, then a line every 260 ms
    await page.addInitScript(({ lines, intent, seed }) => {
      const real = window.fetch.bind(window);
      const seen: unknown[] = ((window as unknown as { __builds: unknown[] }).__builds = []);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!url.endsWith("/v1/build")) return real(input, init);
        seen.push(JSON.parse(String(init?.body ?? "{}")));
        const enc = new TextEncoder();
        const ev = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const body = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(ev("intent", { intent, seed, ms: 300 }));
            for (const [i, line] of lines.entries()) {
              await new Promise((r) => setTimeout(r, 260));
              c.enqueue(ev("op", { i, line }));
            }
            c.enqueue(ev("done", { lines: lines.length }));
            c.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      };
    }, { lines: gameplay(w.fill), intent: w.intent, seed: w.seed });
    await page.goto("/?gl=webgl2&dpr=0.75&prewarm=0");
    await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
    await expect(page.getByTestId("prompt-bar")).toContainText("live AI");

    const bar = page.getByRole("textbox", { name: "Describe a world" });
    await bar.fill(w.prompt);
    await bar.press("Enter");
    // the ground and walls first, from the intent alone, with the line count under them
    await page.waitForFunction(() => (window.__GHOSTRUN__.materialise?.statics ?? 0) > 0, null, { timeout: 20_000 });
    await expect(page.getByTestId("materialise")).toContainText(/building… \d+ lines?/);
    expect((await probe(page)).specHash).toBeUndefined(); // the new world isn't playing yet
    await expect(page.getByTestId("intent-card")).toHaveCount(0); // nor is the last one's card in the way
    const dir = SHOTS && resolve(SHOTS);
    if (dir) {
      mkdirSync(dir, { recursive: true });
      await page.waitForTimeout(450);
      await page.screenshot({ path: resolve(dir, `${name}-1-rising.png`) });
    }
    // then the things in it, one by one as their lines land
    await page.waitForFunction(() => (window.__GHOSTRUN__.materialise?.entities ?? 0) >= 3, null, { timeout: 20_000 });
    expect((await probe(page)).specHash).toBeUndefined();
    if (dir) {
      await page.screenshot({ path: resolve(dir, `${name}-2-entities.png`) });
      await page.waitForTimeout(1300);
      if ((await probe(page)).materialise) await page.screenshot({ path: resolve(dir, `${name}-3-late.png`) });
    }

    // the gameplay layer completes: the real world swaps in and plays (loading it can take a while on
    // a machine busy with other suites, hence the long waits)
    await expect(page.getByTestId("materialise")).toHaveCount(0, { timeout: 60_000 });
    await page.waitForFunction(() => window.__GHOSTRUN__.ready === true && window.__GHOSTRUN__.materialise === undefined && Boolean(window.__GHOSTRUN__.specHash), null, { timeout: 60_000 });
    await expect(page.getByTestId("intent-card")).toContainText(w.intent.headline);
    await expect(page.getByTestId("source-chip")).toHaveText("live AI");
    if (dir) await page.screenshot({ path: resolve(dir, `${name}-4-playing.png`) });
    const builds = await page.evaluate(() => (window as unknown as { __builds: { prompt: string; engine?: string; fresh?: boolean }[] }).__builds);
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({ prompt: w.prompt, engine: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(builds[0]!.fresh).toBeUndefined();
    expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
  });
}

test("cached build: the chip says cached · built live <date> by <model>, nothing materialises, and Build it fresh asks for a new one", async ({ page }) => {
  const errors = collectErrors(page);
  const w = WORLDS.ctf;
  await liveLane(page);
  const asked: { prompt: string; fresh?: boolean }[] = [];
  const stream = (cached: boolean) =>
    (cached ? sse("cached", { at: "2026-10-28T09:30:00.000Z", intentModel: "qwen-3.8-27b", fillModel: "gpt-oss-120b" }) : "") +
    sse("intent", { intent: w.intent, seed: w.seed, ms: 310 }) +
    gameplay(w.fill).map((line, i) => sse("op", { i, line })).join("") +
    sse("done", { lines: 29, intentModel: "qwen-3.8-27b", fillModel: "gpt-oss-120b" });
  await page.route("**/v1/build", (r) => {
    const body = r.request().postDataJSON() as { prompt: string; fresh?: boolean };
    asked.push(body);
    return r.fulfill({ contentType: "text/event-stream", body: stream(!body.fresh) });
  });
  // was a build preview ever on screen? (a world that arrives complete swaps straight in)
  await page.addInitScript(() => {
    const w = window as unknown as { __sawPreview: boolean };
    w.__sawPreview = false;
    const look = () => {
      if (window.__GHOSTRUN__?.materialise) w.__sawPreview = true;
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });

  const bar = page.getByRole("textbox", { name: "Describe a world" });
  await bar.fill(w.prompt);
  await bar.press("Enter");
  const chip = page.getByTestId("source-chip");
  await expect(chip).toHaveText("cached · built live 28 Oct by gpt-oss-120b", { timeout: 30_000 });
  await expect(chip).toHaveAttribute("title", /Replayed from the cache, not built now: this prompt was built live on 28 Oct 2026, 09:30 UTC \(intent by Qwen 3\.8, world by gpt-oss-120b\)/);
  await page.waitForFunction(() => window.__GHOSTRUN__.ready === true && Boolean(window.__GHOSTRUN__.specHash), null, { timeout: 30_000 });
  await expect(page.getByTestId("intent-card")).toContainText(w.intent.headline);
  expect(await page.evaluate(() => (window as unknown as { __sawPreview: boolean }).__sawPreview)).toBe(false);
  const fresh = page.getByTestId("build-fresh");
  await expect(fresh).toHaveText("Build it fresh");
  expect(asked).toEqual([expect.objectContaining({ prompt: w.prompt })]);
  expect(asked[0]!.fresh).toBeUndefined();

  // Build it fresh: the same prompt, past the cache; the world that comes back is live
  await fresh.click();
  await expect(chip).toHaveText("live AI", { timeout: 30_000 });
  await expect(fresh).toHaveCount(0);
  expect(asked).toHaveLength(2);
  expect(asked[1]).toMatchObject({ prompt: w.prompt, fresh: true });
  await page.waitForFunction(() => window.__GHOSTRUN__.ready === true && Boolean(window.__GHOSTRUN__.specHash), null, { timeout: 30_000 });
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});
