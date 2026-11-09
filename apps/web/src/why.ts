// The Host's "why" chips and the facts that answer them. Where you stood still and when you first
// reached each step of the win (with its time and place, so the camera can fly there), against
// the AI par runner's own run from the receipt; and in a place to explore, what is in each room
// and where each exhibit is. Facts only: the Host may cite nothing else.
import type { Vec3, WorldBundle } from "@ghostrun/ir";
import { fraction, type Receipt } from "@ghostrun/proof/light";
import type { SimEvent } from "@ghostrun/sim";
import { clock, zoneAt, type Fact } from "./host";
import { k, t } from "./i18n";

/** The three "why" chips on a result card. */
export const whyChips = (end: "win" | "lose") => [end === "lose" ? k("Why did I lose?") : k("How did I win?"), k("Where did I waste time?"), k("What did the AI do differently?")];

/** The three chips in a place to explore. */
export const tourChips = (b: WorldBundle) => {
  const first = exhibits(b)[0];
  return [k("What's in each room?"), k("What's worth seeing first?"), ...(first ? [t("Where is the {thing}?", { thing: first.noun })] : [])];
};

const zoneName = (b: WorldBundle, id: string | null) => {
  const z = b.zones.find((x) => x.id === id);
  return z ? z.name || z.id.replace(/^z_/, "").replace(/_/g, " ") : "";
};
const near = (p: Vec3, q: readonly number[], r: number) => (p[0] - q[0]!) * (p[0] - q[0]!) + (p[2] - q[2]!) * (p[2] - q[2]!) < r * r;

/**
 * The longest time you stood still: three half-second samples or more within 0.3 m of each other
 * (`trail` is the player's position every 30 ticks). Null under 1.5 s.
 */
export function stoodStill(trail: readonly Vec3[]): { from: number; to: number; at: Vec3 } | null {
  let best: { from: number; to: number; at: Vec3 } | null = null;
  for (let i = 0; i < trail.length; ) {
    let j = i;
    while (j + 1 < trail.length && near(trail[i]!, trail[j + 1]!, 0.3) && Math.abs(trail[j + 1]![1] - trail[i]![1]) < 0.3) j++;
    if (j - i >= 3 && (!best || j - i > (best.to - best.from) / 30)) best = { from: i * 30, to: j * 30, at: trail[i]! };
    i = j + 1;
  }
  return best;
}

/** When you first reached each step of the win (by the playtest's step names), from the log: picked it up, touched it, brought something into it. */
function firstTimes(b: WorldBundle, log: readonly SimEvent[], steps: readonly string[]): { step: string; tick: number; at: Vec3 }[] {
  const out: { step: string; tick: number; at: Vec3 }[] = [];
  const held = new Set<string>();
  for (const step of [...new Set(steps)]) {
    const ids = new Set(b.entities.filter((e) => (e.noun || e.id.replace(/_/g, " ")) === step && (!e.team || e.team === "red" || e.kind !== "goal")).map((e) => e.id));
    held.clear();
    const hit = log.find((e) => {
      if (e.k === "pickup" && e.b === "player") held.add(e.a);
      if ((e.k === "drop" || e.k === "reset") && held.has(e.a)) held.delete(e.a);
      return (e.k === "pickup" && e.b === "player" && ids.has(e.a)) || (e.k === "touch" && e.a === "player" && ids.has(e.b)) || (e.k === "enter" && ids.has(e.b) && (e.a === "player" || held.has(e.a)));
    });
    const at = hit && b.entities.find((e) => ids.has(e.id))?.pos;
    if (hit && at) out.push({ step, tick: hit.tick, at });
  }
  return out;
}

/**
 * What the why chips need beyond the run's own facts (at most four): where you stood still, when
 * you first reached each step, and the AI par runner's run: its time against everyone's, its pace
 * and where it spent its time.
 */
export function whyFacts(b: WorldBundle, log: readonly SimEvent[], trail: readonly Vec3[], r: Receipt | null): Fact[] {
  const out: Fact[] = [];
  const still = stoodStill(trail);
  if (still) {
    const where = zoneName(b, zoneAt(b, still.at));
    out.push({ text: `${clock(still.from)} You stood still for ${Math.round((still.to - still.from) / 60)} s${where ? ` in the ${where}` : ""} (${clock(still.from)}–${clock(still.to)}), the longest you stood still`, tick: still.from, at: still.at });
  }
  const steps = r?.playtest?.steps ?? [];
  const mine = firstTimes(b, log, steps);
  if (mine.length) out.push({ text: `${clock(mine[0]!.tick)} You first reached ${mine.map((m) => `the ${m.step} at ${clock(m.tick)}`).join(", then ")}`, tick: mine[0]!.tick, at: mine[0]!.at });
  const win = r?.chips.find((c) => c.id === "T3:win");
  const par = r?.ghost && r.trails ? r.trails.findIndex((t) => t.won && t.ticks === r.ghost!.ticks) : -1;
  const pr = par >= 0 ? r!.trails![par]! : null;
  if (r?.par && win && pr) {
    const wins = r.trails!.filter((t) => t.won && t.ticks !== undefined).map((t) => t.ticks!);
    out.push({ text: `The AI par runner won in ${r.par.goldS} s, the fastest of ${win.n} AI runners (${fraction(win.k, win.n)} won, the slowest in ${Math.round((Math.max(...wins) / 60) * 10) / 10} s)`, tick: null });
    const pace = steps.map((s, i) => [s, pr.at?.[i] ?? -1] as const).filter(([, t]) => t >= 0);
    const by = new Map<string, number>();
    for (let i = 0; i + 2 < pr.xyz.length; i += 3) {
      const z = zoneName(b, zoneAt(b, [pr.xyz[i]!, pr.xyz[i + 1]! + 0.9, pr.xyz[i + 2]!]));
      if (z) by.set(z, (by.get(z) ?? 0) + 1);
    }
    const [zone, n] = [...by].sort((p, q) => q[1] - p[1])[0] ?? [];
    const share = zone && n ? `, and spent ${Math.round((n / (pr.xyz.length / 3)) * 100)}% of its run in the ${zone}` : "";
    if (pace.length || share) out.push({ text: `The AI par runner ${pace.length ? `reached ${pace.map(([s, t]) => `the ${s} at ${clock(t)}`).join(", then ")}` : "played it"}${share}`, tick: null });
  }
  return out.slice(0, 4);
}

/** What a visitor can look at: things with words to read (an exhibit's text), nearest the spawn first. */
function exhibits(b: WorldBundle): { id: string; noun: string; text: string; pos: Vec3; zone: string }[] {
  const spawn = b.entities.find((e) => e.kind === "spawn")?.pos ?? [0, 0, 0];
  return b.verbs
    .filter((v) => v.verb === "social.inspect")
    .map((v) => b.entities.find((e) => e.id === v.on) && { v, e: b.entities.find((e) => e.id === v.on)! })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .map(({ v, e }) => ({ id: e.id, noun: e.noun || e.id.replace(/_/g, " "), text: String(v.params.text ?? "").slice(0, 120), pos: e.pos, zone: zoneName(b, e.zone) || zoneName(b, zoneAt(b, [e.pos[0], e.pos[1] + 0.2, e.pos[2]])) }))
    .sort((p, q) => Math.hypot(p.pos[0] - spawn[0]!, p.pos[2] - spawn[2]!) - Math.hypot(q.pos[0] - spawn[0]!, q.pos[2] - spawn[2]!) || (p.id < q.id ? -1 : 1));
}

/**
 * A place's facts for the Host (a Wander world has no run to explain): how the visitor tour went,
 * each room and what is in it, each exhibit with its words and where it is (the camera flies to
 * the one the Host cites). At most 40, the Host's limit.
 */
export function tourFacts(b: WorldBundle, r: Receipt | null): Fact[] {
  const out: Fact[] = [];
  const tour = r?.chips.find((c) => c.id === "T3:tour");
  if (tour) out.push({ text: `An AI visitor ${tour.text} (${fraction(tour.k, tour.n)})${tour.cx ? `: ${tour.cx.text}` : ""}`, tick: null });
  const ex = exhibits(b);
  const rooms = new Map<string, typeof ex>();
  for (const x of ex) rooms.set(x.zone, [...(rooms.get(x.zone) ?? []), x]);
  for (const [zone, xs] of rooms) out.push({ text: `${zone ? `The ${zone}` : "Out in the open"} has: ${xs.map((x) => `the ${x.noun}`).join(", ")}`, tick: null, at: xs[0]!.pos });
  for (const x of ex) out.push({ text: `The ${x.noun}${x.zone ? ` is in the ${x.zone}` : ""}${x.text ? `: “${x.text}”` : ""}`, tick: null, at: x.pos });
  const empty = b.zones.filter((z) => !rooms.has(zoneName(b, z.id)));
  if (empty.length) out.push({ text: `Nothing to look at in: ${empty.map((z) => `the ${zoneName(b, z.id)}`).join(", ")}`, tick: null });
  return out.slice(0, 40);
}

/** Where the camera flies for an answer: the first fact it cites that has a place (and, in a run, a time). */
export const flyTarget = (cites: readonly Fact[], run: boolean): Fact | null => cites.find((f) => f.at && (!run || f.tick !== null)) ?? null;
