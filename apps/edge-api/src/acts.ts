// Speech acts at the edge: what a character accepts comes from the world's typed rules (the client
// sends them with the menu), and the mind's answer is checked against them again here, as its
// option is checked against the menu. A mind can never accept an act the world doesn't have, below
// the world's price, or a slot that isn't a real time to come; and an option that only an act earns
// (a guard looking away) is never chosen without that act.
import type { MindAct } from "@ghostrun/llm";

const ACTS = new Set(["ask", "command", "offer", "buy", "pay", "book"]);
const WHAT = /^[a-z0-9_.]{0,48}$/;
const SLOT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const OPTION = /^[\w.:-]{1,48}$/;
/** IANA zone names ("Europe/Prague", "America/Argentina/Buenos_Aires", "UTC"). */
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

const int = (x: unknown, max: number) => (typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= max ? x : 0);

/** The acts a request says this character accepts: at most six, each one well formed, any option it earns on the menu. */
export function readActs(raw: unknown, menu: readonly string[]): MindAct[] {
  if (!Array.isArray(raw)) return [];
  const out: MindAct[] = [];
  for (const x of raw.slice(0, 6)) {
    if (!x || typeof x !== "object") continue;
    const a = x as Record<string, unknown>;
    if (typeof a.act !== "string" || !ACTS.has(a.act)) continue;
    const gives = typeof a.gives === "string" && OPTION.test(a.gives) && menu.includes(a.gives) ? a.gives : "";
    out.push({ act: a.act, what: typeof a.what === "string" && WHAT.test(a.what) ? a.what : "", n: int(a.n, 9999), gives });
  }
  return out;
}

/** A few of the world's facts to answer questions from, one short line each. */
export function readFacts(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, 8).map((x) => x.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 160)) : [];
}

/** Today's date as the visitor's device has it ("2026-11-02, Monday"), and their time zone, or "" when malformed. */
export const readToday = (x: unknown) => (typeof x === "string" && DAY.test(x) ? x.slice(0, 24).replace(/[^\w ,-]/g, "") : "");
export const readZone = (x: unknown) => (typeof x === "string" && ZONE.test(x) && x.length <= 48 ? x : "");

export interface Settled {
  option: string;
  act: string;
  what: string;
  n: number;
  slot: string;
}

/** A real calendar date and time, on or after today and within a year of it. */
function realSlot(slot: string, today: string): boolean {
  const m = SLOT.exec(slot);
  if (!m) return false;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const at = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(at);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59) return false;
  const t = DAY.exec(today);
  if (!t) return true;
  const from = Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]));
  return at >= from && at < from + 366 * 86_400_000;
}

/**
 * The mind's answer, settled against what the world accepts: an act it doesn't have, below its
 * price, or with no real slot is refused (act ""); an earned option comes only with its act; any
 * other option must be on the menu and not an earned one, else the character keeps what it plays.
 */
export function settleAct(v: Record<string, unknown>, acts: readonly MindAct[], menu: readonly string[], current: string, today: string): Settled {
  const keep = menu.includes(current) ? current : menu[0]!;
  const earned = new Set(acts.map((a) => a.gives).filter(Boolean));
  const free = typeof v.option === "string" && menu.includes(v.option) && !earned.has(v.option) ? v.option : earned.has(keep) ? (menu.find((o) => !earned.has(o)) ?? keep) : keep;
  const none: Settled = { option: free, act: "", what: "", n: 0, slot: "" };
  const act = typeof v.act === "string" ? v.act : "none";
  const what = typeof v.what === "string" && WHAT.test(v.what) ? v.what : "";
  const n = int(v.n, 9999);
  const slot = typeof v.slot === "string" ? v.slot : "";
  // (the first the world has that this answer meets: the thing offered, and enough of it)
  const meets = (a: MindAct) => {
    if (a.act !== act) return false;
    if (act === "book") return realSlot(slot, today);
    if (act === "command") return menu.includes(what) && !earned.has(what);
    if (act === "ask") return true;
    return (!a.what || a.what === what) && n >= a.n;
  };
  const a = acts.find(meets);
  if (!a) return none;
  const option = act === "command" ? what : a.gives || free;
  return { option, act, what: act === "book" || act === "ask" ? a.what : what, n: act === "book" || act === "ask" || act === "command" ? 0 : n, slot: act === "book" ? slot : "" };
}
