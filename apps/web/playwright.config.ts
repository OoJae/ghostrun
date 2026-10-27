import { defineConfig, devices } from "@playwright/test";

const PORT = 4317;

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: {
    // Production build served by `vite preview` (cwd is apps/web; no absolute paths, so the
    // space in the repo path never reaches a shell).
    command: "VITE_IWER=1 pnpm run build && pnpm run preview",
    url: `http://localhost:${PORT}`,
    // Never reuse: a stray preview server serves a stale bundle and the suite tests old code.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
