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
  await page.goto("/?gl=webgl2&prewarm=0");
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
  await page.goto(`/?gl=webgl2&fx=0&dpr=0.5&prewarm=0${sim === "stub" ? "&sim=stub" : ""}`); // low-res, no background prewarm: keep key timing tight
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

  // Two jumps: up onto the lane (feet at 2.6 m → capsule centre at 3.5 m). The second press has to
  // land while airborne; under a slow software-GL frame it can arrive late, so allow three tries.
  let onLane = false;
  for (let attempt = 0; attempt < 3 && !onLane; attempt++) {
    await page.keyboard.press("Space");
    await until(() => window.__GHOSTRUN__.player![1] > 2.0);
    await page.keyboard.press("Space");
    onLane = await until(() => {
      const q = window.__GHOSTRUN__.player!;
      return q[2] > 8.3 && Math.abs(q[1] - 3.5) < 0.05;
    }, 4_000).then(() => true, () => false);
    if (!onLane) await until(() => Math.abs(window.__GHOSTRUN__.player![1] - 0.9) < 0.05); // back on the street
  }
  expect(onLane).toBe(true);
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

// Looks are cosmetic but must never break a world: grove (night forest) and gallery (cutaway interior).
for (const [fx, look] of [["forest", "grove"], ["heist", "gallery"]] as const) {
  test(`look: ${look} boots, proves and renders (${fx})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/?gl=webgl2&fixture=${fx}`);
    await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
    await page.waitForFunction(() => window.__GHOSTRUN__?.proof !== undefined, null, { timeout: 90_000 });
    await page.keyboard.press("KeyW");
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(here, `__screenshots__/look-${look}.png`) });
    expect(errors).toEqual([]);
  });
}

test.describe("phone controls", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("the touch stick walks and the Jump button jumps", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/?gl=webgl2&fx=0&dpr=0.5&touch=1&prewarm=0");
    await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
    await expect(page.getByTestId("touch")).toBeVisible();
    const p0 = (await probe(page)).player!;
    const zone = page.locator(".stick-zone");
    const touch = { pointerType: "touch", pointerId: 7, isPrimary: true, bubbles: true };
    await zone.dispatchEvent("pointerdown", { ...touch, clientX: 100, clientY: 640 });
    await zone.dispatchEvent("pointermove", { ...touch, clientX: 100, clientY: 570 }); // push forward
    await page.waitForFunction((x0) => (window.__GHOSTRUN__.player?.[0] ?? x0) > x0 + 2, p0[0], { timeout: 10_000 });
    await zone.dispatchEvent("pointerup", { ...touch, clientX: 100, clientY: 570 });
    const y0 = (await probe(page)).player![1];
    const jump = page.locator(".tbtn.jump");
    await jump.dispatchEvent("pointerdown", { ...touch, pointerId: 8 });
    await page.waitForFunction((y) => (window.__GHOSTRUN__.player?.[1] ?? y) > y + 0.4, y0, { timeout: 5_000 });
    await jump.dispatchEvent("pointerup", { ...touch, pointerId: 8 });
    await zone.dispatchEvent("pointerdown", { ...touch, pointerId: 9, clientX: 110, clientY: 650 });
    await zone.dispatchEvent("pointermove", { ...touch, pointerId: 9, clientX: 135, clientY: 615 });
    await page.screenshot({ path: resolve(here, "__screenshots__/phone.png") });
    await zone.dispatchEvent("pointerup", { ...touch, pointerId: 9, clientX: 135, clientY: 615 });
    expect(errors).toEqual([]);
  });
});

test("Logic X-ray: X shows every rule as WHEN/IF/THEN with its forced-state mark", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("verified", { timeout: 60_000 });
  await page.keyboard.press("KeyX");
  const xray = page.getByTestId("xray");
  await expect(xray).toBeVisible();
  await expect(xray.locator(".sentence")).toHaveCount(5);
  await expect(xray.locator(".sentence.verified")).toHaveCount(5); // every CTF rule is force-tested green
  await expect(xray).toContainText("glowing orb");
  await page.keyboard.press("KeyX");
  await expect(xray).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("VR (emulated Quest 3): enter VR, the left stick walks, A jumps", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&iwer=1");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await page.getByTestId("enter-vr").click();
  await page.waitForFunction(() => window.__GHOSTRUN__?.vr === true, null, { timeout: 20_000 });
  const p0 = (await probe(page)).player!;
  type Ctl = { updateAxes(id: string, x: number, y: number): void; updateButtonValue(id: string, v: number): void };
  const ctl = (hand: "left" | "right", fn: (c: Ctl) => void) => page.evaluate(({ hand, src }) => {
    const c = (window as unknown as { __IWER__: { controllers: Record<string, Ctl> } }).__IWER__.controllers[hand]!;
    new Function("c", src)(c);
  }, { hand, src: `(${fn.toString()})(c)` });
  await ctl("left", (c) => c.updateAxes("thumbstick", 0, -1)); // push forward
  await page.waitForFunction(([x0, z0]) => {
    const p = window.__GHOSTRUN__.player!;
    return Math.hypot(p[0] - x0!, p[2] - z0!) > 2;
  }, [p0[0], p0[2]], { timeout: 10_000 });
  await ctl("left", (c) => c.updateAxes("thumbstick", 0, 0));
  const y0 = (await probe(page)).player![1];
  await ctl("right", (c) => c.updateButtonValue("a-button", 1));
  await page.waitForFunction((y) => (window.__GHOSTRUN__.player?.[1] ?? y) > y + 0.4, y0, { timeout: 5_000 });
  await ctl("right", (c) => c.updateButtonValue("a-button", 0));
  // Emulator artifact, not ours: three picks XR layers support when the renderer is built, before
  // IWER's layers polyfill exists, so it falls back to XRWebGLLayer, whose emulated framebuffer is
  // null (a real headset gives an opaque framebuffer object). Rendering is checked on a real Quest.
  expect(errors.filter((e) => !e.includes("Invalid value used as weak map key"))).toEqual([]);
});

test("result card: a win shows the time against the AI par, and R plays again", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&fixture=heist"); // a recorded world whose win is near the spawn
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  const keys = ["KeyW", "KeyD", "KeyS", "KeyA"];
  for (let i = 0; i < 20 && !(await page.getByTestId("result").count()); i++) {
    await page.keyboard.down(keys[i % 4]!);
    await page.waitForTimeout(900);
    await page.keyboard.up(keys[i % 4]!);
  }
  await expect(page.getByTestId("result")).toContainText("You win");
  await expect(page.getByTestId("result")).toContainText("AI runners");
  await page.keyboard.press("KeyR");
  await expect(page.getByTestId("result")).toHaveCount(0);
  await page.waitForFunction(() => (window.__GHOSTRUN__.tick ?? 999) < 300, null, { timeout: 10_000 });
  expect(errors).toEqual([]);
});
