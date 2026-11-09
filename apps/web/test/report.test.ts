// The exported playtest report: one self-contained HTML file (nothing it would fetch, no scripts)
// saying what the receipt says in its own words, on the organizer's CTF brief proved as the app
// proves it (the ladder, then the playtest), and on the Feng Shui gallery for its section.
import { writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { splitObjects } from "@ghostrun/ir";
import { homage } from "@ghostrun/llm/homage";
import { loadNavNode } from "@ghostrun/nav/node";
import { bandLine, chipLineAt, prove, type Receipt } from "@ghostrun/proof";
import type { Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { fengShuiFor } from "../src/fengshui";
import { BRIEF, ENGINE_HASH, FIXTURE_PROMPTS, FIXTURES, hashWorld, worldFromFill, type World } from "../src/pipeline";
import { reportHtml } from "../src/report";

let R: Rapier;
beforeAll(async () => {
  R = await loadRapierNode();
  await loadNavNode();
});

const seedOf = (fill: string) => (JSON.parse(splitObjects(fill.split("\n", 1)[0]!)[0]!) as { seed: number }).seed;
const worldOf = (name: string): World => worldFromFill(FIXTURES[name]!, seedOf(FIXTURES[name]!));
const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

describe("the HTML playtest report", () => {
  let ctf: World;
  let receipt: Receipt;
  let html: string;
  let spec: string;
  beforeAll(async () => {
    ctf = worldOf("ctf");
    spec = await hashWorld(ctf.bundle);
    receipt = await prove(R, ctf.bundle, { engine: ENGINE_HASH, runs: 12, playtest: true });
    html = reportHtml({ bundle: ctf.bundle, spec, engine: ENGINE_HASH, receipt, prompt: BRIEF, link: "https://ghostrun.example/?s=abcdefghijklmnop", at: "2026-11-09T12:00:00.000Z" });
    // GR_REPORT=<file> keeps the report to look at
    if (process.env.GR_REPORT) writeFileSync(process.env.GR_REPORT, html);
  }, 180_000);

  it("is self-contained: nothing to fetch, no scripts, inline CSS, one document", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<script|<link\b|<img\b|<iframe|@import|url\(/i);
    expect(html).not.toMatch(/\bsrc=/i);
    // the only URLs are links to follow (the share link, the Feng Shui sources), never loaded
    for (const m of html.matchAll(/https?:\/\/[^\s"'<]+/g)) {
      const before = html.slice(Math.max(0, m.index! - 7), m.index!);
      expect(before.endsWith('href="') || before.endsWith(">") || m[0] === "http://www.w3.org/2000/svg", m[0]).toBe(true);
    }
  });

  it("says the prompt, the headline with its method, and every chip line exactly as the receipt does", () => {
    const text = unescape(html);
    expect(text).toContain(`<b>Prompt:</b> ${BRIEF}`);
    expect(receipt.headline?.text).toBe("Rooftop lane needs double jump");
    expect(text).toContain(`<b>Headline:</b> Rooftop lane needs double jump: <b class="verified">verified</b>`);
    expect(text).toContain(`(${receipt.headline!.method})`);
    for (const c of receipt.chips) expect(text).toContain(chipLineAt(c, receipt.host));
    expect(receipt.chips.length).toBeGreaterThan(5);
  });

  it("has the difficulty band and what the AI runners revealed: the heat map with the routes, where runs went wrong, the pacing", () => {
    const text = unescape(html);
    expect(receipt.playtest).toBeDefined();
    expect(text).toContain(bandLine(receipt.playtest!, receipt));
    expect(text).toContain("<h2>What the AI runners revealed</h2>");
    const svg = /<svg[^>]*>[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";
    expect(svg).toMatch(/viewBox="-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+"/);
    expect((svg.match(/fill="#ff5a1f"/g) ?? []).length).toBeGreaterThan(20); // heat cells
    expect((svg.match(/<polyline/g) ?? []).length).toBe(Math.min(24, receipt.trails!.length)); // the experts' routes
    expect(text).toMatch(/Pacing \(median first times\): .+ at \d+:\d\d/);
    expect(text).toMatch(/Nobody went near|Every route passed everything/);
  });

  it("ends with the spec and engine hashes and the share link", () => {
    expect(html).toContain(`Spec hash <code>${spec}</code>`);
    expect(html).toContain(`Engine hash <code>${ENGINE_HASH}</code>`);
    expect(html).toContain('<a href="https://ghostrun.example/?s=abcdefghijklmnop">');
    // with no link, it says why
    expect(reportHtml({ bundle: ctf.bundle, spec, engine: ENGINE_HASH, receipt, prompt: BRIEF, link: null })).toContain("no share link (the live service wasn't reachable");
  });

  it("an unproved world says so; a prompt that named brands shows the words typed and the homage built", () => {
    const typed = "Capture the flag at Hogwarts";
    const h = reportHtml({ bundle: ctf.bundle, spec, engine: ENGINE_HASH, receipt: null, prompt: typed, homages: homage(typed).homages, link: null });
    expect(h).toContain("Not proved yet");
    expect(unescape(h)).toContain("Homage: 'Hogwarts' → 'a wizard school castle'; we don't use trademarked names.");
    expect(h).toContain(`<b>Prompt:</b> ${typed}`);
  });

  it("escapes whatever the prompt holds", () => {
    const h = reportHtml({ bundle: ctf.bundle, spec, engine: ENGINE_HASH, receipt: null, prompt: `<script>alert("x")</script>`, link: `javascript:"x"` });
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
    expect(h).not.toContain("javascript:"); // only an http(s) link is linked
    expect(h).toContain("no share link");
  });

  it("the Feng Shui gallery: the section with each principle, its verdict and its source", async () => {
    const w = worldOf("fengshui-broken");
    const r = await prove(R, w.bundle, { engine: ENGINE_HASH, runs: 12 });
    const fs = fengShuiFor(w, FIXTURE_PROMPTS["fengshui-broken"]!)!.section;
    const h = unescape(reportHtml({ bundle: w.bundle, spec: await hashWorld(w.bundle), engine: ENGINE_HASH, receipt: r, prompt: FIXTURE_PROMPTS["fengshui-broken"]!, fengShui: fs, link: null }));
    expect(h).toContain("<h2>Feng Shui</h2>");
    expect(h).toContain("Feng Shui (Form School): 4 of 6 principles hold");
    expect(h).toContain("Fix: hang a curtain over the tall arched window");
    expect(h).toContain("<h2>Design notes</h2>");
    expect(h).toContain("Feng Shui: No straight line through: “hang a curtain over the tall arched window, or stand a tall plant between it and the front door”");
  }, 120_000);
});
