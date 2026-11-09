// NPC minds: on salient moments (a score, the objective changing hands, a tag, or now and then)
// one minded NPC at a time asks /v1/mind for one option from its typed menu and a line in
// character; the player talking to one always gets an answer. The option is queued into the
// simulation as a logged input, so replays stay exact; the line is cosmetic. Without the live
// service the bots simply keep their defaults.
// Talking, the player may also make a speech act ("here's 20 coins, look the other way"): the
// mind accepts it or refuses in character, and an accepted one goes into the simulation as a logged
// input too, where the world's own rule decides what it does (acts.ts).
import type { SimEvent, SpeechAct } from "@ghostrun/sim";
import type { Act } from "@ghostrun/ir";
import { acceptsOf, CONFIRM, factsOf, today } from "./acts";
import { api } from "./api";
import { chattiness, THINK_EVERY } from "./persona";
import type { World } from "./pipeline";
import type { RapierSim } from "./sim/rapier";

export interface ActHooks {
  /** Money changing hands or a booking: the player says yes first (then RapierSim.queueAct). */
  onConfirm?: (npc: string, name: string, act: SpeechAct) => void;
  /** Something to tell the player ("You have 5 coins."). */
  onNote?: (text: string) => void;
}

const QUIET_TICKS = 20 * 60; // think on their own at most every 20 s
// Between thoughts of their own, 8 s, one NPC at a time: about 75 calls in 10 minutes of play,
// under the edge's 120 per session and leaving room for talk. A world of bots scores, picks up and
// tags many times a second, and every NPC thinking on every event spent the allowance in a minute.
const GAP_TICKS = 8 * 60;
const IDLE_TICKS = 60 * 60; // and only while someone plays: a minute without input, they stop
const BACKOFF_TICKS = 60 * 60; // the edge said "rate limited": wait a minute

export class Minds {
  #world: World;
  readonly #sim: RapierSim;
  /** A line to show and say: `reply` when it answers the player (it cuts in over barks). */
  readonly #onBark: (npc: string, name: string, line: string, reply: boolean) => void;
  readonly #busy = new Set<string>();
  /** When each NPC last thought aloud on its own. */
  readonly #spoke = new Map<string, number>();
  #lastThought = 0;
  #quietUntil = 0;
  #turn = -1;
  #off = false;
  readonly #hooks: ActHooks;
  /** Teammates under the player's order, until a tick: their own thoughts don't overrule it. */
  readonly #held = new Map<string, number>();

  constructor(world: World, sim: RapierSim, onBark: (npc: string, name: string, line: string, reply: boolean) => void, hooks: ActHooks = {}) {
    this.#world = world;
    this.#sim = sim;
    this.#onBark = onBark;
    this.#hooks = hooks;
  }

  /** The same world with a character's persona retuned (a persona slider: prose, the same spec). */
  retarget(world: World) {
    this.#world = world;
  }

  /** NPCs with a real choice to make (a menu of two or more options), or something you can say to them. */
  get minded() {
    const b = this.#world.bundle;
    return b.cast.filter((c) => (c.menu.length > 1 || b.rules.some((r) => r.when.t === "spoken" && r.when.a === c.npc)) && b.entities.some((e) => e.id === c.npc));
  }

  /** The player gave this NPC an order: for a while (30 s) its own thoughts keep to it (it still talks). */
  hold(npc: string, ticks = 30 * 60) {
    this.#held.set(npc, this.#sim.sim.tick + ticks);
  }

  stop() {
    this.#off = true;
  }

  name(npc: string): string {
    return this.#world.bundle.entities.find((e) => e.id === npc)?.noun || npc.replace(/_/g, " ");
  }

  /** The nearest minded NPC within talking distance of the player, if any. */
  nearby(radius = 6): string | null {
    const p = this.#sim.sim.pos("player");
    let best: string | null = null;
    let bestD = radius * radius;
    for (const c of this.minded) {
      const q = this.#sim.sim.pos(c.npc);
      const d = (p[0] - q[0]) * (p[0] - q[0]) + (p[2] - q[2]) * (p[2] - q[2]);
      if (d < bestD) ((bestD = d), (best = c.npc));
    }
    return best;
  }

  observe(evs: SimEvent[]) {
    if (this.#off || !this.minded.length || this.#sim.replaying || this.#sim.idleTicks > IDLE_TICKS) return;
    const tick = this.#sim.sim.tick;
    if (tick < this.#quietUntil || tick - this.#lastThought < GAP_TICKS) return;
    // (a quiet moment comes sooner when someone chatty is about: see persona.ts)
    const soonest = Math.min(...this.minded.map((c) => THINK_EVERY[chattiness(c.persona)] ?? 1));
    const event = this.#salient(evs) ?? (tick - this.#lastThought > QUIET_TICKS * Math.min(1, soonest) ? "a quiet moment" : null);
    if (!event) return;
    const minded = this.minded;
    this.#turn = (this.#turn + 1) % minded.length;
    const c = minded[this.#turn]!;
    const npc = c.npc;
    if (this.#busy.has(npc)) return;
    // its persona says how often it thinks aloud on its own: a quiet one only answers, a chatty one
    // takes its turn sooner (each still waits its turn, so the calls stay within the allowance)
    const every = THINK_EVERY[chattiness(c.persona)] ?? 1;
    if (every === Infinity || (every > 1 && tick - (this.#spoke.get(npc) ?? -Infinity) < QUIET_TICKS * every)) return;
    this.#spoke.set(npc, tick);
    this.#lastThought = tick;
    this.#busy.add(npc);
    void this.#ask(npc, event).finally(() => this.#busy.delete(npc));
  }

  #salient(evs: SimEvent[]): string | null {
    for (const e of evs) {
      if (e.k === "score") return `${e.a.replace("team:", "")} team scored (now ${e.v})`;
      if (e.k === "pickup") return `${e.b === "player" ? "the player" : this.name(e.b)} picked up the ${this.name(e.a)}`;
      if (e.k === "tag") return `${e.a === "player" ? "the player" : this.name(e.a)} knocked the ${this.name(e.b === "player" ? "player" : e.b)} over`;
    }
    return null;
  }

  /** The player said something: always answered, even mid-thought. */
  talk(npc: string, said: string) {
    if (this.#off) return;
    this.#lastThought = this.#sim.sim.tick;
    void this.#ask(npc, "the player walks up and talks to you", said);
  }

  #situation(): string {
    const s = this.#sim.sim;
    const parts = [`score red ${s.scores["team:red"] ?? 0}, blue ${s.scores["team:blue"] ?? 0}`];
    for (const e of this.#world.bundle.entities) {
      const rt = s.entity(e.id);
      if (rt?.carrier) parts.push(`the ${this.name(e.id)} is carried by ${rt.carrier === "player" ? "the player" : this.name(rt.carrier)}`);
    }
    for (const c of this.minded) parts.push(`${this.name(c.npc)} (${c.role}${s.entity(c.npc)?.team ? `, ${s.entity(c.npc)!.team} team` : ""}) is doing ${this.#sim.optionOf(c.npc)}${s.blind(c.npc) ? ", looking away" : ""}`);
    parts.push(`the player is on the ${s.entity("player")?.team ?? "red"} team`);
    // what the player has to offer: their coins, counted
    for (const w of s.words) parts.push(`the player has ${s.purse("player", w)} ${w}`);
    return parts.join("; ");
  }

  async #ask(npc: string, event: string, said?: string) {
    const c = this.minded.find((x) => x.npc === npc);
    if (!c) return;
    try {
      const persona = [c.persona.identity, c.persona.personality, c.persona.replyStyle ? `You speak: ${c.persona.replyStyle}.` : ""].filter(Boolean).join(" ");
      // talked to: the acts it accepts (from the world's rules) and the facts it answers from
      const accepts = said !== undefined ? acceptsOf(this.#world.bundle, npc) : [];
      const facts = said !== undefined ? factsOf(this.#world.bundle, npc) : [];
      const when = accepts.some((a) => a.act === "book") ? today() : null;
      const r = await api("/v1/mind", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ npc: this.name(npc), role: c.role, persona, menu: c.menu, current: this.#sim.optionOf(npc), situation: this.#situation(), event, ...(said ? { said } : {}), ...(accepts.length ? { acts: accepts } : {}), ...(facts.length ? { facts } : {}), ...(when ?? {}) }),
      });
      if (r.status === 429) this.#quietUntil = this.#sim.sim.tick + BACKOFF_TICKS;
      if (!r.ok || this.#off) return;
      const m = (await r.json()) as { option: string; line: string; act?: string; what?: string; n?: number; slot?: string };
      const act = m.act && accepts.some((a) => a.act === m.act) ? (m.act as Act) : null;
      // an option earned by an act comes with the act (the rule sets it, for as long as it says)
      const earned = accepts.some((a) => a.gives === m.option);
      // (a teammate under the player's order keeps to it while it thinks on its own)
      const held = said === undefined && (this.#held.get(npc) ?? 0) > this.#sim.sim.tick;
      if (m.option !== this.#sim.optionOf(npc) && !earned && !held) this.#sim.queueMind(npc, m.option);
      if (m.line) this.#onBark(npc, this.name(npc), m.line, said !== undefined);
      if (act) this.#accepted(npc, { to: npc, act, what: m.what ?? "", n: m.n ?? 0, slot: m.slot ?? "" });
    } catch {
      // no live service: the bot keeps playing its current option
    }
  }

  /** An act the character accepted: into the simulation (after the player's yes, where money or a booking is involved). */
  #accepted(npc: string, a: SpeechAct) {
    const s = this.#sim.sim;
    // coins the player hasn't got: nothing changes hands, and the player is told so
    if (s.words.includes(a.what) && s.purse("player", a.what) < a.n) {
      this.#hooks.onNote?.(`You have ${s.purse("player", a.what)} ${a.what}.`);
      return;
    }
    if (CONFIRM.has(a.act) && this.#hooks.onConfirm) this.#hooks.onConfirm(npc, this.name(npc), a);
    else this.#sim.queueAct(a);
  }
}
