# GHOSTRUN

**It plays what it builds, then plays with you.**

Type any world, and GHOSTRUN turns it into a playable 3D level in the browser in about two seconds. Then it does what builders usually skip: AI runners play the level in a deterministic physics simulation, every rule is force-tested, and a receipt states what was verified, what was played and what could not be checked. When the proof finds a problem, the AI repairs the world, re-proves it, and offers the fix.

> Built for the Victoria VR AI Builder Hackathon 2026. Not affiliated with or endorsed by Victoria VR.

## What a session looks like

1. **Prompt.** "Create a capture-the-flag game in a neon city. Add double jump. Score when the orb reaches the goal."
2. **About 2 s later you are playing.** An intent model picks the genre, a layout pack and the headline property; a fill model streams the world as typed JSON lines (zones, entities, verbs, rules, expectations); a deterministic placer binds them to real geometry.
3. **While you play, the proof runs** on your device (a Web Worker):
   - **T0** checks every rule references something real and regresses the win back through the rule graph ("win ← red reaches 3 ← orb into goal_red ← pick up orb").
   - **T1** checks geometric claims with a jump model ("apex 1.6 m < ledge 2.6 m").
   - **T2** forces each rule's trigger and asserts it fires exactly once.
   - **T3** sends 12 AI runners into the real simulation, against the world's own bots, through doors they must unlock, over gaps they must jump.
4. **The receipt** (press **P**) leads with the prompt-specific claim, for example "Rooftop lane needs double jump: verified · 12 of 12 AI runners won", and labels every number with its method. Fewer than 30 trials print as "k of n", never a percentage.
5. **Logic X-ray** (press **X**): every rule as a WHEN / IF / THEN sentence with its forced-state mark; hover a tile and that thing lights up in the scene.
6. **Repair loop.** If the receipt has counterexamples (a win that needs nothing, a rule that never fires, a false claim), the issues go back to the model with concrete hints, the patch is merged by id, re-proved on the device, and offered as "AI repaired it · re-proved · Apply" only if the new receipt is better.
7. **Change it.** Type a change ("only one jump", "add three more coins", "make it night") and the same world comes back changed, in about a second, and re-proved with its numbers: "jump height 1.6 → 3.4 m · Headline: verified → counterexample · Rooftop lane needs double jump — reachable with 1 jump". Edits patch the world by stable ids and keep its geometry; they can never rewrite what the world promised, so a change that breaks a promise shows up instead of quietly erasing it. Undo is one click.
8. **Why did I lose?** The result card tells the run's story from the simulation's causal log ("Rival 1 carried the glowing orb into the neon goal ring, 3 times"); every moment replays exactly. Ask the Host anything about the run: it answers from the run's facts only and cites them.
9. **Share** a run: the link replays it bit-exactly on any device. **This is wrong** sends a note plus the run.
10. **Gallery** (press **G**): 28 worlds the live AI built from prompts during development, recorded unedited and re-proved on your device when opened: heists, sumo, a Czech ghost maze, a pirate ship, mini golf, places to explore.

Phones get on-screen controls. Browsers with WebXR get **Enter VR** (first person; tested on an emulated Quest 3, not yet on a real headset).

## What is in the box

| Part | What it does |
|---|---|
| `packages/ir` | IR v1: the typed world document (Valibot), spec hash (SHA-256 over canonical JSON, cosmetics stripped), streaming JSONL fill parser with repairs and synonyms, patch merge |
| `packages/sim` | Deterministic 60 Hz simulation on `@dimforge/rapier3d-deterministic`: character controllers, carry, tags, triggers, rule cascades, kit verbs, respawns |
| `packages/kits` | Verb plugins: switch, pressure plate, lock and key, collectible, checkpoint, portal, timer, hazard, crumbling floor, wind, jump pad, inspect, throw, shove (plus jump, carry, oscillate, tag) |
| `packages/bots` | NPCs that play their typed menu options (attack, defend, intercept, follow, patrol) on navmesh paths |
| `packages/packs/*` | Layout packs: city block, floor plan (with doorways), arena, maze, outdoor, obstacle course; each tested over 50 seeds |
| `packages/layout` | The placer and its logged repairs (verbs implied by kinds, collections, door placement, footprints, win fallbacks…) |
| `packages/proof` | The proof ladder T0–T3, the tour proof for places, issues for the repair loop |
| `packages/llm` | Prompts and a streaming client for the intent and fill models |
| `apps/web` | three.js r186 (WebGPU with WebGL2 fallback) client: looks (neon, grove, gallery), HUD, receipt, X-ray, share, touch, VR |
| `apps/edge-api` | Cloudflare Worker: governed `/v1/build`, `/v1/edit` and `/v1/repair` (spend caps per session, IP and pool; fails closed), Turnstile and judge-token gate, share store |
| `apps/cli` | `ghostrun verify`, `build`, `bench`, `rebench [--repair]`, `edits` |
| `tools/detcheck` | Cross-runtime determinism check |

## Determinism

The same world and the same inputs give the same state hash everywhere, so a proof run in one place holds for the game in another and share links replay exactly. `pnpm det:quick` runs the organizer's CTF brief, with its bots, for 2,000 ticks on five runtimes:

| Runtime | Node 26 | workerd | Chromium 156 | Firefox 157 | WebKit 27.2 |
|---|---|---|---|---|---|
| CTF state / event-log hash | `becbbeec` / `d9881845` | same | same | same | same |

Simulation-path code avoids anything engines may compute differently (no `**`, no transcendental `Math`, no clocks or `Math.random`); a lint test enforces it.

## Numbers so far (internal, honest)

- **Prompt to playable:** 2.1 s in one measured live run (intent 0.84 s, fill 1.2 s, build 0.04 s, shader compile 0.1 s), headless Chromium on an Apple M5 development machine. Not yet measured on judges' devices.
- **Live robustness:** 84 live prompts from seven internal prompt sets, their worlds committed in `tools/bench/worlds` with each set's first-pass results (one world crashed the proof before it was recorded; the crash is fixed), re-proved by `ghostrun trust`. Across the 73 games, AI runners win (at least 10 of 12 runs) **38 on the first pass (52%) and 69 with today's code (95%)**, before the live repair loop runs. The newest set (fresh4, 14 prompts) was written after three rounds of fixes and measured before anyone looked at it: **8 of 14 on the first pass**, one of them a crash that is counted as lost; 13 of 14 after fixing what it found. Every set has now been tuned on, so the first-pass column is the honest one; earlier tuned worlds read much higher (36 of 42) and new fills of the same prompts showed that was optimistic, which is why the table in **Why trust this?** is generated from the committed sets rather than written by hand. Prompt to playable had a median of 2.0 to 5.6 s per set.
- Failures name their cause in the receipt: how the runs ended ("6 lost (hit the lava ×6)"), where they got stuck, or the jump model's reason ("a 2.3 m step on the way, and 1 jump reaches 1.5 m").
- These are not external evaluations. An external prompt set from people outside the project is planned.

## Run it

Requires Node 26 and pnpm 11.

```bash
pnpm install
pnpm --filter @ghostrun/web dev          # http://localhost:5173
```

Without an API key the app opens recorded worlds: `?fixture=ctf` (default), `coin-rush`, `forest`, `parkour`, `heist`, `vault`. For live building, put a Cerebras key in a gitignored `.dev.vars` at the repo root:

```
CEREBRAS_API_KEY=...
```

The dev server runs the real edge handler in-process; keys never reach the browser.

```bash
pnpm gate                                # typecheck, unit tests, 5-runtime determinism check
pnpm --filter @ghostrun/web e2e          # browser tests (Chromium, WebGL2, phone and emulated VR)
pnpm --filter @ghostrun/edge-api test:workerd   # the spend governor under real workerd
```

Controls: WASD to move, Space to jump (press again in the air to double jump), F to use (throw, shove, flip, unlock), Q/E or drag to turn the camera, P for the receipt, X for the Logic X-ray, T to talk to a character, G for the gallery. The mic in the prompt bar speaks a world.

## AI use

- **At runtime:** an intent model (Qwen3.8-27B) and a fill/repair model (gpt-oss-120b), both open-weight Apache-2.0 models served by Cerebras. They write the world as typed data; they never write code that runs. Everything they produce is validated, repaired deterministically where possible, and proved before it is trusted.
- **Building it:** the code was written with Claude Code (Anthropic), directed and reviewed by the author.

## Licence and credits

MIT (see `LICENSE`). Third-party components: three.js (MIT), Rapier (Apache-2.0), recast-navigation-js (MIT) with Recast/Detour (Zlib), React (MIT), Valibot (MIT), Vite (MIT), Playwright (Apache-2.0, tests), workerd (Apache-2.0, tests), IWER (MIT, emulated-VR tests only). The full notices file is generated from the dependency tree before release.
