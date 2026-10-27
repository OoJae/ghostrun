import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { initRapier, type Rapier } from "./load";

const require = createRequire(import.meta.url);
export const RAPIER_WASM_PATH = join(dirname(require.resolve("@dimforge/rapier3d-deterministic/package.json")), "rapier_wasm3d_bg.wasm");

/** Node (CLI, CI, verifier): compile the pinned wasm from node_modules. */
export async function loadRapierNode(): Promise<Rapier> {
  return initRapier(await WebAssembly.compile(readFileSync(RAPIER_WASM_PATH)));
}
