// The Worker's engine. workerd instantiates only pre-compiled modules, so both pinned wasm builds
// are imported as modules (as tools/detcheck loads them): scripts/build.mjs keeps them out of the
// bundle and copies the files from node_modules beside it, and wrangler uploads them as
// CompiledWasm modules. Imported by the Worker entry only (index.ts), never by tests.
import { initNav } from "@ghostrun/nav";
import { initRapier, type Rapier } from "@ghostrun/sim";
import rapierWasm from "./rapier_wasm3d_bg.wasm";
import recastWasm from "./recast-navigation.wasm.wasm";

export async function workerdEngine(): Promise<Rapier> {
  await initNav(recastWasm);
  return initRapier(rapierWasm);
}
