// The world being built, drawn while it streams in. From the intent alone the layout pack gives the
// ground and every wall: a scan ring runs out across a grid and the walls rise behind it with
// glowing edges. Then each entity pops in at its anchor as its op line lands. A preview only:
// nothing here is simulated, proved or hashed, and the engine swaps the real world in the moment
// its gameplay layer is complete. Colours come from the world's look (looks.ts), through uniforms,
// so every preview reuses the same few compiled programs.
import { FillParser, DEFAULT_LAWS, type Entity, type WorldBundle } from "@ghostrun/ir";
import { KIND_SIZE } from "@ghostrun/layout";
import type { PackLayout, PackStatic, ZoneSpec } from "@ghostrun/plugin-api";
import { packFor } from "@ghostrun/registry";
import {
  AdditiveBlending, BoxGeometry, CapsuleGeometry, Color, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, NormalBlending, Object3D, PlaneGeometry, RingGeometry,
  SphereGeometry, TorusGeometry, Vector2, Vector3, type BufferGeometry, type PerspectiveCamera,
} from "three/webgpu";
import { abs, attribute, clamp, float, fract, fwidth, length, max, min, mix, oneMinus, positionGeometry, positionWorld, smoothstep, uniform, vec3, vertexColor } from "three/tsl";
import { BoxBatch } from "./boxes";
import { lookOf, type LookStyle } from "./looks";
import { lin, PALETTE } from "./materials";

/** What the preview needs before any fill line: the pack, its sub-zones, the seed, and look words (the intent's setting and mood). */
export interface MaterialiseSpec {
  pack: string;
  sub: string[];
  seed: number;
  look: string;
}

type V3 = [number, number, number];

/** One wall's rise. */
const RISE_S = 0.65;
/** The scan ring reaches the farthest wall this long after the start. */
const SPREAD_S = 1.25;
/** An entity's pop; pops landing together are this far apart. */
const POP_S = 0.42;
const POP_GAP_S = 0.05;

// Shared by every preview: the clock, the look's colours and the layout's reach. The preview on
// screen sets them each frame (the prewarm's sample never does).
const uT = uniform(0);
// colours as plain linear-RGB vectors (vec3 in the shader)
const uEdge = uniform(new Vector3());
const uFill = uniform(new Vector3());
const uGrid = uniform(new Vector3());
const uCentre = uniform(new Vector2());
const uSpeed = uniform(10);
const uReach = uniform(60);

interface Kit {
  wall: MeshBasicNodeMaterial;
  edge: MeshBasicNodeMaterial;
  /** The same edges drawn in ink, for a pale day. */
  ink: MeshBasicNodeMaterial;
  ground: MeshBasicNodeMaterial;
  body: MeshBasicNodeMaterial;
  line: MeshBasicNodeMaterial;
  glow: MeshBasicNodeMaterial;
  flash: MeshBasicNodeMaterial;
  team: Record<"red" | "blue" | "orb", MeshBasicNodeMaterial>;
  geo: { plane: PlaneGeometry; box: BoxGeometry; ring: RingGeometry; beam: CylinderGeometry; torus: TorusGeometry; orb: SphereGeometry; capsule: CapsuleGeometry };
}

let kit: Kit | null = null;

/** Batched boxes rise from their bottom: aStyle x = bottom y, y = start (s), z = top y. */
function rising() {
  const s = attribute("aStyle", "vec4");
  const k = clamp(uT.sub(s.y).div(RISE_S), 0, 1);
  const eased = oneMinus(oneMinus(k).pow(3));
  return { s, k, eased, position: vec3(positionGeometry.x, mix(s.x, positionGeometry.y, eased), positionGeometry.z) };
}

function makeKit(): Kit {
  // walls: a dim translucent body with a bright band riding its top while it rises
  const wall = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
  const w = rising();
  wall.positionNode = w.position;
  const top = mix(w.s.x, w.s.z, w.eased);
  const band = oneMinus(smoothstep(0, 0.6, abs(positionWorld.y.sub(top)))).mul(oneMinus(w.k).mul(0.8).add(0.2));
  wall.colorNode = uFill.add(uEdge.mul(band.mul(1.4)));
  wall.opacityNode = float(0.42).add(band.mul(0.5)).mul(smoothstep(0, 0.06, w.k));

  // edges: HDR strips (their vertex colour is a brightness) in the look's glow, rising with the wall;
  // on a pale day added light is lost against the sky, so the same strips are drawn in ink
  const strips = (blending: typeof AdditiveBlending | typeof NormalBlending) => {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending });
    const e = rising();
    m.positionNode = e.position;
    m.colorNode = uEdge.mul(vertexColor().rgb);
    m.opacityNode = smoothstep(0, 0.05, e.k);
    return m;
  };
  const edge = strips(AdditiveBlending);
  const ink = strips(NormalBlending);

  // the ground: a grid revealed by a ring running out from the centre, fading into the distance
  const ground = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const xz = positionWorld.xz;
  const cell = xz.div(2);
  const g = abs(fract(cell.sub(0.5)).sub(0.5)).div(max(fwidth(cell), 1e-4));
  const grid = oneMinus(min(min(g.x, g.y), 1));
  const r = length(xz.sub(uCentre));
  const reach = uT.mul(uSpeed);
  const inside = oneMinus(smoothstep(reach.sub(1.2), reach.add(1.2), r));
  const ring = oneMinus(smoothstep(0, 1.8, abs(r.sub(reach)))).mul(oneMinus(smoothstep(uReach, uReach.add(8), reach)));
  const far = oneMinus(smoothstep(uReach.mul(0.7), uReach.add(24), r));
  ground.colorNode = mix(uFill.mul(0.6), uGrid, grid).add(uEdge.mul(ring.mul(1.6)));
  ground.opacityNode = clamp(float(0.5).add(grid.mul(0.4)).mul(inside).mul(far).add(ring.mul(0.9)), 0, 1);

  const body = new MeshBasicNodeMaterial({ transparent: true });
  body.colorNode = uFill.add(uEdge.mul(0.18));
  body.opacityNode = float(0.6);
  const line = new MeshBasicNodeMaterial();
  line.colorNode = uEdge.mul(vertexColor().rgb);
  const glow = new MeshBasicNodeMaterial();
  glow.colorNode = uEdge.mul(2.6);
  const flash = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide });
  flash.colorNode = uEdge.mul(1.8);
  flash.opacityNode = float(0.32);
  const solid = (hex: string, k: number) => new MeshBasicNodeMaterial({ color: new Color(...lin(hex, k)) });
  const beam = new CylinderGeometry(1, 1, 1, 24, 1, true);
  beam.translate(0, 0.5, 0); // grows up from its foot
  return {
    wall, edge, ink, ground, body, line, glow, flash,
    team: { red: solid(PALETTE.red, 3), blue: solid(PALETTE.blue, 3), orb: solid(PALETTE.orb, 5) },
    geo: { plane: new PlaneGeometry(1, 1), box: new BoxGeometry(1, 1, 1), ring: new RingGeometry(0.88, 1.04, 48), beam, torus: new TorusGeometry(1.2, 0.08, 10, 56), orb: new SphereGeometry(1, 24, 12), capsule: new CapsuleGeometry(0.33, 1.1, 4, 12) },
  };
}

/** Linear luminance of an sRGB hex colour. */
const luma = (hex: string) => {
  const [r, g, b] = lin(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/**
 * The preview's edge, fill and grid colours from a look, and whether it is pale: glowing lines on a
 * dark world; on a pale day, lines inked in the shade of its ground over walls of that ground (the
 * sky's own colours would vanish against the sky).
 */
function tint(look: LookStyle): [V3, V3, V3, boolean] {
  const air = look.fog.color || look.sky.horizon;
  if (luma(air) > 0.35) return [lin(look.hemi.ground, 0.3), lin(look.hemi.ground, 0.9), lin(look.hemi.ground, 0.55), true];
  return [lin(look.sky.glow, 2.4), lin(air, 1.8), lin(look.hemi.sky, 1.3), false];
}

/** The look before the fill's meta line names one: the intent's words read like a look word. */
function guessLook(spec: MaterialiseSpec): LookStyle {
  const d = new FillParser({ seed: spec.seed, pack: spec.pack }).draft;
  d.cosmetic = { ...d.cosmetic, look: spec.look };
  return lookOf(d);
}

const backOut = (u: number) => 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2;
const easeOut = (u: number) => 1 - (1 - u) ** 3;
const hash = (i: number) => {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};
const isDefault = (s: readonly number[]) => s[0] === 1 && s[1] === 1 && s[2] === 1;

interface Pop {
  obj: Object3D;
  flash: Mesh;
  at: number;
  height: number;
}

export class Materialise {
  readonly root = new Group();
  look: LookStyle;
  readonly #k: Kit;
  readonly #pack: string;
  readonly #layout: PackLayout;
  readonly #geos: BufferGeometry[] = [];
  readonly #groundY: number;
  readonly #centre: V3;
  readonly #radius: number;
  readonly #yaw0: number;
  #t0 = 0;
  #seen = 0;
  #metaSeen = false;
  #statics = 0;
  readonly #pops: Pop[] = [];
  readonly #onAnchor = new Map<string, number>();
  #nextPopAt = 0;
  #colours: [V3, V3, V3, boolean];
  #edges: Mesh | null = null;
  /** The scan ring's speed (m/s) and how far out the farthest wall stands (m). */
  #speed = 10;
  #reach = 10;

  constructor(spec: MaterialiseSpec) {
    this.#k = kit ??= makeKit();
    this.#pack = spec.pack;
    const pack = packFor(spec.pack);
    this.#layout = pack.generate({ seed: spec.seed, params: pack.defaults, sub: spec.sub, laws: DEFAULT_LAWS, harder: false });
    this.look = guessLook(spec);
    this.#colours = tint(this.look);
    this.root.name = "materialise";

    const cb = this.#layout.cameraBounds;
    const main = this.#layout.statics.filter((s) => s.surf === "floor").sort((a, b) => b.size[0] * b.size[2] - a.size[0] * a.size[2])[0];
    this.#groundY = main ? main.pos[1] + main.size[1] / 2 : 0;
    this.#centre = [(cb.min[0] + cb.max[0]) / 2, this.#groundY, (cb.min[2] + cb.max[2]) / 2];
    const ex = cb.max[0] - cb.min[0];
    const ez = cb.max[2] - cb.min[2];
    this.#radius = 0.45 * Math.max(ex, ez) + 5;
    this.#yaw0 = ez > ex ? Math.PI / 2 : 0; // side on to the long axis
    this.#buildStatics(this.#layout.statics.filter((s) => s !== main));
  }

  /** Statics and entities drawn so far. */
  get counts(): { statics: number; entities: number } {
    return { statics: this.#statics, entities: this.#pops.length };
  }

  /** The reveal's clock starts now (the moment it is first on screen). */
  start(now: number) {
    this.#t0 = now;
  }

  #buildStatics(statics: PackStatic[]) {
    const [cx, , cz] = this.#centre;
    for (const s of statics) this.#reach = Math.max(this.#reach, Math.hypot(s.pos[0] - cx, s.pos[2] - cz));
    this.#speed = this.#reach / SPREAD_S;
    const bodies = new BoxBatch();
    const edges = new BoxBatch();
    statics.forEach((s, i) => {
      const [x, y, z] = s.pos;
      const [w, h, d] = s.size;
      const lo: V3 = [x - w / 2, y - h / 2, z - d / 2];
      const hi: V3 = [x + w / 2, y + h / 2, z + d / 2];
      // each wall starts as the ring passes it, with a little scatter so a row doesn't rise as one
      const at = Math.hypot(x - cx, z - cz) / this.#speed + hash(i) * 0.18;
      const style = [lo[1], at, hi[1], 0] as const;
      bodies.add(s.pos, s.size, [1, 1, 1], style);
      const strip = (a: V3, b: V3, t: number, k: number) => {
        const c: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        edges.add(c, [Math.abs(b[0] - a[0]) || t, Math.abs(b[1] - a[1]) || t, Math.abs(b[2] - a[2]) || t], [k, k, k], style, false);
      };
      const t = Math.min(0.09, 0.02 + 0.012 * Math.max(w, d) ** 0.5);
      for (const zz of [lo[2], hi[2]]) strip([lo[0], hi[1], zz], [hi[0], hi[1], zz], t, 1.4);
      for (const xx of [lo[0], hi[0]]) strip([xx, hi[1], lo[2]], [xx, hi[1], hi[2]], t, 1.4);
      if (h > 0.6) for (const [xx, zz] of [[lo[0], lo[2]], [hi[0], lo[2]], [lo[0], hi[2]], [hi[0], hi[2]]] as const) strip([xx, lo[1], zz], [xx, hi[1], zz], t * 0.8, 0.7);
    });
    this.#statics = statics.length;
    const keep = <T extends BufferGeometry>(g: T) => (this.#geos.push(g), g);
    if (statics.length) {
      const body = new Mesh(keep(bodies.build()), this.#k.wall);
      body.renderOrder = 1;
      const edge = new Mesh(keep(edges.build()), this.#colours[3] ? this.#k.ink : this.#k.edge);
      edge.renderOrder = 2;
      this.root.add(body, edge);
      this.#edges = edge;
    }
    const ground = new Mesh(this.#k.geo.plane, this.#k.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.scale.set(400, 400, 1);
    ground.position.set(cx, this.#groundY + 0.01, cz);
    this.root.add(ground);
  }

  /**
   * The fill so far: each entity not yet shown pops in. Returns the look when the fill's meta
   * line changed it (the caller restyles the sky), otherwise null.
   */
  feed(d: WorldBundle): LookStyle | null {
    let changed: LookStyle | null = null;
    if (!this.#metaSeen && d.cosmetic.look !== "default") {
      this.#metaSeen = true;
      // the real world's look reads the pack it is placed in, which is the intent's
      const next = lookOf({ ...d, pack: { ...d.pack, id: this.#pack } });
      if (JSON.stringify(next) !== JSON.stringify(this.look)) {
        this.look = next;
        this.#colours = tint(next);
        if (this.#edges) this.#edges.material = this.#colours[3] ? this.#k.ink : this.#k.edge;
        changed = next;
      }
    }
    const bound = this.#bind(d);
    for (const e of d.entities.slice(this.#seen)) if (!e.tags.includes("area")) this.#pop(e.kind, e.team, this.#where(e, bound.get(e.zone)), isDefault(e.size) ? (KIND_SIZE[e.kind] ?? e.size) : e.size);
    this.#seen = d.entities.length;
    return changed;
  }

  /** Fill zones → pack zones, the way the placer binds them: by slot, then tag, then any left. */
  #bind(d: WorldBundle): Map<string, ZoneSpec> {
    const zones = this.#layout.zones;
    const out = new Map<string, ZoneSpec>();
    const used = new Set<string>();
    for (const z of d.zones) {
      const s = zones.find((x) => x.slot === z.slot && !used.has(x.slot));
      if (s) (out.set(z.id, s), used.add(s.slot));
    }
    for (const z of d.zones) {
      if (out.has(z.id)) continue;
      const s = zones.find((x) => x.tag === z.tag && !used.has(x.slot)) ?? zones.find((x) => !used.has(x.slot)) ?? zones[0];
      if (s) (out.set(z.id, s), used.add(s.slot));
    }
    return out;
  }

  /** Where an entity stands: its anchor, else a spot inside its zone; several on one anchor fan out. */
  #where(e: Entity, zone: ZoneSpec | undefined): V3 {
    const n = this.#pops.length;
    const b = zone?.bounds ?? this.#layout.cameraBounds;
    const a = zone?.anchors[e.anchor] ?? [b.min[0] + (b.max[0] - b.min[0]) * (0.25 + 0.5 * hash(n + 3)), zone?.floorY ?? this.#groundY, b.min[2] + (b.max[2] - b.min[2]) * (0.25 + 0.5 * hash(n + 11))];
    const key = `${e.zone}/${e.anchor}`;
    const k = this.#onAnchor.get(key) ?? 0;
    this.#onAnchor.set(key, k + 1);
    const ang = k * 2.4;
    return k ? [a[0] + Math.cos(ang) * 1.3 * Math.sqrt(k), a[1], a[2] + Math.sin(ang) * 1.3 * Math.sqrt(k)] : [a[0], a[1], a[2]];
  }

  #pop(kind: Entity["kind"], team: string, at: V3, size: readonly number[]) {
    const k = this.#k;
    const g = new Group();
    const tm = team === "red" || team === "blue" ? k.team[team] : k.glow;
    const [sx, sy, sz] = [Math.max(0.2, size[0]!), Math.max(0.1, size[1]!), Math.max(0.2, size[2]!)];
    let height = sy;
    const add = (m: Mesh, y = 0) => (m.position.y = y, g.add(m), m);
    switch (kind) {
      case "spawn":
      case "checkpoint": {
        const ring = add(new Mesh(k.geo.ring, tm), 0.05);
        ring.rotation.x = -Math.PI / 2;
        height = 3;
        break;
      }
      case "goal": {
        const ring = add(new Mesh(k.geo.torus, tm), 1.5);
        ring.rotation.y = Math.PI / 2;
        height = 3;
        break;
      }
      case "pickup": {
        add(new Mesh(k.geo.orb, k.team.orb), 0.9).scale.setScalar(0.28);
        const ring = add(new Mesh(k.geo.ring, k.team.orb), 0.03);
        ring.rotation.x = -Math.PI / 2;
        ring.scale.setScalar(0.8);
        height = 1.4;
        break;
      }
      case "npc": {
        add(new Mesh(k.geo.capsule, tm), 0.9);
        height = 1.8;
        break;
      }
      default: {
        // a body with outlined top edges, its own size
        add(new Mesh(k.geo.box, k.body), sy / 2).scale.set(sx, sy, sz);
        const lines = new BoxBatch();
        const [hx, hz] = [sx / 2, sz / 2];
        for (const zz of [-hz, hz]) lines.strip([-hx, sy, zz], [hx, sy, zz], 0.05, [1.6, 1.6, 1.6]);
        for (const xx of [-hx, hx]) lines.strip([xx, sy, -hz], [xx, sy, hz], 0.05, [1.6, 1.6, 1.6]);
        const geo = lines.build();
        this.#geos.push(geo);
        g.add(new Mesh(geo, k.line));
      }
    }
    // a beam of light where it lands, shrinking away as the thing settles
    const flash = new Mesh(k.geo.beam, k.flash);
    flash.visible = false;
    this.root.add(flash);
    flash.position.set(at[0], at[1], at[2]);
    g.position.set(at[0], at[1], at[2]);
    g.scale.setScalar(0);
    this.root.add(g);
    const t = this.#t0 ? (performance.now() - this.#t0) / 1000 : 0;
    this.#nextPopAt = Math.max(this.#nextPopAt + POP_GAP_S, t);
    this.#pops.push({ obj: g, flash, at: this.#nextPopAt, height: Math.max(2.5, height + 1.5) });
  }

  /** One frame: the clock, the pops, and the camera on its slow orbit round the layout. */
  update(now: number, cam: PerspectiveCamera) {
    const t = (now - this.#t0) / 1000;
    const [cx, cy, cz] = this.#centre;
    uT.value = t;
    uEdge.value.set(...this.#colours[0]);
    uFill.value.set(...this.#colours[1]);
    uGrid.value.set(...this.#colours[2]);
    uCentre.value.set(cx, cz);
    uSpeed.value = this.#speed;
    uReach.value = this.#reach;
    for (const p of this.#pops) {
      const u = (t - p.at) / POP_S;
      if (u < 0) continue;
      p.obj.scale.setScalar(u >= 1 ? 1 : Math.max(0, backOut(u)));
      const f = Math.min(1, u / 2);
      const r = f >= 1 ? 0 : 0.55 * (1 - f);
      p.flash.visible = r > 0;
      p.flash.scale.set(r, p.height * Math.min(1, u * 3), r);
    }
    const a = this.#yaw0 - 0.35 + t * 0.09;
    const r = this.#radius * (1.25 - 0.25 * easeOut(Math.min(1, t / 3)));
    cam.position.set(cx + Math.sin(a) * r, cy + r * 0.62, cz + Math.cos(a) * r);
    cam.lookAt(cx, cy + 1.5, cz);
  }

  dispose() {
    for (const g of this.#geos) g.dispose();
    this.root.removeFromParent();
  }

  /** A small preview with one of every kind of thing, for the shader prewarm. */
  static sample(): Materialise {
    const m = new Materialise({ pack: "arena", sub: [], seed: 1, look: "neon" });
    const kinds: Entity["kind"][] = ["spawn", "goal", "pickup", "npc", "prop"];
    kinds.forEach((kind, i) => m.#pop(kind, i === 0 ? "red" : i === 1 ? "blue" : "", [i * 3, 0, 0], KIND_SIZE[kind] ?? [1, 1, 1]));
    return m;
  }
}
