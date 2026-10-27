// Streaming parser for the fill lane: the LLM emits one JSON op per line, in a fixed order, and
// every accepted line becomes IR immediately so the world can start building while tokens arrive.
//   meta zone+ spawn+ goal? ent* verb* law* state* rule* npc* expect* sig? end(gameplay) dress* poster{0,4} end(cosmetic)
import * as v from "valibot";
import { DEFAULT_LAWS } from "./laws";
import type { Cast, Entity, Expect, Rule, StateVar, VerbBinding, WorldBundle, Zone } from "./schema";
import {
  ACTS, BODIES, COND_OPS, EFFECTS, ENTITY_KINDS, MODES, PROPS, ROLES, SHAPES, SPECIAL_REFS,
  STATE_TYPES, TEAMS, TRIGGERS, WEATHER,
} from "./vocab";

export const MAX_LINE_BYTES = 1024;
export const BUDGETS = { gameplay: 90, zone: 8, ent: 40, verb: 32, rule: 20, minded: 4, plainNpc: 8, expect: 6, dress: 40, poster: 4 } as const;

const id = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,31}$/));
const lit = v.union([v.string(), v.number(), v.boolean()]);
const vec3 = v.tuple([v.number(), v.number(), v.number()]);
const str = (d = "") => v.optional(v.string(), d);
const num = (d = 0) => v.optional(v.pipe(v.number(), v.finite()), d);

// LLM-facing op schemas: v.object drops unknown keys; optional fields get defaults.
const OpMeta = v.object({
  op: v.literal("meta"),
  mode: v.optional(v.picklist(MODES), "play"),
  lang: str("en"),
  pack: str("arena"),
  sub: v.optional(v.array(v.string()), []),
  seed: num(1),
  look: str("default"),
  mood: v.optional(vec3, [0, 0, 0]),
  timeOfDay: num(12),
  weather: v.optional(v.picklist(WEATHER), "clear"),
});
const OpZone = v.object({ op: v.literal("zone"), id, slot: str(), tag: str(), name: str(), parent: str() });
const placed = {
  id,
  zone: id,
  anchor: str(),
  noun: str(),
  hyper: str(),
  team: v.optional(v.picklist(TEAMS), ""),
  size: v.optional(vec3),
  pos: v.optional(vec3),
  rotY: num(0),
  tags: v.optional(v.array(v.string()), []),
  props: v.optional(v.record(v.string(), lit), {}),
};
const OpSpawn = v.object({ op: v.literal("spawn"), ...placed });
const OpGoal = v.object({ op: v.literal("goal"), ...placed });
const OpEnt = v.object({
  op: v.literal("ent"),
  ...placed,
  kind: v.picklist(ENTITY_KINDS),
  body: v.optional(v.picklist(BODIES), "fixed"),
  shape: v.optional(v.picklist(SHAPES), "box"),
  states: v.optional(v.array(v.string()), []),
  init: str(),
});
const OpVerb = v.object({ op: v.literal("verb"), id, verb: v.string(), on: str("player"), params: v.optional(v.record(v.string(), lit), {}) });
const OpLaw = v.object({ op: v.literal("law"), player: v.record(v.string(), v.number()) });
const OpState = v.object({
  op: v.literal("state"),
  id,
  owner: str("global"),
  type: v.picklist(STATE_TYPES),
  values: v.optional(v.array(v.string()), []),
  init: v.optional(lit, 0),
  min: num(0),
  max: num(0),
});
const Trig = v.object({ t: v.picklist(TRIGGERS), a: str(), b: str(), s: str(), n: num(0), act: v.optional(v.picklist(["", ...ACTS]), "") });
const Cnd = v.object({ l: v.string(), op: v.picklist(COND_OPS), r: lit, forS: num(0) });
const Eff = v.object({ e: v.picklist(EFFECTS), target: str(), v: v.optional(lit, ""), n: num(0), fx: str() });
const OpRule = v.object({
  op: v.literal("rule"),
  id,
  when: Trig,
  if: v.optional(v.pipe(v.array(Cnd), v.maxLength(4)), []),
  then: v.pipe(v.array(Eff), v.minLength(1), v.maxLength(4)),
  once: v.optional(v.boolean(), false),
  cooldownS: num(0),
  prio: num(0),
});
const OpNpc = v.object({
  op: v.literal("npc"),
  ...placed,
  role: v.picklist(ROLES),
  minded: v.optional(v.boolean(), false),
  persona: v.optional(
    v.object({ identity: str(), personality: str(), knowledge: str(), replyStyle: str(), tools: v.optional(v.array(v.string()), []), safety: str() }),
    {},
  ),
  menu: v.optional(v.pipe(v.array(v.string()), v.maxLength(8)), []),
  dflt: str(),
  coneDeg: num(70),
  rangeM: num(12),
  hearM: num(8),
  utility: v.optional(v.record(v.string(), v.number()), {}),
});
const OpExpect = v.object({
  op: v.literal("expect"),
  id,
  prop: v.picklist(PROPS),
  a: str(),
  b: str(),
  need: v.optional(v.array(v.string()), []),
  lo: num(0),
  hi: num(0),
  headline: v.optional(v.boolean(), false),
  text: str(),
});
const OpSig = v.object({ op: v.literal("sig"), verb: v.string(), on: str("player"), params: v.optional(v.record(v.string(), lit), {}) });
const OpEnd = v.object({ op: v.literal("end"), layer: v.picklist(["gameplay", "cosmetic"]) });
const OpDress = v.object({ op: v.literal("dress"), id, noun: v.string(), zone: id, anchor: str() });
const OpPoster = v.object({ op: v.literal("poster"), id, prompt: v.string(), zone: id });

export const FillOp = v.variant("op", [
  OpMeta, OpZone, OpSpawn, OpGoal, OpEnt, OpVerb, OpLaw, OpState, OpRule, OpNpc, OpExpect, OpSig, OpEnd, OpDress, OpPoster,
]);
export type FillOp = v.InferOutput<typeof FillOp>;

export type FillNoteKind = "repaired" | "invalid" | "over_budget" | "unresolved" | "late";
export interface FillNote { line: number; kind: FillNoteKind; text: string }
export interface FillEvent { line: number; op: FillOp["op"]; ids: string[] }

export interface FillStats { lines: number; accepted: number; invalid: number; repaired: number; dropped: number }

/** Entity defaults per kind: physics body and shape the runtime needs before assets resolve. */
const KIND_BODY: Partial<Record<Entity["kind"], [Entity["body"], Entity["shape"]]>> = {
  spawn: ["none", "none"],
  goal: ["sensor", "box"],
  checkpoint: ["sensor", "box"],
  plate: ["sensor", "box"],
  hazard: ["sensor", "box"],
  portal: ["sensor", "box"],
  pickup: ["dynamic", "sphere"],
  npc: ["kinematic", "capsule"],
  vehicle: ["dynamic", "box"],
  door: ["kinematic", "box"],
  platform: ["kinematic", "box"],
};

/** Normalise near-miss enum values ("Pressure Plate" → "pressure_plate"). */
const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Deterministic synonyms for enum values LLMs reach for (from the S2 bench's invalid lines). */
const SYNONYMS: Record<string, string> = {
  static: "fixed", solid: "fixed", immovable: "fixed", physics: "dynamic", rigid: "dynamic", movable: "dynamic",
  trigger: "sensor", zone: "sensor", area: "sensor", moving: "kinematic", animated: "kinematic",
  cylinder: "capsule", cube: "box", cuboid: "box", ball: "sphere", mesh: "hull",
  none_team: "", neutral: "", no_team: "",
  lose_reachable: "reachable", goal_reachable: "win_reachable", winnable: "win_reachable",
};

function setAt(obj: unknown, path: (string | number)[], value: unknown) {
  let node = obj as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) node = node[path[i]!] as Record<string | number, unknown>;
  node[path[path.length - 1]!] = value;
}

/** One local repair pass driven by the validation issues: numeric strings → numbers, enum case/space fixes. */
function repair(raw: unknown, issues: v.BaseIssue<unknown>[]): boolean {
  let changed = false;
  for (const issue of issues) {
    const path = issue.path?.map((p) => p.key as string | number);
    if (!path?.length) continue;
    const input = issue.input;
    if (issue.expected === "number" && typeof input === "string" && /^-?\d+(\.\d+)?$/.test(input.trim())) {
      setAt(raw, path, Number(input));
      changed = true;
    } else if (typeof input === "string" && issue.expected?.includes('"')) {
      const options = [...issue.expected.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
      const n = norm(input);
      const syn = path.at(-1) === "team" && (n === "none" || n === "neutral") ? "" : SYNONYMS[n];
      const hit = options.find((o) => o === n) ?? options.find((o) => o === syn);
      if (hit !== undefined) {
        setAt(raw, path, hit);
        changed = true;
      }
    } else if (issue.expected === "string" && typeof input === "number") {
      setAt(raw, path, String(input));
      changed = true;
    }
  }
  return changed;
}

export interface FillInit { seed: number; lang?: string; mode?: WorldBundle["mode"]; pack?: string; packVersion?: string }

export class FillParser {
  readonly notes: FillNote[] = [];
  readonly stats: FillStats = { lines: 0, accepted: 0, invalid: 0, repaired: 0, dropped: 0 };
  #buf = "";
  #line = 0;
  #gameplayDone = false;
  #cosmeticDone = false;
  #held: { line: number; op: FillOp }[] = [];
  #counts = { gameplay: 0, zone: 0, ent: 0, verb: 0, rule: 0, minded: 0, plainNpc: 0, expect: 0, dress: 0, poster: 0 };
  readonly draft: WorldBundle;

  constructor(init: FillInit) {
    this.draft = {
      v: 1,
      engine: "",
      seed: init.seed,
      mode: init.mode ?? "play",
      lang: init.lang ?? "en",
      pack: { id: init.pack ?? "arena", version: init.packVersion ?? "0", seed: init.seed, params: {}, sub: [] },
      laws: { ...DEFAULT_LAWS },
      zones: [], statics: [], entities: [], verbs: [], rules: [], states: [], cast: [], expects: [],
      cosmetic: { look: "default", mood: [0, 0, 0], timeOfDay: 12, weather: "clear", dress: [], posters: [] },
    };
  }

  get gameplayDone() {
    return this.#gameplayDone;
  }

  /** Feed streamed text; returns one event per accepted line. */
  push(chunk: string): FillEvent[] {
    this.#buf += chunk;
    const out: FillEvent[] = [];
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      const ev = this.#line_(line);
      if (ev) out.push(...ev);
    }
    return out;
  }

  /** End of stream: flush the last line and resolve anything still held. */
  end(): FillEvent[] {
    const out: FillEvent[] = [];
    if (this.#buf.trim()) out.push(...(this.#line_(this.#buf) ?? []));
    this.#buf = "";
    if (!this.#gameplayDone) out.push(...this.#closeGameplay(this.#line));
    return out;
  }

  #note(line: number, kind: FillNoteKind, text: string) {
    this.notes.push({ line, kind, text });
  }

  #line_(text: string): FillEvent[] | undefined {
    const line = ++this.#line;
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("//")) return undefined;
    this.stats.lines++;
    if (new TextEncoder().encode(trimmed).length > MAX_LINE_BYTES) {
      this.stats.invalid++;
      this.#note(line, "invalid", `line over ${MAX_LINE_BYTES} bytes`);
      return undefined;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      this.stats.invalid++;
      this.#note(line, "invalid", "not JSON");
      return undefined;
    }
    let parsed = v.safeParse(FillOp, raw);
    if (!parsed.success && raw && typeof raw === "object" && repair(raw, parsed.issues)) {
      parsed = v.safeParse(FillOp, raw);
      if (parsed.success) {
        this.stats.repaired++;
        this.#note(line, "repaired", "coerced field types/enums");
      }
    }
    if (!parsed.success) {
      this.stats.invalid++;
      const issue = parsed.issues[0]!;
      this.#note(line, "invalid", `${v.getDotPath(issue) ?? "op"}: ${issue.message}`);
      return undefined;
    }
    return this.#accept(line, parsed.output);
  }

  #budget(line: number, key: keyof FillParser["counts"], gameplay = true): boolean {
    const c = this.#counts;
    if (c[key] >= BUDGETS[key] || (gameplay && c.gameplay >= BUDGETS.gameplay)) {
      this.stats.dropped++;
      this.#note(line, "over_budget", `${key} budget ${BUDGETS[key]} reached`);
      return false;
    }
    c[key]++;
    if (gameplay) c.gameplay++;
    return true;
  }

  get counts() {
    return this.#counts;
  }

  #has(ref: string): boolean {
    if ((SPECIAL_REFS as readonly string[]).includes(ref) || ref === "" || ref.startsWith("tag:")) return true;
    const head = ref.split(".")[0]!;
    const d = this.draft;
    return (
      d.entities.some((e) => e.id === head) || d.zones.some((z) => z.id === head) ||
      d.states.some((s) => s.id === head) || d.rules.some((r) => r.id === head)
    );
  }

  #refsOk(op: FillOp): boolean {
    switch (op.op) {
      case "verb":
      case "sig":
        return this.#has(op.on);
      case "rule":
        return [op.when.a, op.when.b, ...op.if.map((c) => c.l), ...op.then.map((e) => e.target)].every((r) => this.#has(r));
      case "expect":
        // Never drop an expectation: the placer repairs references and the proof decides.
        return true;
      default:
        return true;
    }
  }

  #zoneFor(line: number, zone: string): string | undefined {
    if (this.draft.zones.some((z) => z.id === zone)) return zone;
    const first = this.draft.zones[0];
    if (!first) {
      this.#note(line, "unresolved", `zone '${zone}' before any zone`);
      return undefined;
    }
    this.#note(line, "repaired", `unknown zone '${zone}' → '${first.id}'`);
    this.stats.repaired++;
    return first.id;
  }

  #dupe(line: number, id: string): boolean {
    const d = this.draft;
    const all = [d.zones, d.entities, d.verbs, d.rules, d.states, d.cast, d.expects].flat() as { id: string }[];
    if (all.some((r) => r.id === id)) {
      this.stats.invalid++;
      this.#note(line, "invalid", `duplicate id '${id}'`);
      return true;
    }
    return false;
  }

  #accept(line: number, op: FillOp): FillEvent[] {
    if (op.op === "end") {
      if (op.layer === "gameplay") return this.#closeGameplay(line);
      this.#cosmeticDone = true;
      return [{ line, op: "end", ids: [] }];
    }
    const cosmeticOp = op.op === "dress" || op.op === "poster";
    if (this.#gameplayDone && !cosmeticOp && op.op !== "meta") {
      this.stats.dropped++;
      this.#note(line, "late", `gameplay op '${op.op}' after the gameplay layer closed`);
      return [];
    }
    if (this.#cosmeticDone) {
      this.stats.dropped++;
      this.#note(line, "late", "op after the cosmetic layer closed");
      return [];
    }
    if (!cosmeticOp && op.op !== "meta" && !this.#refsOk(op)) {
      this.#held.push({ line, op });
      return [];
    }
    const ev = this.#apply(line, op);
    if (ev) {
      this.stats.accepted++;
      // A newly accepted record may unblock held lines.
      const released: FillEvent[] = [ev];
      let progress = true;
      while (progress) {
        progress = false;
        for (let i = 0; i < this.#held.length; i++) {
          const h = this.#held[i]!;
          if (this.#refsOk(h.op)) {
            this.#held.splice(i, 1);
            const e = this.#apply(h.line, h.op);
            if (e) {
              this.stats.accepted++;
              released.push(e);
            }
            progress = true;
            break;
          }
        }
      }
      return released;
    }
    return [];
  }

  #closeGameplay(line: number): FillEvent[] {
    for (const h of this.#held) {
      this.stats.dropped++;
      this.#note(h.line, "unresolved", `'${h.op.op}' references an id that never arrived`);
    }
    this.#held = [];
    this.#gameplayDone = true;
    return [{ line, op: "end", ids: [] }];
  }

  #placed(line: number, op: Omit<v.InferOutput<typeof OpSpawn>, "op">, kind: Entity["kind"], body: Entity["body"], shape: Entity["shape"], states: string[], init: string): Entity | undefined {
    const zone = this.#zoneFor(line, op.zone);
    if (!zone) return undefined;
    return {
      id: op.id, src: "ai", layer: "gameplay", kind, zone, anchor: op.anchor,
      pos: op.pos ?? [0, 0, 0], rotY: op.rotY, size: op.size ?? [1, 1, 1],
      noun: op.noun, hyper: op.hyper, asset: "", body, shape, team: op.team, tags: op.tags,
      states, init, props: op.props,
    };
  }

  #apply(line: number, op: FillOp): FillEvent | undefined {
    const d = this.draft;
    switch (op.op) {
      case "meta": {
        d.mode = op.mode;
        d.lang = op.lang;
        d.pack = { ...d.pack, id: op.pack, sub: op.sub.slice(0, 3) };
        d.cosmetic = { ...d.cosmetic, look: op.look, mood: op.mood, timeOfDay: op.timeOfDay, weather: op.weather };
        return { line, op: op.op, ids: [] };
      }
      case "zone": {
        if (this.#dupe(line, op.id) || !this.#budget(line, "zone")) return undefined;
        const z: Zone = { id: op.id, src: "ai", layer: "gameplay", pack: d.pack.id, slot: op.slot, tag: op.tag, name: op.name, parent: op.parent };
        d.zones.push(z);
        return { line, op: op.op, ids: [op.id] };
      }
      case "spawn":
      case "goal":
      case "ent": {
        if (this.#dupe(line, op.id) || !this.#budget(line, "ent")) return undefined;
        const kind: Entity["kind"] = op.op === "ent" ? op.kind : op.op;
        const [kb, ks] = KIND_BODY[kind] ?? ["fixed", "box"];
        const body = op.op === "ent" && op.body !== "fixed" ? op.body : kb;
        const shape = op.op === "ent" && op.shape !== "box" ? op.shape : ks;
        const e = this.#placed(line, op, kind, body, shape, op.op === "ent" ? op.states : [], op.op === "ent" ? op.init : "");
        if (!e) return undefined;
        d.entities.push(e);
        return { line, op: op.op, ids: [op.id] };
      }
      case "verb":
      case "sig": {
        const vid = op.op === "verb" ? op.id : `sig_${op.verb.replace(".", "_")}`.slice(0, 32);
        if (this.#dupe(line, vid) || !this.#budget(line, "verb")) return undefined;
        if (!/^[a-z_]+\.[a-z_]+$/.test(op.verb)) {
          this.stats.invalid++;
          this.#note(line, "invalid", `verb id '${op.verb}' is not kit.verb`);
          return undefined;
        }
        if (op.op === "sig" && d.verbs.some((x) => x.signature)) {
          this.stats.dropped++;
          this.#note(line, "invalid", "second signature mechanic ignored (single source)");
          return undefined;
        }
        const b: VerbBinding = { id: vid, src: "ai", layer: "gameplay", verb: op.verb, on: op.on, params: op.params, signature: op.op === "sig" };
        d.verbs.push(b);
        return { line, op: op.op, ids: [vid] };
      }
      case "law": {
        const laws = { ...d.laws } as Record<string, number>;
        for (const [k, val] of Object.entries(op.player)) if (k in laws) laws[k] = val;
        d.laws = laws as WorldBundle["laws"];
        return { line, op: op.op, ids: [] };
      }
      case "state": {
        if (this.#dupe(line, op.id)) return undefined;
        const s: StateVar = { id: op.id, src: "ai", layer: "gameplay", owner: op.owner, type: op.type, values: op.values, init: op.init, min: op.min, max: op.max };
        d.states.push(s);
        return { line, op: op.op, ids: [op.id] };
      }
      case "rule": {
        if (this.#dupe(line, op.id) || !this.#budget(line, "rule")) return undefined;
        const r: Rule = { id: op.id, src: "ai", layer: "gameplay", when: op.when, if: op.if, then: op.then, once: op.once, cooldownS: op.cooldownS, prio: op.prio };
        d.rules.push(r);
        return { line, op: op.op, ids: [op.id] };
      }
      case "npc": {
        if (this.#dupe(line, op.id) || !this.#budget(line, op.minded ? "minded" : "plainNpc")) return undefined;
        const e = this.#placed(line, op, "npc", "kinematic", "capsule", [], "");
        if (!e) return undefined;
        const castId = `k_${op.id}`.slice(0, 32);
        const k: Cast = {
          id: castId, src: "ai", layer: "gameplay", npc: op.id, role: op.role, minded: op.minded,
          persona: { identity: op.persona.identity, personality: op.persona.personality, knowledge: op.persona.knowledge, replyStyle: op.persona.replyStyle, tools: op.persona.tools, safety: op.persona.safety },
          coneDeg: op.coneDeg, rangeM: op.rangeM, hearM: op.hearM, menu: op.menu,
          dflt: op.dflt || op.menu[0] || "", utility: op.utility, memory: 0,
        };
        d.entities.push(e);
        d.cast.push(k);
        return { line, op: op.op, ids: [op.id, castId] };
      }
      case "expect": {
        if (this.#dupe(line, op.id) || !this.#budget(line, "expect")) return undefined;
        const x: Expect = { id: op.id, src: "ai", layer: "gameplay", prop: op.prop, a: op.a, b: op.b, need: op.need, lo: op.lo, hi: op.hi, headline: op.headline, text: op.text };
        d.expects.push(x);
        return { line, op: op.op, ids: [op.id] };
      }
      case "dress": {
        if (!this.#budget(line, "dress", false)) return undefined;
        d.cosmetic.dress.push({ id: op.id, noun: op.noun, zone: op.zone, anchor: op.anchor, asset: "" });
        return { line, op: op.op, ids: [op.id] };
      }
      case "poster": {
        if (!this.#budget(line, "poster", false)) return undefined;
        d.cosmetic.posters.push({ id: op.id, prompt: op.prompt, zone: op.zone, url: "" });
        return { line, op: op.op, ids: [op.id] };
      }
    }
  }
}

/** Convenience: parse a complete JSONL fill. */
export function parseFill(text: string, init: FillInit): FillParser {
  const p = new FillParser(init);
  p.push(text);
  p.end();
  return p;
}
