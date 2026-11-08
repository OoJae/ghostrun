// Showing what the proof found, in the world: red/green (the same AI runner on the same seed before
// and after a change, side by side), a design note's Apply (its change re-proved on a copy, offered
// only if it holds, swapped in with Undo), and the Host flying to the moment it cites. The live lane
// is stubbed: no model is called.
import { expect, test, type Page } from "@playwright/test";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const probe = (page: Page) => page.evaluate(() => ({ ...window.__GHOSTRUN__ }));
const sse = (lines: string[]) => lines.map((line, i) => `event: op\ndata: ${JSON.stringify({ i, line })}\n\n`).join("") + `event: done\ndata: {"lines":${lines.length}}\n\n`;
const dist = (p: readonly number[], q: readonly number[]) => Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);

/** The live lane, stubbed: up, with minds and repairs off (each test answers the call it is about). */
async function live(page: Page) {
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  await page.route("**/v1/repair", (r) => r.fulfill({ contentType: "text/event-stream", body: 'event: error\ndata: {"message":"off in this test"}\n\n' }));
}

test("red/green: an edit that breaks the headline plays the same AI runner before and after it, side by side, and names where they part", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await live(page);
  await page.route("**/v1/edit", (r) => r.fulfill({ contentType: "text/event-stream", body: sse(['{"op":"law","player":{"jumpsMax":2,"jumpH":3.4}}']) }));
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await page.getByTestId("edit-box").getByRole("button", { name: "super high jumps" }).click();
  await expect(page.getByTestId("edit-delta")).toContainText("Headline: verified → counterexample", { timeout: 90_000 });
  // the pair is played in a worker once the new receipt lands: then the summary offers it
  const play = page.getByTestId("edit-redgreen");
  await expect(play).toBeVisible({ timeout: 60_000 });
  await play.click();
  const caption = page.getByTestId("redgreen");
  await expect(caption).toContainText("Green: before the change · red: after it · the same AI runner, the same seed", { timeout: 10_000 });
  await page.waitForFunction(() => window.__GHOSTRUN__.redgreen !== undefined, null, { timeout: 10_000 });
  const start = (await probe(page)).redgreen!;
  // side by side from the start: both at the spawn, the camera on them
  expect(dist(start.green, start.red)).toBeLessThan(0.5);
  // where they part: the one-jump attempt falls short before, and clears the 2.6 m ledge after
  await expect(caption).toContainText(/They part here: the jump.*\(green rises 1\.\d m, red [23]\.\d m\)/, { timeout: 60_000 });
  await page.waitForFunction(() => (window.__GHOSTRUN__.redgreen?.red[1] ?? 0) > (window.__GHOSTRUN__.redgreen?.green[1] ?? 0) + 1, null, { timeout: 10_000 });
  const rg = (await probe(page)).redgreen!;
  expect(rg.parted).toBe(true);
  // the camera frames both
  const mid = [0, 1, 2].map((k) => (rg.green[k]! + rg.red[k]!) / 2);
  expect(dist(rg.cam, mid)).toBeLessThan(30);
  expect(dist(rg.cam, rg.green)).toBeGreaterThan(3);
  // Esc hands the camera back
  await page.keyboard.press("Escape");
  await expect(caption).toHaveCount(0);
  expect((await probe(page)).redgreen).toBeUndefined();
  // the receipt's counterexample chips play the same pair
  await page.keyboard.press("KeyP");
  await expect(page.getByTestId("receipt").getByTestId("chip-redgreen").first()).toHaveText("▶ red/green");
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});

test("design notes: Apply turns where runs went wrong into a change, re-proved on a copy and offered with its numbers, then applied with Undo", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  const asked: string[] = [];
  await live(page);
  await page.route("**/v1/edit", (r) => {
    asked.push((r.request().postDataJSON() as { change: string }).change);
    return r.fulfill({ contentType: "text/event-stream", body: sse(['{"op":"ent","id":"x_kiosk","kind":"prop","noun":"ramen kiosk","hyper":"stall","zone":"z_plaza","body":"fixed","shape":"box"}']) });
  });
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  const spec0 = (await probe(page)).specHash;
  await page.keyboard.press("KeyP");
  // the playtest's novices lose to blue near the plaza: that note gets its changes
  const fails = page.getByTestId("fails");
  await expect(fails).toContainText("blue reached 3", { timeout: 90_000 });
  await fails.getByRole("button", { name: "Apply: make the rivals a little slower" }).first().click();
  const offer = page.getByTestId("note-offer");
  await expect(offer).toContainText("“make the rivals a little slower”: +1 ramen kiosk · re-proved on a copy", { timeout: 120_000 });
  expect(asked).toEqual(["make the rivals a little slower"]);
  // offered, not applied: the world on screen is the one it was
  expect((await probe(page)).specHash).toBe(spec0);
  await page.getByTestId("note-accept").click();
  const box = page.getByTestId("edit-box");
  await expect(box).toContainText("“make the rivals a little slower”");
  await expect(box).toContainText("+1 ramen kiosk");
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 90_000 });
  await expect(page.getByTestId("edit-delta")).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await probe(page)).specHash).not.toBe(spec0);
  await page.getByTestId("edit-undo").click();
  await expect.poll(async () => (await probe(page)).specHash, { timeout: 30_000 }).toBe(spec0);
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});

test("the Host flies to the moment it cites: the camera goes to the place, the replay plays from a second before it, and Esc hands control back", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  let asked: { question?: string; facts?: string[] } = {};
  await live(page);
  await page.route("**/v1/host", (r) => {
    asked = r.request().postDataJSON() as typeof asked;
    return r.fulfill({ json: { answer: "Rival 1 ran the orb home three times while you waited.", cites: [2, 1] } });
  });
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  // stand still: the rivals carry the orb home three times
  const result = page.getByTestId("result");
  await expect(result).toContainText("You lose", { timeout: 120_000 });
  const ended = (await probe(page)).tick ?? 0;
  await expect(page.getByTestId("why-chips").getByRole("button")).toHaveText(["Why did I lose?", "Where did I waste time?", "What did the AI do differently?"]);
  await page.getByTestId("why-chips").getByRole("button", { name: "Why did I lose?" }).click();
  await expect(page.getByTestId("host-answer")).toContainText("Rival 1 ran the orb home three times while you waited.");
  expect(asked.question).toBe("Why did I lose?");
  // fact 2 is the moment: blue's third point, scored in blue's goal ring
  expect(asked.facts?.[1]).toMatch(/Rival 1 carried the glowing orb into the neon goal ring, 3 times/);
  const goal = [26, 1.5, 0];
  await page.waitForFunction(() => window.__GHOSTRUN__.shot !== undefined, null, { timeout: 5_000 });
  const from = (await probe(page)).shot!.cam;
  expect((await probe(page)).shot!.to).toEqual(goal);
  // about 1.2 s later it is there, framing the goal ring from close by
  await page.waitForFunction(() => window.__GHOSTRUN__.shot?.arrived === true, null, { timeout: 5_000 });
  const there = (await probe(page)).shot!.cam;
  expect(dist(there, goal)).toBeLessThan(12);
  expect(dist(there, from)).toBeGreaterThan(2);
  // and the moment replays from a second before it, under the held shot
  await expect(page.getByRole("status").filter({ hasText: "Replaying from" })).toContainText("Esc or any key takes over", { timeout: 20_000 });
  const moment = (await probe(page)).tick ?? 0;
  expect(moment).toBeGreaterThan(ended - 600);
  expect(dist((await probe(page)).shot!.cam, goal)).toBeLessThan(12);
  // Esc: the camera and the run are yours again, from where the replay got to
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__GHOSTRUN__.shot === undefined, null, { timeout: 5_000 });
  await expect(page.getByRole("status").filter({ hasText: "Replaying from" })).toHaveCount(0, { timeout: 5_000 });
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});
