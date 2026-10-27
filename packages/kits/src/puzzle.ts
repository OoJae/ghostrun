// Puzzle and meta kit: switches, plates, locks and keys, collectibles, checkpoints, portals, timers.
// Each verb only changes states and emits events; the world's rules decide what they mean.
import type { Bound, VerbCtx, VerbPlugin } from "@ghostrun/plugin-api";

/** Agents that crossed into the bound entity's box this tick (edge-triggered, per binding). */
function entering(c: VerbCtx, b: Bound): string[] {
  const out: string[] = [];
  for (const a of c.agents()) {
    const now = c.inside(a, b.on);
    const key = `in:${a}`;
    if (now && !b.mem[key]) out.push(a);
    b.mem[key] = now;
  }
  return out;
}

export const switchVerb: VerbPlugin = {
  id: "puzzle.switch",
  line: 'on a switch or lever: USE flips its state "off"↔"on"; params {"once":bool}; wire rules with state_is',
  on: ["switch", "prop"],
  params: { once: { def: false } },
  initial: "off",
  use: {
    radius: 1.6,
    label: "flip switch",
    run(c, b) {
      const on = c.ent(b.on)?.state === "on";
      if (on && b.params.once) return;
      c.setState(b.on, on ? "off" : "on");
    },
  },
  produces: (b) => [{ k: "state", a: b.on, s: "on", cause: { do: "use", at: b.on } }],
};

export const plateVerb: VerbPlugin = {
  id: "puzzle.plate",
  line: 'on a pressure plate: state "down" while anyone stands on it, "up" after; params {"latch":bool}',
  on: ["plate"],
  params: { latch: { def: false } },
  body: "sensor",
  initial: "up",
  tick(c, b) {
    const down = c.agents().some((a) => c.inside(a, b.on));
    const s = c.ent(b.on)?.state;
    if (down && s !== "down") c.setState(b.on, "down");
    else if (!down && s === "down" && !b.params.latch) c.setState(b.on, "up");
  },
  produces: (b) => [{ k: "state", a: b.on, s: "down", cause: { do: "enter", at: b.on } }],
};

export const lockVerb: VerbPlugin = {
  id: "puzzle.lock",
  line: 'on a door: USE while carrying the key opens it (key is used up); params {"key":"<item id>"}; state "open"',
  on: ["door"],
  params: { key: { def: "" } },
  body: "fixed",
  initial: "locked",
  carries: (b) => (b.params.key ? [String(b.params.key)] : []),
  use: {
    radius: 1.8,
    label: "unlock",
    run(c, b, actor) {
      if (c.ent(b.on)?.state === "open") return;
      const key = String(b.params.key);
      if (key && c.ent(actor)?.carrying !== key) return;
      if (key) c.destroy(key);
      c.setSolid(b.on, false);
      c.setState(b.on, "open");
    },
  },
  produces: (b) => [{ k: "state", a: b.on, s: "open", cause: b.params.key ? { do: "use", at: b.on, holding: String(b.params.key) } : { do: "use", at: b.on } }],
};

export const collectVerb: VerbPlugin = {
  id: "puzzle.collect",
  line: "on a pickup (coin, gem, star): touching it collects it (touch event a=agent b=it); count with score rules",
  on: ["pickup", "prop"],
  params: {},
  body: "sensor",
  tick(c, b) {
    const e = c.ent(b.on);
    if (!e || e.destroyed) return;
    const reach = Math.max(e.size[0], e.size[2]) / 2 + 0.45;
    for (const a of c.agents()) {
      if (!c.near(a, b.on, reach)) continue;
      c.destroy(b.on);
      c.emit("touch", a, b.on);
      return;
    }
  },
  produces: (b) => [{ k: "touch", a: "player", b: b.on, cause: { do: "touch", at: b.on } }],
};

export const checkpointVerb: VerbPlugin = {
  id: "puzzle.checkpoint",
  line: 'on a checkpoint: entering saves the respawn point; state "reached" the first time',
  on: ["checkpoint"],
  params: {},
  body: "sensor",
  initial: "open",
  tick(c, b) {
    for (const a of entering(c, b)) {
      const e = c.ent(b.on)!;
      c.setCheckpoint(a, [e.home[0], e.home[1] - e.size[1] / 2 + 0.95, e.home[2]]); // a character's centre on its floor
      if (a === "player" && c.ent(b.on)?.state !== "reached") c.setState(b.on, "reached");
    }
  },
  produces: (b) => [{ k: "state", a: b.on, s: "reached", cause: { do: "enter", at: b.on } }],
};

export const portalVerb: VerbPlugin = {
  id: "puzzle.portal",
  line: 'on a portal: entering teleports to another entity; params {"to":"<entity id>"}',
  on: ["portal"],
  params: { to: { def: "" } },
  body: "sensor",
  tick(c, b) {
    const dest = c.ent(String(b.params.to));
    if (!dest) return;
    for (const a of entering(c, b)) {
      // land beside the destination, toward the world centre, so a portal pair never ping-pongs
      const [x, y, z] = dest.home;
      const len = Math.sqrt(x * x + z * z);
      const off = Math.max(dest.size[0], dest.size[2]) / 2 + 1;
      const [dx, dz] = len > 0.5 ? [-x / len, -z / len] : [1, 0];
      c.teleport(a, [x + dx * off, y - dest.size[1] / 2 + 0.95, z + dz * off]); // the sim already logged the enter
    }
  },
  produces: (b) => [{ k: "enter", a: "player", b: b.on, cause: { do: "enter", at: b.on } }],
};

export const timerVerb: VerbPlugin = {
  id: "puzzle.timer",
  line: 'countdown: fires timer_end (a=bound id) after N seconds; bind on "player"; params {"seconds":5-600}',
  on: ["player", "prop", "sign"],
  params: { seconds: { def: 60, min: 5, max: 600 } },
  init(_c, b) {
    b.mem.end = Math.round(Number(b.params.seconds) * 60); // in memory, so T2 can fast-forward it
  },
  tick(c, b) {
    if (c.tick === b.mem.end) c.emit("timer_end", b.on, b.id);
  },
  produces: (b) => [{ k: "timer_end", a: b.on, cause: null }],
};

export const PUZZLE: VerbPlugin[] = [switchVerb, plateVerb, lockVerb, collectVerb, checkpointVerb, portalVerb, timerVerb];
