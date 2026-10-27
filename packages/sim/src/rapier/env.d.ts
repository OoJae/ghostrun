declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

// wasm-bindgen glue shipped without its own typings; we only need the setter and the namespace.
declare module "@dimforge/rapier3d-deterministic/rapier_wasm3d_bg.js" {
  export function __wbg_set_wasm(exports: WebAssembly.Exports): void;
}
