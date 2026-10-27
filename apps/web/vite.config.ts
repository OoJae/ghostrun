import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/app",
    target: "es2023",
    // three/webgpu is one large module by design.
    chunkSizeWarningLimit: 1800,
  },
  server: { port: 5173 },
  preview: { port: 4317, strictPort: true },
});
