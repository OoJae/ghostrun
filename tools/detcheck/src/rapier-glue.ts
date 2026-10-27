// Stand-in for rapier_wasm3d.js. The original does `import * as wasm from "./rapier_wasm3d_bg.wasm"`,
// which only some bundlers/runtimes support; build.mjs redirects it here so every runtime instead
// compiles the same pinned .wasm bytes itself and hands the instance to initRapier().
export * from "@dimforge/rapier3d-deterministic/rapier_wasm3d_bg.js";
