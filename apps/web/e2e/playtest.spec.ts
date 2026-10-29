// The playtest in the browser: the receipt turns green on the experts' runs as it always did, then
// novice and average runners play the same world in the proof worker and the receipt grows the
// difficulty band and what the AI runners revealed, with the heat map over the ground.
import { expect, test, type Page } from "@playwright/test";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test("what the AI runners revealed: the difficulty band lands after the receipt, with a heat map in the overview", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("12 of 12 AI runners won");
  await page.keyboard.press("KeyP");
  // the same seeded runs as in Node: the band reads the same on every runtime
  const band = page.getByTestId("band");
  await expect(band).toContainText("Difficulty: Hard: novices 0 of 6 · average 2 of 6 · experts 12 of 12", { timeout: 90_000 });
  await expect(band).toHaveAttribute("title", "physics, 24 AI runners at 3 skill levels");
  const revealed = page.getByTestId("revealed");
  await expect(revealed).toContainText("What the AI runners revealed");
  await expect(revealed).toContainText("Clear times: median 0:43");
  await expect(page.getByTestId("routes")).toContainText("24 AI runs");
  await expect(page.getByTestId("fails")).toContainText("blue reached 3");
  await expect(page.getByTestId("pace")).toContainText("glowing orb at 0:07 · neon goal ring at 0:11 (22 of 24) · won at 0:43 (14 of 24)");
  // fewer than 30 runs: k of n, never a percentage
  for (const id of ["band", "fails", "pace"]) await expect(page.getByTestId(id)).not.toContainText("%");
  // the overview: the experts' routes over the heat map of every run
  await page.getByTestId("routes-toggle").click();
  await page.waitForFunction(() => (window.__GHOSTRUN__.overview?.heat ?? 0) > 20, null, { timeout: 5_000 });
  expect((await page.evaluate(() => window.__GHOSTRUN__.overview))?.routes).toBe(12);
  await page.getByTestId("routes-toggle").click();
  await page.waitForFunction(() => window.__GHOSTRUN__.overview === undefined, null, { timeout: 5_000 });
  expect(errors).toEqual([]);
});
