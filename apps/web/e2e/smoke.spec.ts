// Walking-skeleton smoke test: the organizer's CTF brief renders, the player walks and jumps,
// and nothing logs an error. The WebGL2 fallback is forced (?gl=webgl2) because that is the path
// headless Chromium and Safari-class devices take; a second test boots the automatic choice.
import { expect, test, type Page } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SHOT = resolve(here, "__screenshots__/ctf.png");

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const probe = (page: Page) => page.evaluate(() => ({ ...window.__GHOSTRUN__ }));

test("CTF brief renders, walks and jumps on the WebGL2 path", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });

  const start = await probe(page);
  expect(start.backend).toBe("webgl2");
  expect(start.sim).toBe("rapier");
  expect(start.player).toBeDefined();
  await expect(page.getByTestId("intent-card")).toContainText("Rooftop lane needs double jump");
  await expect(page.getByTestId("prompt-bar")).toContainText("fixture");
  // The device proof worker plays the world while the judge does; the badge turns green only on evidence.
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("12 of 12 AI runners won");
  expect((await probe(page)).proof?.headline).toBe("verified");

  // Walk forward (the spawn faces the orb on the plaza, +x) for one second.
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(1000);
  await page.keyboard.up("KeyW");
  await page.waitForFunction((x0) => (window.__GHOSTRUN__.player?.[0] ?? x0) > x0 + 2, start.player![0], { timeout: 5_000 });

  // The cast plays too: the rivals leave their spawn pad for the orb.
  await page.waitForFunction(() => {
    const r = window.__GHOSTRUN__.cast?.rival_1;
    return r !== undefined && r[0] < 30;
  }, null, { timeout: 10_000 });

  // Jump: the capsule leaves the ground.
  const y0 = (await probe(page)).player![1];
  await page.keyboard.press("Space");
  await page.waitForFunction((y) => (window.__GHOSTRUN__.player?.[1] ?? y) > y + 0.4, y0, { timeout: 5_000 });

  // First input collapses the prompt bar into the pill (≤ 3 HUD elements during play).
  await expect(page.getByTestId("prompt-pill")).toBeVisible();
  await expect(page.getByTestId("intent-card")).toHaveCount(0);

  await page.screenshot({ path: SHOT });

  // Let the fps window fill (it samples once per second).
  await page.waitForTimeout(2200);
  const end = await probe(page);
  expect(end.specHash).toMatch(/^[0-9a-f]{64}$/);
  console.log(`[ghostrun] webgl2 ${JSON.stringify({ fps: end.fps, backend: end.backend, ttffMs: end.ttffMs, drawCalls: end.drawCalls, pixelRatio: end.pixelRatio, player: end.player, specHash: end.specHash })}`);
  expect(errors).toEqual([]);
});

// The same human-controls choreography on both simulations: Rapier (the product) and the stub
// (the fallback if the physics wasm fails to load).
for (const sim of ["rapier", "stub"] as const) test(`headline: the rooftop ledge needs a double jump (${sim} physics)`, async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto(`/?gl=webgl2&fx=0&dpr=0.5${sim === "stub" ? "&sim=stub" : ""}`); // low-res: keep software-GL frames short so key timing is tight
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  const at = () => probe(page).then((p) => p.player!);
  const until = (fn: () => boolean, timeout = 15_000) => page.waitForFunction(fn, null, { polling: 16, timeout });

  // From sp_red walk east under the first rooftop segment (x ∈ [-22, -9]), then strafe north into its face (z = 8).
  await page.keyboard.down("KeyW");
  await until(() => window.__GHOSTRUN__.player![0] >= -16);
  await page.keyboard.up("KeyW");
  await page.keyboard.down("KeyD");
  await until(() => window.__GHOSTRUN__.player![2] > 7.5);
  await page.waitForTimeout(300);
  let p = await at();
  expect(p[2]).toBeLessThan(8);
  expect(p[1]).toBeCloseTo(0.9, 1);

  // One jump: apex 1.6 m < 2.6 m ledge, back on the street.
  await page.keyboard.press("Space");
  await until(() => window.__GHOSTRUN__.player![1] > 1.6);
  await until(() => Math.abs(window.__GHOSTRUN__.player![1] - 0.9) < 0.03);
  p = await at();
  expect(p[2]).toBeLessThan(8);

  // Two jumps: up onto the lane (feet at 2.6 m → capsule centre at 3.5 m).
  await page.keyboard.press("Space");
  await until(() => window.__GHOSTRUN__.player![1] > 2.2);
  await page.keyboard.press("Space");
  await until(() => {
    const q = window.__GHOSTRUN__.player!;
    return q[2] > 8.3 && Math.abs(q[1] - 3.5) < 0.05;
  });
  await page.keyboard.up("KeyD");
  expect(errors).toEqual([]);
});

test("automatic backend selection boots cleanly and Enter re-runs the pipeline", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await page.waitForTimeout(2200);
  const p = await probe(page);
  expect(["webgpu", "webgl2"]).toContain(p.backend);
  if (p.backend === "webgpu") await page.screenshot({ path: resolve(here, "__screenshots__/ctf-webgpu.png") });
  console.log(`[ghostrun] auto ${JSON.stringify({ fps: p.fps, backend: p.backend, ttffMs: p.ttffMs, drawCalls: p.drawCalls })}`);

  // Enter in the prompt bar rebuilds the world: the sim restarts from tick 0 and the hash is stable.
  await page.getByLabel("Describe a world").press("Enter");
  await page.waitForFunction((t) => window.__GHOSTRUN__.ready && (window.__GHOSTRUN__.tick ?? t) < t, p.tick!, { timeout: 30_000 });
  await page.waitForFunction((h) => window.__GHOSTRUN__.specHash === h, p.specHash!, { timeout: 10_000 });
  expect(errors).toEqual([]);
});

test("kit verbs: coin rush proves green and walking over a coin scores", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&fixture=coin-rush");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("All 5 coins before the clock runs out: verified", { timeout: 60_000 });
  await expect(page.getByTestId("score")).toContainText("SCORE 0");
  // coin_1 sits on the midfield line ahead of the spawn
  await page.keyboard.down("KeyW");
  await expect(page.getByTestId("score")).toContainText("SCORE 1", { timeout: 15_000 });
  await page.keyboard.up("KeyW");
  expect(errors).toEqual([]);
});
