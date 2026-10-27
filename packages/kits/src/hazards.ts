// Motion and hazards kit: things that hurt, fall away or push. Oscillating platforms stay in the
// sim core for now (they predate kits); listed in index.ts so the fill sees one vocabulary.
import type { VerbPlugin } from "@ghostrun/plugin-api";

export const hazardVerb: VerbPlugin = {
  id: "motion_hazards.hazard",
  line: 'on a hazard (lava, spikes, laser): touching emits hit (a=agent b=it) and respawns; params {"respawn":bool}',
  on: ["hazard"],
  params: { respawn: { def: true } },
  body: "sensor",
  tick(c, b) {
    for (const a of c.agents()) {
      const now = c.inside(a, b.on);
      const key = `in:${a}`;
      if (now && !b.mem[key]) {
        c.emit("hit", a, b.on);
        if (b.params.respawn) c.respawn(a);
      }
      b.mem[key] = now && !b.params.respawn;
    }
  },
  produces: (b) => [{ k: "hit", a: "player", b: b.on, cause: { do: "enter", at: b.on } }],
};

export const crumbleVerb: VerbPlugin = {
  id: "motion_hazards.crumble",
  line: 'on a platform: gives way a moment after someone stands on it, back later; params {"delay":0.2-3,"back":1-10}',
  on: ["platform", "prop"],
  params: { delay: { def: 0.6, min: 0.2, max: 3 }, back: { def: 3, min: 1, max: 10 } },
  body: "fixed",
  initial: "solid",
  tick(c, b) {
    const t = c.tick;
    const fallen = c.ent(b.on)?.state === "fallen";
    if (!fallen) {
      if (!b.mem.at && c.agents().some((a) => c.standingOn(a, b.on))) b.mem.at = t + Math.round(Number(b.params.delay) * 60);
      if (b.mem.at && t >= Number(b.mem.at)) {
        c.setSolid(b.on, false);
        c.setState(b.on, "fallen");
        b.mem.at = 0;
        b.mem.back = t + Math.round(Number(b.params.back) * 60);
      }
    } else if (t >= Number(b.mem.back)) {
      c.setSolid(b.on, true);
      c.setState(b.on, "solid");
    }
  },
};

export const windVerb: VerbPlugin = {
  id: "motion_hazards.wind",
  line: 'on a hazard/plate volume: pushes anyone inside (wind, current, conveyor); params {"x":-12-12,"z":-12-12} m/s',
  on: ["hazard", "plate", "prop"],
  params: { x: { def: 4, min: -12, max: 12 }, z: { def: 0, min: -12, max: 12 } },
  body: "sensor",
  tick(c, b) {
    for (const a of c.agents()) if (c.inside(a, b.on)) c.shove(a, Number(b.params.x), Number(b.params.z));
  },
};

export const HAZARDS: VerbPlugin[] = [hazardVerb, crumbleVerb, windVerb];
