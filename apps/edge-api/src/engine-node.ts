// Node's engine (unit tests and the web dev server): the same pinned wasm files, compiled from
// node_modules. Importing this module is what turns the cloud proof on outside workerd.
import { loadNavNode } from "@ghostrun/nav/node";
import { loadRapierNode } from "@ghostrun/sim/node";
import { useEngine } from "./engine";

useEngine(async () => {
  await loadNavNode();
  return loadRapierNode();
});
