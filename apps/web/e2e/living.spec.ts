// The living world, in the browser, on recorded worlds (no live calls): a persona slider is an edit,
// re-proved with its numbers and Undo; a command changes what the CTF mate does, logged as an input;
// a place's ambient life (fireflies, a deer) reacts to the player and never touches the spec hash.
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
const open = async (page: Page, query: string) => {
  await page.goto(`/?gl=webgl2&fx=0&dpr=0.5&prewarm=0&clip=0${query.includes("ff=") ? "" : "&ff=persona_sliders,team_ai,wander_life"}${query}`);
  await page.waitForFunction(() => window.__GHOSTRUN__?.ready === true, null, { timeout: 90_000 });
};
const flat = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, (a.length === 3 ? a[2]! : a[1]!) - (b.length === 3 ? b[2]! : b[1]!));

// These three ship dark (ff.persona_sliders, ff.team_ai, ff.wander_life off by default): each test
// pins its flags on, and stays fixme until it passes again.
test.fixme("persona sliders: the guard made sleepy is an edit, re-proved with its numbers, and Undo puts it back", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await open(page, "&fixture=museum");
  await expect(page.getByTestId("proof-badge")).toContainText("verified", { timeout: 90_000 });
  const spec0 = (await probe(page)).specHash;

  await page.getByTestId("persona-open").click();
  const guard = page.getByTestId("persona-guard");
  await expect(guard).toContainText("night guard");
  await expect(page.getByTestId("persona-value-guard-alert")).toHaveText("sees 9 m");
  await expect(page.getByTestId("persona-value-guard-greedy")).toHaveText("takes 20 coins");

  // sleepy: it sees 6 m instead of 9, a change to play, so the world is re-proved
  await page.getByTestId("persona-guard-alert").fill("6");
  const result = page.getByTestId("persona-result");
  await expect(result).toContainText("night guard sees 9 m → 6 m");
  await expect(page.getByTestId("persona-proved")).toContainText("holds for every choice the guard can make", { timeout: 120_000 });
  await expect(page.getByTestId("persona-proved")).toContainText("AI runners won by playing it");
  await expect(page.getByTestId("persona-value-guard-alert")).toHaveText("sees 6 m");
  const spec1 = (await probe(page)).specHash;
  expect(spec1).toMatch(/^[0-9a-f]{64}$/);
  expect(spec1).not.toBe(spec0);
  await expect(page.getByTestId("proof-badge")).toContainText("verified", { timeout: 90_000 });

  // Undo: the guard sees 9 m again, the spec as it was
  await page.getByTestId("persona-undo").click();
  await expect.poll(async () => (await probe(page)).specHash, { timeout: 60_000 }).toBe(spec0);
  await expect(page.getByTestId("persona-value-guard-alert")).toHaveText("sees 9 m");

  // quiet ↔ chatty is persona prose: no re-proof, the spec stands
  await page.getByTestId("persona-guard-chatty").fill("4");
  await expect(result).toContainText("the same spec: the receipt stands");
  expect((await probe(page)).specHash).toBe(spec0);
  expect(errors).toEqual([]);
});

test.fixme("team AI: the CTF mate follows you when told (key 1), defends when told in words, and every order is logged", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await open(page, "");
  const wheel = page.getByTestId("team");
  await expect(wheel).toBeVisible();
  await expect(page.getByTestId("order-get")).toContainText("Get the glowing orb");
  await expect.poll(async () => (await probe(page)).team?.mates.mate_1).toBe("teammate.defend");

  // 1: follow me. The order goes in as a logged command act; the mate plays its follow option
  await page.keyboard.press("Digit1");
  await expect.poll(async () => (await probe(page)).team?.mates.mate_1).toBe("teammate.follow");
  expect((await probe(page)).team?.orders).toEqual(["act:command:teammate.follow:0"]);
  await expect(page.getByTestId("team-doing")).toContainText("following you");

  // walk off toward the orb: the mate comes along
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(2500);
  await page.keyboard.up("KeyW");
  await expect.poll(async () => {
    const s = await probe(page);
    return flat(s.player!, s.cast!.mate_1!);
  }, { timeout: 10_000 }).toBeLessThan(4.5);

  // said in the talk box: "defend the base". It turns back for its post, away from you
  await page.keyboard.press("KeyT");
  const talk = page.getByTestId("talk");
  await expect(talk).toBeVisible();
  await talk.getByRole("textbox").fill("go defend the base!");
  await talk.getByRole("textbox").press("Enter");
  await expect.poll(async () => (await probe(page)).team?.mates.mate_1).toBe("teammate.defend");
  expect((await probe(page)).team?.orders).toEqual(["act:command:teammate.follow:0", "act:command:teammate.defend:0"]);
  await expect.poll(async () => {
    const s = await probe(page);
    return flat(s.player!, s.cast!.mate_1!);
  }, { timeout: 15_000 }).toBeGreaterThan(7);

  // 3: get the orb. The mate heads for it
  await page.keyboard.press("Digit3");
  await expect.poll(async () => (await probe(page)).team?.mates.mate_1).toBe("teammate.attack");
  await expect(page.getByTestId("team-doing")).toContainText("going for the glowing orb");
  expect(errors).toEqual([]);
});

/** Walk toward a point on the floor (the glade's camera faces −z: W −z, S +z, D +x, A −x) until within `near` m. */
async function walkTo(page: Page, to: [number, number], near: number, timeout = 25_000) {
  const t0 = Date.now();
  const held = new Set<string>();
  const hold = async (want: Set<string>) => {
    for (const k of held) if (!want.has(k)) (await page.keyboard.up(k), held.delete(k));
    for (const k of want) if (!held.has(k)) (await page.keyboard.down(k), held.add(k));
  };
  try {
    while (Date.now() - t0 < timeout) {
      const p = (await probe(page)).player!;
      const [dx, dz] = [to[0] - p[0], to[1] - p[2]];
      if (Math.hypot(dx, dz) < near) return true;
      const want = new Set<string>();
      if (dz < -0.4) want.add("KeyW");
      if (dz > 0.4) want.add("KeyS");
      if (dx > 0.4) want.add("KeyD");
      if (dx < -0.4) want.add("KeyA");
      await hold(want);
      await page.waitForTimeout(60);
    }
    return false;
  } finally {
    await hold(new Set());
  }
}

test.fixme("a place's life: fireflies gather round you and a deer startles, ambient and outside the proof", async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  await open(page, "&fixture=glade");
  await expect(page.getByTestId("life-note")).toContainText("Ambient life: 16 fireflies, 2 deer and 2 owls");
  await expect.poll(async () => (await probe(page)).life?.kinds).toEqual(["firefly", "deer", "owl"]);
  const spec = (await probe(page)).specHash;
  expect(spec).toMatch(/^[0-9a-f]{64}$/);

  // fireflies: walk to the nearest swarm, and they gather round you
  let s = await probe(page);
  const flies = s.life!.creatures.filter((c) => c.kind === "firefly");
  const swarm = flies.reduce((a, c) => (flat(c.p, s.player!) < flat(a.p, s.player!) ? c : a));
  expect(await walkTo(page, swarm.p, 5)).toBe(true);
  await expect.poll(async () => {
    const x = await probe(page);
    return x.life!.creatures.filter((c) => c.kind === "firefly" && c.mood === "flock" && flat(c.p, x.player!) < 3.5).length;
  }, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);

  // a deer: come near and it startles, bolting away from you
  s = await probe(page);
  const deer = s.life!.creatures.map((c, i) => ({ ...c, i })).filter((c) => c.kind === "deer").reduce((a, c) => (flat(c.p, s.player!) < flat(a.p, s.player!) ? c : a));
  expect(await walkTo(page, deer.p, 5.5, 40_000)).toBe(true);
  await expect.poll(async () => (await probe(page)).life!.creatures[deer.i]!.reacted, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => {
    const x = await probe(page);
    return flat(x.life!.creatures[deer.i]!.p, x.player!);
  }, { timeout: 10_000 }).toBeGreaterThan(7);

  // the receipt's stamp: the place checked by its tour, the life said to be cosmetic
  await page.keyboard.press("KeyP");
  await expect(page.getByTestId("place-stamp")).toContainText("Place checked");
  await expect(page.getByTestId("place-stamp")).toContainText("walked to and inspected 3 of 3 things");
  await expect(page.getByTestId("place-stamp")).toContainText("ambient life (16 fireflies, 2 deer and 2 owls) is cosmetic");
  expect((await probe(page)).specHash).toBe(spec);

  // and with the life switched off, the same world hashes the same: it was never in it
  await open(page, "&fixture=glade&ff=persona_sliders,team_ai,-wander_life");
  await expect.poll(async () => (await probe(page)).specHash).toBe(spec);
  expect((await probe(page)).life).toBeUndefined();
  await expect(page.getByTestId("life-note")).toHaveCount(0);
  expect(errors).toEqual([]);
});
