import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const glue = fileURLToPath(new URL("./glue.ts", import.meta.url));
const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve("@dimforge/rapier3d-deterministic/package.json"));
const entry = join(pkgDir, "rapier.js");

/**
 * Vite/Vitest plugin every consumer of @ghostrun/sim must install (web, edge, verifier, tests).
 * - Resolves the package entry (it only has a `module` field, which SSR resolution ignores).
 * - Redirects rapier_wasm3d.js, which imports the .wasm as an ES module, to our glue, so each
 *   runtime compiles the same pinned bytes itself (workerd only accepts pre-compiled modules).
 * Vitest must also inline the package (it uses extensionless imports): server.deps.inline.
 */
export function rapierWasmShim() {
  return {
    name: "ghostrun-rapier-wasm-shim",
    enforce: "pre" as const,
    resolveId(source: string, importer: string | undefined) {
      if (source === "@dimforge/rapier3d-deterministic") return entry;
      if (importer?.includes("rapier3d-deterministic") && /(^|\/)rapier_wasm3d(\.js)?$/.test(source)) return glue;
      return null;
    },
  };
}
