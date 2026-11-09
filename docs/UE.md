# From GHOSTRUN's export to Unreal Engine 5.7: StateTree and GameplayTags

GHOSTRUN exports a world as three files (receipt → **Export** in the app):

- `<world>.glb`: the geometry, one glTF node per static and per entity, each **named by its id** (`orb`, `goal_red`, `pad_mid`), with `extras` saying what it is (`ghostrun: "entity"`, `kind`, `noun`, `zone`, `team`, `body`, `verbs`; statics carry `surface` and `zone`).
- `<world>.logic.json`: the logic, format `ghostrun.logic/1`: entities with their **states**, the verbs on them, the **rules** (each a trigger, conditions and effects, as a sentence and as data, with its proof status), the characters' behaviour menus, the expectations, and the receipt.
- `<world>.report.html`: the playtest report (for people, not engines).

This document says how `logic.json`'s triggers, states and rules are **designed to map onto** Unreal Engine 5.7's StateTree and GameplayTags, with one worked sample: the organizer's capture-the-flag brief.

## What has and hasn't been tested

Be clear about this before relying on anything below:

- **No import has been tested in Unreal Engine here.** We have not opened the `.glb` in UE 5.7, have not built the StateTrees or tag tables below in an editor, and have not run them. This is a mapping design, checked only against our own exporter's output.
- glTF import through **Interchange** is a standard UE path, but it is **untested by us** for these files. Nodes keep their names in glTF, so entities should arrive as actors or static meshes named by id; whether `extras` survive as metadata depends on the importer settings and is unverified.
- The GameplayTag names (`GR.*`) are a proposal, not something UE or any plugin defines.
- What *is* tested: the sample `logic.json` ([docs/ue/ctf-neon.logic.json](ue/ctf-neon.logic.json)) is exactly what the exporter writes for the fixture today. `apps/web/test/ue-sample.test.ts` regenerates it (built and proved in Node, as the app does) and fails if it drifts.

## Units and axes

`logic.json` and the `.glb` are in **metres and seconds, y up** (glTF's convention). Unreal is centimetres, z up. The glTF importer converts the meshes; for positions, read each entity's transform from its imported node (found by id) rather than converting `logic.json`'s `position` by hand, so logic and meshes can never disagree. Lengths in rules and laws scale by 100 (m → cm).

## The mapping

### States → GameplayTags, and a StateTree per stateful entity

`entities[].states` and `entities[].initial` (e.g. the orb: `home`, `carried`, `dropped`, initially `home`):

| logic.json | Unreal |
| --- | --- |
| an entity's current state `s` | the actor holds exactly one tag `GR.State.<s>` (in its tag container, or as the active state of its own StateTree) |
| `initial` | the tag applied at BeginPlay / the StateTree's first state |
| an entity with two or more states | a small StateTree whose states are its states; rules that `set_state` or `reset` it send it an event |
| `team` | tag `GR.Team.Red` / `GR.Team.Blue` |
| `kind` (`goal`, `pickup`, `platform`, `npc`, …) | tag `GR.Kind.<Kind>` (useful for overlap filters) |
| `body: "sensor"` | a trigger volume (overlap only, no collision response) |

### Triggers → StateTree events (a GameplayTag plus a payload)

Each rule's `when` becomes a **StateTree event** sent by gameplay code, its tag naming the trigger and its payload carrying `a`, `b` and `n`. A transition listens for that event tag and checks the payload:

| `when.t` | sent when | event tag |
| --- | --- | --- |
| `enter` / `exit` | actor `a` begins / ends overlapping sensor `b` | `GR.Event.Enter` / `GR.Event.Exit` |
| `pickup` | `b` picks up item `a` | `GR.Event.Pickup` |
| `touch` | `a` touches `b` | `GR.Event.Touch` |
| `hit` | `a` is hit by `b` | `GR.Event.Hit` |
| `state_is` | entity `a` gains `GR.State.<s>` | `GR.Event.StateIs` |
| `health_lte` | `a`'s health drops to `n` or below | `GR.Event.HealthLte` |
| `timer_end` | the timer bound on `a` runs out | `GR.Event.TimerEnd` |
| `lap_done` | `a` completes a lap on line `b` | `GR.Event.LapDone` |
| `score_gte` | team `a`'s score reaches `n` | `GR.Event.ScoreGte` |
| `every` | every `n` seconds | a delay task in the listening state, not an event |
| `spoken` | the player says `act` to NPC `a` | `GR.Event.Spoken.<Act>` |
| `seen_by` | NPC `b` sees `a` | `GR.Event.SeenBy` |

### Conditions → transition conditions

`rule.if` entries become conditions on the transition:

| path | condition |
| --- | --- |
| `<id>.team eq red` | actor `<id>` has tag `GR.Team.Red` |
| `<id>.state eq open` | actor `<id>` has tag `GR.State.Open` |
| `<id>.carrier.team eq red` | the actor carrying `<id>` has `GR.Team.Red` (a small custom condition: find the carrier, test its tag) |
| `<id>.hp`, `player.coins` | a numeric compare on that attribute |
| `team:red.score` | a numeric compare on the team's score (on the GameState) |
| `forS` > 0 | the condition must have held for that long (a timer in the condition) |

### Effects → StateTree tasks

`rule.then` entries become tasks run in the state the transition enters, which completes and returns:

| effect | task |
| --- | --- |
| `score` | add `n` to the team's score, then send `GR.Event.ScoreGte` if a threshold is crossed |
| `win` / `lose` | transition to the world tree's `Won` (Succeeded) / `Lost` (Failed) state |
| `set_state` | send the entity's own tree an event that moves it to `v` (for `n` seconds, else for good) |
| `reset` | move the entity back to its start transform and initial state |
| `emit` | a GameplayCue `GameplayCue.GR.<Fx>` on the target (a Niagara effect) |
| `destroy`, `open` / `close`, `teleport` | destroy the actor; play the door's open / close; set its transform to entity `v`'s |
| `damage` / `heal`, `give` / `take` | a GameplayEffect on the attribute; add or remove inventory |
| `book_slot` | out of scope for an engine (in GHOSTRUN it writes a calendar file) |

`once: true` → the transition is gated by a tag `GR.Rule.<id>.Fired` the task adds. `cooldownS` → a condition on the time since that rule last fired.

### Verbs, laws and characters

- **Verbs** are the kits' behaviours, not rules: `locomotion.jump {jumpsMax}` → the character's `JumpMaxCount`; `physics_props.carry` → a carry ability on whoever touches the item; `combat_sport.tag_drop` → an ability that knocks the item loose (the orb's `dropped` state comes from this verb, not from a rule); `motion_hazards.oscillate {axis, travel, period}` → a platform moving back and forth (an interpolation component or a timeline).
- **Laws** → the character movement component: `speed` 6 m/s → max walk speed 600 cm/s; `jumpH` 1.6 m → jump velocity √(2·g·h) = √(2 · 980 · 160) ≈ 560 cm/s at default gravity (scaled by `gravityScale`); `airControl` 0.6 → air control 0.6 (the two engines may not mean exactly the same by it); `coyoteMs` and `bufferMs` have no built-in counterpart and would be custom.
- **Characters** (`npcs[]`): one StateTree per character whose top-level states are its `menu` (`teammate.defend`, `teammate.attack`, `teammate.follow`), entered at `default`.
- **Expectations** (`expectations[]`) are not runtime logic: they are what GHOSTRUN's proof checked, and would become automated tests (e.g. a functional test that with one jump the rooftop lane can't be reached, and with two it can).

## Worked sample: the capture-the-flag brief

The organizer's brief, *"Create a capture-the-flag game in a neon city. Add double jump. Score when the orb reaches the goal."*, is the fixture [`packages/ir/fixtures/ctf-neon.jsonl`](../packages/ir/fixtures/ctf-neon.jsonl). Its export is [`docs/ue/ctf-neon.logic.json`](ue/ctf-neon.logic.json) (spec `93f92a1f…`; every rule `verified`, headline *Rooftop lane needs double jump: verified*, 12 of 12 AI runners won).

### 1. The fill (what the AI wrote, abridged)

```jsonl
{"op":"ent","id":"orb","kind":"pickup","noun":"glowing orb","body":"dynamic","states":["home","carried","dropped"],"init":"home"}
{"op":"verb","id":"vb_jump","verb":"locomotion.jump","on":"player","params":{"jumpsMax":2}}
{"op":"verb","id":"vb_carry","verb":"physics_props.carry","on":"orb","params":{"speedMul":0.85}}
{"op":"verb","id":"vb_tag","verb":"combat_sport.tag_drop","on":"player","params":{"radius":1.2}}
{"op":"rule","id":"r_pickup","when":{"t":"pickup","a":"orb","b":"player"},"then":[{"e":"set_state","target":"orb","v":"carried"},{"e":"emit","target":"orb","fx":"sparkle"}]}
{"op":"rule","id":"r_score_red","when":{"t":"enter","a":"orb","b":"goal_red"},"if":[{"l":"orb.carrier.team","op":"eq","r":"red"}],"then":[{"e":"score","target":"team:red","n":1},{"e":"reset","target":"orb"}]}
{"op":"rule","id":"r_win","when":{"t":"score_gte","a":"team:red","n":3},"then":[{"e":"win","target":"player"}],"once":true}
```

(plus `r_score_blue` and `r_lose` mirroring them, and five secret neon shards the placer adds, each `WHEN player touches neon shard THEN effect sparkle (once)`).

### 2. Its logic.json (abridged from the committed file)

```json
{
  "format": "ghostrun.logic/1",
  "world": { "mode": "play", "pack": "city_block", "seed": 7, "laws": { "speed": 6, "jumpH": 1.6, "jumpsMax": 2, "airControl": 0.6, "gravityScale": 1 } },
  "entities": [
    { "id": "orb", "kind": "pickup", "noun": "glowing orb", "body": "dynamic", "states": ["home", "carried", "dropped"], "initial": "home" },
    { "id": "goal_red", "kind": "goal", "noun": "neon goal ring", "team": "red", "body": "sensor" },
    { "id": "goal_blue", "kind": "goal", "noun": "neon goal ring", "team": "blue", "body": "sensor" }
  ],
  "rules": [
    { "id": "r_score_red", "text": "WHEN glowing orb enters neon goal ring IF glowing orb carrier team eq red THEN +1 red team, reset glowing orb",
      "when": { "t": "enter", "a": "orb", "b": "goal_red" }, "if": [{ "l": "orb.carrier.team", "op": "eq", "r": "red" }],
      "then": [{ "e": "score", "target": "team:red", "n": 1 }, { "e": "reset", "target": "orb" }], "once": false, "proof": "verified" },
    { "id": "r_win", "text": "WHEN red team reaches 3 THEN you win (once)", "when": { "t": "score_gte", "a": "team:red", "n": 3 },
      "then": [{ "e": "win", "target": "player" }], "once": true, "proof": "verified" }
  ]
}
```

### 3. The GameplayTags it needs

```ini
; Config/DefaultGameplayTags.ini (proposed)
+GameplayTagList=(Tag="GR.Team.Red")
+GameplayTagList=(Tag="GR.Team.Blue")
+GameplayTagList=(Tag="GR.Kind.Goal")
+GameplayTagList=(Tag="GR.Kind.Pickup")
+GameplayTagList=(Tag="GR.State.Home")
+GameplayTagList=(Tag="GR.State.Carried")
+GameplayTagList=(Tag="GR.State.Dropped")
+GameplayTagList=(Tag="GR.Event.Pickup")
+GameplayTagList=(Tag="GR.Event.Enter")
+GameplayTagList=(Tag="GR.Event.Touch")
+GameplayTagList=(Tag="GR.Event.ScoreGte")
+GameplayTagList=(Tag="GR.Event.Reset")
+GameplayTagList=(Tag="GR.Event.TagDrop")
+GameplayTagList=(Tag="GR.Rule.r_win.Fired")
+GameplayTagList=(Tag="GR.Rule.r_lose.Fired")
+GameplayTagList=(Tag="GameplayCue.GR.Sparkle")
```

Actors at BeginPlay: `goal_red` gets `GR.Kind.Goal` + `GR.Team.Red`; `goal_blue` `GR.Kind.Goal` + `GR.Team.Blue`; the player and `mate_1` `GR.Team.Red`; `rival_1` and `rival_2` `GR.Team.Blue`; `orb` `GR.Kind.Pickup` + `GR.State.Home`.

### 4. The orb's StateTree (`ST_Orb`, from `states` / `initial`)

| state | entered by | tasks |
| --- | --- | --- |
| **Home** (first state) | start; `GR.Event.Reset` from any state | set tag `GR.State.Home`; move to its start transform (the `reset` effect) |
| **Carried** | `GR.Event.Pickup` from Home or Dropped (rule `r_pickup`: `set_state carried`) | set tag `GR.State.Carried`; attach to the carrier; GameplayCue `GR.Sparkle` (`emit sparkle`) |
| **Dropped** | `GR.Event.TagDrop` from Carried (the `combat_sport.tag_drop` verb, not a rule) | set tag `GR.State.Dropped`; detach, physics on |

### 5. The world's StateTree (`ST_CTF_Neon`, from `rules`)

```
Root
├─ Playing                                  (the world runs; the secrets' touch rules are handled here as tasks)
│   ├─ on GR.Event.Enter {a=orb, b=goal_red}
│   │      if the orb's carrier has GR.Team.Red          → ScoreRed      (r_score_red)
│   ├─ on GR.Event.Enter {a=orb, b=goal_blue}
│   │      if the orb's carrier has GR.Team.Blue         → ScoreBlue     (r_score_blue)
│   ├─ on GR.Event.ScoreGte {a=team:red, n=3}
│   │      if not GR.Rule.r_win.Fired                    → Won           (r_win, once)
│   └─ on GR.Event.ScoreGte {a=team:blue, n=3}
│          if not GR.Rule.r_lose.Fired                   → Lost          (r_lose, once)
├─ ScoreRed     tasks: red score += 1; send ST_Orb GR.Event.Reset      on completed → Playing
├─ ScoreBlue    tasks: blue score += 1; send ST_Orb GR.Event.Reset     on completed → Playing
├─ Won          tasks: add GR.Rule.r_win.Fired; show the win          (Succeeded)
└─ Lost         tasks: add GR.Rule.r_lose.Fired; show the loss        (Failed)
```

The score task sends `GR.Event.ScoreGte` with the new total as `n`, so the threshold transitions read it from the payload (`n >= 3`).

### 6. Movement and the headline

- `laws`: `jumpsMax 2` → `JumpMaxCount = 2`; `jumpH 1.6` m → jump velocity ≈ 560 cm/s; `speed 6` → max walk speed 600 cm/s.
- The headline expectation `x_roof` (*Rooftop lane needs double jump*, `requires jumps>=2` from `sp_red` to `z_roof`) is what GHOSTRUN proved: by the jump-apex model and 4 of 4 physics jump attempts. In Unreal it would be a functional test: with `JumpMaxCount = 1` a bot can't reach the rooftop lane, with 2 it can. Whether that holds there depends on how closely the movement settings match ours, which is untested.
