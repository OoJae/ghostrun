// Flying, swimming and floating: a held Space lifts you on a jetpack over the floating islands with
// the fuel bar showing, a held C takes you under the lagoon with the breath bar running down, and
// in zero-g a held Space thrusts you straight up. Each world says what Space and C do there.
import { expect, test, type Page } from "@playwright/test";

const SHOTS = process.env.FLIGHT_SHOTS ?? "";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const pos = (page: Page): Promise<[number, number, number]> => page.evaluate(() => window.__GHOSTRUN__.player ?? [0, 0, 0]);

async function open(page: Page, fixture: string) {
  await page.goto(`/?fixture=${fixture}&gl=webgl2&fx=0&dpr=0.5&prewarm=0&clip=0`);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true && Array.isArray(window.__GHOSTRUN__.player), null, { timeout: 90_000 });
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test("flight: a jetpack climbs on a held Space with its fuel bar, a held C dives under the lagoon with the breath bar, zero-g thrusts up", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);

  // ---- the floating islands: hold Space and the jetpack climbs, burning fuel ----
  await open(page, "jetpack");
  await expect(page.getByTestId("moves-hint")).toContainText("fly up");
  await expect(page.getByTestId("moves-hint")).toContainText("dive");
  await expect(page.getByTestId("fuel")).toHaveCount(0); // standing on the launch isle, the tank full
  await expect.poll(async () => (await pos(page))[1], { timeout: 10_000 }).toBeLessThan(1.5); // landed
  const y0 = (await pos(page))[1];
  await page.keyboard.down("Space");
  await expect.poll(async () => (await pos(page))[1], { timeout: 10_000, intervals: [50] }).toBeGreaterThan(y0 + 2);
  const fuel = page.getByTestId("fuel");
  await expect(fuel).toBeVisible();
  await expect.poll(async () => Number(await fuel.getAttribute("aria-valuenow")), { timeout: 5_000 }).toBeLessThan(100);
  await shot(page, "flight-jetpack");
  await page.keyboard.up("Space");

  // ---- the lagoon: walk off the beach into the water, hold C, and the breath runs down ----
  await open(page, "lagoon");
  await expect(page.getByTestId("moves-hint")).toContainText("swim up");
  await page.keyboard.down("KeyW"); // the spawn faces the treasure, out over the water
  await expect.poll(async () => (await pos(page))[2], { timeout: 15_000, intervals: [50] }).toBeGreaterThan(2);
  await page.keyboard.up("KeyW");
  await expect(page.getByTestId("breath")).toHaveCount(0); // swimming at the surface: breathing
  await page.keyboard.down("KeyC");
  await expect.poll(async () => (await pos(page))[1], { timeout: 10_000, intervals: [50] }).toBeLessThan(-2);
  const breath = page.getByTestId("breath");
  await expect(breath).toBeVisible();
  await expect.poll(async () => Number(await breath.getAttribute("aria-valuenow")), { timeout: 5_000 }).toBeLessThan(100);
  await shot(page, "flight-lagoon");
  await page.keyboard.up("KeyC");

  // ---- zero-g: hold Space and the thrusters push you straight up ----
  await open(page, "zero-g");
  await expect(page.getByTestId("moves-hint")).toContainText("up");
  await expect(page.getByTestId("moves-hint")).toContainText("down");
  const z0 = await pos(page);
  await page.keyboard.down("Space");
  await expect.poll(async () => (await pos(page))[1], { timeout: 10_000, intervals: [50] }).toBeGreaterThan(z0[1] + 1.5);
  await page.keyboard.up("Space");
  await expect(page.getByTestId("fuel")).toHaveCount(0); // the zero-g law's thrust needs no tank
  await shot(page, "flight-zero-g");

  expect(errors).toEqual([]);
});
