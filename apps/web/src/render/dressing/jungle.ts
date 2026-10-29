// Jungle: humid green haze, a mossy floor strewn with leaves, temple stone carved with glyphs and
// furred with moss from the top down, vines hanging off every wall, buttressed giant trees under
// broad canopies, ferns everywhere, and a wall of foliage closing the world in.
import type { WorldBundle } from "@ghostrun/ir";
import { ConeGeometry, CylinderGeometry, DodecahedronGeometry, IcosahedronGeometry, MeshStandardNodeMaterial, PlaneGeometry, DoubleSide } from "three/webgpu";
import { abs, float, floor, fract, hash, max, mix, oneMinus, positionLocal, positionWorld, sin, smoothstep, step, time, uv, vec3 } from "three/tsl";
import { BoxBatch } from "../boxes";
import type { LookStyle } from "../looks";
import { lin } from "../materials";
import { CLS, groundMaterial, hex3, is, liquidMaterial, masonry, noise01, staticsMaterial } from "../surfaces";
import { batchMesh, classify, clear, cutWall, instances, merged, ring, rnd, style, type Ctx, type Dressed, type Item, type Part, type V3 } from "./common";

/** A giant tree, 9 m at scale 1: a buttressed trunk and a layered canopy. */
function giant() {
  const bark = "#5a4632";
  const parts: Part[] = [{ geo: new CylinderGeometry(0.42, 0.62, 7, 8), color: bark, at: [0, 3.5, 0] }];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    parts.push({ geo: new ConeGeometry(0.5, 1.8, 4), color: bark, at: [Math.cos(a) * 0.6, 0.8, Math.sin(a) * 0.6], rot: [Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5], scale: [0.35, 1, 1.4] });
  }
  parts.push({ geo: new IcosahedronGeometry(2.8, 1), color: "#2f6a2a", at: [0, 7.6, 0], scale: [1.3, 0.55, 1.3] });
  parts.push({ geo: new IcosahedronGeometry(2.2, 1), color: "#3a7a30", at: [0.8, 8.6, -0.4], scale: [1.1, 0.5, 1.1] });
  parts.push({ geo: new IcosahedronGeometry(1.8, 1), color: "#2a5e28", at: [-1, 8.3, 0.9], scale: [1.1, 0.5, 1.1] });
  for (let k = 0; k < 5; k++) {
    const a = k * 1.3;
    parts.push({ geo: new CylinderGeometry(0.03, 0.03, 3 + (k % 3), 3), color: "#3a6a28", at: [Math.cos(a) * 2.2, 6.2 - (k % 3) * 0.5, Math.sin(a) * 2.2] });
  }
  return merged(parts);
}

/** A fern: fronds arching out from the middle, 1 m across at scale 1. */
function fern() {
  const parts: Part[] = [];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    parts.push({ geo: new ConeGeometry(0.16, 1, 4), color: k % 2 ? "#4a9a3a" : "#3a8a32", at: [Math.cos(a) * 0.32, 0.28, Math.sin(a) * 0.32] as V3, rot: [Math.sin(a) * 1.05, 0, -Math.cos(a) * 1.05] as V3, scale: [1, 1, 0.25] as V3 });
  }
  return merged(parts);
}

export function dressJungle(b: WorldBundle, look: LookStyle, c: Ctx): Dressed {
  const { pieces, bounds, groundY } = classify(b);
  const solid = new BoxBatch();
  const pool = new BoxBatch();
  const floorTops: number[] = [];
  const trees: Item[] = [];
  const ferns: Item[] = [];
  const rocks: Item[] = [];
  const vines: Item[] = [];
  const bushes: Item[] = [];
  const cut = look.cutaway;
  const stone = (i: number) => lin(["#7a7a68", "#8a8874", "#6e6e5e"][i % 3]!);
  const hang = (x: number, z: number, top: number, n: number, k: number, yaw: number, spread: number, alongX: boolean) => {
    for (let j = 0; j < n; j++) {
      const t = (rnd(k + j) - 0.5) * spread;
      const len = 0.8 + rnd(k + j + 9) * 1.8;
      vines.push({ p: [alongX ? x + t : x, top - len / 2, alongX ? z : z + t], s: [0.18, len, 1], r: yaw });
    }
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
        solid.add(s.pos, s.size, lin(p.kind === "path" ? "#7a6a4e" : cut || b.pack.id === "maze" ? "#8a8674" : "#4a6a32"), style(p.kind === "path" ? CLS.path : CLS.ground, i, 0, cut || b.pack.id === "maze" ? 1 : 0));
        break;
      case "water":
      case "hazard":
        pool.add([x, p.top - 0.01, z], [w, 0.04, d], [1, 1, 1]);
        break;
      case "wall":
      case "block":
      case "ledge": {
        if (p.kind === "wall" && cut) cutWall(solid, p, stone(i));
        else solid.add(s.pos, s.size, stone(i), style(p.kind === "wall" ? CLS.wall : CLS.ledge, i, p.kind === "wall" && cut ? p.min[1] + 1.25 : p.top));
        // vines off the top edge, on both long faces
        if (!cut && rnd(i) < 0.7) {
          const alongX = w >= d;
          const half = alongX ? d / 2 + 0.03 : w / 2 + 0.03;
          for (const side of [-1, 1]) hang(alongX ? x : x + side * half, alongX ? z + side * half : z, p.top, Math.ceil(Math.max(w, d) / 1.6), i * 13 + side, alongX ? 0 : Math.PI / 2, Math.max(w, d) * 0.9, alongX);
        }
        break;
      }
      case "boundary":
        solid.add(s.pos, s.size, lin("#2a4a24"), style(CLS.cover, i, p.top));
        break;
      case "trunk":
        trees.push({ p: [x, p.min[1], z], s: [Math.max(w, d) * 1.6, h / 7, Math.max(w, d) * 1.6], r: rnd(i) * 6 });
        break;
      case "cover":
        rocks.push({ p: [x, y, z], s: [w / 2 + 0.05, h / 2 + 0.05, d / 2 + 0.05], r: rnd(i) * 6, color: ["#6a7a58", "#7a8a62", "#5e6e4e"][i % 3]! });
        for (let k = 0; k < 2; k++) ferns.push({ p: [x + (rnd(i * 3 + k) - 0.5) * (w + 1), groundY, z + (rnd(i * 3 + k + 1) - 0.5) * (d + 1)], s: [1.2, 1, 1.2], r: rnd(i + k) * 6 });
    }
  }

  if (!cut) {
    // the green wall: giants and bushes just beyond the edge, ferns across open ground
    for (const { x, z, k } of ring(bounds, 70, 2, 16, 1500)) trees.push({ p: [x, groundY, z], s: [1 + rnd(k) * 0.4, 0.9 + rnd(k + 1) * 0.5, 1 + rnd(k) * 0.4], r: rnd(k + 2) * 6 });
    for (const { x, z, k } of ring(bounds, 110, -1, 4, 1600)) bushes.push({ p: [x, groundY + 0.6, z], s: [1.6 + rnd(k) * 1.4, 1.2 + rnd(k + 1), 1.6 + rnd(k) * 1.4], r: rnd(k) * 6, color: ["#2a5a24", "#326a2a", "#244e20"][k % 3]! });
    const spots = b.entities.map((e) => e.pos);
    for (let k = 0; k < 80; k++) {
      const x = bounds.minX + 1.5 + rnd(k * 3 + 31) * (bounds.maxX - bounds.minX - 3);
      const z = bounds.minZ + 1.5 + rnd(k * 3 + 32) * (bounds.maxZ - bounds.minZ - 3);
      // clear of things and of where the camera trails the player from a spawn
      if (!clear(pieces, x, z, 0.6) || spots.some((e) => Math.hypot(e[0] - x, e[2] - z) < 4)) continue;
      ferns.push({ p: [x, groundY, z], s: [0.7 + rnd(k) * 0.6, 0.5 + rnd(k + 1) * 0.4, 0.7 + rnd(k) * 0.6], r: rnd(k + 2) * 6 });
    }
  }

  // ---- materials ----------------------------------------------------------------------------
  const mat = staticsMaterial((a) => {
    const n1 = noise01(a.p, 0.45);
    const fine = noise01(a.p, 3.4, 6);
    const m = masonry(a.along, a.up, 1.2, 0.6, 0.05);
    const blocks = mix(m.id.mul(0.2).add(0.86), float(0.5), m.mortar).mul(fine.mul(0.2).add(0.88));
    // a band of carved glyphs: square spirals in a row of panels
    const gu = fract(a.along.div(0.8));
    const gv = fract(a.p.y.sub(groundY).sub(1.4).div(0.8));
    const inBand = step(1.4, a.p.y.sub(groundY)).mul(step(a.p.y.sub(groundY), 2.2));
    const glyph = step(0.5, fract(max(abs(gu.sub(0.5)), abs(gv.sub(0.5))).mul(4).add(hash(floor(a.along.div(0.8))).mul(0.5)))).mul(inBand);
    // moss: on every top, and creeping down the faces from the top edge (aStyle.z)
    const fromTop = a.extra.sub(a.p.y);
    const creep = smoothstep(1.2, 0.0, fromTop.add(n1.mul(0.9).sub(0.3)));
    const moss = max(a.top.mul(smoothstep(0.3, 0.55, n1.add(0.2))), creep.mul(0.85));
    const mossCol = hex3("#4a7a2a").mul(fine.mul(0.4).add(0.7)).div(0.5);
    // the green wall: leaves, light and dark
    const leaves = mix(float(0.6), float(1.2), step(0.5, noise01(a.p, 2.2)));
    const isFoliage = is(a.cls, CLS.cover);
    const flat = max(is(a.cls, CLS.ground), is(a.cls, CLS.path));
    const soil = mix(fine.mul(0.3).add(0.75), float(0.55), step(0.82, fine)); // dark wet patches
    const flags = mix(blocks, float(0.6), m.mortar);
    const floorK = mix(soil, flags, is(a.alt, 1));
    const k = mix(blocks.mul(oneMinus(glyph.mul(0.35))), floorK, flat);
    const stoneCol = mix(vec3(k, k, k), mossCol, moss.mul(oneMinus(flat)).add(flat.mul(is(a.alt, 1)).mul(m.mortar).mul(0.8)).min(1));
    return { color: mix(stoneCol, vec3(leaves, leaves, leaves), isFoliage), roughness: float(0.9), bump: m.mortar.mul(-0.03).add(glyph.mul(-0.01)) };
  }, { roughness: 0.9, bump: 1 });
  batchMesh(c, solid, mat, "statics");
  batchMesh(c, pool, liquidMaterial({ deep: "#1a3a22", shallow: "#4a7a3a", roughness: 0.15, flow: 0.5 }), "river");

  const plant = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });
  instances(c, giant(), plant, trees, "giants");
  instances(c, fern(), new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8, flatShading: true, side: DoubleSide }), ferns, "ferns");
  instances(c, new DodecahedronGeometry(1, 0), new MeshStandardNodeMaterial({ roughness: 0.9, flatShading: true }), rocks, "rocks");
  instances(c, new IcosahedronGeometry(1, 1), new MeshStandardNodeMaterial({ roughness: 0.9, flatShading: true }), bushes, "bushes");
  // vines: thin ragged strips that sway a little
  const vine = new MeshStandardNodeMaterial({ color: "#3a6a26", roughness: 0.8, side: DoubleSide });
  const leafy = step(0.35, noise01(vec3(uv().x.mul(3), uv().y.mul(14), positionWorld.x), 1));
  vine.opacityNode = leafy.mul(smoothstep(0.0, 0.15, uv().y)).max(step(abs(uv().x.sub(0.5)), 0.12));
  vine.alphaTest = 0.5;
  // instancing has already placed positionLocal in the world: the tips sway, the tops stay put
  vine.positionNode = positionLocal.add(vec3(sin(time.mul(1.1).add(positionWorld.x)).mul(oneMinus(uv().y)).mul(0.08), 0, 0));
  instances(c, new PlaneGeometry(1, 1, 1, 4), vine, vines, "vines");

  const ground = groundMaterial((p) => {
    const n1 = noise01(p, 0.14);
    const fine = noise01(p, 3.2, 2);
    const moss = smoothstep(0.45, 0.62, noise01(p, 0.35, 5));
    const litter = step(0.86, noise01(p, 5.5, 9)); // fallen leaves, orange and brown
    const base = mix(hex3("#3a3020"), hex3("#3e6a2a"), moss).mul(fine.mul(0.25).add(n1.mul(0.15)).add(0.75));
    return { color: mix(base, hex3("#9a6a2a"), litter.mul(0.7)), roughness: float(0.95), bump: fine.mul(0.04) };
  }, { bump: 1 });

  return { floorTops, groundY, bounds, groundHex: "#3e5a2a", ground, shelter: look.indoor ? bounds : null };
}
