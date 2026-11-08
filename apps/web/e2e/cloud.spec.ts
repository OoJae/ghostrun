// The cloud proof beside the device's, with POST /v1/proof mocked: answered with this device's own
// receipt (as the edge would answer, the simulation being the same everywhere), the receipt says it
// was proved in the cloud with the same result here, whichever came first, and labels every chip with
// where it was proved; answered with another result, it says so and keeps this device's.
import { expect, test, type Page, type Route } from "@playwright/test";

type Receipt = { host: string; playtest?: unknown; par: { goldS: number } | null; chips: unknown[] };
const URL0 = "/?gl=webgl2&fx=0&dpr=0.5&prewarm=0";

async function edge(page: Page, answer: (route: Route) => Promise<void>) {
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: false, gate: "dev", sitekey: null, proof: true, canary: null } }));
  await page.route("**/v1/proof", answer);
}

/** The edge's answer: the receipt, then its playtest, as server-sent events. */
function sse(route: Route, r: Receipt) {
  const { playtest, ...bare } = r;
  const version = (route.request().postDataJSON() as { version: string }).version;
  const body = [`event: proving\ndata: {}\n\n`, `event: receipt\ndata: ${JSON.stringify({ receipt: { ...bare, host: "edge" }, version, cached: null })}\n\n`, `event: playtest\ndata: ${JSON.stringify({ playtest: playtest ?? null })}\n\n`, `event: done\ndata: {}\n\n`].join("");
  return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body });
}

const deviceReceipt = (page: Page) => page.waitForFunction(() => window.__GHOSTRUN__?.deviceReceipt, null, { timeout: 180_000 }).then((h) => h.jsonValue() as Promise<Receipt>);

test("the cloud proof: proved in the cloud, the same result on this device, every chip labelled with where it ran", async ({ page }) => {
  test.setTimeout(420_000);
  // first the device proves alone while the edge is still working (the request held open), then the edge answers alike
  let release: (r: Receipt) => void = () => {};
  const held = new Promise<Receipt>((r) => (release = r));
  await edge(page, async (route) => sse(route, await held));
  await page.goto(URL0);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 120_000 });
  await page.keyboard.press("KeyP");
  const where = page.getByTestId("receipt-where");
  await expect(where).toHaveText("proved on your device · the cloud is proving it too");
  await expect(page.getByTestId("receipt").locator(":scope > ul > li").first()).toContainText(", on your device)");
  const mine = await deviceReceipt(page);
  release(mine);
  await expect(where).toHaveText("proved in the cloud · same result on this device", { timeout: 30_000 });
  expect(await page.evaluate(() => window.__GHOSTRUN__.cloud?.verdict)).toBe("same");

  // then the edge answers first (its stored receipt): the cloud's fills the receipt while this device checks it
  await page.unroute("**/v1/proof");
  await page.route("**/v1/proof", (route) => sse(route, mine));
  await page.reload();
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await page.keyboard.press("KeyP");
  await expect(where).toHaveText("proved in the cloud · this device is checking it…", { timeout: 60_000 });
  const chips = page.getByTestId("receipt").locator(":scope > ul > li");
  expect(await chips.count()).toBe(mine.chips.length);
  for (const t of await chips.allTextContents()) expect(t).toContain(", in the cloud)");
  await expect(page.getByTestId("receipt")).toContainText("in the cloud");
  await expect(where).toHaveText("proved in the cloud · same result on this device", { timeout: 240_000 });
});

test("the cloud proof: a different result is said plainly, and this device's is the one kept", async ({ page }) => {
  test.setTimeout(300_000);
  let mine: Receipt | null = null;
  // the edge answers once this device is done, with a par a tenth of a second off
  await edge(page, async (route) => {
    while (!mine) await new Promise((r) => setTimeout(r, 200));
    await sse(route, { ...mine, par: mine.par ? { ...mine.par, goldS: mine.par.goldS + 0.1 } : null });
  });
  await page.route("**/v1/wrong", (r) => r.fulfill({ status: 201, json: { ok: true, id: "x" } }));
  await page.goto(URL0);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  mine = await deviceReceipt(page);
  await page.keyboard.press("KeyP");
  const where = page.getByTestId("receipt-where");
  await expect(where).toContainText("the cloud and this device got different results (cloud ", { timeout: 30_000 });
  await expect(where).toContainText("showing this device's");
  const v = await page.evaluate(() => window.__GHOSTRUN__.cloud);
  expect(v?.verdict).toBe("different");
  expect(v?.device).not.toBe(v?.cloud);
  await expect(page.getByTestId("receipt").locator(":scope > ul > li").first()).toContainText(", on your device)");
  await expect(page.getByTestId("receipt")).toContainText(`AI par ${mine.par!.goldS} s`);
});
