// The HUD in the world's language: a Czech world from the gallery brings a Czech HUD (machine-
// translated, and labelled so), the receipt counts in Czech ("k z n", never a percentage), and the
// language chip switches back to English and remembers it.
import { expect, test } from "@playwright/test";

const CZECH = "ud-lej-mi-bludi-t-s-duchy-a-kl-em-od-v-c";

test("i18n: a Czech gallery world gets a Czech HUD, and the chip switches it to English", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("lang-select")).toHaveValue("en");
  await expect(page.getByTestId("lang-note")).toHaveCount(0);

  const before = await page.evaluate(() => window.__GHOSTRUN__.specHash);
  await page.keyboard.press("KeyG");
  await page.getByTestId(`gallery-${CZECH}`).click();
  await page.waitForFunction((h) => window.__GHOSTRUN__.ready && window.__GHOSTRUN__.specHash !== undefined && window.__GHOSTRUN__.specHash !== h, before, { timeout: 60_000 });

  // the world's language is the HUD's, and it says it was machine-translated
  await expect(page.getByTestId("lang-select")).toHaveValue("cs");
  await expect(page.getByTestId("lang-note")).toContainText("strojově přeloženo, nezkontrolováno");
  await expect(page.locator("html")).toHaveAttribute("lang", "cs");
  await expect(page.getByTestId("key-hint")).toContainText("doklad");

  // the receipt, once the AI runners are done: Czech words, counts as "k z n"
  await expect(page.getByTestId("proof-badge")).not.toContainText("…", { timeout: 90_000 });
  await page.keyboard.press("KeyP");
  const receipt = page.getByTestId("receipt");
  await expect(receipt).toContainText("Doklad");
  await expect(receipt).toContainText(/\d+ z \d+/);
  await expect(receipt).toContainText("Proč tomu věřit?");
  await expect(receipt).not.toContainText(" of 12");

  // English, chosen with the chip: the receipt and the badge change at once, and the choice is kept
  await page.getByTestId("lang-select").selectOption("en");
  await expect(receipt).toContainText("Receipt");
  await expect(receipt).toContainText("Why trust this?");
  await expect(page.getByTestId("lang-note")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(await page.evaluate(() => localStorage.getItem("ghostrun.lang"))).toBe("en");
  expect(errors).toEqual([]);
});
