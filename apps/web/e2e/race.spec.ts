// Racing ghosts: the proof's par runner runs beside you, a win becomes a "Race me" link that plays
// your exact run as the ghost to beat, and a world's best times rank only runs this device replayed
// to their time. The edge's share and board store is stubbed in the page (no live service here).
import { expect, test, type Page } from "@playwright/test";

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

const probe = (page: Page) => page.evaluate(() => ({ ...window.__GHOSTRUN__ }));

/** The edge's share store and best-times board, in memory, behind the same routes and shapes. */
function fakeEdge(page: Page) {
  const shares = new Map<string, Record<string, unknown>>();
  const boards = new Map<string, { shareId: string; ticks: number; name: string }[]>();
  let n = 0;
  return {
    shares,
    boards,
    async install() {
      await page.route("**/v1/share", async (r) => {
        const body = r.request().postDataJSON() as Record<string, unknown>;
        const id = `racetestaaaaaaaa${[...(++n).toString(8)].map((d) => "abcdefgh"[Number(d)]).join("")}`.slice(-16);
        shares.set(id, body);
        await r.fulfill({ status: 201, json: { id, created: true } });
      });
      await page.route(/\/v1\/share\/[a-z2-7]{16}$/, async (r) => {
        const id = r.request().url().split("/").pop()!;
        const s = shares.get(id);
        await (s ? r.fulfill({ json: { id, ...s, minds: s.minds ?? [] } }) : r.fulfill({ status: 404, json: { error: "not found" } }));
      });
      await page.route("**/v1/board", async (r) => {
        const { specHash, shareId, ticks, name } = r.request().postDataJSON() as { specHash: string; shareId: string; ticks: number; name?: string };
        const list = [...(boards.get(specHash) ?? []), { shareId, ticks, name: name ?? "" }].sort((a, b) => a.ticks - b.ticks);
        boards.set(specHash, list);
        await r.fulfill({ status: 201, json: { ok: true, created: true, entries: list.slice(0, 10) } });
      });
      await page.route(/\/v1\/board\/[0-9a-f]{64}$/, async (r) => {
        await r.fulfill({ json: { entries: (boards.get(r.request().url().split("/").pop()!) ?? []).slice(0, 10) } });
      });
    },
  };
}

test("race the AI: the par runner's ghost runs beside you by tick, with its time and a live split, and H hides it", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0");
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
  await expect(page.getByTestId("proof-badge")).toContainText("12 of 12 AI runners won", { timeout: 60_000 });
  await page.keyboard.press("KeyW"); // play: the prompt bar folds away and the race line shows
  const race = page.getByTestId("race");
  await expect(race).toContainText("AI 0:41.4"); // the CTF brief's par runner: 2,481 ticks
  await expect(page.getByTestId("race-delta")).toContainText(/you [+−±]\d+\.\d s/);
  await expect(page.getByTestId("race-rival")).toHaveAttribute("title", /fastest of the proof's 12 AI runners \(12 of 12 won\)/);
  // the ghost runs on the simulation's clock, from the start of the run, and moves
  const snap = await probe(page);
  const a = snap.ghost!;
  expect(a.shown).toBe(true);
  expect(Math.abs(a.tick - snap.tick!)).toBeLessThan(40); // the ghost's probe updates per rendered frame (a few a second under software GL)
  // (waits on the run, not the wall clock: a busy machine renders few ticks a second, and the runner
  // stands still for a moment at times)
  await page.waitForFunction(
    ([t, x, z]) => {
      const g = window.__GHOSTRUN__.ghost;
      return Boolean(g && g.tick > t + 30 && Math.hypot(g.p[0] - x, g.p[2] - z) > 1);
    },
    [a.tick, a.p[0], a.p[2]] as const,
    { timeout: 30_000 },
  );
  // H hides it (it keeps its place in the run) and brings it back
  await page.keyboard.press("KeyH");
  await expect(page.getByTestId("ghost-toggle")).toHaveText("show ghost");
  expect((await probe(page)).ghost!.shown).toBe(false);
  await page.keyboard.press("KeyH");
  await expect(page.getByTestId("ghost-toggle")).toHaveText("hide ghost");
  // Play again: the same ghost from the top, at once (no second wait for the proof)
  await page.keyboard.press("KeyR");
  await page.waitForFunction(() => (window.__GHOSTRUN__.ghost?.tick ?? 999) < 120, null, { timeout: 10_000 });
  expect(errors).toEqual([]);
});

test.describe("race my ghost", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });
  test("a win copies a result line and a Race me link; the board ranks the run once this device replays it; the link races your exact run", async ({ page }) => {
    const errors = collectErrors(page);
    const edge = fakeEdge(page);
    await edge.install();
    await page.goto("/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&fixture=heist"); // a recorded world whose win is near the spawn
    await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
    await page.waitForFunction(() => window.__GHOSTRUN__?.proof !== undefined, null, { timeout: 60_000 }); // its runners win (too fast to be much of a game: the receipt says so)
    const keys = ["KeyW", "KeyD", "KeyS", "KeyA"];
    for (let i = 0; i < 24 && !(await page.getByTestId("result").count()); i++) {
      await page.keyboard.down(keys[i % 4]!);
      await page.waitForTimeout(900);
      await page.keyboard.up(keys[i % 4]!);
    }
    const result = page.getByTestId("result");
    await expect(result).toContainText("You win");
    const card = page.getByTestId("result-card");
    await expect(card).toContainText(/^GHOSTRUN · museum heist · \d+ of 12 AI runners won · me \d:\d\d\.\d · AI \d:\d\d\.\d$/);
    const mine = /me (\d:\d\d\.\d)/.exec((await card.textContent())!)![1]!;

    // the board: nothing yet; post this run with a nickname, and this device replays it to its time
    await page.getByTestId("best-times").click();
    const board = page.getByTestId("board");
    await expect(board).toContainText("No times yet: yours can be the first.");
    await expect(page.getByTestId("board-ai")).toContainText("AI par runner");
    await page.getByTestId("board-name").fill("sh1t");
    await page.getByTestId("board-post").click();
    await expect(page.getByTestId("board-refused")).toContainText("pick another name");
    await page.getByTestId("board-name").fill("Tester");
    await page.getByTestId("board-post").click();
    const entry = page.getByTestId("board-entry");
    await expect(entry).toContainText(`Tester${mine}`);
    await expect(entry).toContainText("✓ verified by replay on this device", { timeout: 30_000 });
    const [spec] = [...edge.boards.keys()];
    const [stored] = [...edge.shares.values()] as { inputs: { tick: number }[] }[];
    // a claim its run can't back: the same run, said to be a second faster
    const real = edge.boards.get(spec!)![0]!;
    edge.boards.get(spec!)!.unshift({ shareId: real.shareId, ticks: real.ticks - 60, name: "Cheater" });
    expect(stored!.inputs.at(-1)!.tick).toBe(real.ticks); // the stored run stops on its winning tick
    await board.getByRole("button", { name: "close" }).click();
    await page.getByTestId("best-times").click();
    await expect(page.getByTestId("board-unverified")).toContainText("Cheater", { timeout: 30_000 }); // ranked only once replayed: it isn't
    await expect(page.getByTestId("board-unverified")).toContainText("✗ its run doesn't replay to that time here");
    await expect(page.getByTestId("board-entry")).toHaveCount(1);
    await expect(page.getByTestId("board-post")).toHaveCount(0); // this run is on the board already
    await board.getByRole("button", { name: "close" }).click();

    // Race me: the link (with the nickname) is copied, and so is the result line with it
    await page.getByTestId("race-me").click();
    await expect(page.locator(".toast")).toContainText("Race link copied:");
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/\?race=[a-z2-7]{16}&by=Tester$/);
    await page.getByTestId("copy-card").click();
    await expect(page.getByTestId("copy-card")).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${(await card.textContent())!}`);
    await expect(card).toContainText(`· beat it: ${link}`);

    // the recipient: the same world, the sender's run replayed here into the ghost to beat
    await page.goto(`${link}&gl=webgl2&fx=0&dpr=0.5&prewarm=0`);
    await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
    await expect(page.locator(".toast")).toContainText(`Race Tester: ${mine} to beat (replayed on this device)`);
    await page.keyboard.press("KeyS"); // play: the prompt bar folds away and the race line shows
    await expect(page.getByTestId("race")).toContainText(`Tester ${mine}`);
    await expect(page.getByTestId("race-rival")).toHaveAttribute("title", /Tester's run, replayed on this device from its stored inputs/);
    await page.waitForFunction(() => window.__GHOSTRUN__.ghost?.finished === true, null, { timeout: 60_000 });
    expect(errors).toEqual([]);
  });
});
