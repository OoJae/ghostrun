import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { rapierWasmShim } from "../../packages/sim/src/rapier/vite-plugin.ts";
import { proofVersion } from "../../packages/world/src/version.ts";

/** Dev only: serve /v1/* and /mcp with the real edge handler, keys from the repo's gitignored .dev.vars. */
function devEdgeApi(): Plugin {
  const varsFile = fileURLToPath(new URL("../../.dev.vars", import.meta.url));
  const env: Record<string, string> = {};
  if (existsSync(varsFile)) {
    for (const line of readFileSync(varsFile, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]!] = m[2]!;
    }
  }
  return {
    name: "ghostrun-dev-edge-api",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const isMcp = req.url === "/mcp" || req.url?.startsWith("/mcp?");
        if (!req.url?.startsWith("/v1/") && !isMcp) return next();
        try {
          const { handle } = (await server.ssrLoadModule("/../edge-api/src/handler.ts")) as typeof import("../edge-api/src/handler");
          // the cloud proof on Node's engine (whole in this process: no shards in dev)
          await server.ssrLoadModule("/../edge-api/src/engine-node.ts");
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          // MCP needs its headers (the protocol version, the method, a token) and its own host for the links it gives
          const hop = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"]);
          const headers = isMcp ? Object.fromEntries(Object.entries(req.headers).filter((kv): kv is [string, string] => typeof kv[1] === "string" && !hop.has(kv[0]))) : { "content-type": String(req.headers["content-type"] ?? "application/json") };
          const request = new Request(`http://${isMcp ? (req.headers.host ?? "localhost") : "localhost"}${req.url}`, {
            method: req.method ?? "GET",
            headers,
            ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
          });
          // DEV_OPEN opens the gate for localhost only; the governor and share store run in-process.
          const response = await handle(request, { CEREBRAS_API_KEY: env.CEREBRAS_API_KEY ?? "", ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}), DEV_OPEN: "1" });
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          if (!response.body) return res.end();
          const reader = response.body.getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    },
  };
}

// recast's exports map hides its .wasm; resolve the real file once and alias it.
const recastWasm = join(dirname(createRequire(import.meta.url).resolve("@recast-navigation/wasm/wasm")), "recast-navigation.wasm.wasm");

export default defineConfig({
  plugins: [rapierWasmShim(), react(), devEdgeApi()],
  // the proof version (packages/world/src/version.ts): the edge serves and compares receipts of this proof code only
  define: { __PROOF_VERSION__: JSON.stringify(proofVersion()) },
  resolve: { alias: [{ find: /^ghostrun-recast-wasm/, replacement: recastWasm }] },
  worker: { format: "es", plugins: () => [rapierWasmShim()] },
  build: {
    outDir: "dist/app",
    target: "es2023",
    // three/webgpu is one large module by design.
    chunkSizeWarningLimit: 1800,
  },
  server: { port: 5173, fs: { allow: ["../.."] } },
  preview: { port: 4317, strictPort: true },
});
