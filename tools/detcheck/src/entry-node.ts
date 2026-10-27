import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initRapier } from "./load";
import { runFixture } from "./fixture";
import { runNavQ } from "./fixture-navq";
import { runCtf } from "./fixture-ctf";

const wasmDir = process.argv[2]!;
const ticks = Number(process.argv[3] ?? 2000);
const compile = (f: string) => WebAssembly.compile(readFileSync(join(wasmDir, f)));
const R = await initRapier(await compile("rapier_wasm3d_bg.wasm"));
const physics = runFixture(R, ticks, `node ${process.version}`, () => performance.now());
const navq = await runNavQ(await compile("recast-navigation.wasm.wasm"), await compile("emscripten-module.wasm"), () => performance.now());
const ctf = runCtf(R, ticks);
console.log(JSON.stringify({ ...physics, navq, ctf }));
