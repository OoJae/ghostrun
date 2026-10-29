// ghostrun CLI: verify a saved fill, build a world from a prompt with the live fast lane, or
// benchmark the fast lane over a prompt list (spike S2: our pipeline's timings, not vendor
// comparisons).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FillParser, layoutLaws, mergeFill, parseFill, pinLayout, splitObjects, type FillNote, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { directorMessages, editMessages, fillMessages, hostJsonSchema, hostMessages, IntentOut, intentJsonSchema, intentMessages, jsonLanes, lanesFor, mindJsonSchema, mindMessages, repairMessages, settleIntent, streamLanes, type JobCall, type Keys } from "@ghostrun/llm";
import { loadNavNode } from "@ghostrun/nav/node";
import { badness, better, caught, chipLine, insights, issuesOf, plants, prove, provedWon, traceRunners, type Receipt } from "@ghostrun/proof";
import { ALL_SUBS, PACKS, packFor } from "@ghostrun/registry";
import { loadRapierNode } from "@ghostrun/sim/node";
import * as v from "valibot";

const ENGINE = "dev-engine";

function loadDevVars() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const f = join(dir, ".dev.vars");
    if (existsSync(f)) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
      }
      return;
    }
    dir = dirname(dir);
  }
}

/** The providers a run may use: both (the fast lane, then Haiku when it's busy); GR_LANE pins one to measure it alone. */
function cliKeys(): Keys {
  const lane = process.env.GR_LANE;
  const keys = { cerebras: lane === "anthropic" ? undefined : process.env.CEREBRAS_API_KEY, anthropic: lane === "cerebras" ? undefined : process.env.ANTHROPIC_API_KEY };
  if (!keys.cerebras && !keys.anthropic) throw new Error("no model key (put CEREBRAS_API_KEY or ANTHROPIC_API_KEY in .dev.vars)");
  return keys;
}

function placeFromFill(text: string, seed: number, packId?: string, mode?: WorldBundle["mode"]): { bundle: WorldBundle; invalid: number; lines: number; notes: string[]; fillNotes: FillNote[] } {
  const fill = parseFill(text, { seed });
  if (packId) fill.draft.pack = { ...fill.draft.pack, id: packId };
  if (mode) fill.draft.mode = mode;
  const pack = packFor(fill.draft.pack.id);
  const layout = pack.generate({ seed, params: pack.defaults, sub: fill.draft.pack.sub, laws: layoutLaws(text, fill.draft.laws), harder: false });
  const placed = placeWorld({ ...fill.draft, engine: ENGINE }, layout);
  for (const n of fill.notes) console.log(`  · fill line ${n.line}: ${n.kind} — ${n.text}`);
  return { bundle: placed.bundle, invalid: fill.stats.invalid, lines: fill.stats.lines, notes: placed.notes, fillNotes: fill.notes };
}

function printReceipt(r: Receipt) {
  console.log(`\nRECEIPT spec ${r.spec.slice(0, 8)} · proved in ${r.ms} ms on ${r.host}`);
  if (r.headline) console.log(`HEADLINE: ${r.headline.text} — ${r.headline.status.toUpperCase()} (${r.headline.method})`);
  for (const c of r.chips) console.log(`  ${chipLine(c)}`);
  if (r.par) console.log(`  AI par ${r.par.goldS} s (${r.par.won} of ${r.par.runs} runners won)`);
}

interface BuildTimings {
  intentMs: number;
  fillFirstTokenMs: number;
  firstEntityMs: number;
  gameplayEndMs: number;
  fillDoneMs: number;
  playableMs: number;
  proofMs: number;
  outTok: number;
  invalid: number;
  lines: number;
  /** The models that answered (a fallback shows up here). */
  intentModel: string;
  fillModel: string;
}

/** The gameplay lines of a fill (the repair call never needs the cosmetic tail). */
const gameplayOf = (fill: string) => {
  const lines = fill.split("\n");
  const end = lines.findIndex((l) => l.includes('"op":"end"') && l.includes('"gameplay"'));
  return (end >= 0 ? lines.slice(0, end + 1) : lines).join("\n");
};

/**
 * One counterexample-guided repair round: the receipt's failures go back to the fill model as a
 * patch request; the patched fill is re-placed and re-proved, and kept only if it is better.
 */
async function repairRound(R: Awaited<ReturnType<typeof loadRapierNode>>, prompt: string, intent: IntentOut, fill: string, seed: number, packId: string, receipt: Receipt, bundle: WorldBundle, notes: string[], lines: FillNote[]) {
  const keys = cliKeys();
  const issues = issuesOf(receipt, bundle, lines);
  if (!issues.length) return null;
  const t0 = performance.now();
  const pack = packFor(packId);
  const layout = pack.generate({ seed, params: pack.defaults, sub: intent.sub, laws: bundle.laws, harder: false });
  const context = notes.filter((n) => !/^(interior|arena|outdoor|course|maze|rooftop|fall floor|lookout)/.test(n)).slice(0, 6);
  let patch = "";
  for await (const ev of streamLanes(lanesFor("patch", keys, { maxTokens: 4000, messages: repairMessages(prompt, intent, layout, gameplayOf(fill), [...issues, ...(context.length ? [`(already repaired by the placer: ${context.join("; ")})`] : [])]) }))) {
    if (ev.type === "text") patch += ev.delta;
  }
  const merged = mergeFill(fill, patch);
  const placed = placeFromFill(merged.text, seed, packId, intent.mode);
  const r2 = await prove(R, placed.bundle, { engine: ENGINE, runs: 12 });
  return { fill: merged.text, receipt: r2, bundle: placed.bundle, lines: placed.fillNotes, kept: better(r2, receipt), issues, stats: merged.stats, ms: Math.round(performance.now() - t0) };
}

/** Things a player can interact with: kit verbs, carryables, moving platforms and minded NPCs. */
function controlsOf(b: WorldBundle): number {
  const on = new Set(b.verbs.filter((v) => v.on !== "player").map((v) => v.on));
  for (const c of b.cast) on.add(c.npc);
  return on.size;
}

async function build(prompt: string, seed: number, outDir: string | null): Promise<{ timings: BuildTimings; receipt: Receipt; intent: IntentOut; fill: string; controls: number }> {
  const keys = cliKeys();
  const now = () => performance.now();
  const t0 = now();

  // 1. intent (strict schema, no reasoning)
  const intentRes = await jsonLanes<unknown>(lanesFor("intent", keys, { messages: intentMessages(prompt, PACKS), jsonSchema: { name: "intent", schema: intentJsonSchema(PACKS.map((p) => p.id), ALL_SUBS) }, maxTokens: 800 }));
  const intent = settleIntent(prompt, v.parse(IntentOut, intentRes.value));
  const intentMs = Math.round(now() - t0);
  if (intent.safety === "block") throw new Error(`blocked by moderation: ${intent.setting}`);

  // 2. fill (streamed JSONL), parsed line by line as it arrives
  const chosen = packFor(intent.pack);
  const layout = chosen.generate({ seed, params: chosen.defaults, sub: intent.sub, laws: { gravityScale: 1, jumpH: 1.6, speed: 6, jumpsMax: 1, airControl: 0.6, coyoteMs: 120, bufferMs: 100, thrust: 0 }, harder: false });
  const fx = (f: string) => readFileSync(resolve(import.meta.dirname, `../../../packages/ir/fixtures/${f}`), "utf8");
  const choice = process.env.GR_EXAMPLE ?? "vault"; // A/B the fill example (vault is the default, as at the edge)
  const example = choice === "both" ? [fx("ctf-neon.jsonl"), fx("vault-heist.jsonl")] : fx(choice === "vault" ? "vault-heist.jsonl" : choice === "coin" ? "coin-rush.jsonl" : "ctf-neon.jsonl");
  const parser = new FillParser({ seed, pack: layout.packId });
  let fillText = "";
  let fillFirstTokenMs = -1;
  let firstEntityMs = -1;
  let gameplayEndMs = -1;
  let outTok = 0;
  let fillModel = "";
  for await (const ev of streamLanes(lanesFor("fill", keys, { maxTokens: 6000, messages: fillMessages(prompt, intent, layout, example, seed) }))) {
    if (ev.type === "first_token") fillFirstTokenMs = Math.round(now() - t0);
    if (ev.type === "fallback") console.log(`  · ${ev.from} answered ${ev.status}: the fill falls back to ${ev.to}`);
    if (ev.type === "usage") [outTok, fillModel] = [ev.outTok, ev.model];
    if (ev.type !== "text") continue;
    fillText += ev.delta;
    for (const e of parser.push(ev.delta)) {
      if (firstEntityMs < 0 && (e.op === "spawn" || e.op === "ent" || e.op === "goal")) firstEntityMs = Math.round(now() - t0);
      if (gameplayEndMs < 0 && e.op === "end") gameplayEndMs = Math.round(now() - t0);
    }
  }
  parser.end();
  fillText = fillText.split("\n").flatMap(splitObjects).join("\n"); // one object per line, as stored
  const fillDoneMs = Math.round(now() - t0);
  if (gameplayEndMs < 0) gameplayEndMs = fillDoneMs;

  // 3. place + prove
  const { bundle, invalid, lines } = placeFromFill(fillText, seed, layout.packId, intent.mode);
  const playableMs = Math.round(now() - t0); // gameplay layer final + placed
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  if (outDir) {
    // recorded before the proof runs, so a world that crashes it is kept to reproduce
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${slug}.fill.jsonl`), fillText);
    writeFileSync(join(outDir, `${slug}.receipt.json`), JSON.stringify({ prompt, intent, receipt: null }, null, 2));
  }
  const R = await loadRapierNode();
  await loadNavNode();
  const receipt = await prove(R, bundle, { engine: ENGINE, runs: 12 });
  const proofMs = receipt.ms;
  // (the runners' routes and the par runner's ghost stay out of the recorded receipt: they're for the app, and large)
  if (outDir) writeFileSync(join(outDir, `${slug}.receipt.json`), JSON.stringify({ prompt, intent, receipt: { ...receipt, trails: undefined, ghost: undefined } }, null, 2));
  return {
    timings: { intentMs, fillFirstTokenMs, firstEntityMs, gameplayEndMs, fillDoneMs, playableMs, proofMs, outTok, invalid, lines, intentModel: intentRes.model, fillModel },
    receipt,
    intent,
    fill: fillText,
    controls: controlsOf(bundle),
  };
}

async function main() {
  loadDevVars();
  const [cmd, ...args] = process.argv.slice(2);
  const seed = Number(args[args.indexOf("--seed") + 1]) || 7;
  if (cmd === "verify") {
    const R = await loadRapierNode();
    await loadNavNode();
    const { bundle } = placeFromFill(readFileSync(args[0]!, "utf8"), seed);
    printReceipt(await prove(R, bundle, { engine: ENGINE }));
  } else if (cmd === "diagnose") {
    // one recorded world, taken apart: what the placer repaired, the receipt, and what one AI
    // runner did step by step (where it got stuck, and on what)
    const f = args[0]!;
    const text = readFileSync(f, "utf8");
    const rp = f.replace(".fill.jsonl", ".receipt.json");
    const saved = existsSync(rp) ? (JSON.parse(readFileSync(rp, "utf8")) as { prompt?: string; intent?: IntentOut }) : {};
    const s0 = (JSON.parse(splitObjects(text.split("\n", 1)[0] ?? "{}")[0] ?? "{}") as { seed?: number }).seed ?? seed;
    const placed = placeFromFill(text, s0, saved.intent?.pack, saved.intent?.mode);
    console.log(`PROMPT: ${saved.prompt ?? "?"}`);
    for (const n of placed.notes) console.log(`  · ${n}`);
    if (args.includes("--ents")) for (const e of placed.bundle.entities) console.log(`  ${e.id} ${e.kind}/${e.body} at ${e.pos.map((x) => x.toFixed(1)).join(",")} size ${e.size.join("×")}${e.team ? ` team ${e.team}` : ""}`);
    const R = await loadRapierNode();
    await loadNavNode();
    printReceipt(await prove(R, placed.bundle, { engine: ENGINE, runs: 12 }));
    const runs = Number(args[args.indexOf("--runs") + 1]) || 1; // trace this many runners
    const log: string[] = [];
    traceRunners((m) => void (log.length < 200 * runs && log.push(m)));
    await prove(R, placed.bundle, { engine: ENGINE, runs });
    traceRunners(null);
    console.log(["RUNNERS:", ...log.map((l) => `  ${l}`)].join("\n"));
  } else if (cmd === "build") {
    const prompt = args[0]!;
    console.log(`PROMPT: ${prompt}`);
    const r = await build(prompt, seed, args.includes("--out") ? args[args.indexOf("--out") + 1]! : null);
    console.log(`INTENT: ${JSON.stringify(r.intent)}`);
    console.log(`TIMINGS (ms): ${JSON.stringify(r.timings)}`);
    printReceipt(r.receipt);
  } else if (cmd === "rebench") {
    // re-prove saved live fills offline (no LLM calls): what the deterministic repairs buy
    const dir = args[0]!;
    const R = await loadRapierNode();
    await loadNavNode();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".fill.jsonl")).sort()) {
      const text = readFileSync(join(dir, f), "utf8");
      const meta = JSON.parse(text.split("\n", 1)[0] ?? "{}") as { seed?: number };
      const fill = parseFill(text, { seed: meta.seed ?? 7 });
      const rp = join(dir, f.replace(".fill.jsonl", ".receipt.json"));
      const intentPack = existsSync(rp) ? (JSON.parse(readFileSync(rp, "utf8")) as { intent?: { pack?: string } }).intent?.pack : undefined;
      if (intentPack) fill.draft.pack = { ...fill.draft.pack, id: intentPack }; // the layout the fill was written against
      const intentMode = existsSync(rp) ? (JSON.parse(readFileSync(rp, "utf8")) as { intent?: { mode?: WorldBundle["mode"] } }).intent?.mode : undefined;
      if (intentMode) fill.draft.mode = intentMode;
      const pack = packFor(fill.draft.pack.id);
      const layout = pack.generate({ seed: meta.seed ?? 7, params: pack.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
      const placed = placeWorld({ ...fill.draft, engine: ENGINE }, layout);
      const r = await prove(R, placed.bundle, { engine: ENGINE, runs: 12 });
      const row = (rc: Receipt, bd: WorldBundle) => {
        const win = rc.chips.find((c) => c.id === "T3:win");
        const bad = rc.chips.filter((c) => c.status === "counterexample").map((c) => c.id);
        return `${bd.mode.padEnd(6)} ctrl ${String(controlsOf(bd)).padStart(2)}  headline ${(rc.headline?.status ?? "none").padEnd(14)} T3 ${win ? `${win.k}/${win.n}` : "-"}  par ${rc.par?.goldS ?? "-"}  ${bad.length ? "✗ " + bad.join(" ") : ""}`;
      };
      console.log(`${f.slice(0, 40).padEnd(40)} ${row(r, placed.bundle)}`);
      if (!args.includes("--repair")) for (const n of placed.notes.filter((x) => !x.startsWith("interior") && !x.startsWith("arena") && !x.startsWith("outdoor") && !x.startsWith("course"))) console.log(`    · ${n}`);
      // what the repair loop would send for it (offline: no model is asked)
      if (args.includes("--issues")) for (const i of issuesOf(r, placed.bundle, fill.notes)) console.log(`    ? ${i}`);
      if (args.includes("--repair") && existsSync(rp)) {
        const saved = JSON.parse(readFileSync(rp, "utf8")) as { prompt: string; intent: IntentOut };
        // up to three rounds, as the app does: each accepted patch is the base for the next
        let [curFill, curReceipt, curBundle, curNotes, curLines] = [text, r, placed.bundle, placed.notes, fill.notes];
        for (let round = 1; round <= 3; round++) {
          const fix = await repairRound(R, saved.prompt, saved.intent, curFill, meta.seed ?? 7, fill.draft.pack.id, curReceipt, curBundle, curNotes, curLines);
          if (!fix) break;
          console.log(`  round ${round}: ${fix.kept ? "REPAIRED" : "rejected"} in ${fix.ms} ms (${JSON.stringify(fix.stats)}) → ${row(fix.receipt, fix.bundle)}`);
          for (const i of fix.issues) console.log(`    ? ${i.slice(0, 160)}`);
          await new Promise((res) => setTimeout(res, 2500));
          if (!fix.kept) break;
          writeFileSync(join(dir, f.replace(".fill.jsonl", ".repaired.jsonl")), fix.fill);
          [curFill, curReceipt, curBundle, curNotes, curLines] = [fix.fill, fix.receipt, fix.bundle, [], fix.lines];
        }
      }
    }
  } else if (cmd === "edits") {
    // live edits on saved live worlds, re-proved offline: does each change land, and what does it do to the receipt?
    const dir = args[0]!;
    const changes = readFileSync(args[1]!, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const limit = Number(args[args.indexOf("--worlds") + 1]) || 6;
    const keys = cliKeys();
    const R = await loadRapierNode();
    await loadNavNode();
    const row = (rc: Receipt, bd: WorldBundle) => {
      const win = rc.chips.find((c) => c.id === "T3:win");
      const bad = rc.chips.filter((c) => c.status === "counterexample").map((c) => c.id);
      return `ctrl ${String(controlsOf(bd)).padStart(2)} headline ${(rc.headline?.status ?? "none").padEnd(14)} T3 ${win ? `${win.k}/${win.n}` : "-"} par ${rc.par?.goldS ?? "-"}${bad.length ? `  ✗ ${bad.join(" ")}` : ""}`;
    };
    const rows: unknown[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".fill.jsonl")).sort().slice(0, limit)) {
      const rp = join(dir, f.replace(".fill.jsonl", ".receipt.json"));
      if (!existsSync(rp)) continue;
      const saved = JSON.parse(readFileSync(rp, "utf8")) as { prompt: string; intent: IntentOut };
      const text0 = pinLayout(readFileSync(join(dir, f), "utf8"));
      const s0 = (JSON.parse(text0.split("\n", 1)[0] ?? "{}") as { seed?: number }).seed ?? 7;
      const base = placeFromFill(text0, s0, saved.intent.pack, saved.intent.mode);
      const r0 = await prove(R, base.bundle, { engine: ENGINE, runs: 12 });
      console.log(`\n${saved.prompt.slice(0, 90)}\n  before                     ${row(r0, base.bundle)}`);
      const pack = packFor(saved.intent.pack);
      const layout = pack.generate({ seed: s0, params: pack.defaults, sub: saved.intent.sub, laws: base.bundle.laws, harder: false });
      for (const change of changes) {
        let patch = "";
        let ms = 0;
        for (let attempt = 0; ; attempt++) {
          const t0 = performance.now();
          try {
            patch = "";
            for await (const ev of streamLanes(lanesFor("patch", keys, { maxTokens: 4000, messages: editMessages(saved.prompt, change, saved.intent, layout, gameplayOf(text0)) }))) if (ev.type === "text") patch += ev.delta;
            ms = Math.round(performance.now() - t0);
            break;
          } catch (e) {
            if (attempt >= 3 || !(e instanceof Error && /429/.test(e.message))) throw e;
            await new Promise((res) => setTimeout(res, 20_000)); // free tier: back off on the per-minute limit
          }
        }
        const merged = mergeFill(text0, patch, { edit: true });
        const placed = placeFromFill(merged.text, s0, saved.intent.pack, saved.intent.mode);
        const r1 = await prove(R, placed.bundle, { engine: ENGINE, runs: 12 });
        const same = merged.text.trim() === text0.trim();
        console.log(`  ${change.slice(0, 26).padEnd(26)} ${row(r1, placed.bundle)}   [${ms} ms, ${same ? "NO CHANGE" : JSON.stringify(merged.stats)}]`);
        rows.push({ prompt: saved.prompt, change, ms, patch, changed: !same, stats: merged.stats, before: { headline: r0.headline?.status ?? null, par: r0.par?.goldS ?? null, controls: controlsOf(base.bundle) }, after: { headline: r1.headline?.status ?? null, par: r1.par?.goldS ?? null, controls: controlsOf(placed.bundle), won: r1.chips.find((c) => c.id === "T3:win")?.k ?? 0, cx: r1.chips.filter((c) => c.status === "counterexample").map((c) => c.id) } });
        await new Promise((res) => setTimeout(res, 6000));
      }
    }
    if (args.includes("--out")) writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify(rows, null, 2));
  } else if (cmd === "trust") {
    // the numbers behind "Why trust this?": every committed eval set's first-pass live results
    // (bench.json, as the live lane produced them) and its worlds re-proved with today's code
    const root = args[0]!;
    const out = args[args.indexOf("--out") + 1]!;
    const R = await loadRapierNode();
    await loadNavNode();
    const sets: unknown[] = [];
    for (const name of readdirSync(root).filter((d) => existsSync(join(root, d, "bench.json"))).sort()) {
      const dir = join(root, name);
      const bench = JSON.parse(readFileSync(join(dir, "bench.json"), "utf8")) as { prompt: string; t3win?: string; playableMs?: number; controls?: number }[];
      const header = existsSync(join(root, "..", `prompts-${name}.txt`)) ? (readFileSync(join(root, "..", `prompts-${name}.txt`), "utf8").split("\n").find((l) => l.startsWith("#")) ?? "").replace(/^#\s*/, "") : "";
      let play = 0, places = 0, toured = 0, touredFirst = 0, firstPass = 0, now = 0;
      const controls: number[] = [];
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".fill.jsonl")).sort()) {
        const text = readFileSync(join(dir, f), "utf8");
        const saved = JSON.parse(readFileSync(join(dir, f.replace(".fill.jsonl", ".receipt.json")), "utf8")) as { prompt: string; intent: IntentOut; receipt?: Receipt | null };
        const seed = (JSON.parse(splitObjects(text.split("\n", 1)[0] ?? "{}")[0] ?? "{}") as { seed?: number }).seed ?? 7;
        const placed = placeFromFill(text, seed, saved.intent.pack, saved.intent.mode);
        if (saved.intent.mode === "wander") {
          // a place is proved by its tour: an AI visitor walks to and uses everything in it (first
          // pass from the receipt recorded when the live lane built it)
          places++;
          const first = saved.receipt?.chips.find((c) => c.id === "T3:tour");
          if (saved.receipt && (!first || first.status === "played")) touredFirst++;
          const r = await prove(R, placed.bundle, { engine: ENGINE, runs: 12 }).catch(() => null);
          const tour = r?.chips.find((c) => c.id === "T3:tour");
          if (!tour || tour.status === "played") toured++;
          else console.log(`  not toured: ${name}/${f.replace(".fill.jsonl", "")} · ${tour.k} of ${tour.n} (${tour.cx?.text ?? ""})`);
          continue;
        }
        play++;
        controls.push(controlsOf(placed.bundle));
        const r = await prove(R, placed.bundle, { engine: ENGINE, runs: 12 }).catch((e: unknown) => {
          console.log(`  ${f}: the proof crashed (${String(e).slice(0, 120)})`);
          return null;
        });
        const won = r?.chips.find((c) => c.id === "T3:win");
        if ((won?.k ?? 0) >= 10) now++;
        else console.log(`  not won: ${name}/${f.replace(".fill.jsonl", "")} · ${won ? `${won.k} of ${won.n}` : (r?.chips.find((c) => c.status === "counterexample")?.text ?? "no T3")}`);
        if (/^(1[0-2])\/12$/.test(bench.find((x) => x.prompt === saved.prompt)?.t3win ?? "")) firstPass++;
      }
      // a prompt the live lane crashed on left no world to re-prove: it counts as lost in both columns
      const recorded = new Set(readdirSync(dir).filter((x) => x.endsWith(".receipt.json")).map((x) => (JSON.parse(readFileSync(join(dir, x), "utf8")) as { prompt: string }).prompt));
      for (const row of bench as { prompt: string; error?: string }[]) {
        if (!row.error || recorded.has(row.prompt)) continue;
        play++;
        console.log(`  crashed on the live lane, counted as lost: ${row.prompt}`);
      }
      const ms = bench.map((x) => x.playableMs).filter((x): x is number => typeof x === "number").sort((x, y) => x - y);
      const mid = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)]! : null);
      sets.push({ name, note: header, prompts: bench.length, play, places, touredFirst, toured, firstPass, now, playableP50Ms: mid(ms), controlsP50: mid([...controls].sort((x, y) => x - y)) });
      console.log(`${name}: ${play} play worlds, first pass ${firstPass}, now ${now}; ${places} places, fully toured ${touredFirst} first pass, ${toured} now`);
    }
    // the planted-bug results (ghostrun fool) are kept until that is run again
    const fool = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as { fool?: unknown }).fool : undefined;
    writeFileSync(out, `${JSON.stringify({ generated: new Date().toISOString().slice(0, 10), won: "at least 10 of 12 AI runners win in physics", sets, ...(fool ? { fool } : {}) }, null, 1)}\n`);
  } else if (cmd === "gallery-add") {
    // recorded live worlds into the web gallery, unedited: each is proved first and only a won one
    // goes in ("honest receipt" when runners win but the world's own headline claim fails)
    const dir = resolve(import.meta.dirname, "../../web/src/gallery");
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { slug: string; prompt: string; pack: string; mode: string; honest?: boolean }[];
    const R = await loadRapierNode();
    await loadNavNode();
    for (const f of args.filter((x) => x.endsWith(".fill.jsonl"))) {
      const text = readFileSync(f, "utf8");
      const saved = JSON.parse(readFileSync(f.replace(".fill.jsonl", ".receipt.json"), "utf8")) as { prompt: string; intent: IntentOut };
      const slug = saved.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      if (index.some((e) => e.slug === slug || e.prompt === saved.prompt)) {
        console.log(`  already in: ${saved.prompt}`);
        continue;
      }
      const seed = (JSON.parse(splitObjects(text.split("\n", 1)[0] ?? "{}")[0] ?? "{}") as { seed?: number }).seed ?? 7;
      const { bundle } = placeFromFill(text, seed, saved.intent.pack, saved.intent.mode);
      const r = await prove(R, bundle, { engine: ENGINE, runs: 12 });
      const place = saved.intent.mode === "wander";
      if (!place && !provedWon(r)) {
        console.log(`  not won, left out: ${saved.prompt}`);
        continue;
      }
      const honest = !place && r.headline?.status === "counterexample";
      writeFileSync(join(dir, "worlds", `${slug}.json`), JSON.stringify({ prompt: saved.prompt, intent: saved.intent, fill: text }));
      index.push({ slug, prompt: saved.prompt, pack: saved.intent.pack, mode: saved.intent.mode, ...(honest ? { honest: true } : {}) });
      console.log(`  added${honest ? " (honest receipt)" : ""}: ${saved.prompt}`);
    }
    writeFileSync(join(dir, "index.json"), `${JSON.stringify(index, null, 1)}\n`);
  } else if (cmd === "fool") {
    // "Try to fool it", at scale: plant every bug that applies (the goal 40 m up, the key gone, a
    // condition nothing meets, a 5 s countdown, no jumping on a course) in every committed world the
    // proof says is won, and count how many the proof catches, and by which check
    const root = args[0]!;
    const R = await loadRapierNode();
    await loadNavNode();
    let worlds = 0;
    let planted = 0;
    let got = 0;
    const byTier = new Map<string, number>();
    const byKind = new Map<string, [number, number]>();
    const missed: string[] = [];
    for (const name of readdirSync(root).filter((d) => existsSync(join(root, d, "bench.json"))).sort()) {
      const dir = join(root, name);
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".fill.jsonl")).sort()) {
        const text = readFileSync(join(dir, f), "utf8");
        const saved = JSON.parse(readFileSync(join(dir, f.replace(".fill.jsonl", ".receipt.json")), "utf8")) as { intent: IntentOut };
        const seed = (JSON.parse(splitObjects(text.split("\n", 1)[0] ?? "{}")[0] ?? "{}") as { seed?: number }).seed ?? 7;
        const { bundle } = placeFromFill(text, seed, saved.intent.pack, saved.intent.mode);
        if (bundle.mode !== "play") continue;
        const before = await prove(R, bundle, { engine: ENGINE, runs: 12 });
        if (!provedWon(before)) continue;
        const ps = plants(bundle, before.par?.goldS ?? null);
        if (!ps.length) continue;
        worlds++;
        for (const p of ps) {
          const after = await prove(R, p.bundle, { engine: ENGINE, runs: 12 }).catch(() => null);
          const c = after ? caught(after) : { caught: false, by: null };
          planted++;
          const k = byKind.get(p.id) ?? [0, 0];
          byKind.set(p.id, [k[0] + 1, k[1] + (c.caught ? 1 : 0)]);
          if (c.caught) {
            got++;
            const t = c.by?.tier ?? "?";
            byTier.set(t, (byTier.get(t) ?? 0) + 1);
          } else missed.push(`${name}/${f.replace(".fill.jsonl", "")}: ${p.text}`);
        }
      }
    }
    console.log(`planted ${planted} bugs in ${worlds} worlds the proof says are won: caught ${got} (${[...byTier].map(([t, n]) => `${t} ${n}`).join(", ")})`);
    for (const [k, [n, c]] of byKind) console.log(`  ${k}: ${c} of ${n}`);
    for (const m of missed) console.log(`  missed: ${m}`);
    if (args.includes("--out")) {
      const out = args[args.indexOf("--out") + 1]!;
      const t = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
      t.fool = { worlds, planted, caught: got, byTier: Object.fromEntries(byTier), byKind: Object.fromEntries([...byKind].map(([k, [n, c]]) => [k, { planted: n, caught: c }])) };
      writeFileSync(out, `${JSON.stringify(t, null, 1)}\n`);
    }
  } else if (cmd === "director") {
    // the Director's cut on saved live worlds, re-proved offline: how long it takes, what it adds,
    // and whether the reworked world still plays at least as well (the rule the app offers it by)
    const dir = args[0]!;
    const limit = Number(args[args.indexOf("--worlds") + 1]) || 6;
    const skip = args.includes("--start") ? Number(args[args.indexOf("--start") + 1]) : 0;
    const keys = cliKeys();
    const R = await loadRapierNode();
    await loadNavNode();
    const win = (r: Receipt) => r.chips.find((c) => c.id === "T3:win");
    const rows: unknown[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".fill.jsonl")).sort().slice(skip, skip + limit)) {
      const rp = join(dir, f.replace(".fill.jsonl", ".receipt.json"));
      if (!existsSync(rp)) continue;
      const saved = JSON.parse(readFileSync(rp, "utf8")) as { prompt: string; intent: IntentOut };
      const text0 = pinLayout(readFileSync(join(dir, f), "utf8"));
      const s0 = (JSON.parse(splitObjects(text0.split("\n", 1)[0] ?? "{}")[0] ?? "{}") as { seed?: number }).seed ?? 7;
      const base = placeFromFill(text0, s0, saved.intent.pack, saved.intent.mode);
      const r0 = await prove(R, base.bundle, { engine: ENGINE, runs: 12 });
      const seen = insights(base.bundle, r0.trails ?? []);
      const notes = [
        r0.headline ? `headline "${r0.headline.text}": ${r0.headline.status}` : "",
        win(r0) ? `AI runners won ${win(r0)!.k} of ${win(r0)!.n}${r0.par ? `, par ${r0.par.goldS} s` : ""}` : "",
        `${controlsOf(base.bundle)} things to use`,
        seen.unused.length ? `nobody went near: ${seen.unused.map((u) => u.noun).slice(0, 5).join(", ")}` : "",
        ...r0.chips.filter((c) => c.status === "counterexample").map((c) => `failing: ${c.text}`).slice(0, 3),
      ].filter(Boolean);
      const pack = packFor(saved.intent.pack);
      const layout = pack.generate({ seed: s0, params: pack.defaults, sub: saved.intent.sub, laws: base.bundle.laws, harder: false });
      const t0 = performance.now();
      let patch = "";
      let first = -1;
      let model = "";
      let tok = [0, 0];
      try {
        for await (const ev of streamLanes(lanesFor("director", keys, { maxTokens: 6000, messages: directorMessages(saved.prompt, saved.intent, layout, gameplayOf(text0), notes) }))) {
          if (ev.type === "first_token") first = Math.round(performance.now() - t0);
          if (ev.type === "usage") [model, tok] = [ev.model, [ev.inTok, ev.outTok]];
          if (ev.type === "text") patch += ev.delta;
        }
      } catch (e) {
        console.log(`${saved.prompt.slice(0, 60)}  ERROR ${String(e).slice(0, 160)}`);
        continue;
      }
      const ms = Math.round(performance.now() - t0);
      const merged = mergeFill(text0, patch, { edit: true });
      const placed = placeFromFill(merged.text, s0, saved.intent.pack, saved.intent.mode);
      const r1 = await prove(R, placed.bundle, { engine: ENGINE, runs: 12 });
      const kept = (w0: ReturnType<typeof win>, w1: ReturnType<typeof win>) => !w0 || (w1 !== undefined && w1.k >= Math.min(w0.k, 10));
      const ok = badness(r1) <= badness(r0) && kept(win(r0), win(r1)) && controlsOf(placed.bundle) > controlsOf(base.bundle);
      const personas = placed.bundle.cast.filter((c) => c.persona?.identity).length;
      const row = { prompt: saved.prompt, model, ms, firstMs: first, inTok: tok[0], outTok: tok[1], stats: merged.stats, controls: [controlsOf(base.bundle), controlsOf(placed.bundle)], rules: [base.bundle.rules.length, placed.bundle.rules.length], npcs: [base.bundle.cast.length, placed.bundle.cast.length], personas, t3: [win(r0) ? `${win(r0)!.k}/${win(r0)!.n}` : "-", win(r1) ? `${win(r1)!.k}/${win(r1)!.n}` : "-"], headline: [r0.headline?.status ?? "none", r1.headline?.status ?? "none"], badness: [badness(r0), badness(r1)], offered: ok, failing: r1.chips.filter((c) => c.status === "counterexample").map((c) => `${c.id}: ${c.text}${c.cx ? ` (${c.cx.text})` : ""}`), patch };
      rows.push(row);
      console.log(`${saved.prompt.slice(0, 50).padEnd(50)} ${ok ? "OFFER" : "no   "} ${String(ms).padStart(6)} ms  ctrl ${row.controls.join("→")}  rules ${row.rules.join("→")}  npc ${row.npcs.join("→")} (${personas} voiced)  T3 ${row.t3.join("→")}  head ${row.headline.join("→")}  ${tok[1]} tok`);
      if (!ok) for (const x of row.failing) console.log(`    ✗ ${x.slice(0, 200)}`);
    }
    if (args.includes("--out")) writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify(rows, null, 2));
  } else if (cmd === "canary") {
    // every structured-output job on each lane on its own (no failover): does each schema still
    // answer, how fast, and with what. The plan's twice-daily canary; also how we pick a lane per job.
    const keys = cliKeys();
    const menu = ["guard.patrol", "guard.chase", "guard.investigate"];
    const jobs: Record<"intent" | "mind" | "host", JobCall> = {
      intent: { messages: intentMessages("a maze with ghosts and a key that opens the exit", PACKS), jsonSchema: { name: "intent", schema: intentJsonSchema(PACKS.map((p) => p.id), ALL_SUBS) }, maxTokens: 800 },
      mind: { messages: mindMessages({ npc: "guard_1", role: "guard", persona: "Gruff but fair; hates noise.", menu, current: "guard.patrol", situation: "The vault corridor. The player is 4 m away, carrying the key.", event: "the player picked up the key" }), jsonSchema: { name: "mind", schema: mindJsonSchema(menu) }, maxTokens: 120 },
      host: { messages: hostMessages("why did I lose?", ["0:12 you fell into the lava pit", "the lava pit lies between the start and the key", "you had 1 jump"]), jsonSchema: { name: "host", schema: hostJsonSchema(3) }, maxTokens: 200 },
    };
    const times = Number(args[args.indexOf("--repeat") + 1]) || 1;
    for (const [job, call] of Object.entries(jobs) as [keyof typeof jobs, JobCall][]) {
      for (const lane of lanesFor(job, keys, call)) {
        for (let n = 0; n < times; n++) {
          const t0 = performance.now();
          try {
            const r = await jsonLanes<Record<string, unknown>>([{ ...lane, retryMs: [] }]);
            console.log(`${job.padEnd(7)} ${lane.model.padEnd(18)} ${String(Math.round(performance.now() - t0)).padStart(5)} ms  ${JSON.stringify(r.value).slice(0, 110)}`);
          } catch (e) {
            console.log(`${job.padEnd(7)} ${lane.model.padEnd(18)} FAILED ${String(e).slice(0, 160)}`);
          }
        }
      }
    }
  } else if (cmd === "bench") {
    const prompts = readFileSync(args[0]!, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const outDir = args.includes("--out") ? args[args.indexOf("--out") + 1]! : "bench-out";
    const rows: unknown[] = [];
    for (const [i, p] of prompts.entries()) {
      try {
        const r = await build(p, seed + i, outDir);
        const headline = r.receipt.headline?.status ?? "none";
        const win = r.receipt.chips.find((c) => c.id === "T3:win");
        const tooEasy = r.receipt.chips.some((c) => c.id === "T3:too_easy");
        rows.push({ prompt: p, pack: r.intent.pack, ...r.timings, controls: r.controls, headline, t3win: win ? `${win.k}/${win.n}` : "-", par: r.receipt.par?.goldS ?? null, tooEasy, chips: r.receipt.chips.length });
        console.log(`[${i + 1}/${prompts.length}] ${JSON.stringify(rows.at(-1))}`);
      } catch (e) {
        rows.push({ prompt: p, error: String(e) });
        console.log(`[${i + 1}/${prompts.length}] ERROR ${String(e).slice(0, 200)}`);
      }
      await new Promise((r) => setTimeout(r, process.env.GR_LANE === "anthropic" ? 1000 : 13_000)); // free tier: qwen-3.8-27b allows 5 requests/min
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "bench.json"), JSON.stringify(rows, null, 2));
  } else {
    console.log('usage: ghostrun verify <fill.jsonl> | build "<prompt>" [--out dir] | bench <prompts.txt> [--out dir]');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
