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
- **Licences:** Recast/Detour (Zlib), the Emscripten runtime (NCSA) and the fdlibm SunPro notice were approved by the user on 2026-10-27 as documented permissive exceptions. They are attribution-only and must be credited in THIRD_PARTY_NOTICES.

Run it yourself: `pnpm --filter @ghostrun/detcheck quick` (2k ticks) or `full` (10k ticks).

## S2: live fast lane (Cerebras intent + streamed fill): **GO** (2026-10-27)

10 varied dev prompts (`tools/bench/prompts-s2.txt`, written by us, so never part of the external eval set). Pipeline: qwen-3.8-27b intent (strict JSON schema, reasoning none) → gpt-oss-120b streamed JSONL fill (reasoning low), parsed line by line → placed → proof ladder. Measured from Lagos on the free tier. These are timings of *our pipeline*, not a vendor comparison (Cerebras ToS forbids competitive benchmarking).

| Metric | p50 | p90 | Gate |
|---|---|---|---|
| Intent | 0.59 s | 0.91 s | p50 ≤ 0.8 s ✅ |
| First entity on screen | 1.21 s | 1.42 s | — |
| **Playable (gameplay layer final + placed)** | **1.48 s** | **1.66 s** | p50 ≤ 3.5 s, p90 ≤ 7 s ✅ |
| Proof ladder (T0–T3, Node) | 0.05 s | 0.38 s | — |
| Invalid fill lines | 7.7% (18 / 235) | | < 1% ❌ |

**Fixes applied.**
- 12 of the 18 invalid lines were `"body":"static"`. A deterministic enum synonym table in the parser's single repair pass now handles it (static→fixed, cylinder→capsule, team "none"→"", lose_reachable→reachable and others).
- The fill prompt now lists the exact enum values.
- The floor_plan pack was added, so interior prompts (villa tour, gallery, ramen shop, museum heist) are no longer forced into a street grid.
- **Re-run, same 10 prompts:**
  - invalid lines **0.7%** (2/270) ✅
  - playable p50 **1.49 s**, p90 2.19 s ✅
  - intent p50 0.59 s, p90 1.09 s ✅
  - 8/10 prompts picked floor_plan, 2 picked city_block.

**Open.**
- Median interactive controls per world is well under the target of 15. The prompt and completeness contract must ask for more affordances.
- Headline counterexamples on prompts that don't fit the available packs. The repair loop (counterexample-guided repair, CEGR) and more packs/kits address this.
- The parkour prompt: 0/12 runners at first, because the witness planner couldn't jump.
  - Fixed: T3 jump links. When the target is on a raised surface the navmesh can't reach on foot, runners walk to its nearest face, jump, air-jump at the apex and land on top. Re-verified: **12/12 won, AI par 9.3 s**.
  - Also fixed: any entity targeted by an enter/exit trigger is now forced to a sensor. A solid "spike trap" could never be entered in play, yet its forced-state test passed.
- Coverage: the intent picks floor_plan for castles and space stations because only two packs exist. The arena, outdoor and maze packs are next (Build A).

## S0c: the product's own SimWorld is bit-identical on every runtime: **GO** (2026-10-27)

`tools/detcheck/src/fixture-ctf.ts` builds the organizer's CTF brief the way the product does (fill → city_block → placer). It then plays it in `SimWorld` for 2,000 ticks with scripted inputs: the KCC with coyote time, jump buffer and air jumps; carry; enter and pickup triggers; rule cascades with score and reset; score_gte → win/lose.

| Runtime | State hash | Event-log hash | Events | Scores |
|---|---|---|---|---|
| Node 26 · workerd · Chromium 156 · Firefox 157 · WebKit 27.2 | `74928a5b` | `ae80c6d3` | 79 | red 2, blue 0 |

All five are identical. **A proof computed at the edge is valid in the judge's browser**, and share-link replays are bit-exact.

**Re-baselined 2026-10-27:** the web e2e caught the teammate `mate_1` standing 1.6 m in front of the red spawn, in the line to the orb. Real physics stopped a human pressing W after 0.9 m, while the AI runners pathed around it. The placer now fans out bodies that share an anchor *across* the line from the anchor to the world centre. New hashes `dbb6200f` / `79fd7f6f`, still 79 events and red 2 / blue 0, still identical on all five runtimes. A layout regression test keeps the first 4 m from every spawn clear.

**Bots join the hash, 2026-10-27.** NPCs are now characters on the player's own controller, driven by `@ghostrun/bots`: menu options run as navmesh steering (attack, intercept, defend, follow, patrol); the `tag_drop` verb works for every agent. The detcheck CTF fixture plays its scripted player against the world's own bots.

| Ticks | State hash | Event-log hash | Events | Scores | Runtimes |
|---|---|---|---|---|---|
| 2,000 | `becbbeec` | `d9881845` | 88 | red 1, blue 2 | all 5 identical |
| 10,000 | `f9f49770` (before secrets: re-measure) | `88ef8300` | 134 | red 1, blue 3 (blue wins) | all 5 identical |

State hashes re-baselined later the same night when signs became decor (no collider); the event logs are unchanged. **Re-baselined again overnight 27 Oct:** the placer now adds up to six "secrets" (bonus collectibles that only sparkle and count apart from the win) to play worlds with fewer than ten things to use, so the CTF gains five neon shards on its rooftop lane and decks. The 2k state hash moved from `59f5b58f` to `becbbeec`; the event log is unchanged (the scripted run touches none of them), and all five runtimes still agree. The 10k figure is from before the secrets and is re-measured by the nightly run. Recast path queries inside the tick are bit-exact on every runtime too, so **a proof the edge ran against the bots holds for the bots in the judge's browser.** The T3 receipt on the CTF brief: 12 of 12 AI runners won against 3 bots, AI par 36.9 s (26.2 s against static NPCs).

## S6: Cerebras terms: **GO** (2026-10-28)

Read against the [Cerebras ToS](https://cerebras.ai/terms-of-service) (effective 27 Aug 2024) and the model pages; the user gave the GO on 28 Oct.

- **Outputs are ours to license.** Cerebras claims no ownership; gpt-oss-120b and Qwen3.8-27B are Apache-2.0, compatible with T&C 7.2 and the organizer's sublicence (11.4).
- **No training on API data; serving end users inside the app is allowed** (reselling keys is not, and we don't). No EU restriction beyond standard US export controls.
- **Condition: no vendor comparisons.** The terms forbid using the service "for benchmarking or competitive analysis of the Service". The README, video, description and trust panel publish only GHOSTRUN's own end-to-end timings ("prompt to playable"), never a Cerebras-vs-anyone table or a per-provider speed claim.
- **Anthropic stays in the routing** (user decision, 28 Oct): Haiku is the fallback rung for Cerebras 429s and the NPC-minds alternative, Sonnet runs the Director's cut and hard repairs. MiMo is dev-only, behind a flag that is off in production.

## S5b: the fallback rung (Claude Haiku 5.5): **GO** (2026-10-28)

When the fast lane is busy (429) or down (5xx) before it has written a word, the same request goes to Claude Haiku 5.5 over the Messages API (`packages/llm/src/lanes.ts`). The primary gets one quick retry (0.7 s, or the provider's own hint) before failing over. Once text has streamed, a failure is final: the client has already placed those lines. A bad request (4xx) or a refusal never fails over. Every route uses it: intent, fill, repair and edit patches, NPC minds and the Host.

- **Said plainly:** the build stream sends a `fallback` event and `done` names the model that answered. The app labels such a world "live AI · Haiku", and the stopwatch split says which model wrote the fill. The receipt and its proof are unchanged.
- **Charged honestly:** the governor commits the cost at the price of the model that answered. The hold is priced on the fast lane, which costs more per token than Haiku, so a hold still covers a fallback. An HTTP error is free; a mid-stream error is charged at its estimate (fail closed).
- **Switch:** KV `route:primary = anthropic` puts Haiku first for every call, deploy-free (the runbook's "fast lane down for an hour"). Without `ANTHROPIC_API_KEY` there is one lane, as before.
- **No paid fast lane (user decision, 28 Oct).** Cerebras stays on its free trial: 5 requests a minute per model, 1M tokens a day, and a $5 credit that ends 30 days after it was granted. So the failover also covers a provider that turns the key away (401/402/403, as when the trial ends) without retrying it, and an isolate that sees a provider fail tries it last for a while (20 s after a 429, 10 min after a refusal to serve), so builds stop waiting on it.
- **Minds and the Host start on Haiku.** They are frequent (every minded NPC thinks on each score, pickup and tag) and would spend the five requests a minute that world builds need. `ghostrun canary` (each structured-output job on each lane alone, the plan's twice-daily schema check): a Haiku mind answers in 1.1–2.1 s, within the 3 s cast timeout; a Host answer in 1.2–2.6 s.
- **Plain fetch, not the SDK:** `@anthropic-ai/sdk` bundles `fast-sha256` (Unlicense) through its webhooks module, which our licence list doesn't allow. The adapter calls the Messages API directly (API version 2026-10-21; no sampling parameters; thinking off at low effort for these fast jobs; structured outputs with the JSON-schema bounds it rejects removed, since every caller re-checks them).
- **Tested:** unit tests for each failover rule; the edge handler end to end with a fake upstream; and the same build failing over inside real workerd (`test:workerd`, 17 checks).

**The lane on its own.** The 28 prompts of `prompts-fresh10.txt` (the organizer's likely prompts), with Haiku forced as the only lane (`GR_LANE=anthropic ghostrun bench`), recorded in `tools/bench/lanes/haiku-fresh10/`:

| | |
|---|---|
| Builds that errored | 0 of 28 |
| Games won by the AI runners (≥10 of 12), first pass | 16 of 20 (one more had its win chain disproved before any run) |
| Places | 8 (headline verified on 5) |
| Prompt to playable | p50 11.8 s, p90 13.6 s |
| Invalid fill lines | 1.8% (19 of 1,083) |

It is slower, and a fallback it stays: a world in twelve seconds beats a lost one. These describe our pipeline on this lane; they are not a comparison between providers.
