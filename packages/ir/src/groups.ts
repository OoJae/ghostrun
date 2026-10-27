// A plural that names no one thing ("puppies" with pup_1..pup_5 placed, "stars" with star_1..star_3)
// means each of the things that answer to it. Shared by the fill parser (which keeps such a rule
// instead of dropping it) and the placer (which splits it into one rule per member).

const one = (w: string) => w.replace(/ies$/, "y").replace(/(ches|shes|xes|ses)$/, (m) => m.slice(0, -2)).replace(/s$/, "");

/** The ids a group name stands for (sorted), or [] when it is one thing, nothing, or fewer than two. */
export function groupMembers(name: string, entities: readonly { id: string; kind: string; noun: string }[]): string[] {
  if (!name || name === "player" || name.includes(":") || name.includes(".") || entities.some((e) => e.id === name)) return [];
  const n = one(name.toLowerCase().replace(/^(all|the|any|every)_/, ""));
  if (n.length < 3) return [];
  const base = (id: string) => one(id.replace(/_?\d+$/, ""));
  const last = (noun: string) => one(noun.toLowerCase().split(/\s+/).at(-1) ?? "");
  const hit = entities.filter((e) => {
    if (e.kind === "spawn" || e.kind === "decor") return false;
    const s = base(e.id);
    return s === n || last(e.noun) === n || (/\d$/.test(e.id) && s.length >= 3 && n.startsWith(s));
  });
  return hit.length >= 2 ? hit.map((e) => e.id).sort() : [];
}
