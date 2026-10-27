// workerd entry. Workers only allow instantiating pre-compiled modules, so the .wasm is imported
// as a CompiledWasm module (kept external by build.mjs, loaded by Miniflare's module rules).
import wasmModule from "./rapier_wasm3d_bg.wasm";
import { initRapier } from "./load";
import { runFixture } from "./fixture";

export default {
  async fetch(request: Request): Promise<Response> {
    const ticks = Number(new URL(request.url).searchParams.get("ticks") ?? 2000);
    const R = await initRapier(wasmModule as WebAssembly.Module);
    // Date.now() only for the reported duration; never used by the simulation.
    return Response.json(runFixture(R, ticks, "workerd", () => Date.now()));
  },
};
