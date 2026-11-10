// The two tiers after the playtest in the browser: T3h (the experts' plan through the player's keys
// and the follow camera) lands as its own chips, and T4 (the route model) as lines that each say
// modelled, with its ±, beside the physics runs they can be checked against; never played or
// verified. "Why trust this?" says how each is made and how well it holds up on the bench.
import { expect, test, type Page } from "@playwright/test";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test("T3h's chips and T4's modelled lines land on the receipt after the playtest, and Why trust this? explains both", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("12 of 12 AI runners won", { timeout: 90_000 });
  await page.keyboard.press("KeyP");
  await expect(page.getByTestId("band")).toContainText("Difficulty:", { timeout: 120_000 });

  const human = page.getByTestId("t3h");
  await expect(human).toContainText("The player's controls and camera (T3h)", { timeout: 60_000 });
  const chips = human.locator("li");
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toContainText("[T3h] the camera stays out of walls and ceilings · ");
  await expect(chips.nth(1)).toContainText("[T3h] no stuck frames over 0.5 s with the keys held · ");
  await expect(chips.nth(2)).toContainText("[T3h] nothing traps the player's capsule · ");
  // six runs: k of n, never a percentage
  for (const t of await chips.allTextContents()) {
    expect(t).toMatch(/ · \d of 6 /);
    expect(t).toContain("(physics, 6 runs through the player's keys and camera (noisy synthetic input on the experts' routes), on your device)");
  }

  const model = page.getByTestId("t4");
  await expect(model).toContainText("Route model (T4): modelled, not played");
  const lines = await model.locator("li").allTextContents();
  expect(lines[0]).toMatch(/^~ Win rate, modelled: novices \d+% ±24 \(physics \d of 6\) · average \d+% ±15 \(physics \d of 6\) · experts \d+% ±4 \(physics 12 of 12\)$/);
  expect(lines.some((l) => /^~ Clear times, modelled: median \d:\d\d ±11%/.test(l))).toBe(true);
  for (const l of lines) {
    expect(l.startsWith("~ ")).toBe(true);
    expect(l).toContain("modelled");
    expect(l).not.toMatch(/\b(played|verified)\b/);
  }
  await expect(model).toContainText("route model, 1200 modelled runs, anchored on this world's expert runs; ± is the calibration error on the bench");

  await page.getByTestId("why-trust").click();
  const trust = page.getByTestId("trust");
  await expect(trust).toContainText("T3h the player's controls: the experts' plan played again through the keys and the follow camera");
  await expect(trust).toContainText("T4 route model: the world's route as a graph plays 1200 modelled runs in milliseconds");
  await expect(trust).toContainText("held-out bench worlds (win rate ±24 novices, ±15 average players; clear time ±11%)");
  expect(errors).toEqual([]);
});
