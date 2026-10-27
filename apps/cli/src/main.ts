// ghostrun CLI: verify a saved fill, build a world from a prompt with the live fast lane, or
// benchmark the fast lane over a prompt list (spike S2: our pipeline's timings, not vendor
// comparisons).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FillParser, mergeFill, parseFill, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { chatJson, fillMessages, IntentOut, intentJsonSchema, intentMessages, repairMessages, streamChat } from "@ghostrun/llm";
import { loadNavNode } from "@ghostrun/nav/node";
import { better, chipLine, issuesOf, prove, type Receipt } from "@ghostrun/proof";
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

function placeFromFill(text: string, seed: number, packId?: string): { bundle: WorldBundle; invalid: number; lines: number } {
  const fill = parseFill(text, { seed });
  if (packId) fill.draft.pack = { ...fill.draft.pack, id: packId };
  const pack = packFor(fill.draft.pack.id);
  const layout = pack.generate({ seed, params: pack.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  const placed = placeWorld({ ...fill.draft, engine: ENGINE }, layout);
  for (const n of fill.notes) console.log(`  · fill line ${n.line}: ${n.kind} — ${n.text}`);
  return { bundle: placed.bundle, invalid: fill.stats.invalid, lines: fill.stats.lines };
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
}

/** The gameplay lines of a fill (the repair call never needs the cosmetic tail). */
const gameplayOf = (fill: string) => {
  const lines = fill.split("\n");
  const end = lines.findIndex((l) => l.includes('"op":"end"') && l.includes('"gameplay"'));
  return (end >= 0 ? lines.slice(0, end + 1) : lines).join("\n");
};

/**
 * One counterexample-guided repair round: the receipt's failures go back to gpt-oss-120b as a
 * patch request; the patched fill is re-placed and re-proved, and kept only if it is better.
 */
async function repairRound(R: Awaited<ReturnType<typeof loadRapierNode>>, prompt: string, intent: IntentOut, fill: string, seed: number, packId: string, receipt: Receipt, bundle: WorldBundle, notes: string[]) {
  const key = process.env.CEREBRAS_API_KEY;
  const issues = issuesOf(receipt, bundle);
  if (!key || !issues.length) return null;
  const t0 = performance.now();
  const pack = packFor(packId);
  const layout = pack.generate({ seed, params: pack.defaults, sub: intent.sub, laws: bundle.laws, harder: false });
  const context = notes.filter((n) => !/^(interior|arena|outdoor|course|maze|rooftop|fall floor|lookout)/.test(n)).slice(0, 6);
  let patch = "";
  for await (const ev of streamChat({ apiKey: key, model: "gpt-oss-120b", reasoningEffort: "low", maxTokens: 4000, messages: repairMessages(prompt, intent, layout, gameplayOf(fill), [...issues, ...(context.length ? [`(already repaired by the placer: ${context.join("; ")})`] : [])]) })) {
    if (ev.type === "text") patch += ev.delta;
  }
  const merged = mergeFill(fill, patch);
  const placed = placeFromFill(merged.text, seed, packId);
  const r2 = await prove(R, placed.bundle, { engine: ENGINE, runs: 12 });
  return { fill: merged.text, receipt: r2, bundle: placed.bundle, kept: better(r2, receipt), issues, stats: merged.stats, ms: Math.round(performance.now() - t0) };
}

/** Things a player can interact with: kit verbs, carryables, moving platforms and minded NPCs. */
function controlsOf(b: WorldBundle): number {
  const on = new Set(b.verbs.filter((v) => v.on !== "player").map((v) => v.on));
  for (const c of b.cast) on.add(c.npc);
  return on.size;
}

async function build(prompt: string, seed: number, outDir: string | null): Promise<{ timings: BuildTimings; receipt: Receipt; intent: IntentOut; fill: string; controls: number }> {
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) throw new Error("CEREBRAS_API_KEY missing (put it in .dev.vars)");
  const now = () => performance.now();
  const t0 = now();

  // 1. intent (qwen-3.8-27b, strict schema, no reasoning)
  const intentRes = await chatJson<unknown>({
    apiKey: key,
    model: "qwen-3.8-27b",
    reasoningEffort: "none",
    messages: intentMessages(prompt, PACKS),
    jsonSchema: { name: "intent", schema: intentJsonSchema(PACKS.map((p) => p.id), ALL_SUBS) },
    maxTokens: 800,
  });
  const intent = v.parse(IntentOut, intentRes.value);
  const intentMs = Math.round(now() - t0);
  if (intent.safety === "block") throw new Error(`blocked by moderation: ${intent.setting}`);

  // 2. fill (gpt-oss-120b, streamed JSONL, low reasoning), parsed line by line as it arrives
  const chosen = packFor(intent.pack);
  const layout = chosen.generate({ seed, params: chosen.defaults, sub: intent.sub, laws: { gravityScale: 1, jumpH: 1.6, speed: 6, jumpsMax: 1, airControl: 0.6, coyoteMs: 120, bufferMs: 100, thrust: 0 }, harder: false });
  const example = readFileSync(resolve(import.meta.dirname, "../../../packages/ir/fixtures/ctf-neon.jsonl"), "utf8");
  const parser = new FillParser({ seed, pack: layout.packId });
  let fillText = "";
  let fillFirstTokenMs = -1;
  let firstEntityMs = -1;
  let gameplayEndMs = -1;
  let outTok = 0;
  for await (const ev of streamChat({ apiKey: key, model: "gpt-oss-120b", reasoningEffort: "low", maxTokens: 6000, messages: fillMessages(prompt, intent, layout, example, seed) })) {
    if (ev.type === "first_token") fillFirstTokenMs = Math.round(now() - t0);
    if (ev.type === "usage") outTok = ev.outTok;
    if (ev.type !== "text") continue;
    fillText += ev.delta;
    for (const e of parser.push(ev.delta)) {
      if (firstEntityMs < 0 && (e.op === "spawn" || e.op === "ent" || e.op === "goal")) firstEntityMs = Math.round(now() - t0);
      if (gameplayEndMs < 0 && e.op === "end") gameplayEndMs = Math.round(now() - t0);
    }
  }
  parser.end();
  const fillDoneMs = Math.round(now() - t0);
  if (gameplayEndMs < 0) gameplayEndMs = fillDoneMs;

  // 3. place + prove
  const { bundle, invalid, lines } = placeFromFill(fillText, seed, layout.packId);
  const playableMs = Math.round(now() - t0); // gameplay layer final + placed
  const R = await loadRapierNode();
  await loadNavNode();
  const receipt = await prove(R, bundle, { engine: ENGINE, runs: 12 });
  const proofMs = receipt.ms;

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    writeFileSync(join(outDir, `${slug}.fill.jsonl`), fillText);
    writeFileSync(join(outDir, `${slug}.receipt.json`), JSON.stringify({ prompt, intent, receipt }, null, 2));
  }
  return {
    timings: { intentMs, fillFirstTokenMs, firstEntityMs, gameplayEndMs, fillDoneMs, playableMs, proofMs, outTok, invalid, lines },
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
      if (args.includes("--repair") && existsSync(rp)) {
        const saved = JSON.parse(readFileSync(rp, "utf8")) as { prompt: string; intent: IntentOut };
        const fix = await repairRound(R, saved.prompt, saved.intent, text, meta.seed ?? 7, fill.draft.pack.id, r, placed.bundle, placed.notes);
        if (fix) {
          console.log(`  ${fix.kept ? "REPAIRED" : "rejected"} in ${fix.ms} ms (${JSON.stringify(fix.stats)}) → ${row(fix.receipt, fix.bundle)}`);
          for (const i of fix.issues) console.log(`    ? ${i.slice(0, 160)}`);
          writeFileSync(join(dir, f.replace(".fill.jsonl", ".repaired.jsonl")), fix.fill);
        }
        await new Promise((res) => setTimeout(res, 2500));
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
      await new Promise((r) => setTimeout(r, 13_000)); // free tier: qwen-3.8-27b allows 5 requests/min
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
