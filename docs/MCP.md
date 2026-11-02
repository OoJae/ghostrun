# GHOSTRUN over MCP

GHOSTRUN is an MCP server, so any agent can build, change and check worlds: `https://play.ghostrun.workers.dev/mcp`.

- **Transport:** Streamable HTTP, JSON-RPC 2.0, one message per POST, one JSON answer per request. Dual-era: MCP **2026-07-28** (per-request `_meta`, `server/discover`, no handshake) and the handshake revisions **2025-11-25**, **2025-06-18** and **2025-03-26** (`initialize`). No sessions: none is minted and none is needed.
- **Auth:** a GHOSTRUN judge or dev token, as `Authorization: Bearer <token>`. A client that can't set headers may put it in the URL instead (`/mcp?t=<token>`); treat that URL as a secret. Without a token every request is `401`.
- **Spend:** the tools build and edit through the web app's own routes, so the same spend governor and caps apply (each judge token has its own spending cap, $0.60 on production). On top: 120 requests and 20 builds or edits per token per 10 minutes. An exact repeat of a prompt and seed replays from the build cache for free.

## Connect

**Claude Code**

```bash
claude mcp add --transport http ghostrun https://play.ghostrun.workers.dev/mcp --header "Authorization: Bearer <token>"
```

Then ask for a world ("build me a capture-the-flag world in a neon city with double jump"), or `/mcp` to see the tools.

**claude.ai and Claude Desktop (custom connector).** Settings → Connectors → Add custom connector, with the URL `https://play.ghostrun.workers.dev/mcp?t=<token>` (connectors can't send a header, so the token rides in the URL). In Claude Desktop's `claude_desktop_config.json` you can send the header instead, through `mcp-remote`:

```json
{
  "mcpServers": {
    "ghostrun": {
      "command": "npx",
      "args": ["mcp-remote", "https://play.ghostrun.workers.dev/mcp", "--header", "Authorization:${GHOSTRUN_AUTH}"],
      "env": { "GHOSTRUN_AUTH": "Bearer <token>" }
    }
  }
}
```

**Other clients.** Anything that speaks Streamable HTTP: give it the URL and the `Authorization` header. VS Code (`.vscode/mcp.json`): `{"servers": {"ghostrun": {"type": "http", "url": "https://play.ghostrun.workers.dev/mcp", "headers": {"Authorization": "Bearer <token>"}}}}`. Cursor (`~/.cursor/mcp.json`): `{"mcpServers": {"ghostrun": {"url": "https://play.ghostrun.workers.dev/mcp", "headers": {"Authorization": "Bearer <token>"}}}}`. MCP Inspector: transport Streamable HTTP, the URL, and the header. A browser-based client on another origin must be on the Worker's `MCP_ORIGINS` list.

**Locally:** `pnpm --filter @ghostrun/web dev` serves `http://localhost:5173/mcp` with the real handler; with `DEV_OPEN` (the dev server sets it) localhost needs no token.

## Tools

| Tool | Arguments | What it does |
|---|---|---|
| `build_world` | `prompt`, `seed?` | Builds a world with the live AI: the intent, the rules as WHEN / IF / THEN sentences, the promises, a share link to play it, and the proof |
| `edit_world` | `world`, `change` | Changes a world in plain words ("only one jump"): patched by stable ids, re-placed, re-checked; what changed, how the receipt moved, and a new link (a remix that says where it came from) |
| `explain_world` | `world` | The Logic X-ray in text: rules, verbs, promises and what was proved about each |
| `get_receipt` | `world` | The receipt in honest labels: the headline, every check with its tier, method and counts |
| `list_gallery` | none | The 62 recorded gallery worlds, with their slugs and links |

`world` is a share id (16 letters, from `build_world` or `edit_world`), a play link (`?s=<id>` or `?g=<slug>`), or a gallery slug. Every tool answers in text and as `structuredContent` matching its `outputSchema`; a failure (a cap, a refusal, bad arguments) is a tool result with `isError: true` that says why.

**What is proved where.** The edge has no physics, so it runs the static rungs of the proof: T0 (every rule references something real; the win regresses through the rule graph) and T1 (jump, reach, range and drive models). T2 (each rule forced and checked) and T3 (AI runners in the deterministic simulation) run when the link is opened, on whoever opens it, and the receipt says so. When the cloud proof route (`POST /v1/proof`) answers for a world's spec, its full receipt is used instead (`proof.source: "cloud"`).

## Example

```json
{"jsonrpc": "2.0", "id": 1, "method": "tools/call",
 "params": {"name": "build_world", "arguments": {"prompt": "Capture the flag in a neon city. Add double jump. Score when the orb reaches the goal.", "seed": 7}}}
```

The text it returns (the structured content says the same, field by field):

```
Built: Rooftop lane needs double jump (ctf · city_block · a game, seed 7).
Intent: neon city. Goal: carry the orb home. Fail: lose the orb. You play: runner.
Play it: https://play.ghostrun.workers.dev/?s=vgo7wn3pc3oinj4x  (world vgo7wn3pc3oinj4x)

Rules (WHEN / IF / THEN; ✓ proved, ✗ counterexample, · no forced-state test yet):
- · WHEN glowing orb is picked up by player THEN glowing orb becomes carried, ✨ sparkle
- · WHEN glowing orb enters neon goal ring IF glowing orb carrier team = red THEN +1 red team, reset glowing orb
- · WHEN glowing orb enters neon goal ring IF glowing orb carrier team = blue THEN +1 blue team, reset glowing orb
- · WHEN red team reaches 3 THEN you win (once)
- · WHEN blue team reaches 3 THEN you lose (once)
★ 5 secret neon shards: WHEN you touch one THEN it sparkles (once). They count apart from the win.
Verbs:
- glowing orb: physics_props.carry (on an item entity: an agent picks it up by touching it and carries it)
- hover platform: motion_hazards.oscillate (on a platform: moves back and forth)
Promises (expectations):
- [headline] Rooftop lane needs double jump: verified
- Red can score and win: verified
- Red vs blue is fair: not checked here

Receipt for spec 93f92a1f · static checks at the edge (T0 rule graph, T1 kinematic models) · 4 ms
Headline: Rooftop lane needs double jump: verified (kinematic reachability (jump apex model))
✓ [T0] all 10 rules reference existing things  (static def-use)
✓ [T0] win ← r_win (team:red reaches 3) ← r_score_red (orb into goal_red, carried by red) ← pick up orb  (static goal regression over rules)
✓ [T1] Rooftop lane needs double jump  (kinematic reachability (jump apex model), AI-written rule)
Not proved here: T2 (each rule forced and checked) and T3 (AI runners in the physics simulation) need the simulation, so AI runners prove it when you open the link.
```

Then `edit_world {"world": "vgo7wn3pc3oinj4x", "change": "super high jumps"}` answers with what changed and how the receipt moved, and links the new version (a remix of the first):

```
What changed: jump height 1.6 → 3.4 m
Receipt: Headline verified → counterexample · Counterexamples 0 → 1 (static checks; AI runners re-prove it on the new link)
New failures: Rooftop lane needs double jump — reachable with 1 jump: step 2.6 m ≤ apex 3.2 m
```

With curl, a 2026-07-28 request carries its version in `_meta` and mirrors it, the method and the tool name into headers:

```bash
curl -s https://play.ghostrun.workers.dev/mcp \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/call" -H "Mcp-Name: list_gallery" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_gallery","arguments":{},
       "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

Errors follow the spec: `-32700` unreadable JSON, `-32600` not a JSON-RPC request (batches included), `-32601` unknown method (`404` in 2026-07-28), `-32602` bad params or an unknown tool, `-32020` headers that disagree with the body, `-32022` an unsupported version (with the `supported` list), and `-31429` for this endpoint's own rate limit (`429`, `Retry-After`).
