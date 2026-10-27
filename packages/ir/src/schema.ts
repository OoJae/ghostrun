// IR v1: the typed world document every lane (fill, edits, proof, runtime, export) shares.
// Flat and non-recursive: arrays of records that reference each other by Sid.
import * as v from "valibot";
import {
  ACTS, BODIES, COND_OPS, EFFECTS, ENTITY_KINDS, LAYERS, MODES, PROPS, ROLES, SHAPES, SRC,
  STATE_TYPES, STATIC_SHAPES, SURFACES, TEAMS, TRIGGERS, WEATHER,
} from "./vocab";

export const IR_VERSION = 1 as const;

export const Sid = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,31}$/, "ids are lower_snake, ≤32 chars"));
export type Sid = v.InferOutput<typeof Sid>;

const lit = v.union([v.string(), v.number(), v.boolean()]);
export type Lit = v.InferOutput<typeof lit>;
const vec3 = v.tuple([v.number(), v.number(), v.number()]);
export type Vec3 = v.InferOutput<typeof vec3>;
const num = v.pipe(v.number(), v.finite());

const meta = {
  id: Sid,
  src: v.picklist(SRC),
  layer: v.picklist(LAYERS),
};

export const Zone = v.strictObject({
  ...meta,
  pack: v.string(),
  slot: v.string(),
  tag: v.string(),
  name: v.string(), // display text, not hashed
  parent: v.string(), // '' = root
});

export const Static = v.strictObject({
  ...meta,
  zone: Sid,
  shape: v.picklist(STATIC_SHAPES),
  pos: vec3,
  rotY: num,
  size: vec3,
  surf: v.picklist(SURFACES),
});

export const Entity = v.strictObject({
  ...meta,
  kind: v.picklist(ENTITY_KINDS),
  zone: Sid,
  anchor: v.string(), // pack slot the placer resolves into pos
  pos: vec3,
  rotY: num,
  size: vec3,
  noun: v.string(),
  hyper: v.string(),
  asset: v.string(), // resolved kit/hero asset id, not hashed
  body: v.picklist(BODIES),
  shape: v.picklist(SHAPES),
  team: v.picklist(TEAMS),
  tags: v.array(v.string()),
  states: v.array(v.string()),
  init: v.string(),
  props: v.record(v.string(), lit),
});

export const Trigger = v.strictObject({
  t: v.picklist(TRIGGERS),
  a: v.string(),
  b: v.string(),
  s: v.string(), // state value for state_is
  n: num, // threshold or seconds
  act: v.picklist(["", ...ACTS]),
});

export const Cond = v.strictObject({
  l: v.string(), // path, e.g. "orb.carrier.team"
  op: v.picklist(COND_OPS),
  r: lit,
  forS: num, // condition must hold this long (0 = instantly)
});

export const Effect = v.strictObject({
  e: v.picklist(EFFECTS),
  target: v.string(),
  v: lit,
  n: num,
  fx: v.string(),
});

export const Rule = v.strictObject({
  ...meta,
  when: Trigger,
  if: v.pipe(v.array(Cond), v.maxLength(8)),
  then: v.pipe(v.array(Effect), v.minLength(1), v.maxLength(4)),
  once: v.boolean(),
  cooldownS: num,
  prio: num,
});

export const StateVar = v.strictObject({
  ...meta,
  owner: v.string(),
  type: v.picklist(STATE_TYPES),
  values: v.array(v.string()),
  init: lit,
  min: num,
  max: num,
});

export const VerbBinding = v.strictObject({
  ...meta,
  verb: v.pipe(v.string(), v.regex(/^[a-z_]+\.[a-z_]+$/, "verbs are kit.verb")),
  on: v.string(),
  params: v.record(v.string(), lit),
  signature: v.boolean(), // the one per-world signature mechanic
});

/** AI Hub's six persona fields. Prose only: never hashed, never read by the simulation. */
export const Persona = v.strictObject({
  identity: v.string(),
  personality: v.string(),
  knowledge: v.string(),
  replyStyle: v.string(),
  tools: v.array(v.string()),
  safety: v.string(),
});

export const Cast = v.strictObject({
  ...meta,
  npc: Sid,
  role: v.picklist(ROLES),
  minded: v.boolean(),
  persona: Persona,
  coneDeg: num,
  rangeM: num,
  hearM: num,
  menu: v.pipe(v.array(v.string()), v.maxLength(8)),
  dflt: v.string(),
  utility: v.record(v.string(), num),
  memory: num,
});

export const Laws = v.strictObject({
  gravityScale: num,
  jumpH: num,
  speed: num,
  jumpsMax: num,
  airControl: num,
  coyoteMs: num,
  bufferMs: num,
  thrust: num,
});
export type Laws = v.InferOutput<typeof Laws>;

export const Expect = v.strictObject({
  ...meta,
  prop: v.picklist(PROPS),
  a: v.string(),
  b: v.string(),
  need: v.array(v.string()), // e.g. "jumps>=2"
  lo: num,
  hi: num,
  headline: v.boolean(), // the prompt-specific property the receipt leads with
  text: v.string(), // display text, not hashed
});

export const DressItem = v.strictObject({
  id: Sid,
  noun: v.string(),
  zone: Sid,
  anchor: v.string(),
  asset: v.string(),
});

export const Poster = v.strictObject({
  id: Sid,
  prompt: v.string(),
  zone: Sid,
  url: v.string(),
});

/** Cosmetic layer: may stream after handover, never hashed, never read by the simulation. */
export const Cosmetic = v.strictObject({
  look: v.string(),
  mood: vec3, // valence, arousal, tension in [-1, 1]
  timeOfDay: num, // hours 0–24
  weather: v.picklist(WEATHER),
  dress: v.array(DressItem),
  posters: v.pipe(v.array(Poster), v.maxLength(4)),
});

export const PackRef = v.strictObject({
  id: v.string(),
  version: v.string(),
  seed: num,
  params: v.record(v.string(), lit),
  sub: v.pipe(v.array(v.string()), v.maxLength(3)),
});

export const WorldBundle = v.strictObject({
  v: v.literal(IR_VERSION),
  engine: v.string(),
  seed: num,
  mode: v.picklist(MODES),
  lang: v.string(),
  pack: PackRef,
  laws: Laws,
  zones: v.array(Zone),
  statics: v.array(Static),
  entities: v.array(Entity),
  verbs: v.array(VerbBinding),
  rules: v.array(Rule),
  states: v.array(StateVar),
  cast: v.array(Cast),
  expects: v.array(Expect),
  cosmetic: Cosmetic,
});

export type Zone = v.InferOutput<typeof Zone>;
export type Static = v.InferOutput<typeof Static>;
export type Entity = v.InferOutput<typeof Entity>;
export type Trigger = v.InferOutput<typeof Trigger>;
export type Cond = v.InferOutput<typeof Cond>;
export type Effect = v.InferOutput<typeof Effect>;
export type Rule = v.InferOutput<typeof Rule>;
export type StateVar = v.InferOutput<typeof StateVar>;
export type VerbBinding = v.InferOutput<typeof VerbBinding>;
export type Persona = v.InferOutput<typeof Persona>;
export type Cast = v.InferOutput<typeof Cast>;
export type Expect = v.InferOutput<typeof Expect>;
export type Cosmetic = v.InferOutput<typeof Cosmetic>;
export type WorldBundle = v.InferOutput<typeof WorldBundle>;

/** Collections addressable by id in patches, in canonical order. */
export const COLLECTIONS = ["zones", "statics", "entities", "verbs", "rules", "states", "cast", "expects"] as const;
export type Collection = (typeof COLLECTIONS)[number];
export const RECORD_SCHEMAS = {
  zones: Zone,
  statics: Static,
  entities: Entity,
  verbs: VerbBinding,
  rules: Rule,
  states: StateVar,
  cast: Cast,
  expects: Expect,
} as const satisfies Record<Collection, v.GenericSchema>;
