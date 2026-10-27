// Builds the S0 fixture three ways (Node, workerd, browser) from one source with one Rapier shim.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
export const wasmPath = resolve(
  dirname(require.resolve("@dimforge/rapier3d-deterministic/package.json")),
  "rapier_wasm3d_bg.wasm",
);
const glue = resolve(root, "src/rapier-glue.ts");

// rapier_wasm3d.js imports the .wasm as an ES module; send every runtime to our glue instead.
const rapierShim = {
  name: "rapier-wasm-shim",
  enforce: "pre",
  resolveId(source, importer) {
    if (importer?.includes("rapier3d-deterministic") && /(^|\/)rapier_wasm3d(\.js)?$/.test(source)) return glue;
    return null;
  },
};

const common = { root, configFile: false, logLevel: "warn", plugins: [rapierShim] };

await build({
  ...common,
  ssr: { noExternal: true },
  build: { ssr: "src/entry-node.ts", outDir: "dist/node", target: "node26", emptyOutDir: true },
});

await build({
  ...common,
  ssr: { noExternal: true, target: "webworker" },
  build: {
    ssr: "src/entry-worker.ts",
    outDir: "dist/worker",
    target: "es2023",
    emptyOutDir: true,
    rollupOptions: { external: [/\.wasm$/] },
  },
});
copyFileSync(wasmPath, resolve(root, "dist/worker/rapier_wasm3d_bg.wasm"));

await build({
  ...common,
  base: "./",
  build: { outDir: "dist/browser", target: "es2023", emptyOutDir: true },
});
mkdirSync(resolve(root, "dist/browser"), { recursive: true });
copyFileSync(wasmPath, resolve(root, "dist/browser/rapier_wasm3d_bg.wasm"));

console.log("detcheck: built node, worker and browser bundles");
