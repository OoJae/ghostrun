// The real world pipeline, fed by the fixture until the fill lane streams from an LLM:
//   JSONL fill → parseFill → pack.generate → placeWorld → placed WorldBundle.
import fixtureFill from "../../../packages/ir/fixtures/ctf-neon.jsonl?raw";
import coinRushFill from "../../../packages/ir/fixtures/coin-rush.jsonl?raw";
import forestFill from "../../../packages/packs/outdoor/test/fixtures/glow-forest.jsonl?raw";
import parkourFill from "../../../packages/packs/course/test/fixtures/parkour-time-trial.jsonl?raw";
import heistFill from "../../../packages/ir/fixtures/heist-live-1.jsonl?raw";
import vaultFill from "../../../packages/ir/fixtures/vault-heist.jsonl?raw";
import duelFill from "../../../packages/ir/fixtures/wizard-duel.jsonl?raw";
import zombieFill from "../../../packages/ir/fixtures/zombie-survival.jsonl?raw";
import laserFill from "../../../packages/ir/fixtures/laser-tag.jsonl?raw";
import stationFill from "../../../packages/ir/fixtures/space-station.jsonl?raw";
import kartFill from "../../../packages/ir/fixtures/kart-race.jsonl?raw";
import streetFill from "../../../packages/ir/fixtures/street-race.jsonl?raw";
import snowFill from "../../../packages/ir/fixtures/snowmobile-race.jsonl?raw";
import fengShuiFill from "../../../packages/ir/fixtures/fengshui-gallery.jsonl?raw";
import fengShuiBrokenFill from "../../../packages/ir/fixtures/fengshui-gallery-broken.jsonl?raw";
import museumFill from "../../../packages/ir/fixtures/museum-bribe.jsonl?raw";
import villaFill from "../../../packages/ir/fixtures/villa-viewing.jsonl?raw";
import gladeFill from "../../../packages/ir/fixtures/glade-walk.jsonl?raw";
import { specHash, type FillNote, type FillStats, type WorldBundle } from "@ghostrun/ir";
import type { PackLayout } from "@ghostrun/plugin-api";
import { ENGINE_HASH, placeFill } from "@ghostrun/world";
import { cueOf, rawMeta, weatherWord, type Cue } from "./render/pick";

// the engine hash lives with the placer the edge shares (@ghostrun/world)
export { ENGINE_HASH };

/** The organizer's brief the fixture answers. */
export const BRIEF = "Create a capture-the-flag game in a neon city. Add double jump. Score when the orb reaches the goal.";


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
  /** What the AI wrote about how it looks (the renderer and the sound pick its look from this). */
  cue: Cue;
  /**
   * For live (and edited) worlds: what the repair loop needs to ask for a patch, and what the
   * person pinned on the Intent card (a rebuild as a maze stays a maze through the next rebuild).
   */
  source?: { prompt: string; intent: unknown; fill: string; seed: number; pack: string; base?: string; edits?: string[]; pinned?: { pack?: string; mode?: "play" | "wander"; genre?: string } };
  intent: Intent;
  notes: string[];
  /** The pack's rooms and doorways it was placed on (what the Feng Shui check reads). */
  layout?: PackLayout;
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
export const FIXTURES: Record<string, string> = { ctf: fixtureFill, "coin-rush": coinRushFill, forest: forestFill, parkour: parkourFill, heist: heistFill, vault: vaultFill, duel: duelFill, zombies: zombieFill, "laser-tag": laserFill, station: stationFill, kart: kartFill, "street-race": streetFill, snowmobile: snowFill, fengshui: fengShuiFill, "fengshui-broken": fengShuiBrokenFill, museum: museumFill, villa: villaFill, glade: gladeFill };
export const FIXTURE_PROMPTS: Record<string, string> = {
  ctf: BRIEF,
  "coin-rush": "Collect five gold coins in a neon arena before the clock runs out. Mind the lava.",
  forest: "A bioluminescent forest at night: climb to the owl lookout before the fog rolls in.",
  vault: "A museum at night: find the brass key, open the vault, steal the star sapphire and get to the van before the alarm.",
  heist: "A museum heist: grab the key, unlock the vault, steal the gem and escape before the alarm timer runs out.",
  parkour: "A parkour time trial: double jump the opening wall, then race the gaps and beams to the finish.",
  duel: "A wizard duel in a neon arena: fireballs against a frost mage, healing potions in your circle, a storm crystal on the balcony.",
  zombies: "Zombie survival: hold the yard with a blaster and knock out ten zombies before they get you.",
  "laser-tag": "A laser tag game in a neon arena: red against blue, first team to ten tags wins.",
  station: "A shooter in a space station: get past the security robots and shoot down the reactor core.",
  kart: "A go-kart race in a neon arena: three laps through the gates against two rival karts.",
  "street-race": "A street race through the neon city: two laps against rival cars before the police arrive.",
  snowmobile: "A snowmobile race on a frozen lake: two laps through the ice gates, drifting round the pines.",
  fengshui: "A Feng Shui handbag gallery: five wings, one for each element, and a reception desk in the command position.",
  "fengshui-broken": "A Feng Shui handbag gallery with a tall arched window in line with the front door and an incense burner on the doorstep.",
  museum: "A museum heist at night: collect coins, bribe the guard to look the other way, and carry the star sapphire out of the vault to the van.",
  villa: "A villa tour where the guide books a viewing.",
  glade: "A bioluminescent forest at night to wander: a glowcap glade, a lantern grove and the rangers' camp.",
};

/** Fill text (fixture or a live stream) → placed world, choosing the pack from the registry. */
export function worldFromFill(fillText: string, seed: number, live?: Intent["live"], packId?: string, mode?: WorldBundle["mode"]): World {
  // placed into the pack the fill was written against, in the mode the intent decided
  const placed = placeFill(fillText, seed, { pack: packId, mode });
  const { bundle, notes } = placed;

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

  // the stored fill names the pack actually used, so the same fill always rebuilds the same world,
  // and carries the intent's setting, so a share link rebuilds the same look
  const lines = fillText.split("\n");
  const raw = rawMeta(fillText);
  const setting = live?.setting ? live.setting.slice(0, 240) : (raw?.setting ?? "");
  try {
    const meta = JSON.parse(lines[0] ?? "") as { op?: string; pack?: string; mode?: string; setting?: string };
    if (meta.op === "meta" && (meta.pack !== placed.pack || meta.mode !== bundle.mode || (setting && meta.setting !== setting))) lines[0] = JSON.stringify({ ...meta, pack: placed.pack, mode: bundle.mode, ...(setting ? { setting } : {}) });
  } catch {
    // no meta line: the parser already defaulted it
  }
  // A meta line the parser turned down (a weather word it doesn't know, like "sandstorm") still says
  // how the world looks: its cosmetic words are kept. Cosmetic only, so the spec hash can't move.
  if (raw?.look !== undefined && bundle.cosmetic.look !== raw.look) {
    bundle.cosmetic = { ...bundle.cosmetic, look: raw.look, weather: weatherWord(raw.weather ?? ""), ...(raw.mood && { mood: raw.mood }), ...(raw.timeOfDay !== undefined && { timeOfDay: raw.timeOfDay }) };
    intent.look = raw.look;
    intent.weather = bundle.cosmetic.weather;
  }
  return {
    bundle,
    fill: lines.join("\n"),
    seed,
    cue: cueOf(bundle, { setting, meta: raw }),
    intent,
    notes,
    layout: placed.layout,
    fillNotes: placed.fillNotes,
    stats: placed.stats,
    timings: placed.timings,
  };
}

export const hashWorld = (b: WorldBundle): Promise<string> => specHash(ENGINE_HASH, b);
