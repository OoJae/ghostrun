// VR in the emulated Quest 3 (IWER): the panels in the headset, pointing and clicking with the
// controller ray, teleport, grabbing, driving from the seat, and saying a world. IWER emulates the
// runtime and the controllers but presents no frames (see the VR test in smoke.spec.ts), so what
// is checked is what the game does with them, read from the probe: what each panel says, where
// its buttons are, and how the player moves.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (rel: string) => readFileSync(resolve(here, "../../../", rel), "utf8");

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

// Emulator artifact (see smoke.spec.ts): IWER's XRWebGLLayer has a null framebuffer; and the
// stubbed live lane answers its NPC minds with a 503.
const real = (errors: string[]) => errors.filter((e) => !e.includes("Invalid value used as weak map key") && !e.includes("503"));

type V3 = [number, number, number];
type Ctl = { updateAxes(id: string, x: number, y: number): void; updateButtonValue(id: string, v: number): void; position: { set(x: number, y: number, z: number): void }; quaternion: { set(x: number, y: number, z: number, w: number): void } };
/** Runs `src` with `c` bound to that hand's emulated controller. */
const ctl = (page: Page, hand: "left" | "right", src: string) =>
  page.evaluate(({ hand, src }) => {
    const c = (window as unknown as { __IWER__: { controllers: Record<string, Ctl> } }).__IWER__.controllers[hand]!;
    new Function("c", src)(c);
  }, { hand, src });
const stick = (page: Page, hand: "left" | "right", x: number, y: number) => ctl(page, hand, `c.updateAxes("thumbstick", ${x}, ${y})`);
const button = (page: Page, hand: "left" | "right", id: string, v: number) => ctl(page, hand, `c.updateButtonValue("${id}", ${v})`);

const xr = async (page: Page) => (await page.evaluate(() => window.__GHOSTRUN__.xr))!;
const player = async (page: Page) => (await page.evaluate(() => window.__GHOSTRUN__.player))!;

/** Point the right controller, from in front of the chest, at a spot in the play space. */
async function aim(page: Page, at: V3) {
  const from: V3 = [0.2, 1.35, -0.25];
  const d = [at[0] - from[0], at[1] - from[1], at[2] - from[2]];
  const n = Math.hypot(d[0]!, d[1]!, d[2]!);
  const [x, y, z] = [d[0]! / n, d[1]! / n, d[2]! / n];
  // the rotation taking −z (where a controller points) onto the direction
  const q = [y, -x, 0, 1 - z];
  const m = Math.hypot(...q);
  await ctl(page, "right", `c.position.set(${from.join(",")}); c.quaternion.set(${q.map((v) => v / m).join(",")})`);
}

/** Point at a panel button (wherever its panel is now) and pull the trigger. */
async function click(page: Page, id: string) {
  await page.waitForFunction((b) => Boolean(window.__GHOSTRUN__.xr?.buttons[b]), id, { timeout: 15_000 });
  await aim(page, (await xr(page)).buttons[id]!);
  await page.waitForFunction((b) => window.__GHOSTRUN__.xr?.hover === b, id, { timeout: 5_000 });
  await button(page, "right", "trigger", 1);
  await page.waitForTimeout(150);
  await button(page, "right", "trigger", 0);
}

async function enterVr(page: Page, query = "") {
  await page.goto(`/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&iwer=1${query}`);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await page.getByTestId("enter-vr").click();
  await page.waitForFunction(() => window.__GHOSTRUN__?.vr === true && Boolean(window.__GHOSTRUN__.xr), null, { timeout: 20_000 });
}

test("VR panels: the watch says the proof, the result card appears when the run ends, and the trigger on Play again plays again", async ({ page }) => {
  const errors = collectErrors(page);
  await enterVr(page, "&fixture=heist"); // a recorded world whose win is near the spawn
  // the watch on the left wrist: the receipt's line (the desktop badge's words) and its buttons
  await page.waitForFunction(() => /AI runners won|counterexample/.test(window.__GHOSTRUN__.xr?.panels.wrist?.words[0] ?? ""), null, { timeout: 60_000 });
  const wrist = (await xr(page)).panels.wrist!;
  expect(wrist.shown).toBe(true);
  expect(wrist.words).toEqual(expect.arrayContaining(["[New world]", "[Move: smooth]", "[Vignette: on]"]));
  // painted when its words change, never per frame: while you play, when the ghost's split or the
  // alarm's clock moves (each once a second)
  const d0 = wrist.draws;
  await page.waitForTimeout(2000);
  expect((await xr(page)).panels.wrist!.draws - d0).toBeLessThanOrEqual(6);

  // walk about with the left stick until the run ends
  const moves: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let i = 0; i < 24 && !(await xr(page)).panels.result?.shown; i++) {
    await stick(page, "left", ...moves[i % 4]!);
    await page.waitForTimeout(900);
  }
  await stick(page, "left", 0, 0);
  await page.waitForFunction(() => window.__GHOSTRUN__.xr?.panels.result?.shown === true, null, { timeout: 5_000 });
  const card = (await xr(page)).panels.result!;
  expect(card.words[0]).toBe("You win");
  expect(card.words.join(" ")).toMatch(/AI runners do it in|You beat the AI par/);
  expect(card.words.join(" ")).toContain("Host: You won in");
  expect(card.draws).toBe(1); // painted once for the whole time it's up
  // and with the run over nothing on the watch moves, so it isn't painted again at all
  const w0 = (await xr(page)).panels.wrist!.draws;
  await page.waitForTimeout(1500);
  expect((await xr(page)).panels.wrist!.draws).toBe(w0);
  expect((await xr(page)).panels.result!.draws).toBe(1);
  // in front of you, a little under the eyes (the headset stands at 1.6 m in the play space)
  const again = (await xr(page)).buttons["result:again"]!;
  expect(again[2]).toBeLessThan(-1);
  expect(again[1]).toBeGreaterThan(1);

  // point at Play again and pull the trigger: the same world from the top
  await click(page, "result:again");
  await page.waitForFunction(() => window.__GHOSTRUN__.xr?.panels.result?.shown === false, null, { timeout: 10_000 });
  await page.waitForFunction(() => (window.__GHOSTRUN__.tick ?? 999) < 300, null, { timeout: 10_000 });
  await expect(page.getByTestId("result")).toHaveCount(0);
  expect((await page.evaluate(() => window.__GHOSTRUN__.vr))).toBe(true);
  expect(real(errors)).toEqual([]);
});

test("VR teleport: the right stick held forward aims an arc at the floor, and letting go walks you there behind a blink", async ({ page }) => {
  const errors = collectErrors(page);
  await enterVr(page);
  const p0 = await player(page);
  await stick(page, "right", 0, -1);
  await page.waitForFunction(() => window.__GHOSTRUN__.xr?.teleport.aiming === true && window.__GHOSTRUN__.xr.teleport.valid, null, { timeout: 5_000 });
  const target = (await xr(page)).teleport.target!;
  const away = Math.hypot(target[0] - p0[0], target[2] - p0[2]);
  expect(away).toBeGreaterThan(2);
  expect(away).toBeLessThan(9);
  await stick(page, "right", 0, 0);
  await page.waitForFunction(() => window.__GHOSTRUN__.xr?.teleport.walking === true, null, { timeout: 2_000 });
  await page.waitForFunction(() => window.__GHOSTRUN__.xr?.teleport.walking === false, null, { timeout: 5_000 });
  const p1 = await player(page);
  expect(Math.hypot(target[0] - p1[0], target[2] - p1[2])).toBeLessThan(0.6);

  // and smooth walking can be switched off on the watch (then the left stick aims the arc too)
  await click(page, "wrist:move");
  await page.waitForFunction(() => window.__GHOSTRUN__.xr?.move === "teleport", null, { timeout: 2_000 });
  await stick(page, "left", 0, -1);
  await page.waitForFunction(() => window.__GHOSTRUN__.xr?.teleport.aiming === true, null, { timeout: 2_000 });
  await stick(page, "left", 0, 0);
  expect(real(errors)).toEqual([]);
});

test("VR grab: the right grip on the orb it points at walks you to it and the sim's pickup makes it yours", async ({ page }) => {
  const errors = collectErrors(page);
  await enterVr(page); // the CTF brief: you start facing the orb
  // close enough that the watch offers the grab
  for (let i = 0; i < 12 && !(await xr(page)).panels.wrist!.words.includes("Right grip: grab it"); i++) {
    await stick(page, "left", 0, -1);
    await page.waitForTimeout(250);
    await stick(page, "left", 0, 0);
    await page.waitForTimeout(300);
  }
  await button(page, "right", "squeeze", 1);
  await page.waitForFunction(() => window.__GHOSTRUN__.xr?.grab === "orb" || window.__GHOSTRUN__.xr?.carrying === "orb", null, { timeout: 3_000 });
  await page.waitForFunction(() => window.__GHOSTRUN__.xr?.carrying === "orb", null, { timeout: 6_000 });
  expect((await xr(page)).grab).toBeNull(); // the walk ends once it's yours
  await button(page, "right", "squeeze", 0);
  expect(real(errors)).toEqual([]);
});

test("VR driving: the kart steers from the seat with the stick, the seat turns with it, and the race layer animates", async ({ page }) => {
  const errors = collectErrors(page);
  await enterVr(page, "&fixture=kart"); // you start at the wheel
  await page.waitForFunction(() => window.__GHOSTRUN__.xr?.seat?.vehicle === "kart_red", null, { timeout: 10_000 });
  const yaw0 = (await xr(page)).seat!.yaw;
  const p0 = await player(page);
  await stick(page, "left", 0.8, -1); // throttle and steer right
  await page.waitForTimeout(2500);
  await stick(page, "left", 0, 0);
  const s = (await xr(page)).seat!;
  const turned = Math.abs(Math.atan2(Math.sin(s.yaw - yaw0), Math.cos(s.yaw - yaw0)));
  expect(turned).toBeGreaterThan(0.3); // the vehicle (and you in it) turned, where it used to keep its parked heading
  const p1 = await player(page);
  expect(Math.hypot(p1[0] - p0[0], p1[2] - p0[2])).toBeGreaterThan(3);
  expect((await xr(page)).panels.wrist!.words.join(" ")).toMatch(/LAP 1\/3/);
  expect(real(errors)).toEqual([]);
});

test("VR barks: a character's line is shown by them, sized for the distance (in front of you while they're out of sight)", async ({ page }) => {
  const errors = collectErrors(page);
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  for (const path of ["repair", "director"]) await page.route(`**/v1/${path}`, (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ json: { option: (r.request().postDataJSON() as { current: string }).current, line: "Mine now, slowpoke!" } }));
  await enterVr(page);
  await page.waitForFunction(() => window.__GHOSTRUN__.xr?.panels.bark?.shown === true, null, { timeout: 60_000 });
  const x = await xr(page);
  expect(x.panels.bark!.words.join(" ")).toContain("Mine now, slowpoke!");
  expect(["head", "front"]).toContain(x.bark);
  expect(real(errors)).toEqual([]);
});

// ---- saying a world, with the live lane stubbed (as build.spec.ts does) ----------------------

const gameplay = (fill: string) => {
  const lines = fill.split("\n").filter(Boolean);
  return lines.slice(0, lines.findIndex((l) => l.includes('"layer":"gameplay"')) + 1);
};
const VAULT = {
  lines: gameplay(fixture("packages/ir/fixtures/vault-heist.jsonl")),
  seed: 5,
  intent: { lang: "en", mode: "play", genre: "game", setting: "a museum at night", role: "runner", goal: "win", fail: "lose", mood: "tense", pack: "floor_plan", sub: [], safety: "ok", headline: "The gem can be stolen before the alarm", nouns: [], moodVec: { valence: 0, arousal: 0.5, tension: 0.5 } },
};
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function liveLane(page: Page, speech: string | null) {
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/mind", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  for (const path of ["repair", "director"]) await page.route(`**/v1/${path}`, (r) => r.fulfill({ contentType: "text/event-stream", body: sse("error", { message: "off in this test" }) }));
  // the build streams the intent at once, then (once its reveal is on show: the emulator compiles
  // the reveal's shaders slowly, and these tests skip the prewarm that would have) a line every 150 ms
  await page.addInitScript(({ lines, intent, seed, speech }) => {
    const real = window.fetch.bind(window);
    const seen: unknown[] = ((window as unknown as { __builds: unknown[] }).__builds = []);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith("/v1/build")) return real(input, init);
      seen.push(JSON.parse(String(init?.body ?? "{}")));
      const enc = new TextEncoder();
      const ev = (event: string, data: unknown) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(ev("intent", { intent, seed, ms: 300 }));
          for (let t = 0; t < 600 && !window.__GHOSTRUN__.materialise; t++) await new Promise((r) => setTimeout(r, 50));
          for (const [i, line] of lines.entries()) {
            await new Promise((r) => setTimeout(r, 150));
            c.enqueue(ev("op", { i, line }));
          }
          c.enqueue(ev("done", { lines: lines.length }));
          c.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    // the browser's speech recognition: one that hears `speech`, or none at all (as in the Quest browser)
    const w = window as unknown as Record<string, unknown>;
    if (speech === null) {
      w.SpeechRecognition = undefined;
      w.webkitSpeechRecognition = undefined;
    } else {
      w.SpeechRecognition = w.webkitSpeechRecognition = class {
        lang = "";
        interimResults = false;
        continuous = false;
        onresult: ((e: unknown) => void) | null = null;
        onend: (() => void) | null = null;
        onerror: ((e: unknown) => void) | null = null;
        start() {
          setTimeout(() => this.onresult?.({ results: [Object.assign([{ transcript: speech }], { isFinal: true })] }), 150);
        }
        stop() {
          setTimeout(() => this.onend?.(), 20);
        }
      };
    }
  }, { ...VAULT, speech });
}

for (const speech of [true, false]) {
  test(`VR say a world: ${speech ? "hold the left grip and say it" : "no speech recognition (the Quest browser): the left grip opens prompt chips"}, and it builds and drops you in`, async ({ page }) => {
    const errors = collectErrors(page);
    const said = "A museum at night: steal the star sapphire before the alarm";
    await liveLane(page, speech ? said : null);
    await enterVr(page);
    await expect(page.getByTestId("prompt-bar")).toContainText("live AI");
    await button(page, "left", "squeeze", 1);
    await page.waitForFunction(() => window.__GHOSTRUN__.xr?.sheet === true, null, { timeout: 5_000 });
    let asked = said;
    if (speech) {
      await page.waitForFunction((s) => window.__GHOSTRUN__.xr?.panels.sheet?.words.includes(s), said, { timeout: 5_000 });
      expect((await xr(page)).panels.sheet!.words[0]).toBe("Listening…");
      await button(page, "left", "squeeze", 0); // let go: it builds what you said
    } else {
      await button(page, "left", "squeeze", 0);
      expect((await xr(page)).panels.sheet!.words.join(" ")).toContain("This browser can't listen. Pick one:");
      expect((await xr(page)).panels.sheet!.words).toContain("[Museum heist]");
      await click(page, "sheet:chip:1");
      asked = "A museum at night: find the brass key, open the vault, steal the star sapphire and get to the van before the alarm.";
    }
    // the world rises around you while it streams in (the reveal, seen from where it is watched)
    await page.waitForFunction(() => (window.__GHOSTRUN__.materialise?.statics ?? 0) > 0, null, { timeout: 60_000 });
    await page.waitForFunction(() => window.__GHOSTRUN__.xr?.watching === true, null, { timeout: 2_000 });
    expect((await xr(page)).panels.sheet!.shown).toBe(false);
    // then it plays, still in the headset
    await page.waitForFunction(() => window.__GHOSTRUN__.ready === true && window.__GHOSTRUN__.materialise === undefined && Boolean(window.__GHOSTRUN__.specHash), null, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__GHOSTRUN__.vr)).toBe(true);
    const builds = await page.evaluate(() => (window as unknown as { __builds: { prompt: string }[] }).__builds);
    expect(builds).toHaveLength(1);
    expect(builds[0]!.prompt).toBe(asked);
    await page.waitForFunction(() => /gem can be stolen before the alarm/.test(window.__GHOSTRUN__.xr?.panels.wrist?.words[0] ?? ""), null, { timeout: 60_000 });
    expect(real(errors)).toEqual([]);
  });
}
