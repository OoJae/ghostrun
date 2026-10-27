import { initRapier } from "./load";
import { runFixture } from "./fixture";

const ticks = Number(new URLSearchParams(location.search).get("ticks") ?? 2000);
const module = await WebAssembly.compileStreaming(fetch("./rapier_wasm3d_bg.wasm"));
const R = await initRapier(module);
const result = runFixture(R, ticks, navigator.userAgent, () => performance.now());
(globalThis as unknown as { __DET__: unknown }).__DET__ = result;
document.body.textContent = JSON.stringify(result);
