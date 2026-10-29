// Haunted: moonlight through mist, dead grass, old stone gone green at the foot, tombs with candles
// guttering on them, gravestones leaning, bare twisted trees, iron spikes along the walls, bats
// circling. Indoors the walls are dark panelling under faded damask; a haunted library's are
// shelves of crumbling books.
import type { WorldBundle } from "@ghostrun/ir";
import { BufferGeometry, ConeGeometry, CylinderGeometry, Float32BufferAttribute, InstancedMesh, Matrix4, MeshBasicNodeMaterial, MeshStandardNodeMaterial, Object3D, PlaneGeometry, SphereGeometry, BoxGeometry, DoubleSide } from "three/webgpu";
import { abs, float, floor, fract, hash, instanceIndex, length, max, mix, oneMinus, positionWorld, sin, smoothstep, step, time, uv, vec2, vec3 } from "three/tsl";
import { BoxBatch } from "../boxes";
import type { LookStyle } from "../looks";
import { lin } from "../materials";
import { books, CLS, groundMaterial, hex3, is, liquidMaterial, masonry, noise01, planks, staticsMaterial } from "../surfaces";
import { batchMesh, classify, clear, cutWall, instances, lamps, merged, ring, rnd, style, type Ctx, type Dressed, type Item, type V3 } from "./common";

/** A bare dead tree, 6 m at scale 1: a leaning trunk, crooked limbs. */
function deadTree() {
  const bark = "#2e2824";
  const parts = [
    { geo: new CylinderGeometry(0.12, 0.28, 3.4, 6), color: bark, at: [0, 1.7, 0] as V3, rot: [0, 0, 0.06] as V3 },
    { geo: new CylinderGeometry(0.06, 0.12, 2.2, 5), color: bark, at: [0.55, 3.7, 0.1] as V3, rot: [0.2, 0, -0.6] as V3 },
    { geo: new CylinderGeometry(0.05, 0.11, 2, 5), color: bark, at: [-0.6, 3.5, -0.2] as V3, rot: [-0.3, 0, 0.75] as V3 },
    { geo: new CylinderGeometry(0.04, 0.09, 1.8, 5), color: bark, at: [0.1, 4.2, -0.5] as V3, rot: [-0.55, 0, 0.1] as V3 },
    { geo: new CylinderGeometry(0.03, 0.06, 1.3, 4), color: bark, at: [1.2, 4.6, 0.2] as V3, rot: [0, 0, -1.1] as V3 },
    { geo: new CylinderGeometry(0.03, 0.06, 1.2, 4), color: bark, at: [-1.25, 4.3, -0.3] as V3, rot: [0, 0, 1.2] as V3 },
    { geo: new CylinderGeometry(0.03, 0.05, 1, 4), color: bark, at: [0.3, 5, -0.9] as V3, rot: [-0.9, 0, 0] as V3 },
  ];
  return merged(parts);
}

/** A gravestone, 1.1 m tall at scale 1: a slab with a rounded head. */
function gravestone() {
  return merged([
    { geo: new BoxGeometry(0.62, 0.8, 0.16), at: [0, 0.4, 0] },
    { geo: new CylinderGeometry(0.31, 0.31, 0.16, 14, 1, false, 0, Math.PI), at: [0, 0.8, 0], rot: [Math.PI / 2, Math.PI / 2, 0] },
  ]);
}

/** A bat: a body and two triangular wings (flapped by scaling). */
function bat() {
  const g = new BufferGeometry();
  const v = [0, 0, 0, 0.32, 0.04, -0.12, 0.28, 0.02, 0.12, 0, 0, 0, -0.28, 0.02, 0.12, -0.32, 0.04, -0.12];
  g.setAttribute("position", new Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

export function dressHaunted(b: WorldBundle, look: LookStyle, c: Ctx): Dressed {
  const library = look.variant === "library";
  const { pieces, bounds, groundY } = classify(b);
  const solid = new BoxBatch();
  const pool = new BoxBatch();
  const floorTops: number[] = [];
  const trees: Item[] = [];
  const graves: Item[] = [];
  const candles: Item[] = [];
  const flames: Item[] = [];
  const spikes: Item[] = [];
  const lightAt: V3[] = [];
  const cut = look.cutaway;
  const stone = (i: number) => lin(["#4a4852", "#55525c", "#423f48"][i % 3]!);
  const candle = (x: number, y: number, z: number, k: number) => {
    const h = 0.18 + rnd(k) * 0.22;
    candles.push({ p: [x, y + h / 2, z], s: [0.05, h, 0.05], color: "#e8dcc0" });
    flames.push({ p: [x, y + h + 0.07, z], s: [0.045, 0.1, 0.045], color: "#ffb04a", scale: 4 });
  };

  for (const p of pieces) {
    const { s, i } = p;
    const [x, y, z] = s.pos;
    const [w, h, d] = s.size;
    switch (p.kind) {
      case "ground":
      case "floor":
      case "mound":
      case "path":
        floorTops.push(p.top);
        {
          // inside the house, old boards; out in the grounds, dead grass
          const inside = cut && x > bounds.minX - 0.1 && x < bounds.maxX + 0.1 && z > bounds.minZ - 0.1 && z < bounds.maxZ + 0.1;
          solid.add(s.pos, s.size, lin(inside ? "#6a5444" : p.kind === "path" ? "#4a443c" : "#3e4234"), style(p.kind === "path" ? CLS.path : CLS.ground, i, 0, inside ? 1 : 0));
        }
        break;
      case "water":
      case "hazard":
        pool.add([x, p.top - 0.01, z], [w, 0.04, d], [1, 1, 1]);
        break;
      case "wall":
        if (cut) cutWall(solid, p, lin("#5a4a52"), library ? 2 : 1);
        else solid.add(s.pos, s.size, library ? lin("#4a3426") : stone(i), style(CLS.wall, i, h, library ? 2 : 0));
        if (rnd(i) < (cut ? 0.25 : 0.12) && Math.max(w, d) > 2) {
          // candles along the wall tops and ledges
          const top = cut ? p.min[1] + Math.min(h, 1.25) : p.top;
          const along = w > d;
          for (let k = 0; k < 3; k++) candle(along ? x + (k - 1) * 0.18 : x, top, along ? z : z + (k - 1) * 0.18, i * 7 + k);
          lightAt.push([x, top + 0.6, z]);
        }
        break;
      case "trunk":
        trees.push({ p: [x, p.min[1], z], s: [Math.max(w, d) * 2.2, h / 5.5, Math.max(w, d) * 2.2], r: rnd(i) * 6 });
        break;
      case "cover":
        // a tomb: the box itself in old stone, a few candles on its lid
        solid.add(s.pos, s.size, stone(i), style(CLS.cover, i, p.top));
        if (rnd(i + 3) < 0.5) {
          for (let k = 0; k < 2 + Math.floor(rnd(i) * 2); k++) candle(x + (rnd(i * 5 + k) - 0.5) * w * 0.6, p.top, z + (rnd(i * 5 + k + 1) - 0.5) * d * 0.6, i * 11 + k);
          lightAt.push([x, p.top + 0.8, z]);
        }
        break;
      case "boundary": {
        solid.add(s.pos, s.size, stone(i), style(CLS.wall, i, h));
        // iron spikes along the top
        const along = w > d;
        const len = along ? w : d;
        for (let k = 0; k < len / 0.45; k++) {
          const t = -len / 2 + 0.22 + k * 0.45;
          spikes.push({ p: [along ? x + t : x, p.top + 0.35, along ? z : z + t], s: [1, 1, 1] });
        }
        break;
      }
      case "lintel": // over a doorway, above the cut-away walls
        break;
      default:
        solid.add(s.pos, s.size, stone(i), style(CLS.ledge, i, p.top));
    }
  }

  // a graveyard's worth of leaning headstones on open ground, clear of everything you collide with
  if (!cut && b.pack.id !== "maze") {
    const spots = b.entities.map((e) => e.pos);
    for (let k = 0; k < 70; k++) {
      const x = bounds.minX + 2 + rnd(k * 3 + 1) * (bounds.maxX - bounds.minX - 4);
      const z = bounds.minZ + 2 + rnd(k * 3 + 2) * (bounds.maxZ - bounds.minZ - 4);
      if (!clear(pieces, x, z, 0.9, ["wall", "boundary", "block", "cover", "ledge", "trunk", "path", "water"]) || spots.some((e) => Math.hypot(e[0] - x, e[2] - z) < 2.5)) continue;
      const s = 0.8 + rnd(k) * 0.5;
      graves.push({ p: [x, groundY, z], s: [s, s, s], r: Math.round(rnd(k + 9) * 3) * (Math.PI / 2) + (rnd(k + 4) - 0.5) * 0.3, tilt: [(rnd(k + 5) - 0.5) * 0.25, (rnd(k + 6) - 0.5) * 0.25], color: ["#8a8894", "#7a7884", "#9a98a2"][k % 3]! });
    }
  }
  // the horizon: black hills and dead trees against the moon
  const hills = ring(bounds, 18, 18, 30, 800).map(({ x, z, k }): Item => ({ p: [x, groundY - 2, z], s: [14 + rnd(k) * 16, 6 + rnd(k + 1) * 10, 14 + rnd(k) * 16], r: rnd(k + 2) * 6 }));
  if (!cut) for (const { x, z, k } of ring(bounds, 50, 4, 20, 820)) trees.push({ p: [x, groundY, z], s: [1 + rnd(k) * 0.5, 1 + rnd(k + 1) * 0.6, 1 + rnd(k) * 0.5], r: rnd(k + 2) * 6 });

  // ---- materials ----------------------------------------------------------------------------
  const mat = staticsMaterial((a) => {
    const n1 = noise01(a.p, 0.5);
    const fine = noise01(a.p, 3.7, 2);
    // old stone: blocks, mortar gone dark, grime and moss rising from the ground
    const m = masonry(a.along, a.up, 0.9, 0.42, 0.06);
    const blocks = mix(m.id.mul(0.25).add(0.82), float(0.45), m.mortar).mul(fine.mul(0.25).add(0.85));
    const moss = smoothstep(1.4, 0.0, a.p.y.sub(groundY).add(n1.mul(0.8))).mul(0.6);
    // indoors: dark wainscot below, faded damask above
    const wainscot = step(a.p.y.sub(groundY), float(0.75));
    const damask = sin(a.along.mul(9)).mul(sin(a.p.y.mul(9))).abs().pow(3).mul(0.25).add(0.75);
    const panel = mix(damask, planks(a.p.y, a.along, 0.2, 2.2).id.mul(0.2).add(0.6), wainscot);
    // a library's shelves: rows of book spines, dusty
    const bk = books(a.along, a.p.y.sub(groundY));
    const shelves = bk.tone.mul(0.8);
    const bookTint = bk.tint.mul(0.85);
    const alt = a.alt;
    const isWall = is(a.cls, CLS.wall);
    const wallSide = mix(mix(blocks, panel, is(alt, 1)), shelves, is(alt, 2));
    // floors: dead grass outside, worn boards inside
    const grass = mix(n1.mul(0.3).add(0.75), fine.mul(0.3).add(0.6), smoothstep(0.55, 0.7, noise01(a.p, 0.15, 5)));
    const boards = planks(a.p.x, a.p.z, 0.22, 2.4);
    const floorTone = mix(grass, mix(boards.id.mul(0.25).add(0.7), float(0.35), boards.seam), is(alt, 1));
    const flat = max(is(a.cls, CLS.ground), is(a.cls, CLS.path));
    const lid = smoothstep(0.03, 0.0, abs(a.p.y.sub(a.extra).add(0.12))).mul(is(a.cls, CLS.cover));
    const k = mix(mix(blocks, wallSide, isWall).mul(oneMinus(lid.mul(0.5))), mix(blocks, floorTone, flat), max(a.top, flat));
    const tint = mix(vec3(1, 1, 1), hex3("#6a8a4a").mul(1.4), moss.mul(oneMinus(flat)).mul(oneMinus(is(alt, 1))));
    const color = mix(vec3(k, k, k).mul(tint), bookTint.mul(shelves).mul(2), is(alt, 2).mul(isWall).mul(oneMinus(a.top)));
    return { color, roughness: float(0.9), bump: m.mortar.mul(-0.03).mul(isWall).mul(oneMinus(is(alt, 2))) };
  }, { roughness: 0.9, bump: 1 });
  batchMesh(c, solid, mat, "statics");
  batchMesh(c, pool, liquidMaterial({ deep: "#0a1a10", shallow: "#2a5a2a", glow: "#5aff7a", glowScale: 0.6, roughness: 0.3, flow: 0.3 }), "ooze");

  instances(c, deadTree(), new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }), trees, "dead trees");
  instances(c, gravestone(), new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92, flatShading: true }), graves, "gravestones");
  instances(c, new CylinderGeometry(1, 1, 1, 6), new MeshStandardNodeMaterial({ roughness: 0.6 }), candles, "candles");
  // flames flicker on their own: each instance its own phase
  const flame = new MeshBasicNodeMaterial();
  const ph = hash(instanceIndex.toFloat().add(3.3)).mul(40);
  flame.colorNode = vec3(1, 1, 1).mul(sin(time.mul(11).add(ph)).mul(0.18).add(sin(time.mul(27).add(ph.mul(2))).mul(0.1)).add(0.85));
  instances(c, new ConeGeometry(1, 1, 6), flame, flames, "flames");
  const iron = new MeshStandardNodeMaterial({ color: "#1a1a20", roughness: 0.5, metalness: 0.7 });
  instances(c, merged([{ geo: new CylinderGeometry(0.02, 0.02, 0.6, 4), at: [0, -0.05, 0] }, { geo: new ConeGeometry(0.05, 0.16, 4), at: [0, 0.32, 0] }]), iron, spikes, "spikes");
  const hillMat = new MeshStandardNodeMaterial({ color: "#14121c", roughness: 1 });
  instances(c, new SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), hillMat, hills, "hills");
  lamps(c, lightAt, "#ff9a3a", 10, 8, 3, 0.35);

  // low mist: soft sheets drifting just above the ground
  const mist = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
  const r = length(uv().sub(0.5)).mul(2);
  const drift = noise01(vec3(positionWorld.x.mul(0.12).add(time.mul(0.05)), positionWorld.z.mul(0.12), time.mul(0.03)), 1);
  mist.colorNode = hex3("#9a96b8");
  mist.opacityNode = oneMinus(smoothstep(0.2, 1, r)).mul(drift).mul(0.22);
  const sheets: Item[] = [];
  for (let k = 0; k < 26; k++) {
    const x = bounds.minX + rnd(k * 9 + 1) * (bounds.maxX - bounds.minX);
    const z = bounds.minZ + rnd(k * 9 + 2) * (bounds.maxZ - bounds.minZ);
    const s = 7 + rnd(k * 9 + 3) * 8;
    sheets.push({ p: [x, groundY + 0.25 + rnd(k * 9 + 4) * 0.5, z], s: [s, s, s], tilt: [-Math.PI / 2, 0], r: rnd(k) * 6 });
  }
  const sheet = instances(c, new PlaneGeometry(1, 1), mist, sheets, "mist");
  if (sheet) sheet.renderOrder = 5;

  // bats circling over the place, animated on the CPU (a dozen is nothing)
  if (!cut || b.pack.id !== "floor_plan") {
    const n = 12;
    const bats = new InstancedMesh(c.keep(bat()), c.keep(new MeshBasicNodeMaterial({ color: "#06050a", side: DoubleSide })), n);
    const o = new Object3D();
    const m4 = new Matrix4();
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    c.animated.push((t) => {
      for (let k = 0; k < n; k++) {
        const a = t * (0.35 + rnd(k) * 0.3) + k * 1.7;
        const rr = 6 + rnd(k + 1) * 14;
        o.position.set(cx + Math.cos(a) * rr, groundY + 7 + rnd(k + 2) * 6 + Math.sin(t * 1.3 + k) * 0.8, cz + Math.sin(a) * rr);
        o.rotation.set(0, -a, 0);
        o.scale.set(1.4, 1.4 * (0.3 + Math.abs(Math.sin(t * 14 + k * 3))), 1.4);
        o.updateMatrix();
        bats.setMatrixAt(k, m4.copy(o.matrix));
      }
      bats.instanceMatrix.needsUpdate = true;
    });
    bats.frustumCulled = false;
    c.root.add(bats);
  }

  const ground = groundMaterial((p) => {
    const n1 = noise01(p, 0.12);
    const patch = smoothstep(0.45, 0.65, noise01(p, 0.3, 4));
    const fine = noise01(p, 3, 6);
    const color = mix(hex3("#3a3e2e"), hex3("#2a2420"), patch).mul(fine.mul(0.25).add(n1.mul(0.2)).add(0.7));
    return { color, roughness: float(0.95), bump: fine.mul(0.05) };
  }, { bump: 1 });

  return { floorTops, groundY, bounds, groundHex: "#34362a", ground, shelter: look.indoor ? bounds : null };
}
