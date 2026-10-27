// The Director, between attempts only: one observation about how you played (from your trail),
// and one twist for the next run that changes how the cast starts (rivals press harder after a
// win, your teammate helps after a loss). The twisted world is a new spec: it is re-proved on the
// device before it is offered, and never applied mid-run.
import { mergeFill } from "@ghostrun/ir";
import { worldFromFill, type World } from "./pipeline";
import type { RunResult } from "./hud/Result";

export interface Twist {
  line: string;
  label: string;
  world: World;
}

/** The first of the wanted verbs (in priority order) that the menu offers. */
const pick = (menu: string[], ...verbs: string[]) => verbs.map((v) => menu.find((m) => m.endsWith(`.${v}`))).find(Boolean);

/** What stood out in the run, in one sentence (or nothing worth saying). */
function observe(world: World, trail: readonly [number, number, number][]): string {
  if (trail.length < 6) return "";
  const b = world.bundle;
  const spawn = b.entities.find((e) => e.kind === "spawn" && e.team === "red") ?? b.entities.find((e) => e.kind === "spawn");
  const goal = b.entities.find((e) => e.kind === "goal" && (e.team === "red" || !e.team)) ?? b.entities.find((e) => e.kind === "pickup");
  const high = trail.filter((p) => p[1] > 2.2).length / trail.length;
  if (high > 0.25) return `You spent ${Math.round(high * 100)}% of the run up high.`;
  if (spawn && goal) {
    // which side of the line from the spawn to the objective did you favour?
    const [ax, az] = [goal.pos[0] - spawn.pos[0], goal.pos[2] - spawn.pos[2]];
    const sides = trail.map((p) => Math.sign(ax * (p[2] - spawn.pos[2]) - az * (p[0] - spawn.pos[0])));
    const left = sides.filter((x) => x > 0).length / sides.length;
    if (left > 0.75 || left < 0.25) return `You kept to the ${left > 0.5 ? "left" : "right"} side ${Math.round(Math.max(left, 1 - left) * 100)}% of the time.`;
  }
  return "";
}

/** One twist for the next run, or null when the cast has nothing to change. */
export function propose(world: World, trail: readonly [number, number, number][], result: RunResult): Omit<Twist, "world"> & { fill: string } | null {
  const b = world.bundle;
  const changes: { npc: string; option: string }[] = [];
  for (const c of b.cast) {
    const team = b.entities.find((e) => e.id === c.npc)?.team ?? "";
    const rival = team && team !== "red";
    const option =
      result.k === "win"
        ? rival ? pick(c.menu, "intercept", "attack", "chase", "hunt") : undefined
        : !rival && team ? pick(c.menu, "attack", "follow", "escort") : rival ? pick(c.menu, "defend", "guard", "patrol") : undefined;
    if (option && option !== c.dflt) changes.push({ npc: c.npc, option });
  }
  if (!changes.length) return null;
  const seen = observe(world, trail);
  const line = result.k === "win" ? `${seen} The rivals noticed: next run they come after you.`.trim() : `${seen} Next run, your side gets more help.`.trim();
  const label = changes.map((c) => `${c.npc.replace(/_/g, " ")} starts on ${c.option.split(".").pop()}`).join(", ");
  // the twist is a patch to the fill (npc lines keep their ids), so the new world rebuilds the same way anywhere
  const lines = world.fill.split("\n");
  const patch = changes
    .map((c) => {
      const raw = lines.find((l) => l.includes('"op":"npc"') && l.includes(`"id":"${c.npc}"`));
      if (!raw) return "";
      const o = JSON.parse(raw) as Record<string, unknown>;
      return JSON.stringify({ ...o, dflt: c.option });
    })
    .filter(Boolean)
    .join("\n");
  if (!patch) return null;
  return { line, label, fill: mergeFill(world.fill, patch).text };
}

export function twistWorld(world: World, fill: string): World {
  const w = worldFromFill(fill, world.seed, world.intent.live, world.bundle.pack.id, world.bundle.mode);
  if (world.source) w.source = { ...world.source, fill };
  return w;
}
