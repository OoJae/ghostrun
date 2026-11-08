// The only producer of strings a receipt shows. Every number carries its method, and no
// percentage is printed for fewer than 30 trials (honest labels are a never-cut item).
import type { Parting } from "./redgreen";
import type { FailSpot, Revealed } from "./revealed";
import type { Chip, FailRun, Level, Playtest, Receipt } from "./types";

export function fraction(k: number, n: number): string {
  if (n < 30) return `${k} of ${n}`;
  return `${Math.round((k / n) * 100)}% (n=${n})`;
}

export function chipLine(c: Chip): string {
  const mark = { verified: "✓", played: "✓", modelled: "~", not_checkable: "–", counterexample: "✗" }[c.status];
  const count = c.n > 0 ? ` · ${fraction(c.k, c.n)}` : "";
  const cx = c.cx ? ` — ${c.cx.text}` : "";
  return `${mark} [${c.tier}] ${c.text}${count}${cx}  (${c.method}${c.src === "ai" ? ", AI-written rule" : c.src === "template" ? ", template rule" : ""})`;
}

/** The word for a status, exactly as the receipt means it (a played claim is not "verified"). */
export function statusWord(s: Chip["status"]): string {
  return { verified: "verified", played: "played", modelled: "modelled", not_checkable: "not checkable yet", counterexample: "counterexample" }[s];
}

// ---- the playtest: the difficulty band and what the runners revealed ----------------------------

/** A share of the positions sampled (thousands of them, so a percentage is fair): "28%". */
export const share = (x: number) => `${Math.round(x * 100)}%`;

/** Seconds on a clock: 0:07, 1:42. */
export function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  const m = Math.floor(t / 60);
  return `${m}:${String(t - m * 60).padStart(2, "0")}`;
}

const LEVEL_WORDS: Record<Level, string> = { novice: "novices", average: "average", expert: "experts" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Normal: novices 2 of 6 · average 5 of 6 · experts 12 of 12" (a too-easy win says so). */
export function bandSaid(p: Playtest, r?: Receipt): string {
  const easy = r?.chips.find((c) => c.id === "T3:too_easy");
  const why = p.band === "Unbeaten" ? " (no expert runner won, so the lower levels weren't sent)" : easy ? ` (${easy.text})` : "";
  return `${p.band}${why}: ${p.levels.map((l) => `${LEVEL_WORDS[l.level]} ${fraction(l.won, l.runs)}`).join(" · ")}`;
}

/** How the band was found. */
export function bandMethod(p: Playtest): string {
  return `physics, ${p.levels.reduce((a, l) => a + l.runs, 0)} AI runners at ${plural(p.levels.length, "skill level")}`;
}

export const bandLine = (p: Playtest, r?: Receipt) => `${bandSaid(p, r)}  (${bandMethod(p)})`;

/** "Clear times: median 0:31, 0:22 to 0:58 (19 winning runs) · experts 0:24 · average 0:33". */
export function timesLine(t: NonNullable<Revealed["times"]>): string {
  const range = clock(t.lo) !== clock(t.hi) ? `, ${clock(t.lo)} to ${clock(t.hi)}` : "";
  const by = t.by.length > 1 ? ` · ${t.by.map((x) => `${LEVEL_WORDS[x.level]} ${clock(x.median)}`).join(" · ")}` : "";
  return `Clear times: median ${clock(t.median)}${range} (${plural(t.n, "winning run")})${by}`;
}

/** "orb at 0:12 · goal ring at 0:31 (19 of 24 runs) · won at 0:45 (19 of 24)": median first times. */
export function paceLine(pace: Revealed["pace"], runs: number): string {
  return pace.map((p) => `${p.step} at ${clock(p.s)}${p.k < runs ? ` (${fraction(p.k, runs)})` : ""}`).join(" · ");
}

/** "near the lava pit: hit the lava ×4 (4 of 24 runs)". */
export function failLine(f: FailSpot, runs: number): string {
  return `${f.near ? `near the ${f.near}` : "in the open"}: ${f.why.map(([w, n]) => `${w} ×${n}`).join(", ")} (${fraction(f.runs, runs)} runs)`;
}

/** "near the gate: 22 hits, 4 knock-outs". */
export function fightLine(f: { hits: number; kos: number; near?: string }): string {
  const what = [f.hits ? plural(f.hits, "hit") : "", f.kos ? plural(f.kos, "knock-out") : ""].filter(Boolean).join(", ");
  return f.near === undefined ? what : `${f.near ? `near the ${f.near}` : "in the open"}: ${what}`;
}

// ---- red/green: the same runner before and after a change -------------------------------------

/** What a red/green pair is, plainly: "Green: before the change · red: after it · the same runner, the same seed". */
export function pairLine(green: "before" | "after"): string {
  return green === "before" ? "Green: before the change · red: after it · the same AI runner, the same seed" : "Red: before the repair · green: after it · the same AI runner, the same seed";
}

/** The failing run a receipt kept, on its own: "Red: AI runner 3 of 12, where it fails (got stuck on the way to the orb, at 1:02)". */
export function failRunLine(f: FailRun, runs: number): string {
  return `Red: AI runner ${f.run + 1} of ${runs}, where it fails (${f.end.why || "it stopped"}, at ${clock(f.ghost.ticks / 60)})`;
}

/**
 * Where they part, from the runs themselves: "They part here: the second jump (green rises 2.9 m,
 * red 1.4 m)", "They part here: the red run ends (got stuck on the way to the glowing orb)",
 * "They part here: their ways split, near the Neon plaza". `red` is which of the parting's two runs is red.
 */
export function partLine(p: Parting, red: 0 | 1, near = "", why = ""): string {
  const where = near ? `, near the ${near}` : "";
  const m = (x: number) => `${Math.max(0, Math.round(x * 10) / 10)} m`;
  if (p.how === "jump") return `They part here: the ${p.midair ? "second " : ""}jump${where} (green rises ${m(p.rise[1 - red]!)}, red ${m(p.rise[red]!)})`;
  if (p.how === "end" && p.ended !== null) return `They part here: the ${p.ended === red ? "red" : "green"} run ends${why ? ` (${why})` : ""}${where}`;
  return `They part here: their ways split${where}`;
}
