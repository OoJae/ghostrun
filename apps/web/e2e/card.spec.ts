// The editable Intent card, and structural edits. A look changed on the card redraws the world in
// place (the run goes on, the same spec, the receipt kept); jumps changed on it come back re-proved
// with their numbers and Undo; a pack changed on it rebuilds the world live with that pack pinned
// ("rebuilt as a maze at your request"), with Undo; and "add a floor" on the museum fixture is a
// structural edit whose diff line names the change. The live lane is stubbed in the page.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// models=0: the primitives, so no model is still loading (and compiling) when a world is swapped
const BOOT = "/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&models=0";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const probe = (page: Page) => page.evaluate(() => ({ ...window.__GHOSTRUN__ }));
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const patch = (lines: string[]) => lines.map((line, i) => sse("op", { i, line })).join("") + sse("done", { lines: lines.length });

/** The live lane, stubbed: up, with the minds, repairs and the Director's cut off. */
async function liveLane(page: Page) {
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  for (const path of ["repair", "director"]) await page.route(`**/v1/${path}`, (r) => r.fulfill({ contentType: "text/event-stream", body: sse("error", { message: "off in this test" }) }));
}

test("intent card: a look changed on the card redraws the world in place, the run goes on, the same spec and receipt", async ({ page }) => {
  test.setTimeout(480_000); // a world, its proof, and a new look's shaders compiled while it plays
  const errors = collectErrors(page);
  await page.goto(BOOT);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  const before = await probe(page);
  expect(before.look).toBe("neon");
  const card = page.getByTestId("intent-card");
  await expect(card.getByTestId("field-look")).toContainText("Neon city");

  // keyboard: the field opens with Enter, the arrows step through the looks, Escape closes it
  await card.getByTestId("field-look").focus();
  await page.keyboard.press("Enter");
  await expect(card.getByRole("group", { name: "Look" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card.getByRole("group", { name: "Look" })).toHaveCount(0);
  await expect(card.getByTestId("field-look")).toBeFocused();

  await card.getByTestId("field-look").click();
  await card.getByRole("group", { name: "Look" }).getByRole("button", { name: "Ice cave" }).click();
  await page.waitForFunction(() => window.__GHOSTRUN__.look === "snow/cave", null, { timeout: 60_000 });
  await expect(card.getByTestId("field-look")).toContainText("Ice cave", { timeout: 60_000 });
  await expect(page.getByTestId("edit-result")).toContainText("the same spec: the receipt stands", { timeout: 60_000 });
  const after = await probe(page);
  expect(after.specHash).toBe(before.specHash);
  expect(after.tick!).toBeGreaterThan(before.tick!); // the same run, still going: nothing reloaded
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified"); // never re-proved

  // (the hour and the weather pin the same way: test/card.test.ts) Undo redraws the neon city in place
  await page.getByTestId("edit-undo").click();
  await page.waitForFunction(() => window.__GHOSTRUN__.look === "neon", null, { timeout: 60_000 });
  expect((await probe(page)).specHash).toBe(before.specHash);
  expect(errors).toEqual([]);
});

test("intent card: jumps changed on the card come back re-proved with their numbers, and Undo restores them", async ({ page }) => {
  test.setTimeout(480_000); // two worlds, each proved by its AI runners
  const errors = collectErrors(page);
  await page.goto(BOOT);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  const spec0 = (await probe(page)).specHash;
  const card = page.getByTestId("intent-card");
  await expect(card.getByTestId("field-jumps")).toContainText("double jump (×2)", { timeout: 60_000 });

  // no live AI needed: the card writes the law line itself (this is the recorded fixture, offline)
  await expect(page.getByTestId("prompt-bar")).toContainText("fixture");
  await card.getByTestId("field-jumps").click();
  await card.getByRole("group", { name: "Jumps" }).getByRole("button", { name: "3 jumps" }).click();
  await expect(page.getByTestId("edit-result")).toContainText("“triple jump”", { timeout: 30_000 });
  await expect(page.getByTestId("edit-summary")).toContainText("jumps 2 → 3", { timeout: 60_000 });
  await expect(page.getByTestId("edit-delta")).toBeVisible({ timeout: 90_000 });
  await expect(card.getByTestId("field-jumps")).toContainText("double jump (×3)");
  expect((await probe(page)).specHash).not.toBe(spec0);

  await page.getByTestId("edit-undo").click();
  await expect(card.getByTestId("field-jumps")).toContainText("double jump (×2)", { timeout: 60_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await expect.poll(async () => (await probe(page)).specHash, { timeout: 60_000 }).toBe(spec0);
  expect(errors).toEqual([]);
});

test("intent card: the pack changed on the card rebuilds the world live as a maze, pinned, and Undo goes back to the city", async ({ page }) => {
  test.setTimeout(480_000); // two worlds, each proved by its AI runners
  const errors = collectErrors(page);
  await liveLane(page);
  const maze = JSON.parse(readFileSync(resolve(here, "../src/gallery/worlds/a-desert-temple-with-pressure-plates-tha.json"), "utf8")) as { intent: Record<string, unknown>; fill: string };
  const lines = maze.fill.split("\n").filter(Boolean);
  const gameplay = lines.slice(0, lines.findIndex((l) => l.includes('"layer":"gameplay"')) + 1);
  const asked: { prompt?: string; seed?: number; intent?: { pack?: string } }[] = [];
  await page.route("**/v1/build", (r) => {
    const body = r.request().postDataJSON() as (typeof asked)[number];
    asked.push(body);
    const intent = { ...maze.intent, ...body.intent };
    return r.fulfill({ contentType: "text/event-stream", body: sse("intent", { intent, seed: body.seed, ms: 300 }) + patch(gameplay) });
  });
  await page.goto(BOOT);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("prompt-bar")).toContainText("live AI");
  await expect(page.getByTestId("proof-badge")).toContainText("verified", { timeout: 60_000 });
  const spec0 = (await probe(page)).specHash;
  const card = page.getByTestId("intent-card");

  await card.getByTestId("field-pack").click();
  await card.getByTestId("pack-maze").click();
  await expect(card.getByTestId("rebuilt-note")).toContainText("rebuilt as a maze at your request", { timeout: 60_000 });
  await expect(card.getByTestId("field-pack")).toContainText("maze");
  await expect(page.getByTestId("edit-result")).toContainText("“rebuilt as a maze at your request”");
  await expect(page.getByTestId("edit-summary")).toContainText("pack city_block → maze");
  // the edge was asked for the same words, the same seed, the pack pinned
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ seed: 7, intent: { pack: "maze" } });
  expect(asked[0]!.prompt).toContain("capture-the-flag");
  await expect(page.getByTestId("edit-delta")).toBeVisible({ timeout: 90_000 });
  expect((await probe(page)).specHash).not.toBe(spec0);

  await page.getByTestId("edit-undo").click();
  await expect(card.getByTestId("field-pack")).toContainText("city_block", { timeout: 60_000 });
  await expect(card.getByTestId("rebuilt-note")).toHaveCount(0);
  await expect.poll(async () => (await probe(page)).specHash, { timeout: 60_000 }).toBe(spec0);
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});

test("structural edit: 'add a floor' on the museum fixture comes back with its diff line, re-proved, and Undo restores the geometry", async ({ page }) => {
  test.setTimeout(480_000); // two worlds, each proved by its AI runners
  const errors = collectErrors(page);
  await liveLane(page);
  let asked: { change?: string; fill?: string } = {};
  await page.route("**/v1/edit", (r) => {
    asked = r.request().postDataJSON() as typeof asked;
    return r.fulfill({
      contentType: "text/event-stream",
      body: patch([
        '{"op":"layout","params":{"floors":2}}',
        '{"op":"zone","id":"z_upper","slot":"upper_hall","tag":"hall","name":"Upper gallery"}',
        '{"op":"ent","id":"bust","kind":"prop","noun":"marble bust","hyper":"sculpture","zone":"z_upper","anchor":"center","body":"fixed","shape":"box","size":[0.6,1.2,0.6]}',
        '{"op":"verb","id":"vb_look_bust","verb":"social.inspect","on":"bust","params":{"text":"The founder, upstairs at last."}}',
      ]),
    });
  });
  await page.goto(`${BOOT}&fixture=vault`);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("prompt-bar")).toContainText("live AI");
  await expect(page.getByTestId("proof-badge")).toContainText("verified", { timeout: 60_000 });
  const spec0 = (await probe(page)).specHash;

  await page.getByTestId("edit-input").fill("add a floor");
  await page.getByTestId("edit-input").press("Enter");
  await expect(page.getByTestId("edit-summary")).toContainText("floors 1 → 2 · 2 rooms added · 1 thing re-anchored · +1 marble bust", { timeout: 30_000 });
  // the re-anchoring, in the placer's words, on the diff line's hover
  await expect(page.getByTestId("edit-summary")).toHaveAttribute("title", /laser: anchor 'corner_ne' is gone from 'main_room' in the new layout, re-anchored to/);
  await expect(page.getByTestId("edit-delta")).toBeVisible({ timeout: 90_000 });
  expect(asked.change).toBe("add a floor");
  expect((await probe(page)).specHash).not.toBe(spec0);
  // the promise stands, re-checked on the new geometry
  await expect(page.getByTestId("intent-card")).toContainText("The gem can be stolen before the alarm");

  // the card's own floor button undoes nothing by itself: Undo restores the one-storey museum
  await page.getByTestId("edit-undo").click();
  await expect.poll(async () => (await probe(page)).specHash, { timeout: 60_000 }).toBe(spec0);
  await expect(page.getByTestId("proof-badge")).toContainText("verified", { timeout: 60_000 });
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});
