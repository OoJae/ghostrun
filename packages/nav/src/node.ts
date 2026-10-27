import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { initNav } from "./index";

const require = createRequire(import.meta.url);
export const RECAST_WASM_PATH = join(dirname(require.resolve("@recast-navigation/wasm/wasm")), "recast-navigation.wasm.wasm");

export async function loadNavNode(): Promise<void> {
  return initNav(await WebAssembly.compile(readFileSync(RECAST_WASM_PATH)));
}
