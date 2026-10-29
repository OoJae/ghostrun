// Models over the primitives: once a world plays, the capsules become KayKit characters that walk
// and jump as you do, and things become props by their noun; ?models=0 keeps every capsule and
// never fetches a model. Cosmetic only, so the proof still verifies with the models on.
import { expect, test, type Page } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const models = (page: Page) => page.evaluate(() => window.__GHOSTRUN__.models);

test("models: the zombie yard swaps its capsules for characters and props, and ?models=0 keeps the capsules", async ({ page }) => {
  const errors = collectErrors(page);
  const fetched: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/models/")) fetched.push(r.url());
  });

  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&fixture=zombies");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  // the first frame never waits on a model: they arrive after it, you and the five zombies first
  await page.waitForFunction(() => (window.__GHOSTRUN__.models?.characters ?? 0) >= 6, null, { timeout: 30_000 });
  await page.waitForFunction(() => (window.__GHOSTRUN__.models?.props ?? 0) >= 2, null, { timeout: 15_000 });
  const m = (await models(page))!;
  expect(m.tier).toBe("full");
  expect(m.failed).toBe(0);
  expect(fetched.some((u) => u.endsWith("/models/knight.glb"))).toBe(true);
  expect(fetched.some((u) => u.endsWith("/models/skeleton.glb"))).toBe(true);
  expect(fetched.some((u) => u.endsWith("/models/anims.glb"))).toBe(true);
  await page.waitForFunction(() => window.__GHOSTRUN__.models?.player === "idle", null, { timeout: 5_000 });

  // the body follows the capsule: walking plays the walk and run, a jump leaves the ground
  await page.keyboard.down("KeyW");
  await page.waitForFunction(() => window.__GHOSTRUN__.models?.player === "move", null, { timeout: 5_000 });
  await page.keyboard.press("Space");
  await page.waitForFunction(() => window.__GHOSTRUN__.models?.player === "air", null, { timeout: 5_000 });
  await page.keyboard.up("KeyW");
  await page.waitForFunction(() => window.__GHOSTRUN__.models?.player === "idle", null, { timeout: 8_000 });
  await page.screenshot({ path: resolve(here, "__screenshots__/models-on.png") });
  // the world still proves exactly as it would without them
  await expect(page.getByTestId("proof-badge")).toContainText("verified", { timeout: 60_000 });
  expect(errors).toEqual([]);

  // ?models=0: no layer, no fetch, the capsules stay
  fetched.length = 0;
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&fixture=zombies&models=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await page.waitForTimeout(2500);
  expect(await models(page)).toBeUndefined();
  expect(fetched).toEqual([]);
  await page.screenshot({ path: resolve(here, "__screenshots__/models-off.png") });
  expect(errors).toEqual([]);
});
