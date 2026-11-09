// The export menu's playtest report (one HTML file with the receipt, the band, the heat map, the
// hashes and the share link), and the Intent card's homage note for a prompt that names brands
// (trademarked names go to the edge as generic homages). The live lane and the share store are stubbed.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (rel: string) => readFileSync(resolve(here, "../../../", rel), "utf8");
const BOOT = "/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&models=0";
const SHARE = "abcdefghijklmnop";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test("export menu: the playtest report downloads as one HTML file with the receipt's headline, the band, the heat map and a share link", async ({ page }) => {
  const errors = collectErrors(page);
  const shared: { prompt?: string; inputs?: unknown[] }[] = [];
  await page.route("**/v1/share", (r) => (shared.push(r.request().postDataJSON() as (typeof shared)[number]), r.fulfill({ json: { id: SHARE } })));
  await page.goto(BOOT);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await page.keyboard.press("KeyP");
  await expect(page.getByTestId("band")).toContainText("Difficulty: Normal", { timeout: 90_000 });

  await page.getByTestId("export").click();
  const menu = page.getByTestId("export-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button")).toHaveText(["Playtest report (.html)", "Scene (.glb)", "Logic (.logic.json)", "All three"]);
  const [file] = await Promise.all([page.waitForEvent("download"), menu.getByTestId("export-report").click()]);
  expect(file.suggestedFilename()).toBe("create-a-capture-the-flag-game-in-a-neon.report.html");
  const html = readFileSync((await file.path())!, "utf8");
  await expect(menu).toHaveCount(0); // the menu closes on a pick

  expect(html).toContain("<h1>Playtest report</h1>");
  expect(html).toContain('<b>Headline:</b> Rooftop lane needs double jump: <b class="verified">verified</b>');
  expect(html).toContain("Normal: novices 0 of 6 · average 3 of 6 · experts 12 of 12");
  expect(html).toMatch(/<svg[^>]*aria-label="Heat map of where the AI runners went"/);
  expect(html).toContain(`?s=${SHARE}`);
  expect(html).toMatch(/Spec hash <code>[0-9a-f]{64}<\/code>/);
  expect(html).not.toMatch(/<script|<link\b|\bsrc=/i);
  // the share is the world from the top: no run in it, the prompt it was built from
  expect(shared).toHaveLength(1);
  expect(shared[0]).toMatchObject({ inputs: [], prompt: "Create a capture-the-flag game in a neon city. Add double jump. Score when the orb reaches the goal." });
  expect(errors).toEqual([]);
});

test("homage: a prompt that names brands goes to the edge as generic homages, and the Intent card says so", async ({ page }) => {
  const errors = collectErrors(page);
  const fill = fixture("packages/ir/fixtures/ctf-neon.jsonl").split("\n").filter(Boolean);
  const gameplay = fill.slice(0, fill.findIndex((l) => l.includes('"layer":"gameplay"')) + 1);
  const intent = { lang: "en", mode: "play", genre: "ctf", setting: "a moon-sized battle station", role: "runner", goal: "score the orb", fail: "blue scores 3", mood: "tense", pack: "city_block", sub: ["rooftop"], safety: "ok", headline: "Rooftop lane needs double jump", nouns: [], moodVec: { valence: 0, arousal: 0.5, tension: 0.5 } };
  const asked: { prompt: string }[] = [];
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  for (const path of ["repair", "director"]) await page.route(`**/v1/${path}`, (r) => r.fulfill({ contentType: "text/event-stream", body: sse("error", { message: "off in this test" }) }));
  await page.route("**/v1/build", (r) => {
    asked.push(r.request().postDataJSON() as { prompt: string });
    return r.fulfill({ contentType: "text/event-stream", body: sse("intent", { intent, seed: 7, ms: 300 }) + gameplay.map((line, i) => sse("op", { i, line })).join("") + sse("done", { lines: gameplay.length }) });
  });
  await page.goto(BOOT);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("prompt-bar")).toContainText("live AI");

  const bar = page.getByRole("textbox", { name: "Describe a world" });
  await bar.fill("Capture the flag on the Death Star with lightsabers");
  await bar.press("Enter");
  await page.waitForFunction(() => window.__GHOSTRUN__.ready === true && Boolean(window.__GHOSTRUN__.specHash), null, { timeout: 60_000 });
  const note = page.getByTestId("homage-note");
  await expect(note).toHaveText("Homage: 'Death Star' → 'a moon-sized battle station', 'lightsabers' → 'a laser sword'; we don't use trademarked names");
  // what reached the edge names no brand
  expect(asked).toEqual([expect.objectContaining({ prompt: "Capture the flag on the moon-sized battle station with a laser sword" })]);
  // an ordinary prompt has no note
  await bar.fill("Capture the flag on neon rooftops");
  await bar.press("Enter");
  await expect.poll(() => asked.length, { timeout: 30_000 }).toBe(2);
  await page.waitForFunction(() => window.__GHOSTRUN__.ready === true && Boolean(window.__GHOSTRUN__.specHash), null, { timeout: 60_000 });
  await expect(page.getByTestId("intent-card")).toBeVisible();
  await expect(note).toHaveCount(0);
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});
