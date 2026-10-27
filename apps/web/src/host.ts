// The Host: why a run ended the way it did, told from the simulation's own causal log (every event
// carries the index of the event that caused it within its tick). Deterministic and free: the story
// is a few moments, each with its time, what happened, who did it and where, and each can be
// replayed exactly. Free-form questions go to the model with these facts and nothing else.
import type { Rule, Vec3, WorldBundle } from "@ghostrun/ir";
import type { SimEvent } from "@ghostrun/sim";
import { api } from "./api";

export interface Moment {
  tick: number;
  text: string;
  /** Where it happened, when the log can say (a sensor's position, the player's trail). */
  at: Vec3 | null;
}

export interface Story {
  ending: string;
  moments: Moment[];
}

export const clock = (tick: number) => {
  const s = Math.floor(tick / 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const nameOf = (b: WorldBundle, id: string) => {
  if (id === "player") return "you";
  if (id.startsWith("team:")) return `${id.slice(5)} team`;
  const e = b.entities.find((x) => x.id === id);
  if (e?.noun) return `the ${e.noun}`;
  const plain = id.replace(/_/g, " ");
  return /\d$/.test(plain) ? cap(plain) : `the ${plain}`; // "Rival 1", not "the rival 1"
};

/** Why a run ended, in words: the trigger of the rule that fired the win or the loss. */
export function why(b: WorldBundle, ruleId: string): string {
  const r: Rule | undefined = b.rules.find((x) => x.id === ruleId);
  if (!r) return "";
  const name = (id: string) => nameOf(b, id).replace(/^the /, "");
  const w = r.when;
  switch (w.t) {
    case "score_gte":
      return `${name(w.a)} reached ${w.n}`;
    case "timer_end":
      return "time ran out";
    case "hit":
      return `hit by the ${name(w.b)}`;
    case "enter":
      return w.a === "player" ? `reached the ${name(w.b)}` : `the ${name(w.a)} reached the ${name(w.b)}`;
    case "touch":
      return w.b ? `touched the ${name(w.b)}` : "collected enough";
    case "state_is":
      return `the ${name(w.a)} became ${w.s}`;
    default:
      return "";
  }
}

/**
 * The story of a run from its event log: the ending, then up to `max` moments that led to it,
 * oldest first. `trail` is the player's position every 30 ticks (for where the player was).
 */
export function story(b: WorldBundle, log: readonly SimEvent[], trail: readonly Vec3[] = [], max = 4): Story | null {
  const endAt = log.findLastIndex((e) => e.k === "win" || e.k === "lose");
  if (endAt < 0) return null;
  const end = log[endAt]!;
  const lost = end.k === "lose";
  const reason = why(b, end.rule);
  const ending = `You ${lost ? "lost" : "won"} at ${clock(end.tick)}${reason ? `: ${reason}` : ""}.`;
  const posOf = (id: string): Vec3 | null => b.entities.find((e) => e.id === id)?.pos ?? null;
  const playerAt = (tick: number): Vec3 | null => trail[Math.min(trail.length - 1, Math.floor(tick / 30))] ?? null;
  // the event that caused log[i], if any (causes index into the same tick's events)
  const causeOf = (i: number): number => {
    const c = log[i]!.cause;
    if (c < 0) return -1;
    let s = i;
    while (s > 0 && log[s - 1]!.tick === log[i]!.tick) s--;
    return s + c;
  };
  const carrierAt = (item: string, before: number): { who: string; tick: number; i: number } | null => {
    for (let i = before; i >= 0; i--) {
      const e = log[i]!;
      if (e.k === "pickup" && e.a === item) return { who: e.b, tick: e.tick, i };
      if ((e.k === "drop" && e.a === item) || (e.k === "reset" && e.a === item)) return null;
    }
    return null;
  };
  /** One scoring (or ending) event in words, from what caused it. */
  const told = (i: number): Moment | null => {
    const e = log[i]!;
    const ci = causeOf(i);
    const c = ci >= 0 ? log[ci]! : null;
    const pts = e.k === "score" ? ` (${e.a.slice(5)} ${e.v})` : "";
    if (c?.k === "enter") {
      const by = c.a === "player" || b.cast.some((k) => k.npc === c.a) ? null : carrierAt(c.a, ci);
      const text = by ? `${cap(nameOf(b, by.who))} carried ${nameOf(b, c.a)} into ${nameOf(b, c.b)}${pts}` : `${cap(nameOf(b, c.a))} reached ${nameOf(b, c.b)}${pts}`;
      return { tick: e.tick, text, at: posOf(c.b) };
    }
    if (c?.k === "touch") return { tick: e.tick, text: `${cap(nameOf(b, c.a))} collected ${nameOf(b, c.b)}${pts}`, at: posOf(c.b) };
    if (c?.k === "hit") return { tick: e.tick, text: `${cap(nameOf(b, c.a))} ran into ${nameOf(b, c.b)}`, at: c.a === "player" ? playerAt(e.tick) : posOf(c.b) };
    if (c?.k === "state") return { tick: e.tick, text: `${cap(nameOf(b, c.a))} became ${String(c.v)}${pts}`, at: posOf(c.a) };
    if (c?.k === "pickup") return { tick: e.tick, text: `${cap(nameOf(b, c.b))} picked up ${nameOf(b, c.a)}${pts}`, at: posOf(c.a) };
    if (c?.k === "timer_end") return { tick: e.tick, text: "The timer ran out", at: null };
    return e.k === "score" ? { tick: e.tick, text: `${cap(nameOf(b, e.a))} scored${pts}`, at: null } : null;
  };

  const moments: Moment[] = [];
  const rule = b.rules.find((r) => r.id === end.rule);
  if (rule?.when.t === "score_gte") {
    // the points that got the team there, and how the item changed hands before each one
    const team = rule.when.a;
    const scores = log.map((e, i) => [e, i] as const).filter(([e, i]) => e.k === "score" && e.a === team && i < endAt);
    for (const [, i] of scores.slice(-(max - 1))) {
      const m = told(i);
      if (!m) continue;
      const ci = causeOf(i);
      const item = ci >= 0 && log[ci]!.k === "enter" ? log[ci]!.a : "";
      const got = item ? carrierAt(item, ci) : null;
      // the carrier took it off someone with a tag: say so first
      if (got) {
        for (let j = got.i; j >= 0 && log[j]!.tick >= got.tick - 30; j--) {
          const t = log[j]!;
          if (t.k === "tag" && t.a === got.who) {
            moments.push({ tick: t.tick, text: `${cap(nameOf(b, t.a))} tagged ${nameOf(b, t.b)} and took ${nameOf(b, item)}`, at: t.b === "player" ? playerAt(t.tick) : null });
            break;
          }
        }
      }
      moments.push(m);
    }
  } else {
    const ci = causeOf(endAt);
    const m = told(endAt) ?? (ci >= 0 ? told(ci) : null);
    if (m) moments.push(m);
  }
  // a loss on the clock: how far the player had got
  if (lost && rule?.when.t === "timer_end") {
    const winRule = b.rules.find((r) => r.then.some((x) => x.e === "win"));
    if (winRule?.when.t === "score_gte") {
      const had = log.slice(0, endAt).findLast((e) => e.k === "score" && e.a === winRule.when.a)?.v ?? 0;
      moments.push({ tick: end.tick, text: `You had ${had} of the ${winRule.when.n} points you needed`, at: null });
    }
  }
  const seen = new Set<string>();
  const sorted = moments.filter((m) => !seen.has(`${m.tick}:${m.text}`) && seen.add(`${m.tick}:${m.text}`)).sort((p, q) => p.tick - q.tick);
  // the same thing again and again is one moment: "…3 times (blue 1–3)", replayed at the last
  const out: Moment[] = [];
  const base = (t: string) => t.replace(/ \((red|blue) [\d–]+\)$/, "").replace(/, \d+ times$/, "");
  for (const m of sorted) {
    const prev = out.at(-1);
    if (prev && base(prev.text) === base(m.text)) {
      const n = (Number(/, (\d+) times/.exec(prev.text)?.[1]) || 1) + 1;
      const first = /\(((?:red|blue) \d+)/.exec(prev.text)?.[1];
      const last = /\((?:red|blue) (\d+)\)$/.exec(m.text)?.[1];
      out[out.length - 1] = { ...m, text: `${base(prev.text)}, ${n} times${first && last ? ` (${first}–${last})` : ""}` };
    } else out.push(m);
  }
  return { ending, moments: out.slice(-max) };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A rule as one readable sentence (the same reading as the Logic X-ray and logic.json). */
export function sentence(b: WorldBundle, r: Rule): string {
  const name = (id: string) => (id.startsWith("team:") ? `${id.slice(5)} team` : b.entities.find((e) => e.id === id)?.noun || id.replace(/_/g, " "));
  const w = r.when;
  const n = (id: string) => (id ? name(id) : "anything");
  const when =
    w.t === "score_gte" ? `${n(w.a)} reaches ${w.n}` : w.t === "state_is" ? `${n(w.a)} becomes ${w.s}` : w.t === "timer_end" ? "the timer runs out" : w.t === "every" ? `every ${w.n} s` : w.t === "pickup" ? `${n(w.b)} picks up ${n(w.a)}` : `${n(w.a)} ${w.t.replace("_", " ")}${w.t.endsWith("h") ? "es" : "s"} ${n(w.b)}`;
  const iff = r.if.map((c) => `${n(c.l.split(".")[0]!)} ${c.l.split(".").slice(1).join(" ")} ${c.op} ${String(c.r)}`).join(" and ");
  const then = r.then
    .map((e) => (e.e === "score" ? `+${e.n || 1} ${n(e.target)}` : e.e === "win" || e.e === "lose" ? `you ${e.e}` : e.e === "set_state" ? `${n(e.target)} becomes ${String(e.v)}` : e.e === "emit" ? `effect ${e.fx}` : `${e.e} ${n(e.target)}`))
    .join(", ");
  return `WHEN ${when}${iff ? ` IF ${iff}` : ""} THEN ${then}${r.once ? " (once)" : ""}`;
}

export interface Fact {
  text: string;
  /** The run tick it happened at (replayable), or null for a fact about the world. */
  tick: number | null;
}

/** The zone a point stands in: the zone of the highest floor under it. */
function zoneAt(b: WorldBundle, p: Vec3): string | null {
  let best: { top: number; zone: string } | null = null;
  for (const s of b.statics) {
    if (s.surf === "wall" || Math.abs(p[0] - s.pos[0]) > s.size[0] / 2 || Math.abs(p[2] - s.pos[2]) > s.size[2] / 2) continue;
    const top = s.pos[1] + s.size[1] / 2;
    if (top <= p[1] + 0.2 && (!best || top > best.top)) best = { top, zone: s.zone };
  }
  return best?.zone ?? null;
}

/**
 * What the Host may say, numbered: the run's salient events (each with its time, so a citation is
 * a replay link), how the player moved, then the world's rules, laws and zones. Nothing else.
 */
export function facts(b: WorldBundle, log: readonly SimEvent[], trail: readonly Vec3[] = [], max = 36): Fact[] {
  const out: Fact[] = [];
  const s = story(b, log, trail, 8);
  if (s) out.push({ text: s.ending.replace(/\.$/, ""), tick: log.findLast((e) => e.k === "win" || e.k === "lose")?.tick ?? null });
  const carried = new Set(b.verbs.filter((v) => v.verb.endsWith(".carry")).map((v) => v.on));
  const run: Fact[] = [];
  for (const e of log) {
    const t = clock(e.tick);
    const who = (id: string) => cap(nameOf(b, id));
    if (e.k === "tag") run.push({ text: `${t} ${who(e.a)} tagged ${nameOf(b, e.b)}`, tick: e.tick });
    else if (e.k === "pickup" && carried.has(e.a)) run.push({ text: `${t} ${who(e.b)} picked up ${nameOf(b, e.a)}`, tick: e.tick });
    else if (e.k === "drop") run.push({ text: `${t} ${who(e.b)} dropped ${nameOf(b, e.a)}`, tick: e.tick });
    else if (e.k === "hit" && e.a === "player") run.push({ text: `${t} You ran into ${nameOf(b, e.b)}`, tick: e.tick });
    else if (e.k === "touch" && e.a === "player" && !carried.has(e.b)) run.push({ text: `${t} You touched ${nameOf(b, e.b)}`, tick: e.tick });
    else if (e.k === "state" && b.entities.some((x) => x.id === e.a && ["door", "switch", "plate", "checkpoint"].includes(x.kind))) run.push({ text: `${t} ${who(e.a)} became ${String(e.v)}`, tick: e.tick });
    else if (e.k === "score") run.push({ text: `${t} ${who(e.a)} scored (now ${String(e.v)})`, tick: e.tick });
    else if (e.k === "timer_end") run.push({ text: `${t} The timer ran out`, tick: e.tick });
  }
  // the story's moments say why; the raw events fill in the rest (most recent first if too many)
  for (const m of s?.moments ?? []) out.push({ text: `${clock(m.tick)} ${m.text}`, tick: m.tick });
  const room = Math.max(0, max - out.length - 8);
  out.push(...run.slice(-room));
  const jumps = log.filter((e) => e.k === "jump" && e.a === "player").length;
  const air = log.filter((e) => e.k === "air_jump" && e.a === "player").length;
  if (jumps) out.push({ text: `You jumped ${jumps} times (${air} of them double jumps)`, tick: null });
  if (trail.length > 4) {
    const by = new Map<string, number>();
    for (const p of trail) {
      const z = zoneAt(b, p);
      if (z) by.set(z, (by.get(z) ?? 0) + 1);
    }
    const [z, n] = [...by].sort((p, q) => q[1] - p[1])[0] ?? [];
    const zn = b.zones.find((x) => x.id === z);
    if (z && n) out.push({ text: `You spent ${Math.round((n / trail.length) * 100)}% of the run in the ${zn?.name || z.replace(/_/g, " ")}`, tick: null });
  }
  const l = b.laws;
  out.push({ text: `Movement: ${l.jumpsMax} jump${l.jumpsMax === 1 ? "" : "s"} in a row, each about ${l.jumpH} m high, running ${l.speed} m/s`, tick: null });
  out.push({ text: `Zones: ${b.zones.map((z) => z.name || z.id).join(", ")}`, tick: null });
  for (const r of b.rules.slice(0, Math.max(0, max - out.length))) out.push({ text: `Rule: ${sentence(b, r)}`, tick: null });
  return out.slice(0, max);
}

/** Ask the Host (POST /v1/host): an answer from the numbered facts, with the facts it cites. */
export async function askHost(question: string, list: readonly Fact[]): Promise<{ answer: string; cites: Fact[] } | null> {
  try {
    const r = await api("/v1/host", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, facts: list.map((f) => f.text) }) });
    if (!r.ok) return null;
    const out = (await r.json()) as { answer?: string; cites?: number[] };
    if (!out.answer) return null;
    return { answer: out.answer, cites: (out.cites ?? []).map((n) => list[n - 1]).filter((f): f is Fact => Boolean(f)) };
  } catch {
    return null;
  }
}
