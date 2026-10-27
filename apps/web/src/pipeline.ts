// The real world pipeline, fed by the fixture until the fill lane streams from an LLM:
//   JSONL fill → parseFill → pack.generate → placeWorld → placed WorldBundle.
import fixtureFill from "../../../packages/ir/fixtures/ctf-neon.jsonl?raw";
import { parseFill, specHash, type FillNote, type FillStats, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { cityBlock } from "@ghostrun/pack-city-block";
import type { LayoutPack } from "@ghostrun/plugin-api";

/** The organizer's brief the fixture answers. */
export const BRIEF = "Create a capture-the-flag game in a neon city. Add double jump. Score when the orb reaches the goal.";

/**
 * Engine hash bound into the spec hash: SHA-256 of the pinned Rapier wasm build (docs/gates.md, S0).
 * The sim package will own this constant once it lands.
 */
export const ENGINE_HASH = "4e9890fd2df60072f9db06a33e4030221249c1b3687b722b2388c21f09e97551";

const PACKS: Record<string, LayoutPack> = { [cityBlock.id]: cityBlock as unknown as LayoutPack };

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
}

export interface World {
  bundle: WorldBundle;
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
export function buildWorld(_prompt: string): World {
  const t0 = performance.now();
  const seed = fillSeed(fixtureFill);
  const fill = parseFill(fixtureFill, { seed });
  const t1 = performance.now();

  const draft = fill.draft;
  const pack = PACKS[draft.pack.id] ?? (cityBlock as unknown as LayoutPack);
  const layout = pack.generate({ seed, params: pack.defaults, sub: draft.pack.sub, laws: draft.laws, harder: false });
  const { bundle, notes } = placeWorld({ ...draft, engine: ENGINE_HASH }, layout);
  const t2 = performance.now();
  if (!PACKS[draft.pack.id]) notes.unshift(`pack '${draft.pack.id}' not available, using '${pack.id}'`);

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
  };

  return {
    bundle,
    intent,
    notes,
    fillNotes: fill.notes,
    stats: fill.stats,
    timings: { fillMs: t1 - t0, layoutMs: t2 - t1 },
  };
}

export const hashWorld = (b: WorldBundle): Promise<string> => specHash(ENGINE_HASH, b);
