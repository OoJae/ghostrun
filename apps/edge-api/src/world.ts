// The web client's world pipeline, on the edge, for the MCP tools: a fill and its seed → the placed
// world, its spec hash and the fill a share link stores; what an edit changed and how its receipt
// moved, in words; and the gallery's recorded worlds. Each piece mirrors the web's own (pipeline.ts worldFromFill, edits.ts,
// remix.ts) wherever a spec hash, a stored fill or a share's line depends on it, and
// apps/web/test/mcp-parity.test.ts holds the two to the same answers.
import { lawsUnwritten, layoutLaws, mergeFill, parseFill, specHash, splitObjects, type Entity, type MergeStats, type WorldBundle } from "@ghostrun/ir";
import { placeWorld, reanchor } from "@ghostrun/layout";
import type { IntentOut } from "@ghostrun/llm";
import { fraction, statusWord, type Chip, type Receipt } from "@ghostrun/proof/static";
import { layoutChange, layoutOf, packFor, PACKS, schemaFor, settleLayout } from "@ghostrun/registry";
import GALLERY_INDEX from "../../web/src/gallery/index.json?raw";

/** The engine hash the web client binds into every spec hash and share (apps/web/src/pipeline.ts). */
export const ENGINE_HASH = "4e9890fd2df60072f9db06a33e4030221249c1b3687b722b2388c21f09e97551";

export type Mode = WorldBundle["mode"];

export interface Placed {
  bundle: WorldBundle;
  /** The fill as a share stores it: its meta line names the pack, the mode and the setting used. */
  fill: string;
  seed: number;
  spec: string;
  notes: string[];
}

/** The setting a fill's meta line carries, if any. */
function metaSetting(fill: string): string {
  try {
    const m = JSON.parse(fill.split("\n", 1)[0] ?? "") as { op?: unknown; setting?: unknown };
    return m.op === "meta" && typeof m.setting === "string" ? m.setting : "";
  } catch {
    return "";
  }
}

/** The seed a recorded fill's meta line carries (7 when it carries none, as the web reads it). */
export function fillSeed(fill: string): number {
  try {
    const m = JSON.parse(splitObjects(fill.split("\n", 1)[0] ?? "{}")[0] ?? "{}") as { seed?: unknown };
    return typeof m.seed === "number" && Number.isFinite(m.seed) ? m.seed : 7;
  } catch {
    return 7;
  }
}

/** The pack a stored fill's meta line names (a share is rebuilt into it). */
export function fillPack(fill: string): string | undefined {
  try {
    const p = (JSON.parse(fill.split("\n", 1)[0] ?? "{}") as { pack?: unknown }).pack;
    return typeof p === "string" ? p : undefined;
  } catch {
    return undefined;
  }
}

/** Fill text → placed world, choosing the pack from the registry (worldFromFill's spec-bearing half). */
export async function placeFill(fillText: string, seed: number, opts: { pack?: string | undefined; mode?: Mode | undefined; setting?: string | undefined } = {}): Promise<Placed> {
  const draft = parseFill(fillText, { seed }).draft;
  // place into the pack the fill was written against (its meta line sometimes names another)
  if (opts.pack && PACKS.some((p) => p.id === opts.pack)) draft.pack = { ...draft.pack, id: opts.pack };
  if (opts.mode) draft.mode = opts.mode; // the intent decides play vs wander
  const known = PACKS.some((p) => p.id === draft.pack.id);
  const pack = packFor(draft.pack.id);
  // a structural edit's layout ("layout" in the meta line); every other fill builds on the defaults
  const shape = layoutOf(pack, fillText);
  if (shape.custom) draft.pack = { ...draft.pack, params: shape.custom };
  const layout = pack.generate({ seed, params: shape.params, sub: draft.pack.sub, laws: layoutLaws(fillText, draft.laws), harder: false });
  const { bundle, notes } = placeWorld({ ...draft, engine: ENGINE_HASH }, layout, { reach: lawsUnwritten(fillText) });
  if (!known) notes.unshift(`pack '${draft.pack.id}' not available, using '${pack.id}'`);
  // the stored fill names the pack actually used, so it always rebuilds the same world, and the
  // intent's setting, so a share link rebuilds the same look
  const lines = fillText.split("\n");
  const setting = opts.setting ? opts.setting.slice(0, 240) : metaSetting(fillText);
  try {
    const meta = JSON.parse(lines[0] ?? "") as { op?: string; pack?: string; mode?: string; setting?: string };
    if (meta.op === "meta" && (meta.pack !== pack.id || meta.mode !== bundle.mode || (setting && meta.setting !== setting))) lines[0] = JSON.stringify({ ...meta, pack: pack.id, mode: bundle.mode, ...(setting ? { setting } : {}) });
  } catch {
    // no meta line: the parser already defaulted it
  }
  return { bundle, fill: lines.join("\n"), seed, spec: await specHash(ENGINE_HASH, bundle), notes };
}

/** The world's headline expectation (the first one when none is marked). */
export const headlineText = (b: WorldBundle) => (b.expects.find((x) => x.headline) ?? b.expects[0])?.text ?? "";

// ---- edits (apps/web/src/edits.ts) --------------------------------------------------------------

/** What /v1/edit needs to know about a world: its live intent, or one read off the world itself. */
export function editIntent(b: WorldBundle, prompt: string, live?: IntentOut): IntentOut {
  if (live && Array.isArray(live.nouns) && live.moodVec) return live;
  return {
    lang: "en", mode: b.mode, genre: "", setting: prompt.slice(0, 200), role: "", goal: "", fail: "", mood: "",
    pack: b.pack.id, sub: b.pack.sub, safety: "ok", headline: headlineText(b), nouns: [], moodVec: { valence: 0, arousal: 0, tension: 0 },
  };
}

/** The prompt an edit of an edited world keeps in mind: the original, then each change. */
export const editedPrompt = (prompt: string, edits: readonly string[]) => [prompt, ...edits.map((e) => `Then: ${e}`)].join("\n");

const noun = (e: Pick<Entity, "noun" | "kind">) => e.noun || e.kind;
const counted = (names: string[], sign: string) => {
  const by = new Map<string, number>();
  for (const n of names) by.set(n, (by.get(n) ?? 0) + 1);
  return [...by].map(([n, k]) => `${sign}${k} ${n}${k > 1 && !n.endsWith("s") ? "s" : ""}`);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const num = (x: number) => String(Math.round(x * 100) / 100);
const night = (h: number) => h >= 19 || h < 6;

/**
 * An edit's patch merged into a world's fill, as the web's structure.ts mergeEdit does: a layout op
 * settled against the pack's schema and the fill re-anchored onto the new layout, with the diff
 * line's phrases ("floors 1 → 2 · 2 rooms added · 1 thing re-anchored") and the moves.
 */
export function mergeEdit(fill0: string, patch: string, seed: number): { text: string; stats: MergeStats; layout: { summary: string[]; notes: string[] } | null } {
  const merged = mergeFill(fill0, patch, { edit: true });
  if (!merged.stats.layout) return { ...merged, layout: null };
  const entry = PACKS.find((p) => p.id === fillPack(merged.text)) ?? PACKS[0]!;
  const text = settleLayout(entry.impl, entry.subs, merged.text);
  const a = layoutOf(entry.impl, fill0);
  const b = layoutOf(entry.impl, text);
  if (same(a.params, b.params) && a.sub.join() === b.sub.join()) return { text, stats: merged.stats, layout: { summary: [], notes: [] } };
  const laws = layoutLaws(text, parseFill(text, { seed }).draft.laws);
  const l0 = entry.impl.generate({ seed, params: a.params, sub: a.sub, laws, harder: false });
  const l1 = entry.impl.generate({ seed, params: b.params, sub: b.sub, laws, harder: false });
  const moved = reanchor(text, l0, l1);
  const summary = layoutChange(schemaFor(entry.id), { ...a, layout: l0 }, { ...b, layout: l1 });
  if (moved.moved.length) summary.push(`${moved.moved.length} thing${moved.moved.length > 1 ? "s" : ""} re-anchored`);
  return { text: moved.fill, stats: merged.stats, layout: { summary, notes: moved.notes } };
}

/** What an edit changed in the world, in a few short phrases (most telling first). */
export function changeSummary(a: WorldBundle, b: WorldBundle): string[] {
  const out: string[] = [];
  const la = a.laws;
  const lb = b.laws;
  if (la.jumpsMax !== lb.jumpsMax) out.push(`jumps ${la.jumpsMax} → ${lb.jumpsMax}`);
  if (la.jumpH !== lb.jumpH) out.push(`jump height ${num(la.jumpH)} → ${num(lb.jumpH)} m`);
  if (la.speed !== lb.speed) out.push(`speed ${num(la.speed)} → ${num(lb.speed)} m/s`);
  if (la.gravityScale !== lb.gravityScale) out.push(`gravity ×${num(la.gravityScale)} → ×${num(lb.gravityScale)}`);
  const ea = new Map(a.entities.map((e) => [e.id, e]));
  const eb = new Map(b.entities.map((e) => [e.id, e]));
  out.push(...counted(b.entities.filter((e) => !ea.has(e.id)).map(noun), "+"));
  out.push(...counted(a.entities.filter((e) => !eb.has(e.id)).map(noun), "−"));
  const moved = b.entities.filter((e) => {
    const o = ea.get(e.id);
    return o && !same([o.kind, o.noun, o.zone, o.team, o.states, o.init, o.body, o.size], [e.kind, e.noun, e.zone, e.team, e.states, e.init, e.body, e.size]);
  }).length;
  if (moved) out.push(`${moved} thing${moved > 1 ? "s" : ""} changed`);
  const ra = new Map(a.rules.map((r) => [r.id, r]));
  const rb = new Map(b.rules.map((r) => [r.id, r]));
  const rNew = b.rules.filter((r) => !ra.has(r.id)).length;
  const rGone = a.rules.filter((r) => !rb.has(r.id)).length;
  const rChanged = b.rules.filter((r) => ra.has(r.id) && !same(ra.get(r.id), r)).length;
  if (rNew) out.push(`+${rNew} rule${rNew > 1 ? "s" : ""}`);
  if (rGone) out.push(`−${rGone} rule${rGone > 1 ? "s" : ""}`);
  if (rChanged) out.push(`${rChanged} rule${rChanged > 1 ? "s" : ""} rewired`);
  const vNew = b.verbs.filter((v) => !a.verbs.some((x) => x.id === v.id)).length;
  const vChanged = b.verbs.filter((v) => a.verbs.some((x) => x.id === v.id && !same(x, v))).length;
  if (vNew && !out.some((x) => x.startsWith("+"))) out.push(`+${vNew} verb${vNew > 1 ? "s" : ""}`);
  if (vChanged) out.push(`${vChanged} verb${vChanged > 1 ? "s" : ""} retuned`);
  const ca = new Map(a.cast.map((c) => [c.npc, c]));
  const cChanged = b.cast.filter((c) => ca.has(c.npc) && !same(ca.get(c.npc), c)).length;
  if (cChanged) out.push(`${cChanged} NPC${cChanged > 1 ? "s" : ""} rethought`);
  const ka = a.cosmetic;
  const kb = b.cosmetic;
  if (night(ka.timeOfDay) !== night(kb.timeOfDay)) out.push(night(kb.timeOfDay) ? "now night" : "now day");
  if (ka.weather !== kb.weather) out.push(kb.weather === "clear" ? "skies clear" : `now ${kb.weather}`);
  if (ka.look !== kb.look) out.push(`look: ${kb.look}`);
  return out;
}

export interface Delta {
  label: string;
  from: string;
  to: string;
  /** -1 the change made it worse, 1 better, 0 neither (a longer par is harder, not worse). */
  sign: -1 | 0 | 1;
}

const RANK: Record<Chip["status"], number> = { counterexample: 0, not_checkable: 1, modelled: 2, played: 3, verified: 4 };
const cmp = (a: number, b: number): -1 | 0 | 1 => (b > a ? 1 : b < a ? -1 : 0);

/** How the receipt moved: only the numbers that changed (all of them labelled as the receipt does). */
export function receiptDelta(a: Receipt, b: Receipt): Delta[] {
  const out: Delta[] = [];
  if (a.headline || b.headline) {
    const from = a.headline ? statusWord(a.headline.status) : "none";
    const to = b.headline ? statusWord(b.headline.status) : "none";
    if (from !== to) out.push({ label: "Headline", from, to, sign: cmp(a.headline ? RANK[a.headline.status] : -1, b.headline ? RANK[b.headline.status] : -1) });
  }
  const wa = a.chips.find((c) => c.id === "T3:win");
  const wb = b.chips.find((c) => c.id === "T3:win");
  if (wa && wb && (wa.k !== wb.k || wa.n !== wb.n)) out.push({ label: "AI runners won", from: fraction(wa.k, wa.n), to: fraction(wb.k, wb.n), sign: cmp(wa.k / Math.max(1, wa.n), wb.k / Math.max(1, wb.n)) });
  if (a.par && b.par && a.par.goldS !== b.par.goldS) out.push({ label: "AI par", from: `${a.par.goldS} s`, to: `${b.par.goldS} s`, sign: 0 });
  else if (a.par && !b.par) out.push({ label: "AI par", from: `${a.par.goldS} s`, to: "no runner won", sign: -1 });
  else if (!a.par && b.par) out.push({ label: "AI par", from: "no runner won", to: `${b.par.goldS} s`, sign: 1 });
  const cx = (r: Receipt) => r.chips.filter((c) => c.status === "counterexample").length;
  if (cx(a) !== cx(b)) out.push({ label: "Counterexamples", from: String(cx(a)), to: String(cx(b)), sign: cmp(cx(b), cx(a)) });
  const forced = (r: Receipt) => {
    const t2 = r.chips.filter((c) => c.tier === "T2" && c.subject.kind === "rule");
    return { k: t2.filter((c) => c.status === "verified").length, n: t2.length };
  };
  const fa = forced(a);
  const fb = forced(b);
  if (fa.k !== fb.k || fa.n !== fb.n) out.push({ label: "Rules force-tested", from: fraction(fa.k, fa.n), to: fraction(fb.k, fb.n), sign: cmp(fa.k / Math.max(1, fa.n), fb.k / Math.max(1, fb.n)) });
  return out;
}

/** Counterexamples the edit introduced, each with the proof's reason (at most three). */
export function newFailures(a: Receipt, b: Receipt): string[] {
  const was = new Set(a.chips.filter((c) => c.status === "counterexample").map((c) => c.id));
  return b.chips
    .filter((c) => c.status === "counterexample" && !was.has(c.id))
    .slice(0, 3)
    .map((c) => `${c.text.split(":")[0]}${c.cx ? ` — ${c.cx.text}` : ""}`);
}

// ---- remixes (apps/web/src/remix.ts) ------------------------------------------------------------

export const MAX_LINEAGE = 8;

/** One change in a remix's line: the world it was made on, and what was asked. */
export interface Step {
  id: string;
  change: string;
  name?: string;
}

/** What a remix's share stores about where it came from. */
export interface Lineage {
  remixOf: string;
  origin: { id: string; prompt: string; spec: string };
  lineage: Step[];
  changes: number;
}

/** One line of what the person wrote, short enough to store. */
export const said = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);

export const galleryRef = (slug: string) => `g:${slug}`;

/** The line a share of a changed world carries: the source's own line, with this change on top. */
export function lineageOf(src: { ref: string; prompt: string; spec: string; line: Lineage | null }, change: string): Lineage {
  const origin = src.line?.origin ?? { id: src.ref, prompt: said(src.prompt), spec: src.spec };
  const steps = [...(src.line?.lineage ?? []), { id: src.ref, change: said(change) }];
  return { remixOf: src.ref, origin, lineage: steps.slice(-MAX_LINEAGE), changes: (src.line?.changes ?? 0) + 1 };
}

/** What an edit of a shared world is told it was asked for: the original prompt, then each change since. */
export const contextPrompt = (prompt: string, line: Lineage | null) => (line ? editedPrompt(line.origin.prompt || "a shared world", line.lineage.map((s) => s.change)) : prompt);

// ---- the gallery (apps/web/src/gallery) ---------------------------------------------------------

export interface GalleryEntry {
  slug: string;
  prompt: string;
  pack: string;
  mode: string;
  honest?: boolean;
}

export interface GalleryWorld {
  prompt: string;
  intent: IntentOut;
  fill: string;
}

export const GALLERY = JSON.parse(GALLERY_INDEX) as GalleryEntry[];
const WORLDS = import.meta.glob<GalleryWorld>("../../web/src/gallery/worlds/*.json", { eager: true, import: "default" });

export const galleryWorld = (slug: string): GalleryWorld | undefined => (GALLERY.some((g) => g.slug === slug) ? WORLDS[`../../web/src/gallery/worlds/${slug}.json`] : undefined);
