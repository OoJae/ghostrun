// Builds the S0 fixtures three ways (Node, workerd, browser) from one source with one Rapier shim.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** The pinned wasm binaries every runtime compiles itself (published name → source path). */
export const WASM = {
  "rapier_wasm3d_bg.wasm": resolve(dirname(require.resolve("@dimforge/rapier3d-deterministic/package.json")), "rapier_wasm3d_bg.wasm"),
  "recast-navigation.wasm.wasm": resolve(dirname(require.resolve("@recast-navigation/wasm/wasm")), "recast-navigation.wasm.wasm"),
  "emscripten-module.wasm": require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"),
};
// The product's own shim (resolves the module-only entry, redirects the wasm import).
const { rapierWasmShim } = await import("../../../packages/sim/src/rapier/vite-plugin.ts");

const common = { root, configFile: false, logLevel: "warn", plugins: [rapierWasmShim()] };
const single = { output: { codeSplitting: false } };
const copyWasm = (dir) => {
  mkdirSync(resolve(root, dir), { recursive: true });
  for (const [name, src] of Object.entries(WASM)) copyFileSync(src, resolve(root, dir, name));
};

await build({
  ...common,
  ssr: { noExternal: true },
  build: { ssr: "src/entry-node.ts", outDir: "dist/node", target: "node26", emptyOutDir: true, rollupOptions: single },
});

await build({
  ...common,
  resolve: { conditions: ["workerd", "worker", "browser", "import", "module", "default"] },
  ssr: { noExternal: true, target: "webworker", resolve: { conditions: ["workerd", "worker", "browser", "import", "module", "default"] } },
  build: {
    ssr: "src/entry-worker.ts",
    outDir: "dist/worker",
    target: "es2023",
    emptyOutDir: true,
    rollupOptions: { ...single, external: [/\.wasm$/] },
  },
});
copyWasm("dist/worker");

await build({
  ...common,
  base: "./",
  build: { outDir: "dist/browser", target: "es2023", emptyOutDir: true },
});
copyWasm("dist/browser");

console.log("detcheck: built node, worker and browser bundles");
