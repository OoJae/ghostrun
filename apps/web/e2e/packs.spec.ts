// The four newer layout packs in the browser: each hand-written world opens on its own pack,
// draws, and the AI runners come back with a green receipt (12 of 12 won, or every thing toured).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

for (const [fx, pack, look, headline] of [
  ["cafe", "service_venue", "home", "Both orders can be served before closing: verified · 12 of 12 AI runners won"],
  ["escape", "puzzle_rooms", "gallery", "Each room's puzzle opens the way on, out to the courtyard: verified · 12 of 12 AI runners won"],
  ["concert", "stage", "gallery", "From the street to backstage, up the stage stairs, every corner can be visited: verified"],
  ["solar", "orrery", "space/moon", "Every planet's stamp, out to Neptune, before the planetarium closes: verified · 12 of 12 AI runners won"],
] as const) {
  test(`pack ${pack}: ?fixture=${fx} opens in its look and proves green`, async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    await page.goto(`/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&clip=0&fixture=${fx}`);
    await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
    expect(await page.evaluate(() => window.__GHOSTRUN__.look)).toBe(look);
    const badge = page.getByTestId("proof-badge");
    await expect(badge).toContainText(headline, { timeout: 120_000 });
    await expect(badge).toHaveClass(/\bgood\b/);
    await page.screenshot({ path: resolve(here, `__screenshots__/pack-${fx}.png`) });
    expect(errors).toEqual([]);
  });
}
