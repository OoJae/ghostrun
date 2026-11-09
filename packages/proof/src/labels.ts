// The only producer of strings a receipt shows. Every number carries its method, and no
// percentage is printed for fewer than 30 trials (honest labels are a never-cut item).
import type { Parting } from "./redgreen";
import type { Element, FengShuiFinding, FengShuiFix, FengShuiSection } from "@ghostrun/layout";
import type { FailSpot, Revealed } from "./revealed";
import type { Chip, FailRun, Level, Playtest, Receipt } from "./types";

export function fraction(k: number, n: number): string {
  if (n < 30) return `${k} of ${n}`;
  return `${Math.round((k / n) * 100)}% (n=${n})`;
}

export const chipLine = (c: Chip): string => line(c);

/** A chip in words with its method and where it was proved: "(physics, 12 AI runners, in the cloud)". */
export const chipLineAt = (c: Chip, host: Receipt["host"]): string => line(c, host);

function line(c: Chip, where?: Receipt["host"]): string {
  const mark = { verified: "✓", played: "✓", modelled: "~", not_checkable: "–", counterexample: "✗" }[c.status];
  const count = c.n > 0 ? ` · ${fraction(c.k, c.n)}` : "";
  const cx = c.cx ? ` — ${c.cx.text}` : "";
  return `${mark} [${c.tier}] ${c.text}${count}${cx}  (${c.method}${c.src === "ai" ? ", AI-written rule" : c.src === "template" ? ", template rule" : ""}${where ? `, ${whereWord(where)}` : ""})`;
}

/** Where a proof ran, as a receipt says it. */
export function whereWord(host: Receipt["host"]): string {
  return { device: "on your device", edge: "in the cloud", node: "in Node" }[host];
}

/** One world proved in the cloud and on this device at once: where each proof stands. */
export interface CrossCheck {
  /** Where the receipt on show was proved. */
  shown: Receipt["host"];
  /** The cloud's proof: not asked (offline, or switched off), under way, failed, or in and compared. */
  cloud: "off" | "asked" | "failed" | "same" | "different";
  device: "proving" | "done" | "failed";
  /** Both receipts' hashes (timings left out: see receiptHash), once both are in. */
  hashes?: { device: string; cloud: string };
}

/** The receipt's trust line: where it was proved, and whether the other proof got the same. */
export function crossLine(c: CrossCheck): string {
  if (c.cloud === "same") return "proved in the cloud · same result on this device";
  if (c.cloud === "different") return `the cloud and this device got different results (cloud ${c.hashes?.cloud.slice(0, 8) ?? "?"}, device ${c.hashes?.device.slice(0, 8) ?? "?"}): showing this device's`;
  if (c.shown === "edge") return c.device === "failed" ? "proved in the cloud · this device couldn't check it" : "proved in the cloud · this device is checking it…";
  if (c.cloud === "asked") return "proved on your device · the cloud is proving it too";
  return `proved ${whereWord(c.shown)}`;
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

// ---- Feng Shui: one named school's principles, checked on the placed world ----------------------

const ANCHOR_WORDS: Record<string, string> = {
  corner_ne: "north-east corner", corner_nw: "north-west corner", corner_se: "south-east corner", corner_sw: "south-west corner",
  wall_n: "north wall", wall_s: "south wall", wall_e: "east wall", wall_w: "west wall", center: "middle",
};
const anchorWords = (a: string) => ANCHOR_WORDS[a] ?? a.replace(/_/g, " ");
const ELEMENT_EXAMPLE: Record<Element, string> = { wood: "wood (a bamboo plant)", fire: "fire (a red paper lantern)", earth: "earth (a stone bench)", metal: "metal (a brass bowl)", water: "water (a small fountain)" };
const countsSaid = (c: Record<Element, number> | undefined) => (c ? (Object.keys(c) as Element[]).map((el) => `${el} ${c[el]}`).join(" · ") : "");

/** "Feng Shui (Form School): 4 of 5 principles hold · 1 not checkable" (k of n, never a percentage). */
export function fengShuiHead(s: FengShuiSection): string {
  const nc = s.findings.length - s.checked;
  if (!s.checked) return `Feng Shui (${s.school}): not checkable here`;
  return `Feng Shui (${s.school}): ${s.holds} of ${s.checked} principles hold${nc ? ` · ${nc} not checkable` : ""}`;
}

/** Why a principle holds, fails or can't be checked, in the world's own nouns and room names. */
export function fengShuiWhy(f: FengShuiFinding): string {
  const { thing = "", room = "", by = "", m = 0, share = 0, rooms = 0, have = 0, more = 0 } = f.vars;
  const pct = Math.round(share * 100);
  const andMore = more ? ` (and ${more} more)` : "";
  switch (f.why) {
    case "command_ok": return `the ${thing} sits across ${room} from its door, its back to a wall and the door in view${andMore}${f.vars.facing ? "" : "; which way it faces isn't recorded"}`;
    case "command_in_line": return `the ${thing} stands in line with the door of ${room}`;
    case "command_near": return `the ${thing} is on the door's side of ${room}, not across from it`;
    case "command_no_wall": return `the ${thing} in ${room} has no solid wall behind it`;
    case "command_hidden": return `the ${by} hides the door of ${room} from the ${thing}`;
    case "command_away": return `the ${thing} faces away from the door of ${room}`;
    case "command_none": return "there is no bed, desk, counter or sofa here to place";
    case "not_interior": return "not an interior: no rooms with doorways to check";
    case "no_front_door": return "no front door to the outside found";
    case "straight_wall": return `the view in from the front door ends at a solid wall (${room})`;
    case "straight_blocked": return `the ${thing} breaks the line in from the front door`;
    case "straight_window": return `from the front door you look straight through to the ${thing}${room ? ` in ${room}` : ""}`;
    case "straight_out": return `from the front door you look straight out of the building${room ? `, through ${room}` : ""}`;
    case "mirror_none": return "there is no mirror";
    case "mirror_aside": return `the ${thing} hangs out of the front door's line${andMore}`;
    case "mirror_faces": return `the ${thing}${room ? ` in ${room}` : ""} faces the front door`;
    case "mirror_unknown": return `the ${thing} stands in view of the front door, and which way it faces isn't recorded`;
    case "entry_clear": return `nothing stands in the way in from the front door to ${room}`;
    case "entry_blocked": return `the ${thing} stands in the way in, ${Math.abs(m)} m ${m < 0 ? "outside" : "inside"} the front door`;
    case "clutter_ok": return `${rooms === 1 ? "the room has" : `all ${rooms} rooms have`} a clear way from the door to the middle; solid things cover ${pct < 1 ? "under 1%" : `at most ${pct}%`} of a floor`;
    case "clutter_path": return `the ${thing} blocks the way from the door of ${room} to its middle`;
    case "clutter_full": return `solid things cover ${pct}% of the floor of ${room} (at most a third)`;
    case "elements_ok": return `${have} of 5 elements present: ${countsSaid(f.vars.counts)}`;
    case "elements_few": return `${have} of 5 elements present (${countsSaid(f.vars.counts)}): no ${(f.vars.missing ?? []).join(" or ")}`;
    case "elements_unnamed": return "too few things are named with a material or colour to tell";
    default: return f.why.replace(/_/g, " ");
  }
}

/** The fix for a failed principle, as the receipt offers it (the edit path takes `fix.change`). */
export function fengShuiFix(x: FengShuiFix): string {
  const { thing = "", room = "", to = "" } = x.vars;
  switch (x.key) {
    case "move_command": return to ? `move the ${thing} to the ${anchorWords(to)} of ${room}, its back to the wall` : `move the ${thing} across ${room} from its door, its back to a wall`;
    case "cover_window": return `hang a curtain over the ${thing}, or stand a tall plant between it and the front door`;
    case "screen_out": return `stand a screen or a tall plant in line with the front door${room ? ` in ${room}` : ""}`;
    case "move_mirror": return to ? `move the ${thing} to the ${anchorWords(to)}${room ? ` of ${room}` : ""}` : `move the ${thing} to a side wall`;
    case "clear_entry": return `move the ${thing} out of the way in`;
    case "clear_path": return `move the ${thing} off the way from the door of ${room} to its middle`;
    case "fewer_things": return `take a few solid things out of ${room}`;
    case "add_elements": return `add ${(x.vars.missing ?? []).map((el) => ELEMENT_EXAMPLE[el]).join(", ")}`;
    default: return x.change;
  }
}

/** One finding as a receipt line: "✗ Command position: the oak desk stands in line with the door of the study — fix: …". */
export function fengShuiLine(f: FengShuiFinding, name: string): string {
  const mark = { holds: "✓", fails: "✗", not_checkable: "–" }[f.verdict];
  return `${mark} ${name}: ${fengShuiWhy(f)}${f.fix ? ` — fix: ${fengShuiFix(f.fix)}` : ""}`;
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
