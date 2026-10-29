// Building from a photo or sketch with the edge stubbed: the picture is made small and clean in the
// browser (what leaves passes the edge's own checks and carries none of the file's metadata), sent
// with the words, and the world that comes back says it is inspired by the image, never a copy of it.
// GR_SHOTS=<dir> saves the bar with its chip and the card that comes back there.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readImage } from "../../edge-api/src/image";

const here = dirname(fileURLToPath(import.meta.url));
const SKETCH = resolve(here, "fixtures/alley-sketch.png"); // 1200×800, with a tEXt chunk of fake GPS metadata
const fill = readFileSync(resolve(here, "../../../packages/ir/fixtures/ctf-neon.jsonl"), "utf8").split("\n").filter(Boolean);
const gameplay = fill.slice(0, fill.findIndex((l) => l.includes('"layer":"gameplay"')) + 1);
const intent = { lang: "en", mode: "play", genre: "heist", setting: "a rainy neon alley at night", role: "thief", goal: "grab the flag", fail: "get caught", mood: "tense", pack: "city_block", sub: ["rooftop"], safety: "ok", headline: "Rooftop lane needs double jump", nouns: [], moodVec: { valence: 0, arousal: 0.5, tension: 0.5 } };
const brief = { setting: "a rainy neon alley at night", mood: "tense", palette: ["teal", "magenta"], objects: ["neon sign", "street lamp", "door"], layout: "a long corridor", genre: "", goal: "" };
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const SHOTS = process.env.GR_SHOTS && resolve(process.env.GR_SHOTS);
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `picture-${name}.png`) });
};

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test("picture: an attached image is made small and clean, sent with the words, and the Intent card says the world is inspired by it", async ({ page }) => {
  const errors = collectErrors(page);
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  for (const path of ["repair", "director"]) await page.route(`**/v1/${path}`, (r) => r.fulfill({ contentType: "text/event-stream", body: sse("error", { message: "off in this test" }) }));
  const asked: { prompt: string; image?: string }[] = [];
  const prompt = `a heist here. Inspired by a picture of ${brief.setting}; mood tense; colours teal, magenta; with neon sign, street lamp, door; layout: a long corridor.`;
  await page.route("**/v1/build", (r) => {
    asked.push(r.request().postDataJSON() as { prompt: string; image?: string });
    const body = sse("inspired", { brief, prompt, ms: 900, model: "claude-haiku-5-5" }) + sse("intent", { intent, seed: 7, ms: 1400 }) + gameplay.map((line, i) => sse("op", { i, line })).join("") + sse("done", { lines: gameplay.length });
    return r.fulfill({ contentType: "text/event-stream", body });
  });
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("prompt-bar")).toContainText("live AI");

  // attach the sketch: a thumbnail chip appears in the bar, and the bar invites words or Enter
  await expect(page.getByTestId("picture-button")).toBeVisible();
  await page.getByTestId("picture-input").setInputFiles(SKETCH);
  const chip = page.getByTestId("picture-chip");
  await expect(chip.locator("img")).toHaveAttribute("src", /^data:image\/(webp|jpeg);base64,/, { timeout: 15_000 });
  await expect(chip).toHaveAttribute("title", /metadata removed/);
  const bar = page.getByRole("textbox", { name: "Describe a world" });
  await expect(bar).toHaveAttribute("placeholder", /press Enter to build from the image/);
  await bar.fill("a heist here");
  await shot(page, "1-chip");
  await bar.press("Enter");

  // the world arrives and plays; its card says where the ideas came from, in the brief's own words
  await page.waitForFunction(() => window.__GHOSTRUN__.ready === true && Boolean(window.__GHOSTRUN__.specHash), null, { timeout: 60_000 });
  const card = page.getByTestId("intent-card");
  await expect(card.getByTestId("inspired-note")).toHaveText("Inspired by your image: a rainy neon alley at night · neon sign, street lamp, door");
  await expect(card).not.toContainText(/reconstruct|recreat|copy of/i);
  await expect(card).toContainText(intent.headline);
  await expect(chip).toBeVisible(); // still attached, like the words, until removed
  await shot(page, "2-card");

  // what left the browser: the words and a small re-encoded image the edge accepts, with no metadata
  expect(asked).toHaveLength(1);
  expect(asked[0]!.prompt).toBe("a heist here");
  const sent = readImage(asked[0]!.image);
  expect(sent.ok, JSON.stringify(sent).slice(0, 200)).toBe(true);
  if (!sent.ok) return;
  expect(Math.max(sent.image.width, sent.image.height)).toBeLessThanOrEqual(768);
  expect(sent.image).toMatchObject({ width: 768, height: 512 }); // 1200×800 scaled to fit, its shape kept
  expect(sent.image.bytes).toBeLessThanOrEqual(300 * 1024);
  expect(Buffer.from(sent.image.data, "base64").toString("latin1")).not.toContain("GHOSTRUN-SECRET-METADATA");
  expect(readFileSync(SKETCH, "latin1")).toContain("GHOSTRUN-SECRET-METADATA"); // (the fixture did carry it)

  // removing the picture takes the chip away; the next build would be words alone
  await page.getByTestId("picture-remove").click();
  await expect(chip).toHaveCount(0);
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});
