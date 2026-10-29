// Statics for the non-city looks. Grove: terrain, trees, rocks, bushes, water and tree lines (at
// night bioluminescent canopies, glowing mushrooms and fireflies). Gallery: polished floors, pale
// walls with baseboards, white plinths and warm pools of light. The newer looks dress themselves
// (render/dressing). Colliders are never changed: each static keeps its exact box, dressed to read
// as what its shape is.
import type { WorldBundle } from "@ghostrun/ir";
import {
  Color, ConeGeometry, CylinderGeometry, DodecahedronGeometry, Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh,
  MeshStandardNodeMaterial, Object3D, PointLight, Quaternion, SphereGeometry, Vector3, type BufferGeometry, type Material,
} from "three/webgpu";
import { mx_noise_float, positionWorld, vec3, vertexColor } from "three/tsl";
import { BoxBatch } from "./boxes";
import type { LookStyle } from "./looks";
import { glowMaterial, lin, stripMaterial } from "./materials";
import { DRESS } from "./dressing";

interface Ctx {
  keep<T extends BufferGeometry | Material>(x: T): T;
  animated: ((t: number) => void)[];
  root: Group;
}

type V3 = [number, number, number];
const rnd = (i: number) => {
  const x = Math.sin(i * 78.233 + 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

/** Vertex-coloured lit boxes with a little world-space noise so large faces don't read flat. */
function terrainMaterial(roughness: number, noise: number): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness, metalness: 0 });
  const n = mx_noise_float(vec3(positionWorld.x.mul(0.35), positionWorld.y.mul(0.35), positionWorld.z.mul(0.35))).mul(noise).add(1);
  m.colorNode = vertexColor().mul(n);
  return m;
}

/** Instances of one geometry/material from a list of transforms. */
function instances(c: Ctx, geo: BufferGeometry, mat: Material, items: { p: V3; s: V3; r?: number }[]) {
  if (!items.length) return null;
  const mesh = new InstancedMesh(c.keep(geo), c.keep(mat), items.length);
  const m = new Matrix4();
  const q = new Quaternion();
  items.forEach((it, i) => {
    q.setFromAxisAngle(new Vector3(0, 1, 0), it.r ?? 0);
    mesh.setMatrixAt(i, m.compose(new Vector3(...it.p), q, new Vector3(...it.s)));
  });
  mesh.instanceMatrix.needsUpdate = true;
  c.root.add(mesh);
  return mesh;
}

export interface Scenery {
  floorTops: number[];
  /** Top of the largest floor: where the ground plane goes. */
  groundY: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  groundHex: string;
  /** A procedural ground in place of the flat groundHex. */
  ground?: Material;
  /** A cut-away building's footprint: the weather stays outside it. */
  shelter?: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
}

function mainFloor(b: WorldBundle): number {
  let best = { area: -1, top: 0 };
  for (const s of b.statics) if (s.surf === "floor" && s.size[0] * s.size[2] > best.area) best = { area: s.size[0] * s.size[2], top: s.pos[1] + s.size[1] / 2 };
  return best.top;
}

export function buildScenery(b: WorldBundle, look: LookStyle, c: Ctx): Scenery {
  if (look.variant === "underwater") return DRESS.desert(b, look, c); // a seabed under caustics, indoors or out
  if (look.id === "gallery") return gallery(b, look, c);
  if (look.id === "grove" || look.id === "neon") return grove(b, look, c);
  return DRESS[look.id](b, look, c);
}

function grove(b: WorldBundle, look: LookStyle, c: Ctx): Scenery {
  const night = look.night;
  const solid = new BoxBatch();
  const glow = new BoxBatch();
  const floorTops: number[] = [];
  let bounds = { minX: -30, maxX: 30, minZ: -30, maxZ: 30 };
  const trunks: { p: V3; s: V3 }[] = [];
  const canopy: { p: V3; s: V3; r: number }[][] = [[], [], []];
  const rocks: { p: V3; s: V3; r: number }[] = [];
  const bushes: { p: V3; s: V3; r: number }[] = [];
  const caps: { p: V3; s: V3 }[] = [];
  const grass = lin(night ? "#1d4234" : "#5d8a45");
  const path = lin(night ? "#26261f" : "#b39d74");
  const stone = lin(night ? "#2c3336" : "#8c8f88");
  const tree = (x: number, z: number, h: number, i: number) => {
    trunks.push({ p: [x, h * 0.3, z], s: [0.32, h * 0.6, 0.32] });
    const r = 0.9 + rnd(i) * 0.9;
    canopy[i % 3]!.push({ p: [x, h * 0.62, z], s: [r, h * 0.42, r], r: rnd(i + 3) * 6 });
    canopy[(i + 1) % 3]!.push({ p: [x, h * 0.86, z], s: [r * 0.7, h * 0.3, r * 0.7], r: rnd(i + 5) * 6 });
    if (night && rnd(i + 9) < 0.6) caps.push({ p: [x + 0.45, 0.12, z + 0.2], s: [0.22, 0.12, 0.22] });
  };

  b.statics.forEach((s, i) => {
    const [x, y, z] = s.pos;
    const [w, h, d] = s.size;
    const top = y + h / 2;
    if (s.surf === "floor") {
      floorTops.push(top);
      if (w * d > 1500) bounds = { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 };
      solid.add(s.pos, s.size, h < 0.06 ? path : [grass[0] * (1 + top * 0.15), grass[1] * (1 + top * 0.15), grass[2]]);
      return;
    }
    if (s.surf === "water") {
      glow.add([x, top - 0.01, z], [w, 0.02, d], lin(night ? "#1fd8c4" : "#3a86c8", night ? 0.9 : 0.5));
      return;
    }
    if (s.surf === "ledge" || s.surf === "roof") {
      solid.add(s.pos, s.size, stone);
      glow.strip([x - w / 2, top + 0.01, z - d / 2], [x + w / 2, top + 0.01, z - d / 2], 0.08, lin(night ? "#38ffcf" : "#6fae4a", night ? 2.4 : 0.8));
      glow.strip([x - w / 2, top + 0.01, z + d / 2], [x + w / 2, top + 0.01, z + d / 2], 0.08, lin(night ? "#38ffcf" : "#6fae4a", night ? 2.4 : 0.8));
      return;
    }
    if (Math.max(w, d) <= 1.0 && h >= 3) return tree(x, z, h, i);
    if (Math.min(w, d) <= 1.5 && Math.max(w, d) >= 8) {
      // perimeter: a dark hedge (the collider) with a tree line along it
      solid.add(s.pos, s.size, lin(night ? "#0b1a14" : "#2f4a26"));
      const along = w > d ? w : d;
      for (let k = 0; k < along / 2.6; k++) {
        const t = -along / 2 + 1.3 + k * 2.6;
        tree(w > d ? x + t : x + (rnd(i * 31 + k) - 0.5) * 0.6, w > d ? z + (rnd(i * 31 + k) - 0.5) * 0.6 : z + t, h + 1 + rnd(i * 17 + k) * 3, i * 101 + k);
      }
      return;
    }
    if (h < 2.5) {
      const item = { p: [x, y, z] as V3, s: [w / 2, h / 2, d / 2] as V3, r: rnd(i) * 6 };
      (rnd(i + 11) < 0.5 ? rocks : bushes).push(item);
      return;
    }
    solid.add(s.pos, s.size, lin("#4a3626")); // anything else: a timber block (cabin, stall)
  });

  // distant forest ring beyond the map: silhouettes the fog dissolves
  for (let k = 0; k < 140; k++) {
    const a = (k / 140) * Math.PI * 2;
    const rad = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2 + 6 + rnd(k) * 26;
    const h = 7 + rnd(k + 1) * 9;
    canopy[k % 3]!.push({ p: [Math.cos(a) * rad, h * 0.55, Math.sin(a) * rad], s: [2 + rnd(k + 2) * 1.6, h, 2 + rnd(k + 2) * 1.6], r: 0 });
  }

  const solidMesh = new Mesh(c.keep(solid.build()), c.keep(terrainMaterial(0.95, 0.18)));
  solidMesh.name = "statics";
  const glowMesh = new Mesh(c.keep(glow.build()), c.keep(stripMaterial()));
  c.root.add(solidMesh, glowMesh);

  const bark = new MeshStandardNodeMaterial({ color: new Color(night ? "#1d1714" : "#5a4330"), roughness: 0.95 });
  instances(c, new CylinderGeometry(0.75, 1, 1, 7), bark, trunks);
  const leaf = night ? ["#0c2b2a", "#0e2233", "#191c33"] : ["#3f7a34", "#4f8a3a", "#2f6a3c"];
  const tint = ["#2dffc4", "#4fb8ff", "#7d8cff"];
  canopy.forEach((items, k) => {
    const m = new MeshStandardNodeMaterial({ color: new Color(leaf[k]!), roughness: 0.85, flatShading: true });
    if (night) m.emissiveNode = vec3(...lin(tint[k]!, 0.07));
    instances(c, k === 1 ? new IcosahedronGeometry(1, 0) : new ConeGeometry(1, 1, 7), m, items);
  });
  instances(c, new DodecahedronGeometry(1, 0), new MeshStandardNodeMaterial({ color: new Color(night ? "#2f3a3c" : "#8a8b84"), roughness: 0.9, flatShading: true }), rocks);
  const bushMat = new MeshStandardNodeMaterial({ color: new Color(night ? "#123a2e" : "#477a33"), roughness: 0.9, flatShading: true });
  if (night) bushMat.emissiveNode = vec3(...lin("#2dffc4", 0.12));
  instances(c, new IcosahedronGeometry(1, 1), bushMat, bushes);

  if (night) {
    instances(c, new SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), glowMaterial("#7dfff0", 3.5), caps);
    // fireflies: tiny glowing points drifting over the map, animated on the CPU (cheap at this count)
    const n = 90;
    const flies = new InstancedMesh(c.keep(new SphereGeometry(0.05, 6, 4)), c.keep(glowMaterial("#d9ff7a", 6)), n);
    const seeds = Array.from({ length: n }, (_, k) => [bounds.minX + rnd(k * 3) * (bounds.maxX - bounds.minX), 0.8 + rnd(k * 3 + 1) * 3, bounds.minZ + rnd(k * 3 + 2) * (bounds.maxZ - bounds.minZ)] as V3);
    const m4 = new Matrix4();
    const o = new Object3D();
    c.animated.push((t) => {
      seeds.forEach((sd, k) => {
        o.position.set(sd[0] + Math.sin(t * 0.4 + k) * 1.2, sd[1] + Math.sin(t * 0.9 + k * 1.7) * 0.4, sd[2] + Math.cos(t * 0.35 + k * 0.6) * 1.2);
        o.updateMatrix();
        flies.setMatrixAt(k, m4.copy(o.matrix));
      });
      flies.instanceMatrix.needsUpdate = true;
    });
    c.root.add(flies);
  }
  return { floorTops, bounds, groundY: mainFloor(b), groundHex: night ? "#0c1a16" : "#4f7a3c" };
}

const CUT_H = 1.25;

function gallery(b: WorldBundle, look: LookStyle, c: Ctx): Scenery {
  const solid = new BoxBatch();
  const trim = new BoxBatch();
  const floorTops: number[] = [];
  let bounds = { minX: -30, maxX: 30, minZ: -30, maxZ: 30 };
  const lights: V3[] = [];
  const wall = lin("#efebe4");
  const floor = lin("#c9c3b8");
  const base = lin("#2c2b30");
  const floorY = mainFloor(b);
  b.statics.forEach((s) => {
    const [x, y, z] = s.pos;
    const [w, h, d] = s.size;
    const top = y + h / 2;
    if (s.surf !== "floor" && y - h / 2 >= floorY + CUT_H) return; // over a doorway: above the cut walls, so not floating there
    if (s.surf === "floor") {
      floorTops.push(top);
      if (w * d > 400 && w * d > (bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ) * 0.5) bounds = { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 };
      solid.add(s.pos, s.size, h < 0.06 ? lin("#8f8a82") : floor);
      if (w * d > 25 && lights.length < 6) lights.push([x, top + 3.2, z]);
      return;
    }
    if (s.surf === "water") {
      solid.add(s.pos, s.size, lin("#5aa6c8"));
      return;
    }
    if (s.surf === "ledge" || s.surf === "roof" || h < 1.6) {
      solid.add(s.pos, s.size, lin("#fbfaf7")); // plinths, steps, low counters
      return;
    }
    // section cut: walls draw to CUT_H (the collider keeps its full height, which no jump clears)
    // so the camera always sees the player and the whole floor plan reads at a glance
    const cut = Math.min(h, CUT_H);
    const cy = y - h / 2 + cut / 2;
    solid.add([x, cy, z], [w, cut, d], wall);
    const bh = 0.12;
    if (w >= d) {
      trim.add([x, y - h / 2 + bh / 2, z - d / 2 - 0.006], [w, bh, 0.012], base);
      trim.add([x, y - h / 2 + bh / 2, z + d / 2 + 0.006], [w, bh, 0.012], base);
    } else {
      trim.add([x - w / 2 - 0.006, y - h / 2 + bh / 2, z], [0.012, bh, d], base);
      trim.add([x + w / 2 + 0.006, y - h / 2 + bh / 2, z], [0.012, bh, d], base);
    }
    trim.add([x, y - h / 2 + cut + 0.01, z], [w + 0.02, 0.02, d + 0.02], lin("#3a3836"));
  });
  const m = terrainMaterial(0.55, 0.04);
  const solidMesh = new Mesh(c.keep(solid.build()), c.keep(m));
  solidMesh.name = "statics";
  const trimMesh = new Mesh(c.keep(trim.build()), c.keep(terrainMaterial(0.6, 0)));
  c.root.add(solidMesh, trimMesh);
  for (const p of lights) {
    const l = new PointLight("#ffd9a8", look.night ? 26 : 14, 14, 1.6);
    l.position.set(...p);
    c.root.add(l);
  }
  return { floorTops, bounds, groundY: mainFloor(b), groundHex: "#a9a296", shelter: look.indoor ? bounds : null };
}
