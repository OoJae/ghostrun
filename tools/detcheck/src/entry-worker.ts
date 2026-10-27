// workerd entry. Workers only allow instantiating pre-compiled modules, so every .wasm is imported
// as a module (kept external by build.mjs and listed in the workerd config).
import rapierWasm from "./rapier_wasm3d_bg.wasm";
import recastWasm from "./recast-navigation.wasm.wasm";
import quickjsWasm from "./emscripten-module.wasm";
import { initRapier } from "./load";
import { runFixture } from "./fixture";
import { runNavQ } from "./fixture-navq";

export default {
  async fetch(request: Request): Promise<Response> {
    const ticks = Number(new URL(request.url).searchParams.get("ticks") ?? 2000);
    // Date.now() only for reported durations; never used by the simulation.
    const R = await initRapier(rapierWasm);
    const physics = runFixture(R, ticks, "workerd", () => Date.now());
    const navq = await runNavQ(recastWasm, quickjsWasm, () => Date.now());
    return Response.json({ ...physics, navq });
  },
};
