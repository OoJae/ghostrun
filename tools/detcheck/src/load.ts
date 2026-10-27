import * as bg from "@dimforge/rapier3d-deterministic/rapier_wasm3d_bg.js";
import RAPIER from "@dimforge/rapier3d-deterministic";

export type Rapier = typeof RAPIER;

let ready: Promise<Rapier> | undefined;

/** Instantiate the pinned Rapier wasm from an already-compiled module (one per runtime realm). */
export function initRapier(module: WebAssembly.Module): Promise<Rapier> {
  ready ??= WebAssembly.instantiate(module, {
    "./rapier_wasm3d_bg.js": bg as unknown as WebAssembly.ModuleImports,
  }).then((instance) => {
    (bg as unknown as { __wbg_set_wasm(e: WebAssembly.Exports): void }).__wbg_set_wasm(instance.exports);
    return RAPIER;
  });
  return ready;
}
