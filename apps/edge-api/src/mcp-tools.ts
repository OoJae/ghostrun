// The MCP tools: build, change and check GHOSTRUN worlds from any agent. Each tool runs on the
// edge's own routes, in-process (the build, edit and share routes gate the caller, spend against
// the governor and use the build cache exactly as they do for the web app), places the world as the
// web client does (world.ts) and proves what can be proved without physics: T0 (the rule graph) and
// T1 (the kinematic models). The cloud proof (POST /v1/proof) answers for the whole ladder; when it
// doesn't (off, rate limited), the share link is where the AI runners prove the rest, on whoever opens it.
import { FillParser, logicOf, mergeFill, pinLayout, ruleText, splitObjects, thingLabel, type WorldBundle } from "@ghostrun/ir";
import { verb } from "@ghostrun/kits";
import { homage, homageNote, type IntentOut } from "@ghostrun/llm";
import { bandLine, chipLine, fraction, staticReceipt, statusWord, type Chip, type Receipt } from "@ghostrun/proof/static";
import { PROOF_VERSION } from "@ghostrun/world";
import * as v from "valibot";
import { SHARE_ID } from "./share";
import { changeSummary, contextPrompt, editIntent, ENGINE_HASH, fillPack, fillSeed, GALLERY, galleryRef, galleryWorld, lineageOf, mergeEdit, newFailures, placeFill, receiptDelta, type Lineage, type Placed } from "./world";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A full receipt for a placed world, or null: no cloud proof answered for this very spec. */
export interface Prover {
  prove(w: Placed): Promise<Receipt | null>;
}

export interface ToolCtx {
  /** One of the edge's routes, in-process, as this caller (their token, their address); a body makes it a POST. */
  call(path: string, body?: unknown): Promise<Response>;
  /** Where links point: the origin this endpoint was reached on. */
  origin: string;
  prover: Prover;
  /** Counts one model-spending call against the caller's own bucket; false once it's used up. */
  spend(): boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult>;
}

/**
 * The cloud proof: POST /v1/proof (proof.ts) with the world as a share stores it ({v, fill, seed,
 * engine, spec, version}), answered as JSON with its receipt (playtest and all), stored or proved
 * on the shards now. A refusal (switched off, rate limited, another proof version) or anything that
 * isn't a receipt for this very spec counts as no receipt, and the tool says what T0 and T1 found.
 */
export function cloudProver(call: ToolCtx["call"]): Prover {
  return {
    async prove(w) {
      try {
        const r = await call("/v1/proof", { v: 1, fill: w.fill, seed: w.seed, engine: ENGINE_HASH, spec: w.spec, version: PROOF_VERSION });
        if (!r.ok || !(r.headers.get("content-type") ?? "").includes("application/json")) return null;
        const j = (await r.json()) as { receipt?: unknown } | null;
        const rc = (j && typeof j === "object" && "receipt" in j ? j.receipt : j) as Partial<Receipt> | null;
        return rc && rc.v === 1 && rc.spec === w.spec && Array.isArray(rc.chips) ? (rc as Receipt) : null;
      } catch {
        return null;
      }
    },
  };
}

// ---- results ------------------------------------------------------------------------------------

const done = (text: string, structured: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text }], structuredContent: structured });
// an error carries text only: a tool's outputSchema describes its results, not its failures
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const isFail = (x: unknown): x is ToolResult => typeof x === "object" && x !== null && "isError" in x;

const BUDGET: Record<string, string> = {
  session_cap: "this token's spending cap is used up",
  ip_cap: "today's spending cap for this address is used up",
  pool_cap: "the pool's budget is used up",
  bad_request: "the spend governor turned the request down",
};

/** A route's refusal in words: the governor's caps, a rate limit, a pause, or whatever it said. */
async function refusal(r: Response, what: string): Promise<string> {
  const b = (await r.json().catch(() => ({}))) as { error?: unknown; reason?: unknown; retryMs?: unknown; retryable?: unknown };
  if (b.error === "budget") return `${what}: ${BUDGET[String(b.reason)] ?? "the budget is used up"} (governor: ${String(b.reason)}).`;
  if (r.status === 429) return `${what}: rate limited; try again in ${Math.ceil((Number(b.retryMs) || 600_000) / 60_000)} min.`;
  return `${what}: ${typeof b.error === "string" ? b.error : `HTTP ${r.status}`}${b.retryable === true ? " (try again shortly)" : ""}.`;
}

/** The server-sent events of a route's answer; leaving the loop early cancels it (the route stops paying for tokens). */
async function* events(res: Response): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event && data) yield { event, data: JSON.parse(data) as Record<string, unknown> };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// ---- the proof, in the receipt's own words ------------------------------------------------------

interface Proof {
  receipt: Receipt;
  /** "cloud": the whole ladder ran somewhere with physics; "edge": T0 and T1 only. */
  source: "cloud" | "edge";
}

export const PENDING = "Not proved here: T2 (each rule forced and checked) and T3 (AI runners in the physics simulation) need the simulation, so AI runners prove it when you open the link.";

async function proofOf(ctx: ToolCtx, w: Placed): Promise<Proof> {
  const cloud = await ctx.prover.prove(w);
  return cloud ? { receipt: cloud, source: "cloud" } : { receipt: await staticReceipt(w.bundle, { engine: ENGINE_HASH, host: "edge" }), source: "edge" };
}

/** The receipt as the CLI and the receipt panel say it (labels.ts): headline, every chip with its method, then par and band. */
function receiptLines(p: Proof): string[] {
  const r = p.receipt;
  const out = [`Receipt for spec ${r.spec.slice(0, 8)} · ${p.source === "cloud" ? `the full proof, run on ${r.host}` : "static checks at the edge (T0 rule graph, T1 kinematic models)"} · ${r.ms} ms`];
  if (r.headline) out.push(`Headline: ${r.headline.text}: ${statusWord(r.headline.status)} (${r.headline.method})`);
  for (const c of r.chips) out.push(chipLine(c));
  if (r.par) out.push(`AI par ${r.par.goldS} s · ${fraction(r.par.won, r.par.runs)} runners won`);
  if (r.playtest) out.push(bandLine(r.playtest, r));
  if (p.source === "edge") out.push(PENDING);
  return out;
}

const chipOut = (c: Chip) => ({ id: c.id, tier: c.tier, status: c.status, text: c.text, method: c.method, n: c.n, k: c.k, line: chipLine(c) });

function proofOut(p: Proof) {
  const r = p.receipt;
  return {
    source: p.source,
    spec: r.spec,
    host: r.host,
    headline: r.headline ? { text: r.headline.text, status: r.headline.status, method: r.headline.method } : null,
    chips: r.chips.map(chipOut),
    par: r.par,
    band: r.playtest ? bandLine(r.playtest, r) : null,
    lines: receiptLines(p),
    pending: p.source === "edge" ? PENDING : null,
  };
}

const MARK: Record<string, string> = { verified: "✓", played: "✓", modelled: "~", not_checkable: "–", counterexample: "✗" };
const WORST: Chip["status"][] = ["counterexample", "verified", "played", "modelled", "not_checkable"];

/** The worst word the chips about one thing earned (a counterexample first), as the headline is judged. */
function verdict(cs: readonly Chip[]): Chip["status"] | null {
  return WORST.find((s) => cs.some((c) => c.status === s)) ?? null;
}

/** The world's logic in sentences, its verbs, and what it promises with what each promise got. */
function logicOut(b: WorldBundle, r: Receipt) {
  const { rules, secrets, verbs, secretNoun } = logicOf(b);
  // a rule's mark is its forced-state test (T2), else a static chip about it, as the X-ray marks it
  const mark = (id: string) => {
    const c = r.chips.find((x) => x.id === `T2:${id}`) ?? r.chips.find((x) => x.subject.kind === "rule" && x.subject.id === id);
    return c ? MARK[c.status]! : "·";
  };
  return {
    rules: rules.map((x) => `${mark(x.id)} ${ruleText(x, b)}`),
    secrets: secrets.length ? `★ ${secrets.length} secret ${secretNoun}s: WHEN you touch one THEN it sparkles (once). They count apart from the win.` : null,
    verbs: verbs.map((x) => `${thingLabel(x.on, b)}: ${x.verb}${verb(x.verb) ? ` (${verb(x.verb)!.line.split(";")[0]})` : ""}`),
    expects: b.expects.map((x) => {
      const s = verdict(r.chips.filter((c) => c.subject.id === x.id || (x.prop === "win_reachable" && c.subject.id === "win_reachable")));
      return { text: x.text, headline: x.headline, prop: x.prop, status: s ? statusWord(s) : "not checked here" };
    }),
  };
}

function logicText(l: ReturnType<typeof logicOut>): string[] {
  return [
    "Rules (WHEN / IF / THEN; ✓ proved, ✗ counterexample, · no forced-state test yet):",
    ...(l.rules.length ? l.rules.map((x) => `- ${x}`) : ["- (none)"]),
    ...(l.secrets ? [l.secrets] : []),
    ...(l.verbs.length ? ["Verbs:", ...l.verbs.map((x) => `- ${x}`)] : []),
    "Promises (expectations):",
    ...(l.expects.length ? l.expects.map((x) => `- ${x.headline ? "[headline] " : ""}${x.text}: ${x.status}`) : ["- (none)"]),
  ];
}

// ---- worlds: built, loaded, shared --------------------------------------------------------------

interface Built {
  intent: IntentOut;
  seed: number;
  fill: string;
  cached: { at: string; intentModel: string; fillModel: string } | null;
  fallback: string | null;
}

/** POST /v1/build, read as the web client reads it: the intent, then fill lines until the gameplay layer is complete. */
async function liveBuild(ctx: ToolCtx, prompt: string, seed: number | undefined): Promise<Built | ToolResult> {
  // the engine hash keys the build cache: an exact repeat replays free, as it does for the web
  const r = await ctx.call("/v1/build", { prompt, engine: ENGINE_HASH, ...(seed !== undefined ? { seed } : {}) });
  if (!r.ok || !r.body) return fail(await refusal(r, "The build was turned away"));
  let intent: IntentOut | null = null;
  let at = seed ?? 1;
  let parser: FillParser | null = null;
  let fill = "";
  let cached: Built["cached"] = null;
  let fallback: string | null = null;
  for await (const ev of events(r)) {
    const d = ev.data;
    if (ev.event === "intent") {
      intent = d.intent as IntentOut;
      at = Number(d.seed);
      parser = new FillParser({ seed: at });
    } else if (ev.event === "cached") cached = { at: String(d.at), intentModel: String(d.intentModel), fillModel: String(d.fillModel) };
    else if (ev.event === "fallback") fallback = String(d.to);
    else if (ev.event === "refusal") return fail(String(d.message));
    else if (ev.event === "error") return fail(`The live AI couldn't build that just now: ${String(d.message)}${d.retryable === true ? " (try again shortly)" : ""}.`);
    else if (ev.event === "op" && parser) {
      const line = String(d.line);
      fill += splitObjects(line).map((one) => `${one}\n`).join(""); // one object per line, even when glued
      parser.push(`${line}\n`);
      if (parser.gameplayDone) break; // the cosmetic tail is optional: the world plays from here
    }
  }
  if (!intent || !fill) return fail("The build ended before the world's gameplay layer was written. Try again.");
  return { intent, seed: at, fill, cached, fallback };
}

interface Loaded {
  /** The share id, or g:<slug> for a gallery world (what a remix of it says it came from). */
  ref: string;
  kind: "share" | "gallery";
  prompt: string;
  line: Lineage | null;
  /** A gallery world's live intent (a share keeps none). */
  intent?: IntentOut;
  w: Placed;
  /** The spec the share was made for (a gallery world's own). */
  spec: string;
  link: string;
  /** It rebuilt to the spec it was shared with. */
  exact: boolean;
  honest?: boolean;
}

/** `world` as a share id, a ?s= (or ?race=) link, a ?g= link, g:<slug>, or a gallery slug. */
export function refOf(world: string): { kind: "share"; id: string } | { kind: "gallery"; slug: string } | null {
  const t = world.trim();
  const slug = (s: string | null | undefined) => (s && GALLERY.some((g) => g.slug === s) ? { kind: "gallery" as const, slug: s } : null);
  if (SHARE_ID.test(t)) return { kind: "share", id: t };
  if (t.startsWith("g:")) return slug(t.slice(2));
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      const id = u.searchParams.get("s") ?? u.searchParams.get("race");
      if (id && SHARE_ID.test(id)) return { kind: "share", id };
      return slug(u.searchParams.get("g"));
    } catch {
      return null;
    }
  }
  return slug(t);
}

async function load(ctx: ToolCtx, world: string): Promise<Loaded | ToolResult> {
  const ref = refOf(world);
  if (!ref) return fail(`"${world.slice(0, 80)}" isn't a world I can find: pass a share id (16 letters), a play link with ?s=, or a gallery slug from list_gallery.`);
  if (ref.kind === "gallery") {
    const g = galleryWorld(ref.slug);
    if (!g) return fail(`The gallery world ${ref.slug} isn't in this build.`);
    const i = g.intent;
    const w = await placeFill(g.fill, fillSeed(g.fill), { pack: i.pack, mode: i.mode, setting: i.setting });
    const honest = GALLERY.find((e) => e.slug === ref.slug)?.honest;
    return { ref: galleryRef(ref.slug), kind: "gallery", prompt: g.prompt, line: null, intent: i, w, spec: w.spec, link: `${ctx.origin}/?g=${ref.slug}`, exact: true, ...(honest ? { honest } : {}) };
  }
  const r = await ctx.call(`/v1/share/${ref.id}`);
  if (r.status === 404) return fail(`There's no share ${ref.id}. Check the id, or build a world with build_world.`);
  if (!r.ok) return fail(await refusal(r, "Couldn't read that share"));
  const s = (await r.json()) as { engine: string; specHash: string; seed: number; fill: string; prompt?: string; remixOf?: string; origin?: Lineage["origin"]; lineage?: Lineage["lineage"]; changes?: number };
  // rebuilt as a ?s= link rebuilds it: into the pack its fill names
  const w = await placeFill(s.fill, s.seed, { pack: fillPack(s.fill) });
  const line = s.remixOf && s.origin && s.lineage?.length && s.changes ? { remixOf: s.remixOf, origin: s.origin, lineage: s.lineage, changes: s.changes } : null;
  return { ref: ref.id, kind: "share", prompt: s.prompt ?? line?.origin.prompt ?? "", line, w, spec: s.specHash, link: `${ctx.origin}/?s=${ref.id}`, exact: s.engine === ENGINE_HASH && w.spec === s.specHash };
}

/** POST /v1/share: the world with no run yet (whoever opens it plays from the top), its prompt, and a remix's line. */
async function shareOf(ctx: ToolCtx, w: Placed, prompt: string, line: Lineage | null): Promise<{ id: string; link: string } | { error: string }> {
  const p = prompt.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
  try {
    const r = await ctx.call("/v1/share", { v: 1, engine: ENGINE_HASH, specHash: w.spec, seed: w.seed, fill: w.fill, inputs: [], ...(p ? { prompt: p } : {}), ...(line ?? {}) });
    if (!r.ok) return { error: await refusal(r, "No share link") };
    const { id } = (await r.json()) as { id: string };
    return { id, link: `${ctx.origin}/?s=${id}` };
  } catch {
    return { error: "No share link: the share store didn't answer." };
  }
}

// ---- arguments and schemas ----------------------------------------------------------------------

const WorldArg = v.pipe(v.string(), v.trim(), v.minLength(1, "world is empty"), v.maxLength(2048));
const Args = {
  build_world: v.strictObject({
    prompt: v.pipe(v.string(), v.trim(), v.minLength(1, "prompt is empty"), v.maxLength(500, "prompt is over 500 characters")),
    seed: v.optional(v.pipe(v.number(), v.integer("seed must be an integer"), v.minValue(0), v.maxValue(2_147_483_647))),
  }),
  edit_world: v.strictObject({ world: WorldArg, change: v.pipe(v.string(), v.trim(), v.minLength(1, "change is empty"), v.maxLength(300, "change is over 300 characters")) }),
  explain_world: v.strictObject({ world: WorldArg }),
  get_receipt: v.strictObject({ world: WorldArg }),
  list_gallery: v.strictObject({}),
};

const S = { type: "string" } as const;
const I = { type: "integer" } as const;
const B = { type: "boolean" } as const;
const strs = { type: "array", items: S } as const;
const orNull = (x: Record<string, unknown>) => ({ anyOf: [x, { type: "null" }] });
const obj = (properties: Record<string, unknown>, optional: string[] = []) => ({ type: "object", properties, required: Object.keys(properties).filter((k) => !optional.includes(k)) });

const WORLD_IN = { type: "string", minLength: 1, maxLength: 2048, description: "A world: a share id (16 letters, from build_world or edit_world), a play link with ?s=<id> or ?g=<slug>, or a gallery slug from list_gallery." };
const CHIP = obj({ id: S, tier: { type: "string", enum: ["T0", "T1", "T2", "T3"] }, status: { type: "string", enum: ["verified", "played", "modelled", "not_checkable", "counterexample"] }, text: S, method: S, n: I, k: I, line: S });
const PROOF = obj({
  source: { type: "string", enum: ["cloud", "edge"], description: "cloud: the whole ladder ran with physics; edge: the static checks (T0, T1) only" },
  spec: S,
  host: S,
  headline: orNull(obj({ text: S, status: S, method: S })),
  chips: { type: "array", items: CHIP },
  par: orNull(obj({ goldS: { type: "number" }, runs: I, won: I })),
  band: orNull(S),
  lines: { ...strs, description: "The receipt in its honest labels, one line each" },
  pending: orNull(S),
});
const LOGIC = {
  rules: { ...strs, description: "Each rule as a WHEN / IF / THEN sentence, with its proof mark" },
  secrets: orNull(S),
  verbs: strs,
  expects: { type: "array", items: obj({ text: S, headline: B, prop: S, status: S }) },
};
const INTENT = obj({ genre: S, setting: S, goal: S, fail: S, role: S, mood: S, pack: S, sub: strs, mode: S, headline: S });

const READ = { readOnlyHint: true, openWorldHint: false } as const;

// ---- the tools ----------------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: "build_world",
    title: "Build a world",
    description:
      "Build a playable 3D world from a prompt (a game, a place or a challenge, up to 500 characters) with GHOSTRUN's live AI, as the web app does. Returns what the AI understood (the intent), the world's rules as WHEN / IF / THEN sentences, what it promises, a share link to play it in a browser, and its proof: the static checks run here (T0 rule graph, T1 jump and reach models); AI runners prove the rest when the link is opened. Pass the returned `world` to edit_world, explain_world or get_receipt. Spends from the token's budget; an exact repeat of a prompt and seed replays from the build cache for free.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 500, description: "What to build, e.g. \"Capture the flag in a neon city. Add double jump. Score when the orb reaches the goal.\"" },
        seed: { type: "integer", minimum: 0, maximum: 2_147_483_647, description: "Layout seed (optional; by default it follows from the prompt, so a repeat builds the same layout)" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    outputSchema: obj({ world: orNull(S), link: orNull(S), seed: I, spec: S, intent: INTENT, cached: orNull(obj({ at: S, intentModel: S, fillModel: S })), fallback: orNull(S), ...LOGIC, proof: PROOF, notes: strs }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, ctx) {
      const a = args as v.InferOutput<(typeof Args)["build_world"]>;
      if (!ctx.spend()) return fail(SPENT);
      // trademarked names as generic homages, as the web sends them (the edge rewrites again: the same function, so a no-op)
      const named = homage(a.prompt);
      const b = await liveBuild(ctx, named.text, a.seed);
      if (isFail(b)) return b;
      const w = await placeFill(b.fill, b.seed, { pack: b.intent.pack, mode: b.intent.mode, setting: b.intent.setting });
      const [proof, share] = await Promise.all([proofOf(ctx, w), shareOf(ctx, w, a.prompt, null)]);
      const l = logicOut(w.bundle, proof.receipt);
      const i = b.intent;
      const intent = { genre: i.genre, setting: i.setting, goal: i.goal, fail: i.fail, role: i.role, mood: i.mood, pack: w.bundle.pack.id, sub: w.bundle.pack.sub, mode: w.bundle.mode, headline: i.headline };
      const link = "id" in share ? share : null;
      const said = homageNote(named.homages);
      const notes = [...(said ? [said] : []), ...(b.cached ? [`Replayed from the build cache: built live ${b.cached.at.slice(0, 10)} by ${b.cached.intentModel} and ${b.cached.fillModel}.`] : []), ...(b.fallback ? [`The fast lane was busy; ${b.fallback} wrote it.`] : []), ...("error" in share ? [share.error] : [])];
      const text = [
        `Built: ${i.headline || i.goal || a.prompt} (${i.genre || "world"} · ${w.bundle.pack.id} · ${w.bundle.mode === "wander" ? "a place to explore" : "a game"}, seed ${w.seed}).`,
        `Intent: ${i.setting}${i.goal ? `. Goal: ${i.goal}` : ""}${i.fail ? `. Fail: ${i.fail}` : ""}${i.role ? `. You play: ${i.role}` : ""}.`,
        link ? `Play it: ${link.link}  (world ${link.id})` : "No share link this time, so there's no `world` to pass on; build again to get one.",
        ...notes.map((n) => `Note: ${n}`),
        "",
        ...logicText(l),
        "",
        ...receiptLines(proof),
      ].join("\n");
      return done(text, { world: link?.id ?? null, link: link?.link ?? null, seed: w.seed, spec: w.spec, intent, cached: b.cached, fallback: b.fallback, ...l, proof: proofOut(proof), notes });
    },
  },
  {
    name: "edit_world",
    title: "Change a world",
    description:
      "Change an existing world in plain words (\"only one jump\", \"add three more coins\", \"make it night\"), as the web app's edit box does: the live AI patches the world by stable ids (its layout and its promises stay), the world is re-placed and re-checked, and you get what changed, how the receipt moved, and a new share link (a remix that says where it came from). Spends from the token's budget.",
    inputSchema: {
      type: "object",
      properties: { world: WORLD_IN, change: { type: "string", minLength: 1, maxLength: 300, description: "The change, in plain words" } },
      required: ["world", "change"],
      additionalProperties: false,
    },
    outputSchema: obj({ world: orNull(S), link: orNull(S), change: S, from: obj({ world: S, link: S, spec: S }), spec: S, summary: strs, locked: I, delta: { type: "array", items: obj({ label: S, from: S, to: S, sign: I }) }, failures: strs, ...LOGIC, proof: PROOF, notes: strs }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(args, ctx) {
      const a = args as v.InferOutput<(typeof Args)["edit_world"]>;
      const src = await load(ctx, a.world);
      if (isFail(src)) return src;
      if (!ctx.spend()) return fail(SPENT);
      const prompt = contextPrompt(src.prompt, src.line) || "a shared world";
      const fill0 = pinLayout(src.w.fill);
      const r = await ctx.call("/v1/edit", { prompt, change: a.change, intent: editIntent(src.w.bundle, prompt, src.intent), fill: fill0, seed: src.w.seed });
      if (!r.ok || !r.body) return fail(await refusal(r, "The edit was turned away"));
      let patch = "";
      for await (const ev of events(r)) {
        if (ev.event === "error") return fail(`The live AI couldn't make that change just now: ${String(ev.data.message)}. Try again, or say it differently.`);
        if (ev.event === "op") patch += `${String(ev.data.line)}\n`;
      }
      if (!patch) return fail("The live AI couldn't make that change just now. Try again, or say it differently.");
      const { text, stats, layout } = mergeEdit(fill0, patch, src.w.seed); // a structural edit settled and re-anchored, as the web does
      const after = await placeFill(text, src.w.seed, { pack: src.w.bundle.pack.id, mode: src.w.bundle.mode, setting: src.intent?.setting });
      const summary = [...(layout?.summary ?? []), ...changeSummary(src.w.bundle, after.bundle)];
      if (!summary.length && text.trim() === fill0.trim()) return fail(stats.locked ? "That would only change what the world promises, and the proof keeps those fixed." : "Nothing in the world changed. Try saying it differently.");
      const line = lineageOf(src, a.change);
      // a remix's share says the prompt at the top of its line, as the web's does
      const [before, proof, share] = await Promise.all([proofOf(ctx, src.w), proofOf(ctx, after), shareOf(ctx, after, line.origin.prompt || src.prompt, line)]);
      const delta = receiptDelta(before.receipt, proof.receipt);
      const failures = newFailures(before.receipt, proof.receipt);
      const shown = summary.length ? summary : [`${stats.replaced + stats.added + stats.deleted} lines changed`];
      const l = logicOut(after.bundle, proof.receipt);
      const link = "id" in share ? share : null;
      const notes = [...(layout?.notes ?? []), ...(stats.locked ? [`${stats.locked} change${stats.locked > 1 ? "s" : ""} to what the world promises ${stats.locked > 1 ? "were" : "was"} kept as ${stats.locked > 1 ? "they were" : "it was"}: the proof keeps promises fixed.`] : []), ...("error" in share ? [share.error] : [])];
      const out = [
        `Changed "${a.change}" on ${src.link}.`,
        `What changed: ${shown.join(" · ")}`,
        `Receipt: ${delta.length ? delta.map((d) => `${d.label} ${d.from} → ${d.to}`).join(" · ") : "no number moved"}${proof.source === "edge" ? " (static checks; AI runners re-prove it on the new link)" : ""}`,
        ...(failures.length ? [`New failures: ${failures.join("; ")}`] : []),
        link ? `Play the new version: ${link.link}  (world ${link.id}, a remix of ${src.ref}; ${line.changes} change${line.changes > 1 ? "s" : ""} since the original)` : "No share link this time.",
        ...notes.map((n) => `Note: ${n}`),
        "",
        ...logicText(l),
        "",
        ...receiptLines(proof),
      ].join("\n");
      return done(out, { world: link?.id ?? null, link: link?.link ?? null, change: a.change, from: { world: src.ref, link: src.link, spec: src.spec }, spec: after.spec, summary: shown, locked: stats.locked, delta, failures, ...l, proof: proofOut(proof), notes });
    },
  },
  {
    name: "explain_world",
    title: "Explain a world",
    description: "Explain a world's logic: every rule as a WHEN / IF / THEN sentence (the web app's Logic X-ray), its verbs, what it promises (its expectations) and what has been proved about each. No model call and no spend.",
    inputSchema: { type: "object", properties: { world: WORLD_IN }, required: ["world"], additionalProperties: false },
    outputSchema: obj({ world: S, link: S, prompt: S, mode: S, pack: S, spec: S, exact: B, honest: B, ...LOGIC, proof: PROOF }),
    annotations: READ,
    async run(args, ctx) {
      const src = await load(ctx, (args as { world: string }).world);
      if (isFail(src)) return src;
      const proof = await proofOf(ctx, src.w);
      const l = logicOut(src.w.bundle, proof.receipt);
      const b = src.w.bundle;
      const text = [
        `${src.kind === "gallery" ? "Gallery world" : "Shared world"} ${src.ref}: ${src.prompt ? `"${src.prompt}"` : "(no prompt recorded)"} (${b.pack.id} · ${b.mode === "wander" ? "a place to explore" : "a game"}). Play it: ${src.link}`,
        ...(src.exact ? [] : ["Note: this share was made by another engine version; the world rebuilt, but not to the spec it was shared with."]),
        ...(src.honest ? ["Note: AI runners win this one, but its own headline claim fails, and the receipt says so."] : []),
        "",
        ...logicText(l),
        "",
        ...receiptLines(proof),
      ].join("\n");
      return done(text, { world: src.ref, link: src.link, prompt: src.prompt, mode: b.mode, pack: b.pack.id, spec: src.w.spec, exact: src.exact, honest: Boolean(src.honest), ...l, proof: proofOut(proof) });
    },
  },
  {
    name: "get_receipt",
    title: "Get a world's receipt",
    description: "The proof receipt for a world, in GHOSTRUN's honest labels: the headline claim and its status, then every check with its tier, its method and its counts (fewer than 30 trials print as \"k of n\", never a percentage). Without a cloud proof the receipt holds the static checks (T0, T1) and says so. No model call and no spend.",
    inputSchema: { type: "object", properties: { world: WORLD_IN }, required: ["world"], additionalProperties: false },
    outputSchema: obj({ world: S, link: S, spec: S, engine: S, proof: PROOF }),
    annotations: READ,
    async run(args, ctx) {
      const src = await load(ctx, (args as { world: string }).world);
      if (isFail(src)) return src;
      const proof = await proofOf(ctx, src.w);
      return done([`World ${src.ref} · ${src.link}`, ...receiptLines(proof)].join("\n"), { world: src.ref, link: src.link, spec: src.w.spec, engine: ENGINE_HASH, proof: proofOut(proof) });
    },
  },
  {
    name: "list_gallery",
    title: "List the gallery",
    description: "The gallery: worlds GHOSTRUN's live AI built from prompts during development, recorded unedited. Each slug works as `world` in explain_world, get_receipt and edit_world, and each link opens it to play (and re-prove) in a browser.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: obj({ worlds: { type: "array", items: obj({ slug: S, prompt: S, pack: S, mode: S, honest: B, link: S }) } }),
    annotations: READ,
    async run(_args, ctx) {
      const worlds = GALLERY.map((g) => ({ slug: g.slug, prompt: g.prompt, pack: g.pack, mode: g.mode, honest: Boolean(g.honest), link: `${ctx.origin}/?g=${g.slug}` }));
      const text = [`${worlds.length} gallery worlds (slug: prompt · pack · game or place):`, ...worlds.map((w) => `- ${w.slug}: ${w.prompt} · ${w.pack} · ${w.mode === "wander" ? "place" : "game"}${w.honest ? " · honest receipt" : ""}`)].join("\n");
      return done(text, { worlds });
    },
  },
];

const SPENT = "This token has made its share of builds and edits for now (a per-token limit on top of the budget): try again in a few minutes.";

/** Runs a tool on checked arguments; bad arguments come back as a tool error the model can correct. */
export async function callTool(tool: Tool, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const parsed = v.safeParse(Args[tool.name as keyof typeof Args], args);
  if (!parsed.success) return fail(`Invalid arguments for ${tool.name}: ${parsed.issues.slice(0, 5).map((i) => `${v.getDotPath(i) ?? "arguments"}: ${i.message}`).join("; ")}`);
  try {
    return await tool.run(parsed.output as Record<string, unknown>, ctx);
  } catch (e) {
    return fail(`GHOSTRUN hit an error doing that: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}.`);
  }
}
