// The real world pipeline, fed by the fixture until the fill lane streams from an LLM:
//   JSONL fill → parseFill → pack.generate → placeWorld → placed WorldBundle.
import fixtureFill from "../../../packages/ir/fixtures/ctf-neon.jsonl?raw";
import coinRushFill from "../../../packages/ir/fixtures/coin-rush.jsonl?raw";
import forestFill from "../../../packages/packs/outdoor/test/fixtures/glow-forest.jsonl?raw";
import parkourFill from "../../../packages/packs/course/test/fixtures/parkour-time-trial.jsonl?raw";
import heistFill from "../../../packages/ir/fixtures/heist-live-1.jsonl?raw";
import vaultFill from "../../../packages/ir/fixtures/vault-heist.jsonl?raw";
import { parseFill, specHash, type FillNote, type FillStats, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { packFor, PACKS } from "@ghostrun/registry";

/** The organizer's brief the fixture answers. */
export const BRIEF = "Create a capture-the-flag game in a neon city. Add double jump. Score when the orb reaches the goal.";

/**
 * Engine hash bound into the spec hash: SHA-256 of the pinned Rapier wasm build (docs/gates.md, S0).
 * The sim package will own this constant once it lands.
 */
export const ENGINE_HASH = "4e9890fd2df60072f9db06a33e4030221249c1b3687b722b2388c21f09e97551";


export interface Intent {
  mode: WorldBundle["mode"];
  pack: string;
  sub: string[];
  zones: { id: string; name: string; tag: string }[];
  rules: number;
  entities: number;
  cast: { role: string; team: string }[];
  jumpsMax: number;
  headline: string;
  look: string;
  weather: string;
  /** From the live intent call (absent for the fixture). */
  live?: { genre: string; setting: string; goal: string; fail: string; role: string };
}

export interface World {
  bundle: WorldBundle;
  /** The fill it was built from (meta pack = the pack actually used) and its seed: a share link. */
  fill: string;
  seed: number;
  /** For live worlds: what the repair loop needs to ask for a patch. */
  source?: { prompt: string; intent: unknown; fill: string; seed: number; pack: string };
  intent: Intent;
  notes: string[];
  fillNotes: FillNote[];
  stats: FillStats;
  timings: { fillMs: number; layoutMs: number };
}

/** The fill's meta line carries the world seed; the parser takes it as init. */
function fillSeed(text: string): number {
  const first = text.split("\n", 1)[0] ?? "";
  try {
    const m = JSON.parse(first) as { op?: string; seed?: unknown };
    if (m.op === "meta" && typeof m.seed === "number" && Number.isFinite(m.seed)) return m.seed;
  } catch {
    // fall through
  }
  return 7;
}

/**
 * Runs the pipeline. The prompt is shown and recorded, but the "fixture LLM" always answers with
 * the CTF fill; the live fill lane replaces `fixtureFill` with the streamed text.
 */
export function buildWorld(_prompt: string, fixture = "ctf"): World {
  const text = FIXTURES[fixture] ?? fixtureFill;
  return worldFromFill(text, fillSeed(text));
}

/** Recorded fills: the organizer's CTF brief, and a kit-verb world (?fixture=coin-rush). */
export const FIXTURES: Record<string, string> = { ctf: fixtureFill, "coin-rush": coinRushFill, forest: forestFill, parkour: parkourFill, heist: heistFill, vault: vaultFill };
export const FIXTURE_PROMPTS: Record<string, string> = {
  ctf: BRIEF,
  "coin-rush": "Collect five gold coins in a neon arena before the clock runs out. Mind the lava.",
  forest: "A bioluminescent forest at night: climb to the owl lookout before the fog rolls in.",
  vault: "A museum at night: find the brass key, open the vault, steal the star sapphire and get to the van before the alarm.",
  heist: "A museum heist: grab the key, unlock the vault, steal the gem and escape before the alarm timer runs out.",
  parkour: "A parkour time trial: double jump the opening wall, then race the gaps and beams to the finish.",
};

/** Fill text (fixture or a live stream) → placed world, choosing the pack from the registry. */
export function worldFromFill(fillText: string, seed: number, live?: Intent["live"], packId?: string): World {
  const t0 = performance.now();
  const fill = parseFill(fillText, { seed });
  const t1 = performance.now();

  const draft = fill.draft;
  // place into the pack the fill was written against (its meta line sometimes names another)
  if (packId && PACKS.some((p) => p.id === packId)) draft.pack = { ...draft.pack, id: packId };
  const known = PACKS.some((p) => p.id === draft.pack.id);
  const pack = packFor(draft.pack.id);
  const layout = pack.generate({ seed, params: pack.defaults, sub: draft.pack.sub, laws: draft.laws, harder: false });
  const { bundle, notes } = placeWorld({ ...draft, engine: ENGINE_HASH }, layout);
  const t2 = performance.now();
  if (!known) notes.unshift(`pack '${draft.pack.id}' not available, using '${pack.id}'`);

  const headline = bundle.expects.find((x) => x.headline) ?? bundle.expects[0];
  const intent: Intent = {
    mode: bundle.mode,
    pack: bundle.pack.id,
    sub: bundle.pack.sub,
    zones: bundle.zones.map((z) => ({ id: z.id, name: z.name || z.id, tag: z.tag })),
    rules: bundle.rules.length,
    entities: bundle.entities.length,
    cast: bundle.cast.map((k) => ({ role: k.role, team: bundle.entities.find((e) => e.id === k.npc)?.team ?? "" })),
    jumpsMax: bundle.laws.jumpsMax,
    headline: headline?.text ?? "",
    look: bundle.cosmetic.look,
    weather: bundle.cosmetic.weather,
    ...(live ? { live } : {}),
  };

  // the stored fill names the pack actually used, so the same fill always rebuilds the same world
  const lines = fillText.split("\n");
  try {
    const meta = JSON.parse(lines[0] ?? "") as { op?: string; pack?: string };
    if (meta.op === "meta" && meta.pack !== pack.id) lines[0] = JSON.stringify({ ...meta, pack: pack.id });
  } catch {
    // no meta line: the parser already defaulted it
  }
  return {
    bundle,
    fill: lines.join("\n"),
    seed,
    intent,
    notes,
    fillNotes: fill.notes,
    stats: fill.stats,
    timings: { fillMs: t1 - t0, layoutMs: t2 - t1 },
  };
}

export const hashWorld = (b: WorldBundle): Promise<string> => specHash(ENGINE_HASH, b);
