import { defineConfig } from "vitest/config";
import { rapierWasmShim } from "./packages/sim/src/rapier/vite-plugin.ts";

export default defineConfig({
  plugins: [rapierWasmShim()],
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    server: { deps: { inline: [/rapier3d-deterministic/, /@recast-navigation/] } },
  },
});
