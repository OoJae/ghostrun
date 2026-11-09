// What the headset shows, as plain data: the React HUD can't be seen in VR, so the app hands the
// same facts (the proof's line, the score, the run's result, who is talking) to the in-headset
// panels as words. No three.js here: the app's own chunk imports it.
import type { WorldBundle } from "@ghostrun/ir";
import { freeAnchors } from "@ghostrun/layout";
import { recap } from "../audio/lines";
import type { EditState } from "../hud/Edit";
import { clock, why, type Story } from "../host";
import { t } from "../i18n";
import type { World } from "../pipeline";
import { raceClock, split, type Rival } from "../race";

export type Tone = "good" | "bad" | "pending" | "warn";

/** The end of a run, said as the desktop card says it. */
export interface VrResult {
  k: "win" | "lose";
  /** "You win" / "You lose". */
  head: string;
  /** "12.4 s · reached the van". */
  time: string;
  /** Against the AI par, when the proof has one. */
  par: string | null;
  /** Against the ghost you raced (a win only). */
  race: string | null;
  /** The Host's recap, the line it says out loud. */
  recap: string;
  /** What led to it (the Host's story, its last few moments), each with its time. */
  moments: string[];
  /** The tick the run ended on (a new run's end is a new card). */
  tick: number;
}

export interface VrHud {
  /** The receipt's headline and the proof's status ("Rooftop lane needs double jump: verified · 12 of 12 AI runners won"). */
  proof: { text: string; tone: Tone };
  /** The score, the clock and the secrets found, as one line ("" until there is any). */
  score: string;
  /** What the use button does here ("flip switch"), or null. */
  hint: string | null;
  /** A brief message (a notice, a toast, the build's progress), or null. */
  toast: string | null;
  /** The line a character is saying, and who says it. */
  bark: { npc: string; name: string; line: string; at: number } | null;
  result: VrResult | null;
  /** The ghost being raced (its live split is read from the simulation). */
  race: { rival: Rival; secrets: ReadonlySet<string> } | null;
  /** One-pick prompts for where there is no speech recognition (the landing's starters). */
  prompts: readonly { label: string; prompt: string }[];
  /** A world is being built (the prompt chips and Play again wait). */
  busy: boolean;
  /** Making and changing the world from inside the headset (ff.vr_create). */
  make: VrMake;
}

/** A thing the diorama's hand may pick up and put somewhere else (a pickup or a prop). */
export interface VrMovable {
  id: string;
  /** What it is, in words ("brass key"). */
  label: string;
  /** It hangs at wall height (a painting): it goes on another wall-height anchor. */
  high: boolean;
}

/** Somewhere a thing may be dropped: an anchor of the world's layout nothing stands on, in world coordinates. */
export interface VrSpot {
  zone: string;
  anchor: string;
  /** Its zone's name ("Great hall"). */
  label: string;
  at: [number, number, number];
  high: boolean;
}

/** The latest edit, in the headset's words: what is happening, what changed, how the receipt moved. */
export interface VrEdit {
  status: "working" | "proving" | "done" | "failed";
  /** "Re-proved: super high jumps". */
  line: string;
  /** What changed in the world: "jump height 1.6 → 3.4 m" ("" for none yet). */
  summary: string;
  /** How the receipt moved: "Headline: verified → counterexample · Counterexamples: 0 → 2" ("" until it is re-proved). */
  receipt: string;
}

export interface VrMake {
  /** The creation tools are on (ff.vr_create): the watch's Change it and Diorama, New world listening at once. */
  on: boolean;
  /** Edits in words (said, or a chip) need the live AI; a move in the diorama doesn't. */
  live: boolean;
  /** Three changes worth trying on this world (the desktop's chips). */
  chips: readonly string[];
  canUndo: boolean;
  edit: VrEdit | null;
  movable: readonly VrMovable[];
  spots: readonly VrSpot[];
  /** The world's extent (the diorama fits it on the table). */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
}

/** What a panel button (or a spoken prompt) asks the app to do. */
export type VrAction =
  | { k: "again" }
  | { k: "build"; prompt: string }
  /** A change to the world in words (a chip, or said): the desktop's edit box. */
  | { k: "edit"; change: string }
  | { k: "undo" }
  /** The diorama's hand put a thing on another anchor: a move op, re-proved like any edit. */
  | { k: "move"; id: string; zone: string; anchor: string };

export const NO_MAKE: VrMake = { on: false, live: false, chips: [], canUndo: false, edit: null, movable: [], spots: [], bounds: null };

export const EMPTY_HUD: VrHud = { proof: { text: "proof: pending", tone: "pending" }, score: "", hint: null, toast: null, bark: null, result: null, race: null, prompts: [], busy: false, make: NO_MAKE };

/** The edit box's state in the headset's words (null while there is none). */
export function vrEdit(s: EditState): VrEdit | null {
  switch (s.status) {
    case "idle":
      return null;
    case "editing":
      return { status: "working", line: t("Changing it: {change}…", { change: s.change }), summary: "", receipt: "" };
    case "racing":
      return { status: "working", line: t("Racing harder versions: {k} of {n} proved…", { k: s.proved, n: s.total }), summary: "", receipt: "" };
    case "proving":
      return { status: "proving", line: t("AI runners re-proving: {change}…", { change: s.change }), summary: s.summary.join(" · "), receipt: "" };
    case "done": {
      const moved = (s.delta ?? []).map((d) => `${d.label}: ${d.from} → ${d.to}`);
      const same = s.delta && !s.delta.length ? [t("Receipt unchanged: every check came out the same.")] : [];
      return { status: "done", line: t("Re-proved: {change}", { change: s.change }), summary: s.summary.join(" · "), receipt: [...moved, ...same].join(" · ") };
    }
    case "failed":
      return { status: "failed", line: s.message, summary: "", receipt: "" };
  }
}

/** Kinds the diorama's hand may move: what stands about, never a wall, a door, a spawn or a goal. */
const MOVABLE = new Set(["pickup", "prop"]);

/**
 * What the diorama can pick up (the fill's own pickups and props, not the placer's extras) and
 * where it can put them (the layout's free anchors), for the world on show.
 */
export function makeOf(w: World): Pick<VrMake, "movable" | "spots" | "bounds"> {
  const ent = new Map(w.bundle.entities.map((e) => [e.id, e]));
  const names = new Map(w.bundle.zones.map((z) => [z.id, z.name || z.id]));
  const spots: VrSpot[] = w.layout ? freeAnchors(w.fill, w.layout).map((a) => ({ zone: a.zone, anchor: a.anchor, label: names.get(a.zone) ?? a.zone, at: a.at, high: a.high })) : [];
  const anchors = new Map<string, boolean>();
  if (w.layout) for (const z of w.layout.zones) for (const [id, p] of Object.entries(z.anchors)) anchors.set(`${z.slot}/${id}`, p[1] > z.floorY + 0.5);
  const slot = new Map(w.bundle.zones.map((z) => [z.id, z.slot]));
  const movable: VrMovable[] = [];
  for (const raw of w.fill.split("\n")) {
    let o: { op?: unknown; id?: unknown };
    try {
      o = JSON.parse(raw) as typeof o;
    } catch {
      continue;
    }
    const e = typeof o.id === "string" && o.op === "ent" ? ent.get(o.id) : undefined;
    if (!e || !MOVABLE.has(e.kind)) continue;
    movable.push({ id: e.id, label: e.noun || e.id, high: anchors.get(`${slot.get(e.zone)}/${e.anchor}`) ?? false });
  }
  const b = w.layout?.cameraBounds;
  return { movable, spots, bounds: b ? { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] } : null };
}

/** The score line the desktop shows over the world, in words. */
export function scoreText(s: { red: number; blue: number; result: string | null }, teams: boolean, clock: number | null, secrets: { found: number; of: number }): string {
  if (!(s.red > 0 || s.blue > 0 || s.result || clock !== null || secrets.found > 0)) return "";
  const parts = [teams ? `RED ${s.red} – ${s.blue} BLUE` : `SCORE ${s.red}`];
  if (clock !== null && !s.result) parts.push(`${Math.floor(clock / 60)}:${String(Math.floor(clock % 60)).padStart(2, "0")}`);
  if (secrets.of > 0 && secrets.found > 0) parts.push(`★ ${secrets.found}/${secrets.of}`);
  return parts.join(" · ");
}

/** The result card's words: the time and why, against the AI par and the ghost, and the Host's recap. */
export function vrResult(r: { k: "win" | "lose"; tick: number; rule: string; story?: Story | null }, bundle: WorldBundle, par: number | null, vs: { name: string; ticks: number } | null): VrResult {
  const t = Math.round((r.tick / 60) * 10) / 10;
  const reason = why(bundle, r.rule);
  const vsPar = par === null ? null : r.k === "win" ? (t <= par ? `You beat the AI par of ${par} s by ${Math.round((par - t) * 10) / 10} s.` : `AI runners do it in ${par} s: there's a faster route.`) : null;
  return {
    k: r.k,
    head: r.k === "win" ? "You win" : "You lose",
    time: `${t} s${reason ? ` · ${reason}` : ""}`,
    par: vsPar,
    race: vs && r.k === "win" ? `vs ${vs.name} ${raceClock(vs.ticks)}: you ${raceClock(r.tick)} (${split((r.tick - vs.ticks) / 60)})` : null,
    recap: recap(r, bundle),
    moments: (r.story?.moments ?? []).slice(-3).map((m) => `${clock(m.tick)} ${m.text}`),
    tick: r.tick,
  };
}
