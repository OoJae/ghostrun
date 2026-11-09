// A fill to a placed world: the one pipeline everything that builds a world shares (the web
// client's live lane, shares and gallery, and the edge's cloud proof). The same fill text, seed,
// pack and mode always place the same world, so a spec hash one of them claims, another can check.
//   JSONL fill → parseFill → pack.generate → placeWorld → placed WorldBundle.
import { lawsUnwritten, layoutLaws, parseFill, type FillNote, type FillStats, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import type { PackLayout } from "@ghostrun/plugin-api";
import { layoutOf, packFor, PACKS } from "@ghostrun/registry";

/** Engine hash bound into the spec hash: SHA-256 of the pinned Rapier wasm build (docs/gates.md, S0). */
export const ENGINE_HASH = "4e9890fd2df60072f9db06a33e4030221249c1b3687b722b2388c21f09e97551";

declare const __PROOF_VERSION__: string | undefined;

/**
 * Which proof code this build runs: a hash over the source of every package a receipt depends on,
 * stamped in when the web app and the Worker are built (version.ts); "dev" where nothing stamped it
 * (unit tests). The edge keeps and serves a receipt only for the version it was proved with, and the
 * client compares its own receipt only with one from the same version.
 */
export const PROOF_VERSION: string = typeof __PROOF_VERSION__ === "string" ? __PROOF_VERSION__ : "dev";

export interface Placed {
  bundle: WorldBundle;
  /** The pack it was placed in (a pack the fill names that isn't available falls back to another). */
  pack: string;
  /** The pack's layout it was placed on (what the Feng Shui checks read the room from). */
  layout: PackLayout;
  /** What the placer moved, repaired or substituted, in words. */
  notes: string[];
  fillNotes: FillNote[];
  stats: FillStats;
  timings: { fillMs: number; layoutMs: number };
}

/**
 * Place a fill. `pack` is the pack the fill was written against (its meta line sometimes names
 * another) and `mode` the intent's play or wander (fills tend to say "play").
 */
export function placeFill(fillText: string, seed: number, opts: { pack?: string | undefined; mode?: WorldBundle["mode"] | undefined; engine?: string } = {}): Placed {
  const t0 = performance.now();
  const fill = parseFill(fillText, { seed });
  const t1 = performance.now();
  const draft = fill.draft;
  if (opts.pack && PACKS.some((p) => p.id === opts.pack)) draft.pack = { ...draft.pack, id: opts.pack };
  if (opts.mode) draft.mode = opts.mode;
  const known = PACKS.some((p) => p.id === draft.pack.id);
  const pack = packFor(draft.pack.id);
  // a structural edit's layout ("layout" in the meta line); every other fill builds on the defaults
  const shape = layoutOf(pack, fillText);
  if (shape.custom) draft.pack = { ...draft.pack, params: shape.custom };
  const layout = pack.generate({ seed, params: shape.params, sub: draft.pack.sub, laws: layoutLaws(fillText, draft.laws), harder: false });
  const { bundle, notes } = placeWorld({ ...draft, engine: opts.engine ?? ENGINE_HASH }, layout, { reach: lawsUnwritten(fillText) });
  const t2 = performance.now();
  if (!known) notes.unshift(`pack '${draft.pack.id}' not available, using '${pack.id}'`);
  return { bundle, pack: pack.id, layout, notes, fillNotes: fill.notes, stats: fill.stats, timings: { fillMs: t1 - t0, layoutMs: t2 - t1 } };
}
