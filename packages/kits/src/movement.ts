// Locomotion and social kits: jump pads, and things you can look at closely. Jump itself is a law
// (jumpH, jumpsMax) the controller applies; it is listed in index.ts for the fill vocabulary.
import type { VerbPlugin } from "@ghostrun/plugin-api";

export const jumpPadVerb: VerbPlugin = {
  id: "locomotion.jump_pad",
  line: 'on a plate/platform: launches anyone stepping on it straight up; params {"height":1-12} metres',
  on: ["plate", "platform", "prop"],
  params: { height: { def: 4, min: 1, max: 12 } },
  body: "sensor",
  tick(c, b) {
    const g = 9.81 * c.laws.gravityScale;
    for (const a of c.agents()) {
      const now = c.inside(a, b.on);
      const key = `in:${a}`;
      if (now && !b.mem[key]) c.launch(a, Math.sqrt(2 * g * Number(b.params.height)));
      b.mem[key] = now;
    }
  },
};

export const inspectVerb: VerbPlugin = {
  id: "social.inspect",
  line: 'on anything worth a closer look (exhibit, car, painting): USE shows its text; params {"text":"≤120 chars"}',
  on: ["prop", "sign", "pickup", "vehicle", "npc", "door", "switch", "platform"],
  params: { text: { def: "" } },
  use: {
    radius: 2.2,
    label: "inspect",
    run(c, b, actor) {
      c.emit("touch", actor, b.on, String(b.params.text).slice(0, 120));
    },
  },
  produces: (b) => [{ k: "touch", a: "player", b: b.on, cause: { do: "use", at: b.on } }],
};

export const MOVEMENT: VerbPlugin[] = [jumpPadVerb, inspectVerb];
