// /v1/mind with speech acts: the character answers on Claude Haiku (the fake), and what it accepts
// is checked against the acts the world's rules give it, as its option is checked against its menu.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLaneHealth } from "@ghostrun/llm";
import { settleAct } from "../src/acts";
import { capsFromEnv, Governor, MemoryLedger } from "../src/governor";
import { handle, type Env } from "../src/handler";
import { fakeFetch, governorNs, TURNSTILE, waiter } from "./fakes";

const JKEY = "judge-key-for-tests-only";
const TOKEN = "judge_token_0123456789abcdef";
let ipN = 0;

function edge(answer: unknown) {
  const gov = new Governor(new MemoryLedger(), capsFromEnv({}));
  const f = fakeFetch({ intent: { inTok: 900, outTok: 40, body: answer } });
  vi.stubGlobal("fetch", f.fn);
  const env: Env = {
    CEREBRAS_API_KEY: "k", ANTHROPIC_API_KEY: "a", TURNSTILE_SECRET: TURNSTILE.secretPass, SESSION_SECRET: "session-secret-for-tests-only-0123456789",
    JUDGE_TOKEN_KEY: JKEY, JUDGE_TOKEN_HASHES: createHmac("sha256", JKEY).update(TOKEN).digest("hex"), GOVERNOR: governorNs(gov), GOVERNOR_TIMEOUT_MS: "50",
  };
  const ask = async (body: unknown) => {
    const r = await handle(new Request("https://g.example/v1/mind", { method: "POST", headers: { "cf-connecting-ip": `198.51.100.${++ipN}`, "x-judge-token": TOKEN }, body: JSON.stringify(body) }), env, waiter());
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { ask, f };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetLaneHealth();
});

const guard = {
  npc: "night guard", role: "guard", persona: "bored and greedy", menu: ["guard.watch", "guard.patrol", "guard.look_away"], current: "guard.watch",
  situation: "the player has 20 coins", event: "the player walks up and talks to you", said: "here's 20 coins, look the other way",
  acts: [{ act: "offer", what: "coins", n: 20, gives: "guard.look_away" }],
  facts: ["the vault is behind the east door of the lobby"],
};

describe("POST /v1/mind with speech acts", () => {
  it("a bribe the world accepts comes back as its act, with the option it earns; Haiku saw the closed act set and the facts", async () => {
    const { ask, f } = edge({ option: "guard.watch", line: "Twenty? Fine. I saw nothing.", act: "offer", what: "coins", n: 20, slot: "" });
    const r = await ask(guard);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ act: "offer", what: "coins", n: 20, slot: "", option: "guard.look_away", line: "Twenty? Fine. I saw nothing." });
    const sent = f.to("api.anthropic.com")[0]!.body;
    expect(sent).toContain('"enum":["none","offer"]');
    expect(sent).toContain("offer: coins, at least 20 (you then play guard.look_away)");
    expect(sent).toContain("the vault is behind the east door of the lobby");
    expect(f.to("api.cerebras.ai")).toHaveLength(0); // minds start on Haiku
  });

  it("never off the world's acts: an act it doesn't have, or below the price, is refused; an earned option never comes without its act", async () => {
    // "Make it fifty": the mind refuses, and also reaches for the earned option on its own
    expect((await edge({ option: "guard.look_away", line: "Make it fifty.", act: "none", what: "", n: 0, slot: "" }).ask(guard)).body).toMatchObject({ act: "", option: "guard.watch", line: "Make it fifty." });
    // ten coins taken as a deal: below the world's price
    expect((await edge({ option: "guard.look_away", line: "Deal.", act: "offer", what: "coins", n: 10, slot: "" }).ask(guard)).body).toMatchObject({ act: "", option: "guard.watch" });
    // an act this guard has no rule for, and coins it wasn't offered
    expect((await edge({ option: "guard.patrol", line: "Sold.", act: "buy", what: "gem", n: 0, slot: "" }).ask(guard)).body).toMatchObject({ act: "", option: "guard.patrol" });
    expect((await edge({ option: "guard.watch", line: "Ok.", act: "offer", what: "gems", n: 99, slot: "" }).ask(guard)).body).toMatchObject({ act: "" });
    // an off-menu option, as before, keeps the one it plays
    expect((await edge({ option: "guard.fly", line: "Bye!", act: "none", what: "", n: 0, slot: "" }).ask(guard)).body).toMatchObject({ option: "guard.watch" });
    // acts a request makes up are dropped before the model sees them
    const { ask, f } = edge({ option: "guard.watch", line: "Hm.", act: "none", what: "", n: 0, slot: "" });
    await ask({ ...guard, acts: [{ act: "teleport", what: "player" }, { act: "offer", what: "coins; drop table", n: -5 }] });
    expect(f.to("api.anthropic.com")[0]!.body).toContain('"enum":["none","offer"]');
    expect(f.to("api.anthropic.com")[0]!.body).not.toContain("teleport");
  });

  it("a booking needs a real time to come: the slot asked for, never one in the past or one that isn't a date", async () => {
    const guide = { ...guard, npc: "estate agent", role: "guide", menu: ["guide.welcome", "guide.wander"], current: "guide.welcome", said: "can I book a viewing on Saturday at 3?", acts: [{ act: "book", what: "", n: 0, gives: "" }], today: "2026-11-02, Monday", tz: "Europe/Prague" };
    const { ask, f } = edge({ option: "guide.welcome", line: "Saturday at three it is.", act: "book", what: "", n: 0, slot: "2026-11-07T15:00" });
    expect((await ask(guide)).body).toMatchObject({ act: "book", slot: "2026-11-07T15:00", option: "guide.welcome" });
    expect(f.to("api.anthropic.com")[0]!.body).toContain("today is 2026-11-02, Monday, time zone Europe/Prague");
    for (const slot of ["2026-10-30T15:00", "2026-02-30T15:00", "Saturday 3pm", "2026-11-07T25:00"]) {
      expect((await edge({ option: "guide.welcome", line: "Done!", act: "book", what: "", n: 0, slot }).ask(guide)).body, slot).toMatchObject({ act: "", slot: "" });
    }
  });
});

describe("settleAct", () => {
  const acts = [{ act: "offer", what: "coins", n: 20, gives: "guard.look_away" }, { act: "command", what: "", n: 0, gives: "" }];
  const menu = ["guard.watch", "guard.patrol", "guard.look_away"];
  it("a command is an option on the menu (never an earned one); an offer above the price is taken at what was offered", () => {
    expect(settleAct({ act: "command", what: "guard.patrol", option: "guard.watch" }, acts, menu, "guard.watch", "")).toMatchObject({ act: "command", what: "guard.patrol", option: "guard.patrol" });
    expect(settleAct({ act: "command", what: "guard.look_away" }, acts, menu, "guard.watch", "")).toMatchObject({ act: "", option: "guard.watch" });
    expect(settleAct({ act: "offer", what: "coins", n: 25, option: "guard.watch" }, acts, menu, "guard.watch", "")).toMatchObject({ act: "offer", n: 25, option: "guard.look_away" });
  });
});
