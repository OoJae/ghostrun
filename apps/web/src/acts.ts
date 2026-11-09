// Speech acts on the client: what each character accepts (read off the world's spoken rules, the
// only place it is decided), the facts it answers questions from, and a booking as a calendar file.
// Nothing here decides what an act does: an accepted act goes into the simulation as a logged input
// and the world's rule answers it there.
import type { WorldBundle } from "@ghostrun/ir";
import type { Booking } from "@ghostrun/sim";

/** One act a character accepts, as the mind is told it (and the edge checks it): offer 20 coins → look away. */
export interface Accepts {
  act: string;
  what: string;
  n: number;
  /** The menu option accepting it earns ("guard.look_away"), or "". */
  gives: string;
}

/** Acts that need the player's yes before they happen: money changing hands, a booking. */
export const CONFIRM = new Set(["pay", "buy", "book"]);

const verbOf = (option: string) => option.slice(option.lastIndexOf(".") + 1);

/** The acts this character's rules listen for (an ask is always fine), with the price each one sets. */
export function acceptsOf(b: WorldBundle, npc: string): Accepts[] {
  const menu = b.cast.find((c) => c.npc === npc)?.menu ?? [];
  const out: Accepts[] = [];
  for (const r of b.rules) {
    const w = r.when;
    if (w.t !== "spoken" || w.a !== npc) continue;
    const act = w.act || "ask";
    // the price: the trigger's count, or what the rule checks the purse holds
    const cost = r.if.find((c) => c.l === `player.${w.b}` && (c.op === "gte" || c.op === "gt"));
    const n = Math.max(w.n, cost ? Number(cost.r) + (cost.op === "gt" ? 1 : 0) || 0 : 0);
    // what accepting it earns: a state the rule sets on the character that names an option on its menu
    const earned = r.then.find((e) => e.e === "set_state" && e.target === npc && menu.some((o) => verbOf(o) === String(e.v)));
    const gives = earned ? menu.find((o) => verbOf(o) === String(earned.v))! : "";
    if (!out.some((x) => x.act === act && x.what === w.b)) out.push({ act, what: w.b, n, gives });
  }
  return out.slice(0, 6);
}

/** What a character answers questions from: what it knows, and the world's own words about its things. */
export function factsOf(b: WorldBundle, npc: string): string[] {
  const c = b.cast.find((x) => x.npc === npc);
  const zone = (id: string) => b.zones.find((z) => z.id === id)?.name || id.replace(/^z_/, "").replace(/_/g, " ");
  const texts = b.verbs.filter((v) => v.verb === "social.inspect" && typeof v.params.text === "string").map((v) => `${b.entities.find((e) => e.id === v.on)?.noun || v.on}: ${String(v.params.text)}`);
  const carried = new Set(b.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on));
  const where = b.entities.filter((e) => carried.has(e.id) && e.noun).map((e) => `the ${e.noun} is in the ${zone(e.zone)}`);
  return [...(c?.persona.knowledge ? [c.persona.knowledge] : []), ...texts.slice(0, 5), ...where.slice(0, 3)].map((x) => x.slice(0, 160)).slice(0, 8);
}

/** Today on this device as a mind is told it ("2026-11-03, Tuesday"), and its time zone. */
export function today(now = new Date()): { today: string; tz: string } {
  const pad = (x: number) => String(x).padStart(2, "0");
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return { today: `${day}, ${now.toLocaleDateString("en-US", { weekday: "long" })}`, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
}

/** Minutes a zone is ahead of UTC at an instant. */
function offsetMin(tz: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Math.round((Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - at) / 60_000);
}

/** The instant a local date and time is in a zone ("2026-11-07T15:00" in Europe/Prague), or null. */
export function slotInstant(slot: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(slot);
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // twice: the second pass settles a slot on the far side of a clock change
  let at = wall - offsetMin(tz, wall) * 60_000;
  at = wall - offsetMin(tz, at) * 60_000;
  return at;
}

/** A slot in words for the reader ("Saturday 7 November, 15:00"), in their language and zone. */
export function slotWords(slot: string, tz: string, lang = "en"): string {
  const at = slotInstant(slot, tz);
  if (at === null) return slot || "a time to be agreed";
  const d = new Date(at);
  const opts = { timeZone: tz } as const;
  return `${d.toLocaleDateString(lang, { ...opts, weekday: "long", day: "numeric", month: "long" })}, ${d.toLocaleTimeString(lang, { ...opts, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
}

const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** RFC 5545 folds lines longer than 75 octets: CRLF and a space. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
    }
    cur += ch;
  }
  return [...out, cur].join("\r\n ");
}
const stamp = (at: number) => new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const local = (slot: string, plusMin = 0) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(slot)!;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]) + plusMin));
  return stamp(t.getTime()).replace("Z", "");
};
const hhmm = (min: number) => `${min < 0 ? "-" : "+"}${String(Math.floor(Math.abs(min) / 60)).padStart(2, "0")}${String(Math.abs(min) % 60).padStart(2, "0")}`;

/**
 * The booking as a calendar file: one hour from the slot, in the reader's zone (a TZID with the
 * zone's offset at that time), the world's own words for it, and nothing about the person.
 */
export function icsFor(booking: Booking, tz: string, where: string, now = Date.now(), uid = `${now.toString(36)}-${booking.tick}@ghostrun`): string | null {
  const at = slotInstant(booking.slot, tz);
  if (at === null) return null;
  const off = offsetMin(tz, at);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GHOSTRUN//Speech acts//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VTIMEZONE", `TZID:${tz}`, "BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${hhmm(off)}`, `TZOFFSETTO:${hhmm(off)}`, "END:STANDARD", "END:VTIMEZONE",
    "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${stamp(now)}`, `DTSTART;TZID=${tz}:${local(booking.slot)}`, `DTEND;TZID=${tz}:${local(booking.slot, 60)}`,
    `SUMMARY:${icsText(booking.what)}`, `DESCRIPTION:${icsText(`${booking.what}, booked with the ${where} in a GHOSTRUN world. One hour.`)}`, "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** Offers the file to save ("viewing-at-villa-aurelia.ics"). */
export function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/calendar" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const fileName = (what: string) => `${what.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "booking"}.ics`;
