// Walking-skeleton smoke test: the organizer's CTF brief renders, the player walks and jumps,
// and nothing logs an error. The WebGL2 fallback is forced (?gl=webgl2) because that is the path
// headless Chromium and Safari-class devices take; a second test boots the automatic choice.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
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
  // the device proof runs whichever simulation plays on the main thread; let it finish first so
  // its worker doesn't compete with the key timing below
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
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
  // land high in the first jump's arc: it is timed inside the page, on the frame the player rises
  // past 2 m (a round trip through the test runner can miss that window under software GL).
  const secondPress = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const key = (type: string) => window.dispatchEvent(new KeyboardEvent(type, { code: "Space", key: " " }));
          const wait = () => {
            if (window.__GHOSTRUN__.player![1] <= 2.0) return void requestAnimationFrame(wait);
            key("keydown");
            setTimeout(() => (key("keyup"), resolve()), 50);
          };
          wait();
        }),
    );
  let onLane = false;
  for (let attempt = 0; attempt < 3 && !onLane; attempt++) {
    await page.keyboard.press("Space");
    await secondPress();
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

  // Enter in the prompt bar rebuilds the world: the sim restarts from tick 0 and the hash is stable
  // (offline, any prompt that isn't a recorded one builds the CTF fixture again).
  await page.getByLabel("Describe a world").fill("A rooftop chase in the rain");
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
    await expect(page.getByTestId("mute")).toBeVisible(); // above the Jump button, clear of the thumbs
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
  // no keyboard in a headset: B mutes the sound (Enter VR's click started it)
  await page.waitForFunction(() => window.__GHOSTRUN__.audio?.state === "running", null, { timeout: 10_000 });
  await ctl("right", (c) => c.updateButtonValue("b-button", 1));
  await page.waitForFunction(() => window.__GHOSTRUN__.audio?.muted === true, null, { timeout: 5_000 });
  await ctl("right", (c) => c.updateButtonValue("b-button", 0));
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

test("export: the scene as glTF, the logic as logic.json, and the playtest report", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("verified", { timeout: 60_000 });
  await page.keyboard.press("KeyS");
  await page.keyboard.press("KeyP");
  const files: Record<string, Buffer> = {};
  page.on("download", async (d) => {
    const path = await d.path();
    files[d.suggestedFilename()] = (await import("node:fs")).readFileSync(path);
  });
  await page.getByTestId("export").click();
  await expect.poll(() => Object.keys(files).length, { timeout: 20_000 }).toBe(3);
  const glb = Object.entries(files).find(([n]) => n.endsWith(".glb"))![1];
  expect(glb.subarray(0, 4).toString("ascii")).toBe("glTF");
  const logic = JSON.parse(Object.entries(files).find(([n]) => n.endsWith(".logic.json"))![1].toString("utf8")) as { format: string; rules: { text: string; proof: string }[] };
  expect(logic.format).toBe("ghostrun.logic/1");
  expect(logic.rules).toHaveLength(10); // the brief's 5 rules and its 5 secrets: the export keeps every rule
  expect(logic.rules.every((r) => r.text.startsWith("WHEN ") && r.proof === "verified")).toBe(true);
  expect(Object.entries(files).find(([n]) => n.endsWith(".report.html"))![1].toString("utf8")).toContain("Rooftop lane needs double jump");
  expect(errors).toEqual([]);
});

test("edit: 'super high jumps' comes back re-proved, the headline turns into a counterexample, and Undo restores it", async ({ page }) => {
  const errors = collectErrors(page);
  // the live lane, stubbed: health says the AI is up; the edit answers with a law patch
  const sse = (lines: string[]) => lines.map((line, i) => `event: op\ndata: ${JSON.stringify({ i, line })}\n\n`).join("") + `event: done\ndata: {"lines":${lines.length}}\n\n`;
  let asked: { change?: string; fill?: string; intent?: { pack?: string } } = {};
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  await page.route("**/v1/repair", (r) => r.fulfill({ contentType: "text/event-stream", body: 'event: error\ndata: {"message":"off in this test"}\n\n' }));
  await page.route("**/v1/edit", (r) => {
    asked = r.request().postDataJSON() as typeof asked;
    return r.fulfill({ contentType: "text/event-stream", body: sse(['{"op":"law","player":{"jumpsMax":2,"jumpH":3.4}}', '{"op":"del","id":"x_roof"}']) });
  });
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("prompt-bar")).toContainText("live AI");
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  const spec0 = (await probe(page)).specHash;

  await page.getByTestId("edit-box").getByRole("button", { name: "super high jumps" }).click();
  await expect(page.getByTestId("edit-result")).toContainText("jump height 1.6 → 3.4 m");
  await expect(page.getByTestId("edit-result")).toContainText("promises were kept");
  await expect(page.getByTestId("edit-delta")).toContainText("Headline: verified → counterexample", { timeout: 60_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("counterexample");
  // and why: the proof's own reason, at the rooftop
  await expect(page.getByTestId("edit-result")).toContainText(/Rooftop lane needs double jump — reachable with 1 jump: step [\d.]+ m ≤ apex [\d.]+ m/);
  expect(asked.change).toBe("super high jumps");
  expect(asked.intent?.pack).toBe("city_block");
  expect(asked.fill).toContain('"fit":{"jumpH":1.6,"jumpsMax":2');
  expect((await probe(page)).specHash).not.toBe(spec0);

  await page.getByTestId("edit-undo").click();
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await expect.poll(async () => (await probe(page)).specHash).toBe(spec0);
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});

test("harder but fair: three candidates race, the hardest fair one is kept, each verdict with its numbers", async ({ page }) => {
  const errors = collectErrors(page);
  const sse = (line: string) => `event: op\ndata: ${JSON.stringify({ i: 0, line })}\n\nevent: done\ndata: {"lines":1}\n\n`;
  const asked: string[] = [];
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  await page.route("**/v1/repair", (r) => r.fulfill({ contentType: "text/event-stream", body: 'event: error\ndata: {"message":"off in this test"}\n\n' }));
  await page.route("**/v1/edit", (r) => {
    const change = (r.request().postDataJSON() as { change: string }).change;
    asked.push(change);
    // one candidate per angle: one breaks the rooftop promise, one is slower (harder, fair), one changes nothing that matters
    const line = change.includes("obstacles") ? '{"op":"law","player":{"jumpsMax":2,"jumpH":3.4}}' : change.includes("pressure") ? '{"op":"law","player":{"jumpsMax":2,"jumpH":1.6,"speed":4.5}}' : '{"op":"verb","id":"vb_carry","verb":"physics_props.carry","on":"orb","params":{"speedMul":0.6}}';
    return r.fulfill({ contentType: "text/event-stream", body: sse(line) });
  });
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await page.getByTestId("edit-input").fill("make it harder but fair");
  await page.getByTestId("edit-input").press("Enter");
  await expect(page.getByTestId("edit-result")).toContainText("racing 3 harder versions", { timeout: 20_000 });
  const race = page.getByTestId("edit-race");
  await expect(race).toContainText("A: too hard or broken", { timeout: 120_000 });
  await expect(race).toContainText("headline counterexample");
  await expect(race).toContainText("B: harder and fair");
  await expect(race).toContainText("C: not harder");
  expect(asked).toHaveLength(3);
  await expect(page.getByTestId("edit-result")).toContainText("speed 6 → 4.5 m/s");
  // the kept world's numbers come from its own full proof
  await expect(page.getByTestId("edit-delta")).toContainText(/AI par: [\d.]+ s → [\d.]+ s/, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified");
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});

test("the Host: a loss explains itself from the causal log, answers questions from it, and ▶ replays that moment exactly", async ({ page }) => {
  const errors = collectErrors(page);
  let asked: { question?: string; facts?: string[] } = {};
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  await page.route("**/v1/host", (r) => {
    asked = r.request().postDataJSON() as typeof asked;
    return r.fulfill({ json: { answer: "Rival 1 ran the orb home three times while you waited.", cites: [2, 1] } });
  });
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  // stand still: the rivals carry the orb home three times
  const result = page.getByTestId("result");
  await expect(result).toContainText("You lose", { timeout: 90_000 });
  await expect(result).toContainText("blue team reached 3");
  const story = page.getByTestId("story");
  await expect(story).toContainText("Rival 1 carried the glowing orb into the neon goal ring, 3 times (blue 1–3)");
  const ended = await probe(page).then((p) => p.tick ?? 0);
  await story.getByRole("button").first().click();
  await expect(result).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Replaying from" })).toBeVisible();
  // fast-forwarded to four seconds before the moment, then played to the same loss on the same tick
  expect((await probe(page)).tick ?? 0).toBeGreaterThan(ended - 300);
  await expect(result).toContainText("You lose", { timeout: 20_000 });
  expect(Math.abs(((await probe(page)).tick ?? 0) - ended)).toBeLessThan(5);
  // the replayed run's card answers from the same log (an answer also flies there: show.spec.ts)
  await page.getByTestId("host-input").fill("why did I lose?");
  await page.getByTestId("host-input").press("Enter");
  await expect(page.getByTestId("host-answer")).toContainText("Rival 1 ran the orb home three times while you waited.");
  expect(asked.question).toBe("why did I lose?");
  expect(asked.facts?.[0]).toMatch(/^You lost at \d+:\d\d: blue team reached 3$/);
  expect(asked.facts).toContain("Rule: WHEN blue team reaches 3 THEN you lose (once)");
  await expect(page.getByTestId("host-answer").getByRole("button")).toHaveCount(2); // each cited moment replays
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});

test("first ten seconds: try-one suggestions open a world in one click; a spoken prompt builds too", async ({ page }) => {
  const errors = collectErrors(page);
  // the browser's speech recognition, stubbed: it "hears" the coin rush prompt
  await page.addInitScript(() => {
    const w = window as unknown as { webkitSpeechRecognition: unknown; SpeechRecognition: unknown };
    w.SpeechRecognition = w.webkitSpeechRecognition = class {
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      start() {
        setTimeout(() => {
          this.onresult?.({ results: [Object.assign([{ transcript: "Collect five gold coins in a neon arena before the clock runs out. Mind the lava." }], { isFinal: true })] });
          this.onend?.();
        }, 100);
      }
      stop() {}
    };
  });
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await page.getByRole("textbox", { name: "Describe a world" }).click();
  const suggest = page.getByTestId("suggest");
  await expect(suggest).toContainText("The organizer's CTF brief");
  await expect(suggest).not.toContainText("Wizard duel"); // live-only prompts hide without the live lane
  await suggest.getByRole("button", { name: "Museum heist" }).click();
  await expect(page.getByTestId("intent-card")).toContainText("floor_plan", { timeout: 30_000 });
  await expect(page.getByText("building world…")).toHaveCount(0, { timeout: 30_000 }); // speak once the world has finished building
  await page.getByTestId("mic").click();
  await expect(page.getByRole("textbox", { name: "Describe a world" })).toHaveValue(/Collect five gold coins/, { timeout: 10_000 });
  await expect(page.getByTestId("intent-card")).toContainText("arena", { timeout: 30_000 });
  await expect(page.getByRole("status").filter({ hasText: "speech service" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("landing: the bar starts empty and cycles examples (Enter builds the one shown), starters build in one click, and a car gets an honest note", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  const bar = page.getByRole("textbox", { name: "Describe a world" });
  await expect(bar).toHaveValue(""); // nothing to clear before typing
  const landing = page.getByTestId("landing");
  await expect(landing).toContainText("Type any world. It's playable in seconds, and AI runners prove it's beatable.");
  await expect(landing.getByRole("button")).toHaveText(["The organizer's brief", "Surprise me", "Museum heist", "Forest climb", "Coin rush"]);
  await expect(page.getByTestId("subst-note")).toHaveCount(0); // the brief asks for nothing missing

  // the placeholder types out an example, then moves on to another
  const typed = async () => {
    await page.waitForFunction(() => (document.querySelector<HTMLInputElement>("[aria-label='Describe a world']")?.placeholder.length ?? 0) > 24, null, { timeout: 8_000 });
    return (await bar.getAttribute("placeholder"))!.slice(0, 24);
  };
  const first = await typed();
  expect(first).toMatch(/^Try: /);
  await expect.poll(typed, { timeout: 10_000 }).not.toBe(first);

  // one click on a starter builds that world, and the landing steps aside
  await landing.getByRole("button", { name: "Coin rush" }).click();
  await expect(page.getByTestId("intent-card")).toContainText("arena", { timeout: 30_000 });
  await expect(landing).toHaveCount(0);
  await expect(bar).toHaveValue(/Collect five gold coins/);

  // Enter on an empty bar builds the example it shows (offline: that prompt's recorded world)
  await bar.fill("");
  const example = (await bar.getAttribute("placeholder"))!.replace(/^Try: /, "");
  await bar.press("Enter");
  await expect(bar).toHaveValue(example);
  await expect(page.getByRole("status").filter({ hasText: "recorded live AI world" })).toBeVisible({ timeout: 30_000 });

  // a mechanic no kit has yet: the Intent card says what you get instead
  await expect(page.getByText("building world…")).toHaveCount(0, { timeout: 30_000 });
  await bar.fill("Drive a race car round a neon city");
  await bar.press("Enter");
  await expect(page.getByTestId("subst-note")).toHaveText("No vehicles yet: you race on foot", { timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("sound: the first key press starts it, a coin chimes, M mutes it (remembered), ?audio=0 turns it off", async ({ page }) => {
  const errors = collectErrors(page);
  const audio = () => page.evaluate(() => window.__GHOSTRUN__.audio!);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&fixture=coin-rush");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  expect((await audio()).state).toBe("off"); // browsers allow no sound before a gesture, and none is made
  await expect(page.getByTestId("landing")).toBeVisible();

  // coin_1 sits on the midfield line ahead of the spawn
  await page.keyboard.down("KeyW");
  await page.waitForFunction(() => window.__GHOSTRUN__.audio?.state === "running", null, { timeout: 10_000 });
  await expect(page.getByTestId("landing")).toHaveCount(0); // the first move puts the landing away
  await expect(page.getByTestId("score")).toContainText("SCORE 1", { timeout: 15_000 });
  await page.keyboard.up("KeyW");
  await expect.poll(async () => (await audio()).counts.coin ?? 0).toBeGreaterThan(0);
  const a = await audio();
  expect(a.counts.step ?? 0).toBeGreaterThan(0); // footsteps on the way there
  expect(a.music?.key).toMatch(/^[A-G]/); // the loop plays in the world's key

  // M mutes: the clock stops, and walking makes no more sound
  await page.keyboard.press("KeyM");
  await expect(page.getByTestId("mute")).toHaveAttribute("aria-pressed", "true");
  await page.waitForFunction(() => window.__GHOSTRUN__.audio?.state === "suspended", null, { timeout: 5_000 });
  const played = (await audio()).played;
  await page.keyboard.down("KeyS");
  await page.waitForTimeout(1200);
  await page.keyboard.up("KeyS");
  expect((await audio()).played).toBe(played);

  // remembered across a reload; the HUD button turns it back on
  await page.reload();
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  expect((await audio()).muted).toBe(true);
  await page.getByTestId("mute").click();
  await page.waitForFunction(() => window.__GHOSTRUN__.audio?.state === "running" && !window.__GHOSTRUN__.audio.muted, null, { timeout: 10_000 });

  // ?audio=0: no sound at all, and no button for it
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&fixture=coin-rush&audio=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await page.keyboard.press("KeyW");
  expect((await audio()).state).toBe("disabled");
  await expect(page.getByTestId("mute")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("repair loop: a broken promise goes back to the model, the fix is re-proved and offered, Apply makes it green", async ({ page }) => {
  const errors = collectErrors(page);
  const sse = (line: string) => `event: op\ndata: ${JSON.stringify({ i: 0, line })}\n\nevent: done\ndata: {"lines":1}\n\n`;
  const issues: string[][] = [];
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  await page.route("**/v1/edit", (r) => r.fulfill({ contentType: "text/event-stream", body: sse('{"op":"law","player":{"jumpsMax":2,"jumpH":3.4}}') }));
  await page.route("**/v1/repair", (r) => {
    issues.push((r.request().postDataJSON() as { issues: string[] }).issues);
    return r.fulfill({ contentType: "text/event-stream", body: sse('{"op":"law","player":{"jumpsMax":2,"jumpH":1.6}}') });
  });
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await page.getByTestId("edit-box").getByRole("button", { name: "super high jumps" }).click();
  await expect(page.getByTestId("proof-badge")).toContainText("counterexample", { timeout: 60_000 });
  const chip = page.getByTestId("repair-chip");
  await expect(chip).toContainText("AI repaired it", { timeout: 90_000 });
  await expect(chip).toContainText("re-proved");
  expect(issues[0]?.some((i) => i.includes("Rooftop lane needs double jump"))).toBe(true);
  await chip.click();
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});

test("director's cut: 'surprise me' asks Claude Sonnet for its version; it is re-proved, offered, applied between runs, and Undo brings yours back", async ({ page }) => {
  const errors = collectErrors(page);
  const sse = (lines: string[]) => `${lines.map((line, i) => `event: op\ndata: ${JSON.stringify({ i, line })}\n\n`).join("")}event: done\ndata: {"lines":${lines.length},"model":"claude-sonnet-5-5"}\n\n`;
  const notes: string[][] = [];
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  await page.route("**/v1/repair", (r) => r.fulfill({ contentType: "text/event-stream", body: 'event: error\ndata: {"message":"off in this test"}\n\n' }));
  await page.route("**/v1/director", (r) => {
    notes.push((r.request().postDataJSON() as { notes: string[] }).notes);
    return r.fulfill({
      contentType: "text/event-stream",
      body: sse(['{"op":"ent","id":"x_kiosk","kind":"prop","noun":"ramen kiosk","hyper":"stall","zone":"z_plaza","body":"fixed","shape":"box"}', '{"op":"verb","id":"vb_kiosk","verb":"social.inspect","on":"x_kiosk","params":{"text":"Best noodles in the district."}}']),
    });
  });
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await page.getByTestId("edit-box").getByRole("button", { name: "surprise me" }).click();
  const chip = page.getByTestId("cut-chip");
  await expect(chip).toContainText("Director's cut ready: +1 ramen kiosk", { timeout: 90_000 });
  await expect(chip).toContainText("re-proved");
  expect(notes[0]?.some((n) => n.includes("Rooftop lane needs double jump"))).toBe(true); // the Director hears what the playtest found
  await chip.click();
  await expect(chip).toHaveCount(0);
  await expect(page.getByTestId("edit-box")).toContainText("Director's cut");
  await expect(page.getByTestId("edit-box")).toContainText("+1 ramen kiosk");
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await page.getByTestId("edit-undo").click();
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await expect(page.getByTestId("edit-box")).not.toContainText("ramen kiosk");
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});

test("gallery: G opens the recorded live worlds; one opens, is rebuilt and re-proved on the device", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await page.keyboard.press("KeyG");
  const gallery = page.getByTestId("gallery");
  const worlds = (JSON.parse(readFileSync(resolve(here, "../src/gallery/index.json"), "utf8")) as unknown[]).length;
  await expect(gallery.getByRole("listitem")).toHaveCount(worlds);
  await expect(gallery).toContainText("honest receipt");
  await gallery.getByTestId("gallery-board-the-enemy-pirate-ship-and-steal-th").click();
  await expect(gallery).toHaveCount(0);
  await expect(page.getByTestId("intent-card")).toContainText("course", { timeout: 30_000 });
  await expect(page.getByRole("textbox", { name: "Describe a world" })).toHaveValue(/pirate ship/i);
  await expect(page.getByTestId("proof-badge")).toContainText("12 of 12 AI runners won", { timeout: 120_000 });
  expect(errors).toEqual([]);
});

test("why trust this: the receipt opens the method, the eval table (one row per committed set) and the limits", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await page.keyboard.press("KeyP");
  await page.getByTestId("why-trust").click();
  const trust = page.getByTestId("trust");
  await expect(trust).toContainText("How a receipt is made");
  await expect(trust).toContainText("Node, Cloudflare workerd, Chromium, Firefox and WebKit");
  const sets = (JSON.parse(readFileSync(resolve(here, "../src/trust.json"), "utf8")) as { sets: { name: string }[] }).sets;
  await expect(trust.locator("tbody tr")).toHaveCount(sets.length);
  await expect(trust).toContainText(sets.at(-1)!.name);
  await expect(trust).toContainText("What it doesn't do yet");
  await page.keyboard.press("Escape");
  await expect(trust).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("try to fool it: a bug planted in a copy of the world is caught, and the next one too", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await page.keyboard.press("KeyP");
  await page.getByTestId("fool").click();
  const fooled = page.getByTestId("fooled");
  await expect(fooled).toContainText("Planted (1 of 2)", { timeout: 90_000 });
  await expect(fooled).toContainText("Caught:");
  await page.getByTestId("fool").click();
  await expect(fooled).toContainText("Planted (2 of 2)", { timeout: 90_000 });
  await expect(fooled).toContainText("Caught:");
  // the world itself is untouched: its own receipt still says verified
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified");
  expect(errors).toEqual([]);
});

test("where the runners went: the receipt shows the AI runners' routes and what nobody went near", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("Rooftop lane needs double jump: verified", { timeout: 60_000 });
  await page.keyboard.press("KeyP");
  const routes = page.getByTestId("routes");
  await expect(routes).toContainText(/\b(12|24) AI runs/); // the experts', then with the playtest's novice and average runs
  await expect(routes).toContainText("Most time: near the");
  await page.getByTestId("routes-toggle").click();
  await expect(page.getByTestId("routes-toggle")).toHaveText("Hide the runners' routes");
  await page.getByTestId("routes-toggle").click();
  await expect(page.getByTestId("routes-toggle")).toHaveText("Where the runners went");
  expect(errors).toEqual([]);
});
