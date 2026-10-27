import { readFileSync } from "node:fs";
import { initRapier } from "./load";
import { runFixture } from "./fixture";

const wasmPath = process.argv[2]!;
const ticks = Number(process.argv[3] ?? 2000);
const R = await initRapier(await WebAssembly.compile(readFileSync(wasmPath)));
console.log(JSON.stringify(runFixture(R, ticks, `node ${process.version}`, () => performance.now())));
