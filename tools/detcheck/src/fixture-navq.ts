// S0b: the navmesh builder (recast-navigation wasm) and the script sandbox (QuickJS wasm) must
// load from pre-compiled modules and give identical results on every runtime, like Rapier.
import { getNavMeshPositionsAndIndices, init as initRecast, NavMeshQuery } from "@recast-navigation/core";
import { generateSoloNavMesh } from "@recast-navigation/generators";
import RecastFactory from "@recast-navigation/wasm/wasm";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import { hex32, stream, xxh32 } from "@ghostrun/detmath";

export interface NavQResult {
  nav: { polys: number; verts: number; hash: string; paths: string; buildMs: number };
  qjs: { value: string; interruptedAfter: number; boundedCalls: number; memLimitHit: boolean; hash: string };
}

function hashNumbers(xs: ArrayLike<number>, seed = 0): number {
  const f = new Float64Array(xs.length);
  for (let i = 0; i < xs.length; i++) f[i] = xs[i] === 0 ? 0 : xs[i]!;
  return xxh32(new Uint8Array(f.buffer), seed);
}

/** Axis-aligned box → 12 triangles appended to a triangle soup. */
function box(pos: number[], idx: number[], cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) {
  const b = pos.length / 3;
  for (const [x, y, z] of [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ] as const) pos.push(cx + x * hx, cy + y * hy, cz + z * hz);
  for (const [a, c, d] of [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [3, 6, 2], [3, 7, 6], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
  ] as const) idx.push(b + a, b + c, b + d);
}

export async function runNavQ(recastWasm: WebAssembly.Module, quickjsWasm: WebAssembly.Module, now: () => number): Promise<NavQResult> {
  // ---- recast: Emscripten's instantiateWasm hook lets us pass the pre-compiled module ----------
  // init() only ever calls impl(); its parameter is typed as the factory's full static shape.
  const factory = () =>
    RecastFactory({
      instantiateWasm(imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) {
        WebAssembly.instantiate(recastWasm, imports).then((inst) => done(inst, recastWasm));
        return {};
      },
    });
  await initRecast(factory as unknown as typeof RecastFactory);

  const pos: number[] = [];
  const idx: number[] = [];
  box(pos, idx, 0, -0.5, 0, 30, 0.5, 30); // ground
  box(pos, idx, 0, 3, 30, 30, 3, 0.5); // walls
  box(pos, idx, 0, 3, -30, 30, 3, 0.5);
  box(pos, idx, 30, 3, 0, 0.5, 3, 30);
  box(pos, idx, -30, 3, 0, 0.5, 3, 30);
  const rng = stream(7, "navq:obstacles");
  for (let i = 0; i < 40; i++) box(pos, idx, (rng() - 0.5) * 50, 0.75, (rng() - 0.5) * 50, 0.5 + rng() * 2, 0.75, 0.5 + rng() * 2);
  // a walkable ramp up to a raised platform (sloped quad built from vertices, no trig)
  const r = pos.length / 3;
  pos.push(10, 0, 10, 16, 2, 10, 16, 2, 14, 10, 0, 14);
  idx.push(r, r + 2, r + 1, r, r + 3, r + 2);
  box(pos, idx, 20, 1, 12, 4, 1, 4);

  const t0 = now();
  const { success, navMesh } = generateSoloNavMesh(pos, idx, { cs: 0.2, ch: 0.2, walkableRadius: 2, walkableClimb: 2, walkableHeight: 9, walkableSlopeAngle: 45 });
  const buildMs = Math.round(now() - t0);
  if (!success || !navMesh) throw new Error("navmesh build failed");
  const [nvPos, nvIdx] = getNavMeshPositionsAndIndices(navMesh);
  const navHash = hashNumbers(nvIdx, hashNumbers(nvPos));

  const query = new NavMeshQuery(navMesh);
  let pathHash = 0;
  const prng = stream(7, "navq:paths");
  for (let i = 0; i < 20; i++) {
    const a = { x: (prng() - 0.5) * 56, y: 0, z: (prng() - 0.5) * 56 };
    const b = i === 0 ? { x: 20, y: 2, z: 12 } : { x: (prng() - 0.5) * 56, y: 0, z: (prng() - 0.5) * 56 };
    const res = query.computePath(a, b);
    const flat = res.success ? res.path.flatMap((p) => [p.x, p.y, p.z]) : [-1];
    pathHash = hashNumbers(flat, pathHash);
  }
  query.destroy();
  navMesh.destroy();

  // ---- QuickJS: pre-compiled module through newVariant; deterministic interrupt budget --------
  const QuickJS = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmModule: quickjsWasm }));
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(4 * 1024 * 1024);
  let calls = 0;
  let limit = 2_000;
  rt.setInterruptHandler(() => ++calls > limit);
  const ctx = rt.newContext();

  calls = 0;
  limit = 1e9;
  const ok = ctx.evalCode("let s = 0; for (let i = 0; i < 200000; i++) s = (s + i * 7) % 1000003; String(s)");
  const value = ok.error ? `error:${ctx.dump(ok.error)}` : String(ctx.dump(ok.value));
  (ok.error ?? ok.value).dispose();
  const boundedCalls = calls;

  calls = 0;
  limit = 2_000;
  const loop = ctx.evalCode("while (true) {}");
  const interruptedAfter = loop.error ? calls : -1;
  (loop.error ?? loop.value).dispose();

  calls = 0;
  limit = 1e9;
  const mem = ctx.evalCode("const a = []; while (true) a.push(new Array(1000).fill(1));");
  const memLimitHit = Boolean(mem.error);
  (mem.error ?? mem.value).dispose();
  ctx.dispose();
  rt.dispose();

  const qjsHash = xxh32(new TextEncoder().encode(`${value}|${interruptedAfter}|${boundedCalls}|${memLimitHit}`));
  return {
    nav: { polys: nvIdx.length / 3, verts: nvPos.length / 3, hash: hex32(navHash), paths: hex32(pathHash), buildMs },
    qjs: { value, interruptedAfter, boundedCalls, memLimitHit, hash: hex32(qjsHash) },
  };
}
