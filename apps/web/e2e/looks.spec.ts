// Looks across worlds: recorded fixtures and gallery worlds each boot, render without an error,
// and leave a screenshot plus their frame cadence and draw calls (LOOKS_SHOTS picks where the
// screenshots go; by default next to the smoke suite's, regenerated every run).
import { expect, test, type Page } from "@playwright/test";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.LOOKS_SHOTS ?? resolve(here, "__screenshots__/looks");
const GL = process.env.LOOKS_GL ?? "webgl2";
// LOOKS_GPU=1: the real GPU (Metal through ANGLE) with vsync off, so frame times are the frame's cost
// rather than headless Chromium's software rasteriser or the display's refresh
const GPU = process.env.LOOKS_GPU === "1";
const DPR = process.env.LOOKS_DPR ? `&dpr=${process.env.LOOKS_DPR}` : "";
if (GPU) test.use({ launchOptions: { args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-vsync", "--disable-frame-rate-limit"] } });

const FIXTURES = ["ctf", "forest", "heist", "vault", "parkour", "coin-rush"];
const GALLERY = [
  "race-through-a-desert-canyon-hitting-eve",
  "collect-seashells-on-a-sunny-beach-befor",
  "a-snowy-mountain-race-with-checkpoints-a",
  "feed-the-penguins-bring-a-fish-to-each-o",
  "sammle-alle-kristalle-in-der-eish-hle-un",
  "a-space-station-flip-the-three-breakers-",
  "low-gravity-moon-base-bounce-between-the",
  "zero-g-basketball-on-a-space-station",
  "a-haunted-mansion-where-ghosts-chase-you",
  "ud-lej-mi-bludi-t-s-duchy-a-kl-em-od-v-c",
  "a-medieval-castle-siege-open-the-gate-so",
  "a-wizard-school-brew-the-potion-from-thr",
  "a-lighthouse-on-a-stormy-cliff-climb-to-",
  "a-candy-factory-sort-the-sweets-into-the",
  "a-circus-big-top-bounce-on-the-trampolin",
  "a-pressure-plate-puzzle-temple-with-crum",
  "a-japanese-tea-house-in-the-rain",
  "a-cozy-coffee-shop-where-you-can-order-a",
  "a-library-maze-where-you-find-the-secret",
  "a-3-versus-3-soccer-match-on-a-rooftop-a",
  "a-garden-hedge-maze-with-a-minotaur-hunt",
  "an-aquarium-tunnel-with-sharks-and-rays-",
];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Frame intervals over two seconds of play (ms): the median and the 95th percentile. */
async function cadence(page: Page) {
  const dts = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const out: number[] = [];
        let last = performance.now();
        const t0 = last;
        const tick = (now: number) => {
          out.push(now - last);
          last = now;
          if (now - t0 < 2000) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  dts.sort((a, b) => a - b);
  const at = (q: number) => Math.round(dts[Math.min(dts.length - 1, Math.floor(dts.length * q))]! * 10) / 10;
  return { median: at(0.5), p95: at(0.95) };
}

async function shoot(page: Page, name: string) {
  // a step forward folds the HUD away, then the view settles
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(350);
  await page.keyboard.up("KeyW");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: resolve(OUT, `${name}.png`) });
  const frame = await cadence(page);
  const p = await page.evaluate(() => ({ ...window.__GHOSTRUN__ }));
  const line = JSON.stringify({ name, look: (p as { look?: string }).look, backend: p.backend, fps: p.fps, drawCalls: p.drawCalls, pixelRatio: p.pixelRatio, ...frame });
  console.log(`[looks] ${line}`);
  appendFileSync(resolve(OUT, "metrics.jsonl"), `${line}\n`);
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

for (const fx of FIXTURES) {
  test(`looks: fixture ${fx}`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/?gl=${GL}&prewarm=0&fixture=${fx}${DPR}`);
    await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
    await shoot(page, `fixture-${fx}`);
    expect(errors).toEqual([]);
  });
}

test("looks: gallery worlds", async ({ page }) => {
  test.setTimeout(600_000);
  const errors = collectErrors(page);
  await page.goto(`/?gl=${GL}&prewarm=0${DPR}`);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  for (const slug of GALLERY) {
    const before = await page.evaluate(() => window.__GHOSTRUN__.specHash);
    await page.keyboard.press("KeyG");
    await page.getByTestId(`gallery-${slug}`).click();
    await page.waitForFunction((h) => window.__GHOSTRUN__.ready && window.__GHOSTRUN__.specHash !== undefined && window.__GHOSTRUN__.specHash !== h, before, { timeout: 60_000 });
    await shoot(page, `gallery-${slug.slice(0, 32)}`);
  }
  expect(errors).toEqual([]);
});
