// The proof version, for the build configs (Node only; never bundled): SHA-256 over the source of
// every workspace package the placer and the proof ladder depend on (the IR, the packs, the layout,
// the simulation, the kits, the bots, the navmesh, the proof itself) and the lockfile (the pinned
// Rapier and recast builds). The web app and the Worker are each stamped with it by Vite's define
// (__PROOF_VERSION__), so a change that could change a receipt changes the version, and a receipt
// the edge kept is never served to, or compared with, a client running other proof code.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOTS = ["@ghostrun/world", "@ghostrun/proof"];

/** Every workspace package by name → its folder (the packages/ tree only: apps never prove). */
function packages(repo: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const d = join(dir, name);
      if (!statSync(d).isDirectory()) continue;
      const pj = join(d, "package.json");
      if (existsSync(pj)) out.set((JSON.parse(readFileSync(pj, "utf8")) as { name: string }).name, d);
      else walk(d);
    }
  };
  walk(join(repo, "packages"));
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

export function proofVersion(repo = REPO): string {
  const all = packages(repo);
  const seen = new Set<string>();
  const queue = [...ROOTS];
  while (queue.length) {
    const name = queue.shift()!;
    const dir = all.get(name);
    if (!dir || seen.has(name)) continue;
    seen.add(name);
    const deps = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
    for (const [dep, range] of Object.entries(deps)) if (range.startsWith("workspace:")) queue.push(dep);
  }
  const sources = [...seen]
    .flatMap((name) => [join(all.get(name)!, "package.json"), ...files(join(all.get(name)!, "src"))])
    .concat(join(repo, "pnpm-lock.yaml"))
    .map((p) => relative(repo, p).split("\\").join("/"))
    .sort();
  const h = createHash("sha256");
  for (const p of sources) h.update(`${p}\0`).update(readFileSync(join(repo, p))).update("\0");
  return h.digest("hex");
}
