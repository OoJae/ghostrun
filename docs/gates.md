# Spike decisions (ADRs)

Each week-1 spike ends with a GO / NO-GO decision recorded here, with the evidence and the fallback taken.

## S0: deterministic physics on every runtime: **GO** (2026-10-27)

**Question.** Does `@dimforge/rapier3d-deterministic@0.21.0` produce bit-identical simulations on every runtime GHOSTRUN uses (the judge's browser, the edge proof service and the Node verifier)? This is what makes a proof computed in the cloud valid for the world the player is in, and it is what allows replays and share links.

**Method.** `tools/detcheck`:
- **Fixture:** a static arena with walls and two ramps; 240 dynamic bodies (boxes, balls and capsules with random friction and restitution) dropped into a pile; and a kinematic player capsule driven through `KinematicCharacterController` by a scripted walk-and-jump input.
- **Setup is deterministic:** sfc32 random numbers and no trig functions.
- **Hash:** after every tick, the translation, rotation and linear velocity of every body are hashed with xxh32 over float64 bits (with −0 canonicalized) and chained. A checkpoint is recorded every 100 ticks.
- **Engine binary:** one Rapier wasm build (3,105,893 B, sha256 `4e9890fd2df60072f9db06a33e4030221249c1b3687b722b2388c21f09e97551`) is loaded by each runtime through `src/load.ts`. A build-time shim replaces Rapier's `import * as wasm from "…wasm"` with that loader.

**Result.**

| Runtime | 2,000 ticks | 10,000 ticks | 10k wall time |
|---|---|---|---|
| Node 26.0.0 | `5a7d3431` | `1f69734c` | 2,079 ms |
| workerd 2026-10-19 (the runtime in wrangler 4.152.0) | `5a7d3431` | `1f69734c` | 2,090 ms |
| Chromium 156.0.8078.4 | `5a7d3431` | `1f69734c` | 1,994 ms |
| Firefox 157.0 | `5a7d3431` | `1f69734c` | 2,334 ms |
| WebKit 27.2 | `5a7d3431` | `1f69734c` | 2,276 ms |

Every checkpoint matched. Throughput for 241 bodies plus the controller is about 0.2 ms per tick once warm. A 60 s run (3,600 ticks) therefore costs about 0.7 s of CPU, which bodes well for S1's target of ≤80k CPU-ms per world.

**Notes and follow-ups.**
- The engine imports `performance.now()`, apparently for internal timing counters only. Hashes stay identical on every runtime, so it does not affect results. `detcheck` keeps guarding this.
- Workers can only instantiate pre-compiled wasm. The edge build imports the `.wasm` as a CompiledWasm module, and that is the same path production uses.
- **Done in S0b (same day):** the navmesh builder and the script sandbox, also loaded from pre-compiled wasm modules on all five runtimes. See below.
- Still to come: dependency scans for Koota; the 6-fixture det-quick CI job.

## S0b: navmesh + script sandbox on every runtime: **GO** (2026-10-27)

**Fixture** (`src/fixture-navq.ts`):
- **Navmesh:** a 60 × 60 m arena with walls, 40 random obstacles and a ramp to a raised platform. The navmesh is built with `@recast-navigation` 0.43.1 (cs 0.2, ch 0.2, agent radius 0.4 m), then 20 path queries run. Polygons and paths are hashed.
- **Sandbox:** QuickJS (`quickjs-emscripten` 0.32.0, release-sync) runs three scripts:
  - a bounded compute script;
  - `while(true){}`, under an interrupt budget of 2,000 handler calls;
  - an allocation bomb, under a 4 MB memory limit.

| Runtime | Navmesh hash | Paths hash | Polys | Build | QuickJS hash | Loop stopped at |
|---|---|---|---|---|---|---|
| Node 26 | `c547419d` | `5373b878` | 716 | 30 ms | `d6a9e3f4` | 2,001 calls |
| workerd | `c547419d` | `5373b878` | 716 | 37 ms | `d6a9e3f4` | 2,001 calls |
| Chromium 156 | `c547419d` | `5373b878` | 716 | 29 ms | `d6a9e3f4` | 2,001 calls |
| Firefox 157 | `c547419d` | `5373b878` | 716 | 41 ms | `d6a9e3f4` | 2,001 calls |
| WebKit 27.2 | `c547419d` | `5373b878` | 716 | 34 ms | `d6a9e3f4` | 2,001 calls |

The memory cap held everywhere.

**Decisions.**
- **Navigation:** use recast-navigation everywhere (builder and queries; DetourCrowd for groups once tested). It loads in workerd through Emscripten's `instantiateWasm` hook with the pre-compiled module, so **navcat and its trig patch are not needed**. Navcat stays the documented fallback.
- **Script budget:** the QuickJS interrupt count is deterministic across engines, so an AI-written script's budget can be "N interrupt calls" rather than wall time. That keeps sandboxed behaviours replayable. The wall-clock watchdog is only a backstop.
- **Licences to confirm:** Recast/Detour (Zlib) and the Emscripten runtime (NCSA) are permissive and attribution-only, but they are not on the MIT/Apache/BSD/ISC/CC0 list. They are awaiting the user's approval (`docs/strategy/OVERNIGHT.md`).

Run it yourself: `pnpm --filter @ghostrun/detcheck quick` (2k ticks) or `full` (10k ticks).
