// Speech acts that change the game, in the browser, with the live lane stubbed: the museum guard
// takes a bribe and looks away while you walk past it (then looks back), and the villa's agent
// books a viewing you can save as a calendar file. /v1/mind answers as Haiku would; what the act
// does is the world's own rule, in the simulation.
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

type Asked = { said?: string; acts?: { act: string }[]; current: string; today?: string; tz?: string };

async function live(page: Page, answer: (b: Asked) => Record<string, unknown>) {
  const asked: Asked[] = [];
  await page.route("**/v1/health", (r) => r.fulfill({ json: { ok: true, packs: [], llm: true, gate: "dev", sitekey: null } }));
  await page.route("**/v1/repair", (r) => r.fulfill({ contentType: "text/event-stream", body: 'event: error\ndata: {"message":"off in this test"}\n\n' }));
  await page.route("**/v1/director", (r) => r.fulfill({ status: 503, json: { error: "off in this test" } }));
  await page.route("**/v1/mind", (r) => {
    const body = r.request().postDataJSON() as Asked;
    asked.push(body);
    return r.fulfill({ json: answer(body) });
  });
  return asked;
}

const probe = (page: Page) => page.evaluate(() => ({ p: window.__GHOSTRUN__.player ?? [0, 0, 0], cast: window.__GHOSTRUN__.cast ?? {}, acts: window.__GHOSTRUN__.acts, result: window.__GHOSTRUN__.tick }));

test.use({ timezoneId: "Europe/Prague" });

test("speech acts: bribe the guard with the coins you found, walk past it unseen, and it looks back 20 s later", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  const asked = await live(page, (b) =>
    b.said ? { option: "guard.watch", line: "Twenty? Fine. I saw nothing.", act: "offer", what: "coins", n: 20, slot: "" } : { option: b.current, line: "Quiet night." },
  );
  await page.goto("/?fixture=museum&gl=webgl2&fx=0&dpr=0.5&prewarm=0&clip=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("prompt-bar")).toContainText("live AI");

  // straight ahead from the steps: the dropped purse (20 coins), the front door, the lobby, until
  // the guard in its far corner is in talking distance (it watches the vault door, not you)
  const near = async () => {
    const { p, cast } = await probe(page);
    const g = cast.guard ?? [99, 99];
    return Math.hypot(p[0] - g[0], p[2] - g[1]);
  };
  await page.keyboard.down("KeyW");
  await expect.poll(near, { timeout: 20_000, intervals: [50] }).toBeLessThan(5.2);
  await page.keyboard.up("KeyW");
  await page.waitForTimeout(500);
  let s = await probe(page);
  expect(s.acts?.purse).toEqual({ coins: 20 });
  expect(s.acts?.seeing).toEqual([]);
  await expect(page.getByTestId("purse")).toHaveText("20 coins");

  // T, and say it: the guard's mind takes the offer, the act goes into the sim, the rule takes the coins
  await page.keyboard.press("KeyT");
  const talk = page.getByTestId("talk");
  await expect(talk).toBeVisible();
  await talk.getByRole("textbox").fill("here's 20 coins, look the other way");
  await talk.getByRole("textbox").press("Enter");
  await expect(page.getByTestId("bark")).toContainText("Twenty? Fine. I saw nothing.");
  await expect(page.getByTestId("looking-away")).toContainText("The night guard looks away");
  expect(asked.find((a) => a.said)?.acts).toEqual([{ act: "offer", what: "coins", n: 20, gives: "guard.look_away" }]);
  await expect.poll(async () => (await probe(page)).acts?.log).toEqual(["act:offer:coins:20"]);
  await expect(page.getByTestId("purse")).toHaveText("0 coins");

  // walk past it, along the vault wall, right in its view: it sees nothing while it looks away
  await page.keyboard.down("KeyA"); // (facing north, A is east)
  await expect.poll(async () => (await probe(page)).p[0], { timeout: 10_000, intervals: [50] }).toBeGreaterThan(4.4);
  await page.keyboard.up("KeyA");
  s = await probe(page);
  expect(s.acts?.seeing).toEqual([]);
  expect(Object.keys(s.acts?.away ?? {})).toEqual(["guard"]);
  // 20 s after the bribe it looks back, and there you are
  await expect.poll(async () => (await probe(page)).acts?.seeing, { timeout: 30_000 }).toEqual(["guard"]);
  await expect(page.getByTestId("seen")).toContainText("The night guard sees you");
  await expect(page.getByTestId("looking-away")).toHaveCount(0);
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});

test("speech acts: the villa's agent books a viewing on Saturday at 3, and the booking downloads as a calendar file", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  // next Saturday, as the agent's mind would work it out from today's date
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const asked = await live(page, (b) => (b.said ? { option: "guide.welcome", line: "Saturday at three it is.", act: "book", what: "", n: 0, slot: `${day}T15:00` } : { option: b.current, line: "Welcome to Villa Aurelia." }));
  await page.goto("/?fixture=villa&gl=webgl2&fx=0&dpr=0.5&prewarm=0&clip=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("prompt-bar")).toContainText("live AI");

  // the agent greets you beside the garden steps: T, and ask
  await page.keyboard.press("KeyT");
  const talk = page.getByTestId("talk");
  await expect(talk).toBeVisible();
  await talk.getByRole("textbox").fill("can I book a viewing on Saturday at 3?");
  await talk.getByRole("textbox").press("Enter");
  await expect(page.getByTestId("bark")).toContainText("Saturday at three it is.");
  const said = asked.find((a) => a.said)!;
  expect(said.acts).toEqual([{ act: "book", what: "", n: 0, gives: "" }]);
  expect(said.tz).toBe("Europe/Prague");
  expect(said.today).toMatch(/^\d{4}-\d{2}-\d{2}, [A-Z][a-z]+day$/);

  // a booking waits for your yes, then the agent's rule books it
  const ask = page.getByTestId("act-confirm");
  await expect(ask).toContainText("Book: Viewing at Villa Aurelia, Saturday");
  await ask.getByTestId("act-yes").click();
  const booked = page.getByTestId("booked");
  await expect(booked).toContainText("Booked with the estate agent: Viewing at Villa Aurelia, Saturday");
  await expect(booked).toContainText("15:00 (Europe/Prague)");
  await expect.poll(async () => (await probe(page)).acts?.log).toEqual([`act:book::${day}T15:00`]);

  const [file] = await Promise.all([page.waitForEvent("download"), booked.getByTestId("ics").click()]);
  expect(file.suggestedFilename()).toBe("viewing-at-villa-aurelia.ics");
  const ics = readFileSync((await file.path())!, "utf8");
  expect(ics).toContain("SUMMARY:Viewing at Villa Aurelia");
  expect(ics).toContain(`DTSTART;TZID=Europe/Prague:${day.replace(/-/g, "")}T150000`);
  expect(ics).toContain(`DTEND;TZID=Europe/Prague:${day.replace(/-/g, "")}T160000`);
  expect(ics).toMatch(/BEGIN:VTIMEZONE\r\nTZID:Europe\/Prague/);
  expect(ics).not.toMatch(/ORGANIZER|ATTENDEE|MAILTO/);
  expect(errors.filter((e) => !e.includes("503"))).toEqual([]);
});
