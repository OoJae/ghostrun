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
- Still to come in S0: recast-navigation and QuickJS interrupts inside workerd; dependency scans for navcat, mathcat and Koota; the 6-fixture det-quick CI job.

Run it yourself: `pnpm --filter @ghostrun/detcheck quick` (2k ticks) or `full` (10k ticks).
