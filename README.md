# GHOSTRUN

**It plays what it builds, then plays with you.**

Type any world, and GHOSTRUN turns it into a playable 3D level in the browser in about two seconds. Then it does what builders usually skip: AI runners play the level in a deterministic physics simulation, every rule is force-tested, and a receipt states what was verified, what was played and what could not be checked. When the proof finds a problem, the AI repairs the world, re-proves it, and offers the fix.

**Play it:** https://play.ghostrun.workers.dev (no login; a Cloudflare Turnstile check, usually invisible, guards the live AI).

**From any agent:** GHOSTRUN is an MCP server at https://play.ghostrun.workers.dev/mcp (`build_world`, `edit_world`, `explain_world`, `get_receipt`, `list_gallery`, with a judge or dev token): see [docs/MCP.md](docs/MCP.md).

> Built for the Victoria VR AI Builder Hackathon 2026. Not affiliated with or endorsed by Victoria VR.

## What a session looks like

1. **Prompt.** "Create a capture-the-flag game in a neon city. Add double jump. Score when the orb reaches the goal."
2. **About 2 s later you are playing.** An intent model picks the genre, a layout pack and the headline property; a fill model streams the world as typed JSON lines (zones, entities, verbs, rules, expectations); a deterministic placer binds them to real geometry.
3. **While you play, the proof runs** on your device (a Web Worker):
   - **T0** checks every rule references something real and regresses the win back through the rule graph ("win ← red reaches 3 ← orb into goal_red ← pick up orb").
   - **T1** checks geometric claims with a jump model ("apex 1.6 m < ledge 2.6 m").
   - **T2** forces each rule's trigger and asserts it fires exactly once.
   - **T3** sends 12 AI runners into the real simulation, against the world's own bots, through doors they must unlock, over gaps they must jump.

   The same proof runs in the cloud at the same moment (`POST /v1/proof`: the runs split across six Durable Object shards, the same pinned simulation, the same receipt chip for chip). Whichever receipt is out first fills it in, and the receipt says where it was proved and whether the other one agreed: "proved in the cloud · same result on this device". If they ever differ, it shows this device's and says so.
4. **The receipt** (press **P**) leads with the prompt-specific claim, for example "Rooftop lane needs double jump: verified · 12 of 12 AI runners won", and labels every number with its method. Fewer than 30 trials print as "k of n", never a percentage.
5. **Logic X-ray** (press **X**): every rule as a WHEN / IF / THEN sentence with its forced-state mark; hover a tile and that thing lights up in the scene.
6. **Repair loop.** If the receipt has counterexamples (a win that needs nothing, a rule that never fires, a false claim), the issues go back to the model with concrete hints, the patch is merged by id, re-proved on the device, and offered as "AI repaired it · re-proved · Apply" only if the new receipt is better. If the fast repair can't fix it all, Claude Sonnet takes one harder look, under the same rule.
7. **Change it.** Type a change ("only one jump", "add three more coins", "make it night") and the same world comes back changed, in about a second, and re-proved with its numbers: "jump height 1.6 → 3.4 m · Headline: verified → counterexample · Rooftop lane needs double jump — reachable with 1 jump". Edits patch the world by stable ids; they can never rewrite what the world promised, so a change that breaks a promise shows up instead of quietly erasing it. Undo is one click. Changes to the map itself ("add a floor", "make the map bigger", "remove the rooftop lane") regenerate its layout from the same seed with the pack's new numbers, move whatever stood where an anchor went to the nearest free one, and say so: "floors 1 → 2 · 2 rooms added · 1 thing re-anchored". Every field of the Intent card corrects with one click too: the look, the hour and the weather redraw the world in place (the same spec, the same receipt); jumps, gravity, speed and the map's size come back re-proved; the pack, play or wander and the genre rebuild it live with that pinned ("rebuilt as a maze at your request"), with Undo; and when the prompt's own words name another pack or genre, one chip asks ("Did you mean a race? Make it a race"). When a change breaks a promise, **▶ red/green** plays the same AI runner on the same seed through both versions side by side, green before and red after, and says where they part ("They part here: the jump, near the Neon plaza (green rises 1.5 m, red 3.4 m)"); a world nobody wins shows its commonest failing run ("▶ where it fails").
8. **Director's cut.** The first world you build (or any world, when you say "surprise me") goes to Claude Sonnet with what the playtest found, and comes back fuller: a signature upgrade, more to use, a voice for every character, one twist. It is re-proved in the background and offered ("Director's cut ready: +1 irrigation lever, +1 glowing terrarium · re-proved · Apply") only if it plays at least as well; Apply between runs, Undo to go back.
9. **Why did I lose?** The result card tells the run's story from the simulation's causal log ("Rival 1 carried the glowing orb into the neon goal ring, 3 times"); every moment replays exactly. Ask the Host anything about the run: it answers from the run's facts only and cites them. The Host says its recap out loud ("You lost because the blue team reached 3."), and the first sentence or two of each answer; characters say their lines too, each in a voice of its own picked from the browser's voices for the world's language (pitch and pace by role and persona), one at a time, with the music ducking under them. T by a character opens the talk box: type, or hold the mic and say it. When an answer cites a place, the camera flies there and the moment replays from a second before it, under the held shot; Esc or any key hands control back. The result card asks the questions for you: "Why did I lose?", "Where did I waste time?", "What did the AI do differently?".
10. **What the AI runners revealed** (in the receipt, a few seconds after it turns green): 6 novice and 6 average runners play the world after the 12 experts, through seeded human hands (they act on what they saw a moment ago, wobble off their line, stop to look around, mistime jumps, aim wide in a fight), and the world gets a difficulty band from all three ("Normal: novices 0 of 6 · average 3 of 6 · experts 12 of 12") with the spread of clear times. Every run of every level then feeds a playtest report: a heat map of where they spent their time on the ground under the routes, where runs went wrong and why from the causal log ("near the Neon plaza: blue reached 3 ×5"), where the fights cluster, the pacing of the win ("glowing orb at 0:07 · neon goal ring at 0:11 · won at 0:43"), and what nobody went near ("A design note: give players a reason to go there, or take it out."). Every design note has **Apply**: its change ("put a neon shard on the hover platform", "move the lava pool off the main path", a Feng Shui fix) is made on a copy, re-proved, and offered with its numbers only if it plays at least as well. "Make it harder but fair" prefers the version one band harder that the experts still win.
11. **Share** a run: the link replays it bit-exactly on any device. **Remix** any shared or gallery world: it opens as your copy, your first change makes it a remix, and its link shows where it came from ("Remixed from “…” · 2 changes: “make it night”, “add three more coins”") with a link to the original, and says which receipt is for which version. **This is wrong** sends a note plus the run. **Try to fool it** plants a bug in a copy of the world (the goal 40 m up, the key gone, a condition nothing meets) and shows which check caught it.
12. **Clips.** The last seconds of every run are recorded as you play (the picture and the game's sound), and the result card plays them back: **Save clip** downloads the last ~10 s ending at the win or the loss (`ghostrun-capture-the-flag-0-42.webm`), and **Clean replay** replays the run exactly with the HUD hidden and saves the replay. `?record=1` is the HUD for screen-recording a demo: the extras and the cursor step aside, and one caption strip says the prompt, "playable in 1.8 s", where the world came from and the receipt's headline. `?clip=0` turns clips off (phones record only with `?clip=1`).
13. **Gallery** (press **G**): 62 worlds the live AI built from prompts during development, recorded unedited and re-proved on your device when opened: heists, sumo, bowling, archery, a bomb to defuse, a robot to assemble, a lighthouse in a crosswind, a Czech castle escape, a German ice cave, a pirate ship, mini golf, places to explore.
14. **Feng Shui.** A prompt that asks for Feng Shui gets a receipt section for one named school, the Form School: "Feng Shui (Form School): 5 of 6 principles hold", checked on the placed world (the command position for a bed, desk, counter or sofa; no straight line through from the front door to a window; no mirror facing it; a clear way in; uncluttered rooms; three of the five elements in the materials and colours), each with its reason, a fix the edit path can apply and its published source. Any interior offers it one button away. The rules, their checks and their sources are in `packages/layout/src/fengshui.ts`; `?fixture=fengshui` is a gallery where all six hold, `?fixture=fengshui-broken` one where two fail.
15. **Languages.** The HUD speaks the world's language when it is one of English, Czech, German, Spanish, French, Polish, Italian, Portuguese, Japanese or simplified Chinese, else the browser's, with a chip to switch (remembered on the device). Every language but English is machine-translated and unreviewed, and says so beside the chip. The proof's own sentences are worded in the player's language where their shape is known, and stay in the proof's English otherwise; counts stay "k of n" ("3 z 12") in every language.
16. **Deals.** Talk to a character and make an offer: a night guard takes 20 coins to look away for 20 s, a shopkeeper sells, a villa's agent books a viewing on Saturday at 3, which downloads as a calendar file (.ics, no personal data). The character's mind only picks a closed act (offer, pay, buy, command, ask, book); the edge refuses any act the world doesn't have, any offer below its price and any slot that isn't a real future time, and the world's own rules decide what the act does. The proof plans for it: the runners collect the coins and pay the guard, the forced-state tests force the bribe and the getting-caught rules, and the guard's every choice is covered. `?fixture=museum` and `?fixture=villa` show both.

Characters are animated models (CC0) that walk, run, jump, carry, flinch, fall and cheer as the simulation moves them, in their team's colours, and the things a world names (a rusty key, a treasure chest, a cursed book, a candle) are drawn as props; they load after the first frame, and `?models=0` keeps the primitives.

Phones get on-screen controls. Browsers with WebXR get **Enter VR**: first person, with the HUD as panels in the headset (a watch on the left wrist with the receipt's line, the score, the lap, your hit points and the ghost's split; the result card in front of you with the Host's recap and Play again; a character's line over their head). Point with a controller and pull the trigger to press a panel's button. The left stick walks (or, switched on the watch, teleport only), the right stick snap-turns 30° and, held forward, aims a teleport arc that the sim walks you along behind a blink; a vignette narrows the view while you move (watch toggle). A/X jump, a trigger uses or fires where that controller points (held, it puts down what you carry), the right grip on a pickup walks you to it and a flick as you let go throws it where the world has a throw, B/Y mute. At the wheel the left stick steers from the seat, the right trigger boosts and the left trigger gets out. Hold the left grip and say a world to build it (where the browser can't listen, as in the Quest browser, the grip opens prompt chips), and watch it rise from where its reveal is seen. Every one of these reaches the simulation as the same quantised stick and button input the keyboard gives, so a VR run replays exactly. Tested on an emulated Quest 3 (IWER), not yet on a real headset.

## What is in the box

| Part | What it does |
|---|---|
| `packages/ir` | IR v1: the typed world document (Valibot), spec hash (SHA-256 over canonical JSON, cosmetics stripped), streaming JSONL fill parser with repairs and synonyms, patch merge |
| `packages/sim` | Deterministic 60 Hz simulation on `@dimforge/rapier3d-deterministic`: character controllers (on foot, at the wheel, a jetpack's thrust-limited flight, the zero-g thrust law below 0.05 g, swimming with a breath), carry, tags, triggers, rule cascades, kit verbs, respawns |
| `packages/kits` | Verb plugins: switch, pressure plate, lock and key, collectible, checkpoint, portal, timer, hazard, crumbling floor, wind, jump pad, inspect, throw, shove, shoot (spells, blasters, bows, claws), hit points, fly (a jetpack, wings or a suit: hold jump to climb, C to dive, landing refuels) and swim (water volumes, one breath) (plus jump, carry, oscillate, tag) |
| `packages/bots` | NPCs that play their typed menu options (attack, defend, intercept, follow, patrol) on navmesh paths |
| `packages/packs/*` | Layout packs: city block, floor plan (with doorways), arena, maze, outdoor, obstacle course, and volume (floating sky islands crossed with a jetpack, a lagoon with a sunken ship to dive to, a space station in zero-g); each tested over 50 seeds |
| `packages/layout` | The placer and its logged repairs (verbs implied by kinds, collections, door placement, footprints, win fallbacks…) |
| `packages/proof` | The proof ladder T0–T3, the tour proof for places, issues for the repair loop, planted bugs for "Try to fool it" |
| `packages/llm` | Prompts and a streaming client for the intent and fill models |
| `apps/web` | three.js r186 (WebGPU with WebGL2 fallback) client: eleven looks picked from what the AI wrote (neon city, grove, gallery, desert, snow, space station, haunted, medieval, candy, jungle, home, with sub-styles such as beach, moon, ice cave, wizard school, tea house), HUD, receipt, X-ray, share, touch, VR |
| `apps/edge-api` | Cloudflare Worker: governed `/v1/build`, `/v1/edit` and `/v1/repair` (spend caps per session, IP and pool; fails closed), Turnstile and judge-token gate, share store |
| `apps/cli` | `ghostrun verify`, `build`, `bench`, `rebench [--repair]`, `edits`, `trust` (the eval table), `fool` (planted bugs), `diagnose` (one world taken apart), `gallery-add` |
| `tools/detcheck` | Cross-runtime determinism check |

## Determinism

The same world and the same inputs give the same state hash everywhere, so a proof run in one place holds for the game in another and share links replay exactly. `pnpm det:quick` runs the organizer's CTF brief, with its bots, for 2,000 ticks on five runtimes:

| Runtime | Node 26 | workerd | Chromium 156 | Firefox 157 | WebKit 27.2 |
|---|---|---|---|---|---|
| CTF state / event-log hash | `becbbeec` / `d9881845` | same | same | same | same |

A zombie horde fought with a blaster (shots marched tick by tick, hit points, armed bots firing back) runs alongside it: `7d1e9553` / `0357af80`, with the same 26 shots, 18 hits and 3 knock-outs on all five.

Simulation-path code avoids anything engines may compute differently (no `**`, no transcendental `Math`, no clocks or `Math.random`); a lint test enforces it.

## Numbers so far (internal, honest)

- **Prompt to playable:** 2.1 s in one measured live run (intent 0.84 s, fill 1.2 s, build 0.04 s, shader compile 0.1 s), headless Chromium on an Apple M5 development machine. Not yet measured on judges' devices.
- **Live robustness:** 302 live prompts from eighteen internal prompt sets (239 games and 63 places to explore), their worlds committed in `tools/bench/worlds` with the results recorded when the live lane built them, re-proved by `ghostrun trust`. Three prompts failed on the live lane before their worlds were recorded (one crashed the proof, since fixed; two hit the provider's rate limit, which the client now retries) and still count as lost. **Games:** AI runners win (at least 10 of 12 runs) **153 of 239 on the first pass (64%) and 231 with today's code (97%)**, before the live repair loop runs. **Places** are proved by a tour (an AI visitor walks to and uses every exhibit): **44 of 63 fully toured on the first pass, all 63 with today's code**. The first-pass columns are the honest robustness numbers. The newest sets were benched live before anyone looked at them, each after every earlier set had been fixed: **8 of 14, 8 of 14, 13 of 19, 15 of 20, 19 of 23, 6 of 8, 15 of 21**, the last being the organizer's likely test prompts (their capture-the-flag brief, capture zones with a timer, a parkour time trial, a Feng Shui room, a villa viewing) plus Czech, French, Polish, Spanish and Italian prompts. When fights and vehicles arrived they were benched the same way and fell short at first: **fights 8 of 12, races 0 of 10** (races were laid on packs with no road). After fixes, fresh fills of the same prompts gave **9 of 12 and 8 of 10**, and a new mixed set (rooftop chases, a tank battle, heists, a scooter delivery, a German maze, places to visit) **14 of 17 games, 3 of 3 places**. Earlier tuned worlds read higher than new fills of the same prompts, which is why the table in **Why trust this?** is generated from the committed sets rather than written by hand. Prompt to playable had a median of 1.5 to 5.6 s per set.
- **Try to fool it:** `ghostrun fool` plants bugs that break the game (the goal 40 m up, the thing the win needs gone, a condition nothing can meet, a 5-second countdown, no jumping on a course, a harmless weapon, a target that can't be hurt, a race gate hung off the track, more laps than the clock allows) in every committed world the proof says is won: **607 planted in 220 worlds, 607 caught** (274 by the static check, 73 by the jump, range and drive models, 260 by the AI runners). Any receipt has a "Try to fool it" button that plants one in a copy of the world you're looking at.
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
ANTHROPIC_API_KEY=...   # optional: Claude Haiku answers when the fast lane is busy or down
```

The dev server runs the real edge handler in-process; keys never reach the browser. Either key alone is enough to build.

```bash
pnpm gate                                # typecheck, unit tests, 5-runtime determinism check
pnpm --filter @ghostrun/web e2e          # browser tests (Chromium, WebGL2, phone and emulated VR)
pnpm --filter @ghostrun/edge-api test:workerd   # the spend governor under real workerd
```

Controls: WASD to move, Space to jump (press again in the air to double jump), F to use (throw, shove, flip, unlock), Q/E or drag to turn the camera, P for the receipt, X for the Logic X-ray, T to talk to a character, G for the gallery, M for sound (voices included). The mic in the prompt bar speaks a world, and the picture button beside it (or a pasted or dropped image) builds one inspired by a photo or sketch, with or without words; the mic in the talk box speaks to a character while you hold it.

## AI use

- **At runtime:** an intent model (Qwen3.8-27B) and a fill/repair model (gpt-oss-120b), both open-weight Apache-2.0 models served by Cerebras. They write the world as typed data; they never write code that runs. Everything they produce is validated, repaired deterministically where possible, and proved before it is trusted.
- **The rung below:** when that lane is busy, down or out of credit before it has written anything, the same request goes to Claude Haiku 5.5 (Anthropic), and the build says which model answered. Its worlds go through the same proof. NPC minds and the Host run on Haiku first.
- **Inspired by a picture:** a photo or sketch in the prompt bar (the picture button, a paste, a drop, or the camera on a phone) is shrunk and stripped of its metadata in the browser, then read once by Claude Haiku 5.5 into a short scene brief: the place, its mood and colours, the things in it, the shape of the space. The brief joins your words and the fast lane writes the world from them, so it is inspired by the picture, not a reconstruction of it. The picture is never cached or stored; a shared world keeps only the brief's words.
- **The Director's cut:** Claude Sonnet 5.5 reworks the first world you build (or any world, on "surprise me") into a fuller version of your prompt. It is re-proved while you play and offered only if it plays at least as well; Sonnet also takes a repair the fast lane couldn't finish.
- **Building it:** the code was written with Claude Code (Anthropic), directed and reviewed by the author.

## Licence and credits

MIT (see `LICENSE`). Third-party components: three.js (MIT), Rapier (Apache-2.0), recast-navigation-js (MIT) with Recast/Detour (Zlib), React (MIT), Valibot (MIT), Vite (MIT), Playwright (Apache-2.0, tests), workerd (Apache-2.0, tests), IWER (MIT, emulated-VR tests only). Every shipped component, its version and its licence text is in `THIRD_PARTY_NOTICES.md`, generated from the production dependency tree by `node tools/notices/build.mjs` (it refuses any licence outside MIT, Apache-2.0, BSD, ISC, CC0 and Zlib).

3D models: characters, their animations and props from KayKit by Kay Lousberg (www.kaylousberg.com), CC0 1.0: the Adventurers and Skeletons character packs, Dungeon Remastered, Furniture Bits, Halloween Bits, Prototype Bits, City Builder Bits and the Medieval Hexagon Pack, from KayKit's own repositories. `apps/web/public/models/provenance.json` lists every file, the pack and path it came from and what was cut; `tools/models/build.mjs` rebuilds them with glTF Transform (MIT, build only). They are decoded with the meshoptimizer decoder (MIT) that ships with three.js.
