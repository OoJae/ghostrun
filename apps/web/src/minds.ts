// NPC minds: on salient moments (a score, the objective changing hands, a tag, or now and then)
// one minded NPC at a time asks /v1/mind for one option from its typed menu and a line in
// character; the player talking to one always gets an answer. The option is queued into the
// simulation as a logged input, so replays stay exact; the line is cosmetic. Without the live
// service the bots simply keep their defaults.
import type { SimEvent } from "@ghostrun/sim";
import { api } from "./api";
import type { World } from "./pipeline";
import type { RapierSim } from "./sim/rapier";

const QUIET_TICKS = 20 * 60; // think on their own at most every 20 s
// Between thoughts of their own, 8 s, one NPC at a time: about 75 calls in 10 minutes of play,
// under the edge's 120 per session and leaving room for talk. A world of bots scores, picks up and
// tags many times a second, and every NPC thinking on every event spent the allowance in a minute.
const GAP_TICKS = 8 * 60;
const IDLE_TICKS = 60 * 60; // and only while someone plays: a minute without input, they stop
const BACKOFF_TICKS = 60 * 60; // the edge said "rate limited": wait a minute

export class Minds {
  readonly #world: World;
  readonly #sim: RapierSim;
  readonly #onBark: (npc: string, name: string, line: string) => void;
  readonly #busy = new Set<string>();
  #lastThought = 0;
  #quietUntil = 0;
  #turn = -1;
  #off = false;

  constructor(world: World, sim: RapierSim, onBark: (npc: string, name: string, line: string) => void) {
    this.#world = world;
    this.#sim = sim;
    this.#onBark = onBark;
  }

  /** NPCs with a real choice to make (a menu of two or more options). */
  get minded() {
    return this.#world.bundle.cast.filter((c) => c.menu.length > 1 && this.#world.bundle.entities.some((e) => e.id === c.npc));
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
    const event = this.#salient(evs) ?? (tick - this.#lastThought > QUIET_TICKS ? "a quiet moment" : null);
    if (!event) return;
    const minded = this.minded;
    this.#turn = (this.#turn + 1) % minded.length;
    const npc = minded[this.#turn]!.npc;
    if (this.#busy.has(npc)) return;
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
    for (const c of this.minded) parts.push(`${this.name(c.npc)} (${c.role}${s.entity(c.npc)?.team ? `, ${s.entity(c.npc)!.team} team` : ""}) is doing ${this.#sim.optionOf(c.npc)}`);
    parts.push(`the player is on the ${s.entity("player")?.team ?? "red"} team`);
    return parts.join("; ");
  }

  async #ask(npc: string, event: string, said?: string) {
    const c = this.minded.find((x) => x.npc === npc);
    if (!c) return;
    try {
      const persona = [c.persona.identity, c.persona.personality].filter(Boolean).join(" ");
      const r = await api("/v1/mind", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ npc: this.name(npc), role: c.role, persona, menu: c.menu, current: this.#sim.optionOf(npc), situation: this.#situation(), event, ...(said ? { said } : {}) }),
      });
      if (r.status === 429) this.#quietUntil = this.#sim.sim.tick + BACKOFF_TICKS;
      if (!r.ok || this.#off) return;
      const m = (await r.json()) as { option: string; line: string };
      if (m.option !== this.#sim.optionOf(npc)) this.#sim.queueMind(npc, m.option);
      if (m.line) this.#onBark(npc, this.name(npc), m.line);
    } catch {
      // no live service: the bot keeps playing its current option
    }
  }
}
