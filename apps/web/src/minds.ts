// NPC minds: on salient moments (a score, the objective changing hands, a tag, the player talking
// to them, or now and then) each minded NPC asks /v1/mind for one option from its typed menu and a
// line in character. The option is queued into the simulation as a logged input, so replays stay
// exact; the line is cosmetic. Without the live service the bots simply keep their defaults.
import type { SimEvent } from "@ghostrun/sim";
import { api } from "./api";
import type { World } from "./pipeline";
import type { RapierSim } from "./sim/rapier";

const QUIET_TICKS = 20 * 60; // think on their own at most every 20 s

export class Minds {
  readonly #world: World;
  readonly #sim: RapierSim;
  readonly #onBark: (npc: string, name: string, line: string) => void;
  readonly #busy = new Set<string>();
  #lastThought = 0;
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
    if (this.#off || !this.minded.length) return;
    for (const e of evs) {
      if (e.k === "score") return void this.think(this.minded.map((c) => c.npc), `${e.a.replace("team:", "")} team scored (now ${e.v})`);
      if (e.k === "pickup") return void this.think(this.minded.map((c) => c.npc), `${e.b === "player" ? "the player" : this.name(e.b)} picked up the ${this.name(e.a)}`);
      if (e.k === "tag") return void this.think(this.minded.map((c) => c.npc), `${e.a === "player" ? "the player" : this.name(e.a)} knocked the ${this.name(e.b === "player" ? "player" : e.b)} over`);
    }
    if (this.#sim.sim.tick - this.#lastThought > QUIET_TICKS) void this.think(this.minded.map((c) => c.npc), "a quiet moment");
  }

  talk(npc: string, said: string) {
    void this.think([npc], "the player walks up and talks to you", said);
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

  async think(npcs: string[], event: string, said?: string) {
    if (this.#off) return;
    this.#lastThought = this.#sim.sim.tick;
    const situation = this.#situation();
    await Promise.all(
      npcs.map(async (npc) => {
        const c = this.minded.find((x) => x.npc === npc);
        if (!c || this.#busy.has(npc)) return;
        this.#busy.add(npc);
        try {
          const persona = [c.persona.identity, c.persona.personality].filter(Boolean).join(" ");
          const r = await api("/v1/mind", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ npc: this.name(npc), role: c.role, persona, menu: c.menu, current: this.#sim.optionOf(npc), situation, event, ...(said ? { said } : {}) }),
          });
          if (!r.ok || this.#off) return;
          const m = (await r.json()) as { option: string; line: string };
          if (m.option !== this.#sim.optionOf(npc)) this.#sim.queueMind(npc, m.option);
          if (m.line) this.#onBark(npc, this.name(npc), m.line);
        } catch {
          // no live service: the bot keeps playing its current option
        } finally {
          this.#busy.delete(npc);
        }
      }),
    );
  }
}
