// What failed, in words a model can act on: the receipt's counterexamples (and the placer's notes)
// turned into concrete repair requests, plus the score a repaired world must beat to be kept.
import { clampLaws, type WorldBundle } from "@ghostrun/ir";
import { zonesNeeding } from "./t1";
import type { Receipt } from "./types";

export function issuesOf(r: Receipt, b: WorldBundle): string[] {
  const out: string[] = [];
  const goal = b.entities.find((e) => e.kind === "goal");
  for (const c of r.chips) {
    if (c.status !== "counterexample") continue;
    const cx = c.cx?.text ?? "";
    if (c.id === "T0:win_chain") out.push(`No chain of rules lets the player win (${c.text}). Add or fix a win rule that depends on the objective.`);
    else if (c.id === "T3:too_easy") out.push(`AI runners win in ${c.cx?.have ?? "?"} s without engaging the world: the win does not depend on the objective. ${openWays(b)} Make the win require it (carry the item into ${goal?.id ?? "the exit"}, a locked door with its key elsewhere on the goal room's doorway, or collecting things first).`);
    else if (c.id === "T3:win") out.push(`AI runners could not win in 2 minutes of play (${cx || c.text}). Make the objective reachable on foot or within the allowed jumps, and make every door on the way openable.`);
    else if (c.tier === "T2") out.push(`Rule ${c.subject.id} ${cx || "fails"} when its trigger is forced: fix its trigger, conditions or the verb that should cause it.`);
    else if (c.tier === "T1" || c.id.startsWith("T3:x")) {
      const x = b.expects.find((e) => e.id === c.subject.id);
      const k = Number(/jumps>=(\d+)/.exec(x?.need.join(",") ?? "")?.[1] ?? 0);
      const real = x && k ? zonesNeeding(b, clampLaws(b.laws), x.a, k) : [];
      out.push(`Expectation ${c.subject.id} ("${c.text.split(":")[0]}") is false: ${cx}.${real.length ? ` Zones that really need ${k} jumps from ${x!.a}: ${real.map((z) => `${z} (${b.zones.find((q) => q.id === z)?.name ?? z})`).join(", ")}; point b at one and rewrite the text to match.` : " Fix the claim or the geometry."}`);
    }
    else out.push(`${c.id}: ${c.text}${cx ? ` (${cx})` : ""}`);
  }
  if (b.mode === "play" && !r.chips.some((c) => c.id === "T3:win")) out.push("The world has no winnable objective the AI runners could play.");
  return out.slice(0, 8);
}

/** Lower is better: counterexamples first, then a red headline, then no runner winning. */
export function badness(r: Receipt): number {
  const cx = r.chips.filter((c) => c.status === "counterexample").length;
  const head = r.headline?.status === "counterexample" ? 1 : 0;
  const win = r.chips.find((c) => c.id === "T3:win");
  const lose = win ? (win.n - win.k) / Math.max(1, win.n) : 1;
  return cx * 10 + head * 5 + lose * 3;
}

export const better = (repaired: Receipt, original: Receipt) => badness(repaired) < badness(original);

/** Where the goal's room can be walked into without opening anything (for too-easy repairs). */
function openWays(b: WorldBundle): string {
  const goal = b.entities.find((e) => e.kind === "goal");
  if (!goal) return "";
  const zone = b.zones.find((z) => z.id === goal.zone);
  const spawn = b.entities.find((e) => e.kind === "spawn" && e.team === "red");
  const [dx, dz] = spawn ? [goal.pos[0] - spawn.pos[0], goal.pos[2] - spawn.pos[2]] : [0, 0];
  const d = spawn ? Math.round(Math.sqrt(dx * dx + dz * dz)) : null;
  const doors = b.entities.filter((e) => e.kind === "door" && e.zone === goal.zone).map((e) => `${e.id}@${e.anchor}`);
  return `${goal.id} is in ${goal.zone}${zone ? ` (slot ${zone.slot})` : ""}${d !== null ? `, ${d} m from the spawn` : ""}; doors in that zone: ${doors.length ? doors.join(", ") : "none"}.`;
}
