// Characters that answer back, out loud: NPC barks and replies and the Host's recap are spoken with
// the browser's speechSynthesis, stubbed in the page (it records what it was asked to say), and the
// talk box hears you through a stubbed speech recognition. The live lane is stubbed too.
import { expect, test, type Page } from "@playwright/test";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

interface Said {
  text: string;
  voice: string;
  lang: string;
  pitch: number;
  rate: number;
}

declare global {
  interface Window {
    __spoken: Said[];
    __cancels: number;
  }
}

/** speechSynthesis and SpeechRecognition, faked before the page loads. */
async function stubVoices(page: Page) {
  await page.addInitScript(() => {
    const voices = [
      { name: "Samantha", lang: "en-US", voiceURI: "Samantha", localService: true, default: true },
      { name: "Daniel", lang: "en-GB", voiceURI: "Daniel", localService: true, default: false },
      { name: "Moira", lang: "en-IE", voiceURI: "Moira", localService: true, default: false },
      { name: "Zuzana", lang: "cs-CZ", voiceURI: "Zuzana", localService: true, default: false },
    ];
    type U = { text: string; lang: string; voice: { name: string } | null; pitch: number; rate: number; onend: (() => void) | null; onerror: ((e: unknown) => void) | null };
    window.__spoken = [];
    window.__cancels = 0;
    let current: U | null = null;
    const synth = {
      get speaking() {
        return current !== null;
      },
      pending: false,
      paused: false,
      getVoices: () => voices,
      speak(u: U) {
        window.__spoken.push({ text: u.text, voice: u.voice?.name ?? "", lang: u.lang, pitch: u.pitch, rate: u.rate });
        current = u;
        // about as long as a voice takes to say it
        setTimeout(() => {
          if (current !== u) return;
          current = null;
          u.onend?.();
        }, 500 + 25 * u.text.length);
      },
      cancel() {
        const u = current;
        current = null;
        if (u) (window.__cancels++, u.onerror?.({ error: "interrupted" }));
      },
      addEventListener() {},
      removeEventListener() {},
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
      text: string;
      lang = "";
      voice = null;
      pitch = 1;
      rate = 1;
      volume = 1;
      onstart = null;
      onend = null;
      onerror = null;
      constructor(t: string) {
        this.text = t;
      }
    };
    // hold-to-talk: it hears a question while the mic is held, and finishes when it's let go
    const w = window as unknown as { webkitSpeechRecognition: unknown; SpeechRecognition: unknown };
    w.SpeechRecognition = w.webkitSpeechRecognition = class {
      lang = "";
      onresult: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      start() {
        (window as unknown as { __heardIn: string }).__heardIn = this.lang;
        setTimeout(() => this.onresult?.({ results: [Object.assign([{ transcript: "Where is the orb?" }], { isFinal: true })] }), 100);
      }
      stop() {
        setTimeout(() => this.onend?.(), 50);
      }
    };
  });
}

const spoken = (page: Page) => page.evaluate(() => window.__spoken.map((s) => s.text));
const speech = (page: Page) => page.evaluate(() => ({ ...window.__GHOSTRUN__.speech! }));

test("voices: a bark is spoken in its character's voice, a reply by voice, M mutes them, and the Host says why you lost", async ({ page }) => {
  test.setTimeout(300_000); // two waits for the minds, then a whole run to its loss
  const errors = collectErrors(page);
  await stubVoices(page);
  const asked: { said?: string; npc: string }[] = [];
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/repair", (r) => r.fulfill({ contentType: "text/event-stream", body: 'event: error\ndata: {"message":"off in this test"}\n\n' }));
  await page.route("**/v1/director", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  await page.route("**/v1/mind", (r) => {
    const body = r.request().postDataJSON() as { npc: string; current: string; said?: string };
    asked.push(body);
    // the option it already plays (so the run goes as it would), and a line in character
    return r.fulfill({ json: { option: body.current, line: body.said ? "Follow me to the plaza, the orb is there." : "Mine now, slowpoke!" } });
  });
  await page.route("**/v1/host", (r) => r.fulfill({ json: { answer: "Rival 1 ran the orb home three times while you waited. You never left the spawn. Next time, try the rooftop.", cites: [1] } }));
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("prompt-bar")).toContainText("live AI");
  expect((await speech(page)).state).toBe("on");

  // your teammate takes up its post in front of the red base (x −22, z 3); walk up beside it and
  // stop (the probe's positions can lag a frame or two, so it stops well short of passing), then T:
  // hold the mic, ask, let go; the question goes, and the answer is said
  const at = () => page.evaluate(() => ({ p: window.__GHOSTRUN__.player ?? [-99, 0, 0], m: window.__GHOSTRUN__.cast?.mate_1 ?? [99, 99] }));
  await expect.poll(async () => (await at()).m[0], { timeout: 20_000 }).toBeGreaterThan(-23.5);
  await page.keyboard.down("KeyW");
  await expect.poll(async () => (await at()).p[0], { timeout: 15_000, intervals: [50] }).toBeGreaterThan(-26);
  await page.keyboard.up("KeyW");
  await page.waitForTimeout(700);
  const { p, m } = await at();
  expect(Math.hypot(p[0] - m[0], p[2] - m[1])).toBeLessThan(6); // within talking distance
  await page.keyboard.press("KeyT");
  const talk = page.getByTestId("talk");
  await expect(talk).toBeVisible();
  const mic = page.getByTestId("talk-mic");
  await mic.hover();
  await page.mouse.down();
  await expect(talk.getByRole("textbox")).toHaveValue("Where is the orb?");
  await page.mouse.up();
  await expect(talk).toHaveCount(0);
  await expect.poll(() => asked.find((a) => a.said)?.said).toBe("Where is the orb?");
  expect(await page.evaluate(() => (window as unknown as { __heardIn: string }).__heardIn)).toMatch(/^en/); // in the world's language
  await expect(page.getByTestId("bark")).toContainText("Follow me to the plaza, the orb is there.");
  await expect.poll(() => spoken(page)).toContain("Follow me to the plaza, the orb is there.");
  const reply = (await speech(page)).lines.find((l) => l.kind === "reply")!;
  expect(reply.who).toBe("mate_1");
  expect(reply.voice).not.toBe("Samantha"); // the Host's voice is the Host's
  expect(reply.lang).toMatch(/^en-/);

  // the minds think on their own: a bark, spoken in its character's voice, with the music ducked under it
  await expect.poll(() => spoken(page), { timeout: 40_000 }).toContain("Mine now, slowpoke!");
  const bark = (await speech(page)).lines.find((l) => l.kind === "bark")!;
  expect(["mate_1", "rival_1", "rival_2"]).toContain(bark.who);
  const said = await page.evaluate(() => window.__spoken.find((s) => s.text === "Mine now, slowpoke!")!);
  expect(said.voice).not.toBe("");
  expect(said.pitch).not.toBe(1); // a rival or a teammate, not a flat default
  await expect.poll(() => page.evaluate(() => window.__GHOSTRUN__.audio?.ducked ?? null), { timeout: 10_000 }).not.toBeNull();

  // M mutes the voices with everything else: the subtitle still shows, nothing is said
  await page.keyboard.press("KeyM");
  await expect.poll(async () => (await speech(page)).muted).toBe(true);
  const before = (await spoken(page)).length;
  const calls = asked.length;
  await expect.poll(() => asked.length, { timeout: 40_000 }).toBeGreaterThan(calls);
  await page.waitForTimeout(500);
  expect((await spoken(page)).length).toBe(before);
  await page.keyboard.press("KeyM");
  await expect.poll(async () => (await speech(page)).muted).toBe(false);

  // from the top (the first run may have ended while muted), stand still: the rivals carry the orb
  // home three times, and the Host says why out loud
  await page.keyboard.press("KeyR");
  await page.waitForFunction(() => (window.__GHOSTRUN__.tick ?? 999) < 300, null, { timeout: 10_000 });
  const result = page.getByTestId("result");
  await expect(result).toContainText("You lose", { timeout: 120_000 });
  await expect.poll(async () => (await spoken(page)).find((t) => t.startsWith("You lost")), { timeout: 10_000 }).toMatch(/^You lost because the blue team reached 3\. [A-Z][^()]+ 3 times\.$/); // and the moment that mattered, without the score in brackets
  const host = (await speech(page)).lines.findLast((l) => l.kind === "host")!;
  expect(host.voice).toBe("Samantha"); // the default voice, the same in every world
  const recap = host.text;
  // say it again
  const times = async () => (await spoken(page)).filter((t) => t === recap).length;
  const said0 = await times(); // (the first run may have ended out loud too: the same words)
  await page.getByTestId("host-voice").click();
  await expect.poll(times).toBe(said0 + 1);
  // an answer: its first two sentences out loud, all of it on the card
  await page.getByTestId("host-input").fill("why did I lose?");
  await page.getByTestId("host-input").press("Enter");
  await expect(page.getByTestId("host-answer")).toContainText("Next time, try the rooftop.");
  await expect.poll(() => spoken(page)).toContain("Rival 1 ran the orb home three times while you waited. You never left the spawn.");

  // ?audio=0: no voices either
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&audio=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  expect((await speech(page)).state).toBe("disabled");
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});
