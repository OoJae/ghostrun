import { initRapier } from "./load";
import { runFixture } from "./fixture";
import { runNavQ } from "./fixture-navq";
import { runCtf, runRace, runZombies } from "./fixture-ctf";

const ticks = Number(new URLSearchParams(location.search).get("ticks") ?? 2000);
const compile = (f: string) => WebAssembly.compileStreaming(fetch(`./${f}`));
const R = await initRapier(await compile("rapier_wasm3d_bg.wasm"));
const physics = runFixture(R, ticks, navigator.userAgent, () => performance.now());
const navq = await runNavQ(await compile("recast-navigation.wasm.wasm"), await compile("emscripten-module.wasm"), () => performance.now());
const ctf = runCtf(R, ticks);
const zombies = runZombies(R, ticks);
const race = runRace(R, ticks);
const result = { ...physics, navq, ctf, zombies, race };
(globalThis as unknown as { __DET__: unknown }).__DET__ = result;
document.body.textContent = JSON.stringify(result);
