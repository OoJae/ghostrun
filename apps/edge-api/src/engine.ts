// The simulation the cloud proof runs on: the pinned Rapier and recast builds the device loads,
// instantiated once per isolate. Where they come from depends on the runtime, so the entry point
// says: the Worker hands over workerd's pre-compiled wasm modules (engine-workerd.ts), Node (tests,
// the dev server) compiles the same files from node_modules (engine-node.ts). Without one there is
// no cloud proof, and /v1/health says so.
import type { Rapier } from "@ghostrun/sim";

let load: (() => Promise<Rapier>) | null = null;
let ready: Promise<Rapier> | null = null;

export function useEngine(loader: () => Promise<Rapier>) {
  load = loader;
  ready = null;
}

/** The engine, loading it the first time (null: this runtime has none). A failed load is tried again next time. */
export function engine(): Promise<Rapier> | null {
  if (!load) return null;
  ready ??= load().catch((e: unknown) => {
    ready = null;
    throw e;
  });
  return ready;
}

export const hasEngine = () => load !== null;
