// Models over the primitives, once a world is playing: KayKit characters (CC0, one rig) that walk,
// run, jump, carry, use, flinch, fall and cheer in place of the capsules, and CC0 props in place of
// boxes and orbs where a noun names one (render/nouns.ts). Files load after the first frame and
// models swap in once they are ready and you stand still (the primitive stays until then, and for
// good if a file fails). Cosmetic only: it reads poses, sim state and events, and never writes them.
import type { Entity, WorldBundle } from "@ghostrun/ir";
import type { SimEvent } from "@ghostrun/sim";
import type { GLTF, GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  Box3, CanvasTexture, CapsuleGeometry, Color, Group, Mesh, MeshStandardNodeMaterial, OctahedronGeometry, TorusGeometry, Vector3,
  type AnimationClip, type BufferGeometry, type Camera, type Material, type MeshStandardMaterial, type Object3D, type SkinnedMesh, type Texture,
} from "three/webgpu";
import { probe } from "../probe";
import type { RapierSim } from "../sim/rapier";
import { PLAYER_ID } from "../sim/types";
import { Animator, CLIPS, type ClipNames, type Motion } from "./animate";
import { characterFor, HELD_PROPS, propFor, TEAM_PROPS, type CharacterId, type PropId } from "./nouns";
import type { WorldView } from "./world";

/** full: every character and prop; lite (phones, VR, ?models=lite): a few characters near you, at half rate; off: ?models=0. */
export type ModelTier = "full" | "lite" | "off";

export function modelTier(search: string, coarse: boolean): ModelTier {
  const q = new URLSearchParams(search);
  const p = q.get("models");
  if (p === "0" || p === "off") return "off";
  if (p === "lite") return "lite";
  if (p === "1" || p === "full") return "full";
  // a headset draws every frame twice at 72–90 Hz: the page reloads into VR with vr=1
  return coarse || q.get("vr") === "1" ? "lite" : "full";
}

const BASE = `${import.meta.env.BASE_URL}models/`;
/** KayKit's rig stands about 2.2 units to the top of the head: drawn 1.76 m, the capsule's height less a hair. */
const SCALE = 0.8;
/** The actor's origin is the capsule's centre; the feet are this far below it. */
const FEET = -0.9;
/** Characters drawn at most, and how many animate every frame (the rest every third). */
const CAP = { full: { models: 40, every: 16 }, lite: { models: 6, every: 0 } } as const;

const TEAM_HUE: Record<string, number> = { red: 352, blue: 205 };
/** Each body's team colour: the hue of the cloth that turns red or blue (null: none to turn). */
const ACCENT: Record<CharacterId, number | null> = { knight: 355, rogue: 150, mage: 246, barbarian: 208, skeleton: null };

// ---- files ----------------------------------------------------------------------------------

/** The loader, the meshopt decoder and the skinned-mesh cloner: a chunk of their own, fetched with the first model. */
let addons: Promise<{ loader: GLTFLoader; clone: (o: Object3D) => Object3D }> | null = null;
const three = () =>
  (addons ??= Promise.all([
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/libs/meshopt_decoder.module.js"),
    import("three/addons/utils/SkeletonUtils.js"),
  ]).then(([{ GLTFLoader }, { MeshoptDecoder }, { clone }]) => ({ loader: new GLTFLoader().setMeshoptDecoder(MeshoptDecoder), clone })));

const files = new Map<string, Promise<GLTF>>();
function file(name: string): Promise<GLTF> {
  let f = files.get(name);
  if (!f) {
    f = three().then(({ loader }) => loader.loadAsync(`${BASE}${name}.glb`));
    files.set(name, f);
  }
  return f;
}

/** Lit like the world's own bodies, with a little of its colour glowing so it reads at night. */
function litMaterial(src: MeshStandardMaterial, map: Texture | null = src.map): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ color: src.color.clone(), roughness: 0.8, metalness: 0 });
  if (map) {
    m.map = map;
    m.emissiveMap = map;
  }
  m.emissive = new Color(1, 1, 1);
  m.emissiveIntensity = 0;
  m.name = src.name;
  return m;
}

/** The texture with the accent cloth turned to a team's hue (lightness and saturation kept). */
function teamTexture(src: Texture, accent: number, hue: number): Texture {
  const img = src.image as CanvasImageSource & { width: number; height: number };
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]! / 255, gr = px[i + 1]! / 255, b = px[i + 2]! / 255;
    const max = Math.max(r, gr, b), min = Math.min(r, gr, b);
    const s = max ? (max - min) / max : 0;
    if (s < 0.28 || max < 0.12) continue;
    let h = max === r ? ((gr - b) / (max - min)) % 6 : max === gr ? (b - r) / (max - min) + 2 : (r - gr) / (max - min) + 4;
    h = (h * 60 + 360) % 360;
    if (Math.abs(((h - accent + 540) % 360) - 180) > 28) continue;
    // back to rgb at the team's hue
    const C = max * s, X = C * (1 - Math.abs(((hue / 60) % 2) - 1)), m = max - C;
    const [rr, gg, bb] = hue < 60 ? [C, X, 0] : hue < 120 ? [X, C, 0] : hue < 180 ? [0, C, X] : hue < 240 ? [0, X, C] : hue < 300 ? [X, 0, C] : [C, 0, X];
    px[i] = (rr + m) * 255;
    px[i + 1] = (gg + m) * 255;
    px[i + 2] = (bb + m) * 255;
  }
  g.putImageData(d, 0, 0);
  const t = new CanvasTexture(c);
  t.flipY = src.flipY;
  t.colorSpace = src.colorSpace;
  t.wrapS = src.wrapS;
  t.wrapT = src.wrapT;
  return t;
}

// ---- characters -----------------------------------------------------------------------------

interface CharacterTemplate {
  scene: Object3D;
  clips: Map<string, AnimationClip>;
  names: ClipNames;
  /** Materials by team ("" the pack's own colours), in the order the template's meshes use them. */
  materials: Map<string, MeshStandardNodeMaterial[]>;
}

const characters = new Map<CharacterId, Promise<CharacterTemplate>>();
function character(id: CharacterId): Promise<CharacterTemplate> {
  let c = characters.get(id);
  if (!c) {
    c = Promise.all([file(id), file("anims")]).then(([gltf, anims]) => {
      const clips = new Map<string, AnimationClip>();
      for (const a of [...anims.animations, ...gltf.animations]) clips.set(a.name, a);
      const meshes: Mesh[] = [];
      gltf.scene.traverse((o) => {
        if ((o as Mesh).isMesh) meshes.push(o as Mesh);
      });
      const own = meshes.map((m) => m.material as MeshStandardMaterial);
      const materials = new Map<string, MeshStandardNodeMaterial[]>([["", own.map((m) => litMaterial(m))]]);
      const accent = ACCENT[id];
      for (const [team, hue] of Object.entries(TEAM_HUE)) {
        materials.set(team, accent === null ? materials.get("")! : own.map((m) => litMaterial(m, m.map && teamTexture(m.map, accent, hue))));
      }
      for (const m of meshes) {
        // the skinned body moves well outside its bind-pose bounds (a jump, a fall)
        m.frustumCulled = false;
      }
      // the undead shamble; a mage casts where the others shoot from the hip
      let names: ClipNames = clips.has("Walking_D_Skeletons") ? { ...CLIPS, walk: "Walking_D_Skeletons" } : CLIPS;
      if (id === "mage") names = { ...names, cues: { ...names.cues, shoot: "Spellcast_Shoot" } };
      return { scene: gltf.scene, clips, names, materials };
    });
    characters.set(id, c);
  }
  return c;
}

// ---- props ----------------------------------------------------------------------------------

const GEM_HEX: readonly [RegExp, string][] = [
  [/red|ruby|blood|fire/, "#ff3b5c"],
  [/blue|sapphire|ice|frost|storm/, "#3bb8ff"],
  [/green|emerald|jade|seed|leaf/, "#4dff8a"],
  [/purple|amethyst|violet|time|void/, "#b35cff"],
  [/gold|yellow|topaz|sun|amber/, "#ffd23b"],
];

const props = new Map<string, Promise<Object3D>>();
function prop(id: PropId, team: string, noun: string): Promise<Object3D> {
  // a gem is drawn here: a faceted crystal in its colour
  if (id === "gem") {
    const hex = GEM_HEX.find(([re]) => re.test(noun.toLowerCase()))?.[1] ?? "#5cf2ff";
    const key = `gem:${hex}`;
    let p = props.get(key);
    if (!p) {
      const geo = new OctahedronGeometry(0.5, 0);
      geo.scale(0.8, 1.3, 0.8);
      const m = new MeshStandardNodeMaterial({ color: new Color(hex), roughness: 0.15, metalness: 0.3, flatShading: true });
      m.emissive = new Color(hex);
      m.emissiveIntensity = 0.6;
      p = Promise.resolve(new Mesh(geo, m));
      props.set(key, p);
    }
    return p;
  }
  const name = TEAM_PROPS.has(id) ? (team === "red" || team === "blue" ? `${id}_${team}` : id === "banner" ? "banner_red" : id) : id;
  let p = props.get(name);
  if (!p) {
    p = file(`props/${name}`).then((gltf) => {
      gltf.scene.traverse((o) => {
        const m = o as Mesh;
        if (m.isMesh) m.material = litMaterial(m.material as MeshStandardMaterial);
      });
      return gltf.scene;
    });
    props.set(name, p);
  }
  return p;
}

const _box = new Box3();
const _size = new Vector3();
const _centre = new Vector3();

/** The box a mesh fills in its parent's frame. */
function boxIn(m: Mesh, out: Box3): Box3 {
  const g = m.geometry as BufferGeometry;
  if (!g.boundingBox) g.computeBoundingBox();
  m.updateMatrix();
  return out.copy(g.boundingBox!).applyMatrix4(m.matrix);
}

const isFlat = (m: Mesh) => ["RingGeometry", "CircleGeometry", "PlaneGeometry"].includes((m.geometry as BufferGeometry).type);
const isLit = (m: Mesh) => {
  const mat = m.material as Partial<Record<"isMeshStandardMaterial" | "isMeshStandardNodeMaterial", boolean>>;
  return Boolean(mat.isMeshStandardNodeMaterial || mat.isMeshStandardMaterial);
};

/**
 * The mesh a prop stands in for: an actor's biggest lit body (a switch's box, a door's panel, a
 * prop's block) or, on an all-glow actor (an orb, a coin, a key), its biggest solid glow. Glow
 * trims, halos, lamps and lights stay (they say what the thing does), and so does a switch's pole.
 */
function standIn(actor: Object3D): Mesh | null {
  const meshes: Mesh[] = [];
  actor.traverse((o) => {
    if ((o as Mesh).isMesh && o.visible) meshes.push(o as Mesh);
  });
  const vol = (m: Mesh) => boxIn(m, _box).getSize(_size).x * _size.y * _size.z;
  const lit = meshes.filter(isLit);
  const pool = lit.length ? lit : meshes.filter((m) => !isFlat(m) && !(m.material as Material).transparent);
  return pool.sort((a, b) => vol(b) - vol(a))[0] ?? null;
}

// ---- the layer ------------------------------------------------------------------------------

interface Cast {
  id: string;
  actor: Object3D;
  team: string;
  holder: Group;
  model: Object3D;
  animator: Animator | null;
  /** The bone held things ride (KayKit's right-hand slot). */
  hand: Object3D | null;
  /** Its own weapon (a blaster, a spell, a sword), drawn in hand while it holds nothing else. */
  innate: Object3D | null;
  /** A held pickup in hand (by item id), standing in for the item while it is carried. */
  holding: { item: string; obj: Object3D } | null;
  last: Vector3;
  speed: number;
  vy: number;
  airTime: number;
  ko: boolean;
  koAt: number;
  hp: number;
  skip: number;
  /** Fell for good: drawn where it fell until it sinks away. */
  fallen: number;
}

export interface ModelStats {
  tier: Exclude<ModelTier, "off">;
  characters: number;
  props: number;
  failed: number;
  /** What the player's body is doing (idle, move, air, ko, cheer): the e2e suite reads it. */
  player?: string;
}

export interface ModelOptions {
  tier: Exclude<ModelTier, "off">;
  /** Compiles an object's shaders off the frame (the renderer's compileAsync against the world's scene). */
  compile: (o: Object3D) => Promise<unknown>;
  /** Night worlds lift the models' own colours a little so they read under neon and moonlight. */
  night: boolean;
  /** The ghost you race (engine-owned): it runs as a knight of light instead of a capsule. */
  ghost?: Object3D;
  /** Who the player is, in the world's own words (the live intent's role): picks the player's body. */
  role?: string;
}

const GHOST_ID = "\u0000ghost";
/** Ticks without touching the controls that count as standing still (a third of a second). */
const QUIET_TICKS = 20;
/** A weapon a character carries in its hand from the start: what its shoot verb reads as. */
function innateProp(body: CharacterId, range: number): PropId | null {
  if (body === "skeleton") return null; // claws
  if (body === "mage") return "wand";
  return range < 3 ? "sword" : "crossbow";
}

export class ModelLayer {
  readonly stats: ModelStats;
  readonly #bundle: WorldBundle;
  readonly #view: WorldView;
  readonly #sim: RapierSim | null;
  readonly #opts: ModelOptions;
  readonly #cast = new Map<string, Cast>();
  readonly #spin: Object3D[] = [];
  /** Pickups that are held in a hand when carried (a sword, a wand): item id → prop. */
  readonly #held = new Map<string, PropId>();
  /** Item actors hidden while their stand-in rides a hand. */
  readonly #hidden = new Set<string>();
  readonly #compiled = new Set<string>();
  /** Models loaded and compiled, waiting for a quiet moment to swap in (see update). */
  readonly #ready: (() => void)[] = [];
  readonly #unsub: (() => void) | null;
  #lastShot = -1;
  #frame = 0;
  #t = 0;
  #disposed = false;

  constructor(bundle: WorldBundle, view: WorldView, sim: RapierSim | null, opts: ModelOptions) {
    this.#bundle = bundle;
    this.#view = view;
    this.#sim = sim;
    this.#opts = opts;
    this.stats = { tier: opts.tier, characters: 0, props: 0, failed: 0 };
    this.#unsub = sim ? sim.subscribe((evs) => this.#events(evs)) : null;
    const spawn = bundle.entities.find((e) => e.kind === "spawn" && e.team === "red") ?? bundle.entities.find((e) => e.kind === "spawn");
    const playerTeam = sim?.sim.entity(PLAYER_ID)?.team || spawn?.team || "red";

    // characters: you first, then the cast nearest you
    const player = view.actors.get(PLAYER_ID);
    const npcs = bundle.entities.filter((e) => e.kind === "npc" && !e.tags.includes("area") && view.actors.has(e.id));
    if (player) npcs.sort((a, b) => dist2(a.pos, player.position) - dist2(b.pos, player.position));
    const wanted: { id: string; body: CharacterId; team: string }[] = [];
    if (player) wanted.push({ id: PLAYER_ID, body: characterFor(opts.role ?? "", true)!, team: playerTeam });
    for (const e of npcs) {
      const body = characterFor(e.noun || e.id);
      if (body) wanted.push({ id: e.id, body, team: e.team });
    }
    for (const w of wanted.slice(0, CAP[opts.tier].models)) void this.#dress(w.id, w.body, w.team, view.actors.get(w.id)!);
    if (opts.ghost && opts.tier === "full") void this.#dress(GHOST_ID, "knight", "", opts.ghost);

    // props by noun
    for (const e of bundle.entities) {
      if (e.tags.includes("area")) continue;
      const id = propFor(e.noun, e.kind);
      const actor = view.actors.get(e.id);
      if (id && actor) void this.#furnish(e, id, actor);
      if (id && HELD_PROPS.has(id)) this.#held.set(e.id, id);
    }
    this.#publish();
  }

  async #dress(id: string, body: CharacterId, team: string, actor: Object3D) {
    try {
      const tpl = await character(body);
      if (this.#disposed) return;
      const model = (await three()).clone(tpl.scene);
      const ghost = id.startsWith(GHOST_ID) ? ghostMaterial(actor) : null;
      const mats = tpl.materials.get(team) ?? tpl.materials.get("")!;
      let i = 0;
      model.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        m.material = ghost ?? mats[i] ?? mats[0]!;
        i++;
        // see-through, drawn after the world like the ghost's own capsule
        if (ghost) m.renderOrder = 3;
      });
      for (const m of mats) m.emissiveIntensity = this.#opts.night ? 0.22 : 0.04;
      model.scale.setScalar(SCALE);
      model.rotation.y = Math.PI; // the pack faces +z; an actor faces −z
      const holder = new Group();
      holder.name = "model";
      holder.position.y = FEET;
      holder.add(model);
      const hand = model.getObjectByName("handslotr") ?? null;
      const shoot = this.#bundle.verbs.find((v) => v.verb === "combat_sport.shoot" && (v.on === id || v.on === `team:${team}` || (id === PLAYER_ID && v.on === "player")));
      const innateId = shoot && hand ? innateProp(body, Number(shoot.params.range ?? 10)) : null;
      const innate = innateId ? (await prop(innateId, team, "")).clone() : null;
      if (innate && hand) hand.add(innate);
      await this.#compileOnce(ghost ? "ghost" : `${body}:${team}`, holder);
      if (this.#disposed) return;
      this.#ready.push(() => {
        // the capsule's body, visor and waist go; the team ring at the feet and the marker stay
        for (const c of actor.children) {
          const g = (c as Mesh).geometry as BufferGeometry | undefined;
          if (g && (g instanceof CapsuleGeometry || g instanceof TorusGeometry)) c.visible = false;
        }
        actor.add(holder);
        const animator = new Animator(model, tpl.clips, tpl.names);
        this.#cast.set(id, {
          id, actor, team, holder, model, animator, hand, innate, holding: null,
          last: actor.position.clone(), speed: 0, vy: 0, airTime: 0, ko: false, koAt: 0, hp: Infinity, skip: 0, fallen: -1,
        });
        if (!ghost) this.stats.characters++;
      });
    } catch (e) {
      this.stats.failed++;
      console.warn(`model for ${id} unavailable, keeping the capsule`, e);
    }
    this.#publish();
  }

  async #furnish(e: Entity, id: PropId, actor: Object3D) {
    try {
      const tpl = await prop(id, e.team, e.noun);
      if (this.#disposed) return;
      const anchor = standIn(actor);
      if (!anchor) return;
      const parent = anchor.parent ?? actor;
      // the room the stand-in took, in its parent's frame
      const room = boxIn(anchor, new Box3());
      const roomSize = room.getSize(new Vector3());
      const model = tpl.clone();
      // a coin stands on its edge, as the neon coins do
      if (id === "coin") model.rotation.x = Math.PI / 2;
      // a piece turned to face somewhere (a desk to its door) is drawn turned; its box is already its turned footprint
      else if (e.kind === "prop" && e.rotY) model.rotation.y = e.rotY;
      const own = new Box3().setFromObject(model);
      const size = own.getSize(_size);
      const holder = new Group();
      holder.name = "prop";
      const fit = (a: number, b: number) => a / Math.max(1e-3, b);
      if (id === "door" || id === "gate") {
        // a door fills its doorway
        const sx = fit(roomSize.x, size.x);
        const sy = fit(roomSize.y, size.y);
        model.scale.set(sx, sy, Math.min(sx, sy));
      } else {
        // a pickup a little proud of its orb, so it reads at a glance; anything else inside its box
        const k = e.kind === "pickup" ? 1.6 : 1;
        model.scale.setScalar(k * Math.min(fit(roomSize.x, size.x), fit(roomSize.y, size.y), fit(roomSize.z, size.z)));
      }
      own.getCenter(_centre);
      model.position.set(-_centre.x * model.scale.x, -own.min.y * model.scale.y, -_centre.z * model.scale.z);
      room.getCenter(_centre);
      holder.position.set(_centre.x, room.min.y, _centre.z);
      holder.add(model);
      if (id !== "gem") model.traverse((o) => {
        const m = (o as Mesh).material as MeshStandardNodeMaterial | undefined;
        if (m?.isMeshStandardNodeMaterial) m.emissiveIntensity = this.#opts.night ? 0.25 : 0.03;
      });
      await this.#compileOnce(`prop:${id}`, holder);
      if (this.#disposed) return;
      this.#ready.push(() => {
        anchor.visible = false;
        parent.add(holder);
        // a loose pickup turns slowly where it waits (kit pickups already spin their own group)
        if (e.kind === "pickup" && parent === actor) this.#spin.push(holder);
        this.stats.props++;
      });
    } catch (err) {
      this.stats.failed++;
      console.warn(`prop ${id} for ${e.id} unavailable, keeping its shape`, err);
    }
    this.#publish();
  }

  /** Each look's shaders compile once, off the frame, before the first of them is shown. */
  async #compileOnce(key: string, o: Object3D) {
    if (this.#compiled.has(key)) return;
    this.#compiled.add(key);
    await this.#opts.compile(o).catch(() => undefined);
  }

  #events(evs: readonly SimEvent[]) {
    for (const ev of evs) {
      const c = this.#cast.get(ev.a);
      if (!c) continue;
      if (ev.k === "knockout") {
        c.ko = true;
        c.koAt = this.#t;
      } else if (ev.k === "respawn") {
        c.ko = false;
      } else if (ev.k === "hp" && typeof ev.v === "number") {
        // a hit, not a heal (and not the one that knocks it out: that one falls)
        if (ev.v < c.hp && ev.v > 0) c.animator?.cue("hit");
        c.hp = ev.v;
      } else if (ev.k === "touch") c.animator?.cue("use");
      else if (ev.k === "destroy" && c.ko) this.#fall(c);
    }
  }

  /** Down for good (the sim removed it): it stays where it fell, then sinks away. */
  #fall(c: Cast) {
    c.actor.updateMatrixWorld();
    c.holder.applyMatrix4(c.actor.matrixWorld);
    this.#view.root.add(c.holder);
    c.fallen = this.#t;
  }

  /** A held pickup rides the carrier's hand (its own actor hidden meanwhile); anything else stays over its head. */
  #hold(c: Cast, item: string) {
    const want = this.#held.get(item) ?? null;
    if (c.holding && c.holding.item !== (want ? item : "")) {
      c.holding.obj.removeFromParent();
      this.#show(c.holding.item);
      c.holding = null;
    }
    if (want && !c.holding && c.hand) {
      const obj = new Group();
      c.holding = { item, obj };
      void prop(want, c.team, "").then((tpl) => {
        if (c.holding?.obj === obj) obj.add(tpl.clone());
      });
      c.hand.add(obj);
      const a = this.#view.actors.get(item);
      if (a?.visible) {
        a.visible = false;
        this.#hidden.add(item);
      }
    }
    if (c.innate) c.innate.visible = !c.holding;
  }

  #show(item: string) {
    if (!this.#hidden.delete(item)) return;
    const a = this.#view.actors.get(item);
    if (a && !this.#sim?.sim.entity(item)?.destroyed) a.visible = true;
  }

  update(dt: number, t: number, camera: Camera) {
    this.#t = t;
    this.#frame++;
    const sim = this.#sim;
    // A model's first frame can stall while the GPU finishes its shaders (a tenth of a second on a
    // laptop, seconds under software GL), so models swap in while you stand still, never mid-jump.
    if (this.#ready.length && (!sim || sim.idleTicks > QUIET_TICKS || sim.sim.result)) {
      for (const swap of this.#ready.splice(0)) swap();
      this.#publish();
    }
    // shots fired since last frame: the shooter's arms (a swipe for claws and blades, a shot for the rest)
    if (sim) {
      for (const s of sim.sim.shots) {
        if (s.id <= this.#lastShot) continue;
        this.#lastShot = s.id;
        this.#cast.get(s.by)?.animator?.cue(s.range < 3 ? "punch" : "shoot");
      }
    }
    for (const h of this.#spin) h.rotation.y = t * 1.1;
    // the nearest characters animate every frame; the rest every third
    const cap = CAP[this.#opts.tier].every;
    const near = cap > 0 && this.#cast.size > cap ? new Set([...this.#cast.values()].sort((a, b) => a.actor.position.distanceToSquared(camera.position) - b.actor.position.distanceToSquared(camera.position)).slice(0, cap)) : null;
    const result = sim?.sim.result ?? null;
    const mine = this.#cast.get(PLAYER_ID)?.team ?? "red";
    for (const c of this.#cast.values()) {
      if (!c.animator) continue;
      if (c.fallen >= 0) {
        const age = t - c.fallen;
        if (age > 1.6) c.holder.position.y -= dt * 0.8;
        if (age > 3) {
          c.holder.removeFromParent();
          c.animator.dispose();
          c.animator = null;
          continue;
        }
      }
      const p = c.actor.position;
      const step = dt > 0 ? 1 / dt : 0;
      const jump = p.distanceToSquared(c.last) > 9; // a respawn's teleport is no sprint
      const k = jump ? 1 : 1 - Math.exp(-10 * dt);
      c.speed += ((jump ? 0 : Math.hypot(p.x - c.last.x, p.z - c.last.z) * step) - c.speed) * k;
      c.vy += ((jump ? 0 : (p.y - c.last.y) * step) - c.vy) * k;
      c.last.copy(p);
      const ctrl = sim ? (c.id === PLAYER_ID ? sim.sim.player : sim.sim.npcs.get(c.id)) : undefined;
      const grounded = ctrl ? ctrl.grounded : null;
      c.airTime = grounded === false ? c.airTime + dt : 0;
      // up again (healed, or a respawn the sim didn't announce)
      if (c.ko && c.fallen < 0 && sim && t - c.koAt > 1.2 && (sim.sim.hp(c.id) ?? 1) > 0 && !sim.sim.entity(c.id)?.destroyed && !(c.id === PLAYER_ID && result)) c.ko = false;
      const carrying = sim?.sim.entity(c.id)?.carrying ?? "";
      this.#hold(c, carrying);
      // you and your side cheer a win; when you lose, the other side does
      const won = !c.id.startsWith(GHOST_ID) && (result === "win" ? c.team === mine : result === "lose" ? c.id !== PLAYER_ID && c.team !== mine : false);
      const m: Motion = { speed: c.speed, vy: c.vy, grounded, airTime: c.airTime, carrying: carrying !== "" && !c.holding, ko: c.ko || c.fallen >= 0, cheer: won };
      const every = near && !near.has(c) ? 3 : this.#opts.tier === "lite" ? 2 : 1;
      c.skip += dt;
      if (this.#frame % every !== 0) continue;
      c.animator.update(c.skip, m);
      c.skip = 0;
    }
    const me = this.#cast.get(PLAYER_ID)?.animator?.state;
    if (me && me !== this.stats.player) {
      this.stats.player = me;
      this.#publish();
    }
  }

  #publish() {
    if (!this.#disposed) probe().models = { ...this.stats };
  }

  /**
   * Another ghost (red/green's two runs) as a knight of light too, while it plays: its capsule's own
   * see-through material on the knight. The returned function takes the knight off again.
   */
  dressGhost(obj: Object3D, key: string): () => void {
    const id = `${GHOST_ID}:${key}`;
    if (this.#opts.tier === "full" && !this.#cast.has(id)) void this.#dress(id, "knight", "", obj);
    return () => {
      const c = this.#cast.get(id);
      this.#cast.delete(id);
      c?.animator?.dispose();
      c?.holder.removeFromParent();
      for (const k of obj.children) k.visible = true;
    };
  }

  dispose() {
    this.#disposed = true;
    this.#ready.length = 0;
    this.#unsub?.();
    for (const id of [...this.#hidden]) this.#show(id);
    for (const c of this.#cast.values()) {
      c.animator?.dispose();
      c.model.traverse((o) => (o as SkinnedMesh).skeleton?.dispose());
      c.holder.removeFromParent();
    }
    // the ghost outlives the world: its capsule comes back for the next one
    const g = this.#opts.ghost;
    if (g) for (const c of g.children) c.visible = true;
    this.#cast.clear();
    delete probe().models;
  }
}

/** The ghost capsule's own see-through material (its colour and fade are uniforms the engine sets). */
function ghostMaterial(ghost: Object3D): Material | null {
  const shell = ghost.children.find((c) => (c as Mesh).geometry instanceof CapsuleGeometry && ((c as Mesh).material as Material).transparent) as Mesh | undefined;
  return shell ? (shell.material as Material) : null;
}

const dist2 = (a: readonly number[], b: Vector3) => (a[0]! - b.x) ** 2 + (a[2]! - b.z) ** 2;
