// Closed vocabularies of the world IR. They map onto Victoria VR's "triggers, states and
// rules/conditions" logic blocks (docs/strategy/SPEC.md §logic model). Extending one is an IR
// version bump, because they feed the spec hash and the LLM wire schemas.

export const ORIGINS = ["user", "ai-fill", "ai-repair", "host", "npc", "ai-director", "sonnet"] as const;
export type Origin = (typeof ORIGINS)[number];
/** Origins the AI drives; they may never write /expects or /meta. */
export const AI_ORIGINS: readonly Origin[] = ["ai-fill", "ai-repair", "host", "npc", "ai-director", "sonnet"];

export const SRC = ["template", "ai", "user"] as const;
export const LAYERS = ["gameplay", "cosmetic"] as const;
export const MODES = ["play", "wander"] as const;

export const ENTITY_KINDS = [
  "prop", "pickup", "goal", "spawn", "checkpoint", "door", "switch",
  "plate", "hazard", "platform", "vehicle", "npc", "portal", "sign",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const BODIES = ["none", "fixed", "kinematic", "dynamic", "sensor"] as const;
export const SHAPES = ["none", "box", "capsule", "sphere", "hull"] as const;
export const STATIC_SHAPES = ["box", "hull", "heightfield", "ramp"] as const;
export const SURFACES = ["floor", "wall", "ledge", "roof", "glass", "water", "hazard"] as const;
export const TEAMS = ["", "red", "blue"] as const;

export const TRIGGERS = [
  "enter", "exit", "touch", "pickup", "drop", "seen_by", "heard", "hit", "health_lte",
  "timer_end", "state_is", "score_gte", "lap_done", "spoken", "every",
] as const;
export type TriggerKind = (typeof TRIGGERS)[number];

export const EFFECTS = [
  "score", "win", "lose", "spawn", "destroy", "open", "close", "teleport", "set_state", "give",
  "take", "tween", "move_to", "apply_impulse", "attach", "carry", "damage", "heal", "emit",
  "next_level", "book_slot", "checkout", "say", "reset",
] as const;
export type EffectKind = (typeof EFFECTS)[number];

export const COND_OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "has", "in"] as const;

/** Speech acts: a closed enum; consequential ones (pay, book, buy) need a confirm chip. */
export const ACTS = ["ask", "command", "offer", "buy", "pay", "book"] as const;
export type Act = (typeof ACTS)[number];

/** A watcher in this state sees nothing: what a bribe buys, for as long as the rule says. */
export const LOOK_AWAY = "look_away";

export const ROLES = ["guard", "merchant", "guide", "rival", "teammate", "creature", "citizen"] as const;
export type Role = (typeof ROLES)[number];

export const PROPS = [
  "win_reachable", "no_softlock", "reachable", "unreachable", "requires", "rule_fires",
  "completion_band", "par_gte", "slack_gte", "fair_teams", "radius_reachable", "life_contract",
] as const;
export type PropKind = (typeof PROPS)[number];

export const STATE_TYPES = ["enum", "int", "float", "bool"] as const;
export const WEATHER = ["clear", "rain", "snow", "fog", "storm"] as const;

/** Rule-target references beyond plain ids. */
export const SPECIAL_REFS = ["player", "global", "team:red", "team:blue"] as const;
