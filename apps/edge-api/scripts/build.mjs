// Bundles the Worker (src/index.ts → dist/worker/index.js, one ES module) with the repo's Vite, so
// `?raw` imports and workspace packages resolve exactly as they do in tests. wrangler uploads this
// file as-is (no_bundle in wrangler.jsonc), and the workerd test runs a bundle built the same way.
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const conditions = ["workerd", "worker", "browser", "import", "module", "default"];

export async function bundle(entry, outDir, fileName) {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    resolve: { conditions },
    ssr: { noExternal: true, target: "webworker", resolve: { conditions } },
    build: {
      ssr: entry,
      outDir,
      target: "es2023",
      emptyOutDir: true,
      minify: false,
      rollupOptions: { output: { codeSplitting: false, entryFileNames: fileName } },
    },
  });
  return resolve(root, outDir, fileName);
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  const out = await bundle("src/index.ts", "dist/worker", "index.js");
  console.log(`edge-api: bundled ${out}`);
}
