// Remix with lineage: a shared world opens with a Remix button; Remix makes it your copy with the
// edit box ready, your edits make it a remix, and its share carries where it came from, so the new
// link shows "Remixed from … · 2 changes: …" with a link to the original and which receipt is
// whose. The edge's share store and the live edit lane are stubbed in the page.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

const probe = (page: Page) => page.evaluate(() => ({ ...window.__GHOSTRUN__ }));
const BOOT = "/?gl=webgl2&fx=0&dpr=0.5&prewarm=0";
const BRIEF = "Create a capture-the-flag game in a neon city. Add double jump. Score when the orb reaches the goal.";

interface Stored {
  specHash: string;
  prompt?: string;
  remixOf?: string;
  origin?: { id: string; prompt: string; spec: string };
  lineage?: { id: string; change: string; name?: string }[];
  changes?: number;
}

/** The edge's share store in memory, behind the same routes and shapes, and the live lane stubbed. */
async function fakeEdge(page: Page) {
  const shares = new Map<string, Stored>();
  let n = 0;
  const sse = (line: string) => `event: op\ndata: ${JSON.stringify({ i: 0, line })}\n\nevent: done\ndata: {"lines":1}\n\n`;
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  await page.route("**/v1/repair", (r) => r.fulfill({ contentType: "text/event-stream", body: 'event: error\ndata: {"message":"off in this test"}\n\n' }));
  await page.route("**/v1/director", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  await page.route("**/v1/edit", (r) => {
    const { change } = r.request().postDataJSON() as { change: string };
    return r.fulfill({ contentType: "text/event-stream", body: sse(change.includes("day") ? '{"op":"meta","timeOfDay":12,"weather":"clear"}' : '{"op":"law","player":{"jumpsMax":2,"jumpH":2.2}}') });
  });
  await page.route("**/v1/share", async (r) => {
    const body = r.request().postDataJSON() as Stored;
    const id = `remixaaaaaaaaaa${"abcdefgh"[++n]}`;
    shares.set(id, body);
    await r.fulfill({ status: 201, json: { id, created: true } });
  });
  await page.route(/\/v1\/share\/[a-z2-7]{16}$/, async (r) => {
    const id = r.request().url().split("/").pop()!;
    const s = shares.get(id);
    await (s ? r.fulfill({ json: { id, minds: [], ...s } }) : r.fulfill({ status: 404, json: { error: "not found" } }));
  });
  return shares;
}

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("remix: a shared world opens as your copy, two edits make it a remix, and its link shows where it came from", async ({ page }) => {
  test.setTimeout(360_000); // three worlds and two edits, each proved by its AI runners
  const errors = collectErrors(page);
  const shares = await fakeEdge(page);

  // someone shares the CTF brief's world (the share says its prompt)
  await page.goto(BOOT);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("prompt-bar")).toContainText("live AI");
  await expect(page.getByTestId("proof-badge")).toContainText("verified", { timeout: 60_000 });
  const spec1 = (await probe(page)).specHash!;
  await page.keyboard.press("KeyP");
  await page.getByTestId("share").click();
  await expect(page.getByRole("status").filter({ hasText: "Link copied" })).toBeVisible();
  const [first] = [...shares.keys()];
  expect(shares.get(first!)).toMatchObject({ prompt: BRIEF, specHash: spec1 });
  expect(shares.get(first!)!.lineage).toBeUndefined(); // an original

  // the link: a shared world, with Remix
  await page.goto(`${BOOT}&s=${first}`);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  const lineage = page.getByTestId("lineage");
  await expect(lineage).toContainText("Shared world");
  await expect(lineage).toContainText("Create a capture-the-flag game in a neon city.");
  await page.getByTestId("remix").click();
  await expect(page.getByTestId("edit-input")).toBeFocused();
  await expect(page.getByTestId("edit-input")).toHaveAttribute("placeholder", "Change it: make it yours…");
  await expect(lineage).toContainText("Your copy: your first change makes it a remix.");
  await expect(page.getByTestId("remix")).toHaveCount(0);
  await expect(page.getByTestId("share-remix")).toHaveCount(0); // nothing of yours to share yet
  await expect(page.getByTestId("proof-badge")).toContainText("verified", { timeout: 60_000 }); // your copy, proved here

  // two edits, each re-proved as usual
  await page.keyboard.type("make it day");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("edit-result")).toContainText("now day");
  await expect(page.getByTestId("edit-delta")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("lineage-line")).toContainText("Your remix");
  await expect(page.getByTestId("lineage-line")).toContainText("1 change: “make it day”");
  // the spec is the world's play, not its looks: honest that this one plays the same as the original
  await expect(page.getByTestId("lineage-receipts")).toContainText(`Only the looks changed: it plays the same as the original (both spec ${spec1.slice(0, 8)})`);
  await page.getByTestId("edit-input").fill("higher jumps");
  await page.getByTestId("edit-input").press("Enter");
  await expect(page.getByTestId("edit-result")).toContainText("jump height 1.6 → 2.2 m");
  await expect(page.getByTestId("edit-delta")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("lineage-line")).toContainText("2 changes: “make it day”, “higher jumps”");
  const spec2 = (await probe(page)).specHash!;
  expect(spec2).not.toBe(spec1);
  await expect(page.getByTestId("lineage-receipts")).toContainText(`This version (spec ${spec2.slice(0, 8)})`);
  await expect(page.getByTestId("lineage-receipts")).toContainText(`the original (spec ${spec1.slice(0, 8)}) has its own receipt`);

  // share it: the store gets its line
  await page.getByTestId("share-remix").click();
  await expect(page.getByRole("status").filter({ hasText: "Link copied" })).toBeVisible();
  const second = [...shares.keys()].find((k) => k !== first)!;
  expect(shares.get(second)).toMatchObject({
    specHash: spec2,
    prompt: BRIEF,
    remixOf: first,
    origin: { id: first, prompt: BRIEF, spec: spec1 },
    lineage: [
      { id: first, change: "make it day" },
      { id: first, change: "higher jumps" },
    ],
    changes: 2,
  });

  // the new link: where it came from, a link to the original, and whose receipt is whose
  await page.goto(`${BOOT}&s=${second}`);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  const line = page.getByTestId("lineage-line");
  await expect(line).toContainText("Remixed from “Create a capture-the-flag game in a neon city.");
  await expect(line).toContainText("· 2 changes: “make it day”, “higher jumps”");
  await expect(line).not.toContainText("Your remix");
  await expect(page.getByTestId("lineage-original")).toHaveAttribute("href", `/?s=${first}`);
  await expect.poll(async () => (await probe(page)).specHash).toBe(spec2);
  await expect(page.getByTestId("lineage-receipts")).toContainText(`This version (spec ${spec2.slice(0, 8)})`);
  await expect(page.getByTestId("lineage-receipts")).toContainText(`the original (spec ${spec1.slice(0, 8)})`);
  await page.keyboard.press("KeyP");
  await expect(page.getByTestId("receipt-version")).toContainText(`this receipt is for this version (spec ${spec2.slice(0, 8)}) only; the original (spec ${spec1.slice(0, 8)}) has its own`);
  await page.keyboard.press("KeyP");
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});

test("remix from the gallery: a world opens as your copy with the edit box ready, and ?g= opens a gallery world", async ({ page }) => {
  const errors = collectErrors(page);
  await fakeEdge(page);
  const [entry] = JSON.parse(readFileSync(resolve(here, "../src/gallery/index.json"), "utf8")) as { slug: string; prompt: string }[];
  await page.goto(BOOT);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("prompt-bar")).toContainText("live AI");
  await page.keyboard.press("KeyG");
  await page.getByTestId(`gallery-remix-${entry!.slug}`).click();
  await expect(page.getByTestId("gallery")).toHaveCount(0);
  await expect(page.getByTestId("edit-input")).toBeFocused({ timeout: 30_000 });
  await expect(page.getByTestId("lineage")).toContainText("Gallery world");
  await expect(page.getByTestId("lineage")).toContainText("Your copy: your first change makes it a remix.");

  // the link a remix of it points back with
  await page.goto(`${BOOT}&g=${entry!.slug}`);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByRole("textbox", { name: "Describe a world" })).toHaveValue(entry!.prompt);
  await expect(page.getByTestId("lineage")).toContainText("Gallery world");
  await expect(page.getByTestId("remix")).toBeVisible();
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});
