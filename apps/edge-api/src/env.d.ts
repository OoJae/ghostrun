declare module "*?raw" {
  const text: string;
  export default text;
}

// Vite's glob import: the Worker is bundled by Vite (scripts/build.mjs) and tested under Vitest,
// so a literal pattern becomes the matching modules, inlined.
interface ImportMeta {
  glob<T = unknown>(pattern: string, options: { eager: true; import: "default" }): Record<string, T>;
}

/** A wasm file imported as a module: workerd hands over the compiled module (engine-workerd.ts). */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
