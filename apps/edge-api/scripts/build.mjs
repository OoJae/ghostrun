// Bundles the Worker (src/index.ts → dist/worker/index.js, one ES module) with the repo's Vite, so
// `?raw` imports and workspace packages resolve exactly as they do in tests. wrangler uploads this
// file as-is (no_bundle in wrangler.jsonc), and the workerd test runs a bundle built the same way.
// The cloud proof's two pinned wasm builds stay out of the bundle: they are copied beside it and
// imported as modules (workerd instantiates only pre-compiled ones), and wrangler uploads them as
// CompiledWasm modules. The bundle is stamped with the proof version (packages/world/src/version.ts).
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const conditions = ["workerd", "worker", "browser", "import", "module", "default"];
const { rapierWasmShim } = await import("../../../packages/sim/src/rapier/vite-plugin.ts");
const { proofVersion } = await import("../../../packages/world/src/version.ts");

/** The commit being built ("-dirty" with uncommitted changes), for /v1/version. */
function gitCommit() {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "";
    return head + (dirty ? "-dirty" : "");
  } catch {
    return "unknown";
  }
}

/** The pinned wasm binaries the Worker imports as modules (published name → source path). */
export const WASM = {
  "rapier_wasm3d_bg.wasm": resolve(dirname(require.resolve("@dimforge/rapier3d-deterministic/package.json")), "rapier_wasm3d_bg.wasm"),
  "recast-navigation.wasm.wasm": resolve(dirname(require.resolve("@recast-navigation/wasm/wasm")), "recast-navigation.wasm.wasm"),
};

export async function bundle(entry, outDir, fileName) {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    plugins: [rapierWasmShim()],
    define: { __PROOF_VERSION__: JSON.stringify(proofVersion()), __GIT_COMMIT__: JSON.stringify(gitCommit()) },
    resolve: { conditions },
    ssr: { noExternal: true, target: "webworker", resolve: { conditions } },
    build: {
      ssr: entry,
      outDir,
      target: "es2023",
      emptyOutDir: true,
      minify: false,
      rollupOptions: { external: [/\.wasm$/], output: { codeSplitting: false, entryFileNames: fileName } },
    },
  });
  for (const [name, src] of Object.entries(WASM)) copyFileSync(src, resolve(root, outDir, name));
  return resolve(root, outDir, fileName);
}

/** The same sources for Node (the workerd test's other side: the proof as the device runs it), stamped alike. */
export async function nodeBundle(entry, outDir, fileName) {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    plugins: [rapierWasmShim()],
    define: { __PROOF_VERSION__: JSON.stringify(proofVersion()) },
    ssr: { noExternal: true },
    build: { ssr: entry, outDir, target: "node26", emptyOutDir: true, minify: false, rollupOptions: { output: { codeSplitting: false, entryFileNames: fileName } } },
  });
  return resolve(root, outDir, fileName);
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  const out = await bundle("src/index.ts", "dist/worker", "index.js");
  console.log(`edge-api: bundled ${out}`);
}
