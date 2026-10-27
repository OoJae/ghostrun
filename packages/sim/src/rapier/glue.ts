// Stand-in for rapier_wasm3d.js, which does `import * as wasm from "./rapier_wasm3d_bg.wasm"`.
// rapierWasmShim() redirects it here so each runtime compiles the same pinned .wasm itself
// (workerd only accepts pre-compiled modules) and hands it to initRapier().
export * from "@dimforge/rapier3d-deterministic/rapier_wasm3d_bg.js";
