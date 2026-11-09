// The permanent AI label (AI Act Art. 50) sits beside the wordmark from the first frame and links
// to the privacy page, which is a page of its own, not the app.
import { expect, test } from "@playwright/test";

test("the AI label is always on the prompt bar and opens the privacy page", async ({ page }) => {
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&models=0");
  const label = page.getByTestId("ai-label");
  await expect(label).toBeVisible({ timeout: 60_000 });
  await expect(label).toHaveText("AI-made");
  await expect(label).toHaveAttribute("href", "/privacy");

  const res = await page.request.get("/privacy");
  expect(res.ok()).toBe(true);
  const html = await res.text();
  expect(html).toContain("<h1>Privacy and AI</h1>");
  expect(html).toContain("No audio reaches us");
  expect(html).not.toContain('id="root"'); // the page itself, not the app's fallback
});
