// What the headset shows, as plain data: the React HUD can't be seen in VR, so the app hands the
// same facts (the proof's line, the score, the run's result, who is talking) to the in-headset
// panels as words. No three.js here: the app's own chunk imports it.
import type { WorldBundle } from "@ghostrun/ir";
import { recap } from "../audio/lines";
import { clock, why, type Story } from "../host";
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
  /** One-pick prompts for where there is no speech recognition. */
  prompts: readonly { label: string; prompt: string }[];
  /** A world is being built (the prompt chips and Play again wait). */
  busy: boolean;
}

/** What a panel button (or a spoken prompt) asks the app to do. */
export type VrAction = { k: "again" } | { k: "build"; prompt: string };

export const EMPTY_HUD: VrHud = { proof: { text: "proof: pending", tone: "pending" }, score: "", hint: null, toast: null, bark: null, result: null, race: null, prompts: [], busy: false };

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
