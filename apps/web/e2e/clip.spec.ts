// Clips of the run: the canvas and the game's sound are recorded while you play, the result card
// previews the last seconds ending at the win and saves them as a file, and Clean replay records
// the run replayed exactly with the HUD hidden.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const clipState = (page: Page) => page.evaluate(() => window.__GHOSTRUN__.clip);
const EBML = "1a45dfa3";

test("clip: a win's card previews its last seconds and Save clip downloads them; Clean replay saves the run replayed with the HUD hidden", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&fixture=heist"); // a recorded world whose win is near the spawn
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__GHOSTRUN__?.proof !== undefined, null, { timeout: 60_000 });
  await page.waitForFunction(() => window.__GHOSTRUN__.clip?.state === "rolling", null, { timeout: 10_000 });
  expect((await clipState(page))!.type).toMatch(/^video\/webm/);
  const keys = ["KeyW", "KeyD", "KeyS", "KeyA"];
  for (let i = 0; i < 24 && !(await page.getByTestId("result").count()); i++) {
    await page.keyboard.down(keys[i % 4]!);
    await page.waitForTimeout(900);
    await page.keyboard.up(keys[i % 4]!);
  }
  const result = page.getByTestId("result");
  await expect(result).toContainText("You win");
  // the recording stops a moment after the win; the card plays the clip back, muted and looping
  const preview = page.getByTestId("clip-preview");
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => preview.evaluate((v: HTMLVideoElement) => (v.muted && v.loop ? v.duration : -1)), { timeout: 10_000 }).toBeGreaterThan(1);
  await expect.poll(() => preview.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0);
  expect((await clipState(page))!.state).toBe("off");
  await expect(page.getByTestId("save-clip")).toContainText(/Save clip · \d+(\.\d)? s/);

  const [saved] = await Promise.all([page.waitForEvent("download"), page.getByTestId("save-clip").click()]);
  expect(saved.suggestedFilename()).toMatch(/^ghostrun-museum-heist-0-\d\d\.webm$/);
  const file = readFileSync((await saved.path())!);
  expect(file.length).toBeGreaterThan(2000);
  expect(file.subarray(0, 4).toString("hex")).toBe(EBML);

  // the clean take: the same run replayed exactly, nothing on screen but the world, saved whole
  const take = page.waitForEvent("download", { timeout: 90_000 });
  await page.getByTestId("clip-take").click();
  await expect(result).toHaveCount(0);
  await expect(page.locator("body")).toHaveClass(/clip-take/);
  await expect(page.getByTestId("proof-badge")).toBeHidden();
  await page.waitForFunction(() => window.__GHOSTRUN__.clip?.state === "take", null, { timeout: 10_000 });
  const replay = await take;
  expect(replay.suggestedFilename()).toMatch(/^ghostrun-museum-heist-0-\d\d-replay\.webm$/);
  const whole = readFileSync((await replay.path())!);
  expect(whole.subarray(0, 4).toString("hex")).toBe(EBML);
  // the same win on the same card, with the HUD back
  await expect(result).toContainText("You win");
  await expect(page.locator("body")).not.toHaveClass(/clip-take/);
  await expect(page.getByTestId("proof-badge")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Saved the clean replay" })).toBeVisible();
  expect(errors).toEqual([]);
});
