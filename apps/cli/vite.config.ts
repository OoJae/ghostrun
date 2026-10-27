import { defineConfig } from "vite";
import { rapierWasmShim } from "../../packages/sim/src/rapier/vite-plugin.ts";

export default defineConfig({
  plugins: [rapierWasmShim()],
  ssr: { noExternal: true },
  build: {
    ssr: "src/main.ts",
    outDir: "dist",
    target: "node26",
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "ghostrun.mjs", codeSplitting: false } },
  },
  logLevel: "warn",
});
