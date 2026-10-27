// Browser loaders for the pinned wasm builds. Vite emits each .wasm as an asset; we compile it
// with streaming compilation and hand the module to the same initialisers every runtime uses.
import { initNav } from "@ghostrun/nav";
import { initRapier, type Rapier } from "@ghostrun/sim";
import rapierUrl from "@dimforge/rapier3d-deterministic/rapier_wasm3d_bg.wasm?url";
import recastUrl from "ghostrun-recast-wasm?url"; // aliased in vite.config.ts

export const WASM_URLS = { rapier: rapierUrl, recast: recastUrl };

let rapier: Promise<Rapier> | undefined;

export function loadRapier(): Promise<Rapier> {
  rapier ??= WebAssembly.compileStreaming(fetch(rapierUrl)).then((m) => initRapier(m));
  return rapier;
}

let nav: Promise<boolean> | undefined;

/** Recast on the main thread for the bots; if it fails the world still plays, with idle NPCs. */
export function loadNav(): Promise<boolean> {
  nav ??= WebAssembly.compileStreaming(fetch(recastUrl))
    .then((m) => initNav(m))
    .then(
      () => true,
      (e: unknown) => {
        console.warn("navmesh unavailable: NPCs will stand still", e);
        return false;
      },
    );
  return nav;
}
