// What the Host says out loud: a short recap when a run ends ("You lost because…", from the same
// causal log as the card), and the first sentence or two of an answer. Plain functions, so the
// words are tested without a voice.
import type { WorldBundle } from "@ghostrun/ir";
import { why, type Story } from "../host";

/** why() reads as a caption ("reached the van"); spoken after "because" it needs its subject. */
function subject(reason: string): string {
  if (/^(reached|touched|collected)\b/.test(reason)) return `you ${reason}`;
  if (/^hit by\b/.test(reason)) return `you were ${reason}`;
  if (/^(red|blue) team\b/.test(reason)) return `the ${reason}`;
  return reason;
}

const sentence = (s: string) => {
  const t = s.replace(/\s*\([^)]*\)/g, "").trim();
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : "";
};

/**
 * The Host's spoken recap of a run: why it ended, then the moment that mattered most (the story's
 * last one), unless it only says the same thing again.
 */
export function recap(r: { k: "win" | "lose"; tick: number; rule: string; story?: Story | null }, b: WorldBundle): string {
  const reason = why(b, r.rule);
  const secs = Math.round((r.tick / 60) * 10) / 10;
  const first = r.k === "lose" ? (reason ? `You lost because ${subject(reason)}.` : "You lost.") : `You won in ${secs} seconds${reason ? `: ${subject(reason)}` : ""}.`;
  const last = r.story?.moments.at(-1)?.text ?? "";
  const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const second = last && !plain(first).includes(plain(last).replace(/^the /, "")) ? sentence(last) : "";
  return second ? `${first} ${second}` : first;
}

/** The first `n` sentences of an answer: enough to hear why, the rest stays on the card. */
export function firstSentences(text: string, n = 2): string {
  const parts = text.trim().split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“'])/u);
  return parts.slice(0, n).join(" ");
}
