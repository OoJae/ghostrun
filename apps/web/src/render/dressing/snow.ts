// Snow: drifts that glitter where the light catches them, every top capped white, packed-ice and
// stone sides, snow-laden pines, boulders and white peaks on the horizon. The cave variant is the
// inside of a glacier: dark blue rock and ice, lit by glowing crystals.
import type { WorldBundle } from "@ghostrun/ir";
import { ConeGeometry, CylinderGeometry, DodecahedronGeometry, MeshBasicNodeMaterial, MeshStandardNodeMaterial, OctahedronGeometry } from "three/webgpu";
import { abs, float, hash, max, mix, normalWorld, oneMinus, positionViewDirection, positionWorld, pow, smoothstep, vec3, vertexColor } from "three/tsl";
import { BoxBatch } from "../boxes";
import type { LookStyle } from "../looks";
import { lin } from "../materials";
import { CLS, groundMaterial, hex3, is, liquidMaterial, masonry, noise01, staticsMaterial, type N3 } from "../surfaces";
import { batchMesh, classify, clear, cutWall, instances, lamps, merged, ring, rnd, style, type Ctx, type Dressed, type Item, type V3 } from "./common";

/** A snow-laden pine, 6 m tall at scale 1: dark tiers, each with a white cap. */
function pine() {
  const parts = [{ geo: new CylinderGeometry(0.14, 0.2, 1.4, 6), color: "#4a3426", at: [0, 0.7, 0] as V3 }];
  for (let k = 0; k < 4; k++) {
    const y = 1.2 + k * 1.15;
    const r = 1.55 - k * 0.32;
    parts.push({ geo: new ConeGeometry(r, 1.9, 8), color: k % 2 ? "#24483a" : "#2a5240", at: [0, y + 0.95, 0] });
    parts.push({ geo: new ConeGeometry(r * 0.72, 0.9, 8), color: "#f2f6fb", at: [0, y + 1.45, 0] });
  }
  return merged(parts);
}

/** The sparkle of snow: tiny facets that flash when the view lines up with them. */
const glitter = (p: N3, density: number) => {
  const cell = p.mul(density).floor();
  const h = hash(cell.x.add(cell.y.mul(17)).add(cell.z.mul(131)).add(9000));
  const facing = max(normalWorld.dot(positionViewDirection.negate()), 0);
  return smoothstep(0.985, 1, h).mul(pow(facing, 3)).mul(hash(cell.x.add(cell.z.mul(7.7))).add(0.5));
};

export function dressSnow(b: WorldBundle, look: LookStyle, c: Ctx): Dressed {
  const cave = look.variant === "cave";
  const { pieces, bounds, groundY } = classify(b);
  const solid = new BoxBatch();
  const floors = new BoxBatch();
  const ice = new BoxBatch();
  const hot = new BoxBatch();
  const floorTops: number[] = [];
  const trees: Item[] = [];
  const rocks: Item[] = [];
  const crystals: Item[] = [];
  const glowAt: V3[] = [];
  const snow = lin(cave ? "#5a7898" : "#f4f7fb");
  const rock = (i: number) => lin(cave ? ["#2a3a52", "#34465e", "#24324a"][i % 3]! : ["#8a96a6", "#9aa6b4", "#7a8696"][i % 3]!);
  const iceRgb = lin(cave ? "#5a9ad0" : "#bcdcf0");
  const cut = look.cutaway;

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
        floors.add(s.pos, s.size, p.kind === "path" ? [snow[0] * 0.86, snow[1] * 0.9, snow[2] * 0.96] : snow, style(CLS.ground, i));
        break;
      case "water":
        ice.add([x, p.top - 0.01, z], [w, 0.02, d], [1, 1, 1]);
        break;
      case "hazard":
        hot.add([x, p.top - 0.01, z], [w, 0.04, d], [1, 1, 1]);
        break;
      case "wall":
        if (cut) cutWall(solid, p, rock(i));
        else solid.add(s.pos, s.size, cave ? rock(i) : iceRgb, style(CLS.wall, i));
        if (cave && rnd(i) < 0.6) {
          // crystals growing out of the cave walls, some lighting the passage
          const along = w > d;
          const cx = along ? x + (rnd(i + 1) - 0.5) * w * 0.8 : x + (w / 2 + 0.05) * (rnd(i + 2) < 0.5 ? -1 : 1);
          const cz = along ? z + (d / 2 + 0.05) * (rnd(i + 2) < 0.5 ? -1 : 1) : z + (rnd(i + 1) - 0.5) * d * 0.8;
          // a cluster at the foot of the wall, and now and then one up on its top where it shows from afar
          for (let k = 0; k < 3; k++) {
            const ch = 0.35 + rnd(i * 3 + k + 3) * 0.6;
            crystals.push({ p: [cx + (rnd(i * 3 + k) - 0.5) * 0.5, p.min[1] + ch * 0.8, cz + (rnd(i * 3 + k + 1) - 0.5) * 0.5], s: [ch * 0.32, ch, ch * 0.32], r: rnd(i + 4 + k) * 6, tilt: [(rnd(i + 5 + k) - 0.5) * 0.9, (rnd(i + 6 + k) - 0.5) * 0.9], color: rnd(i + 7) < 0.6 ? "#7fe8ff" : "#a08aff", scale: 2.6 });
          }
          if (rnd(i + 9) < 0.35) crystals.push({ p: [x, p.top + 0.35, z], s: [0.22, 0.5, 0.22], r: rnd(i) * 6, tilt: [0.3, -0.2], color: "#7fe8ff", scale: 3 });
          if (rnd(i + 8) < 0.4) glowAt.push([cx, p.min[1] + 1.2, cz]);
        }
        break;
      case "trunk":
        trees.push({ p: [x, p.min[1], z], s: [Math.max(w, d) * 2.4, h / 6, Math.max(w, d) * 2.4], r: rnd(i) * 6 });
        break;
      case "cover":
        rocks.push({ p: [x, y, z], s: [w / 2 + 0.05, h / 2 + 0.05, d / 2 + 0.05], r: rnd(i) * 6, color: cave ? "#3a4a64" : "#9aa4b0" });
        break;
      case "lintel": // over a doorway, above the cut-away walls
        break;
      default: {
        // ledges and the outer walls are packed ice outdoors; in a cave everything is rock
        const icy = !cave && (p.kind === "ledge" || p.kind === "boundary");
        solid.add(s.pos, s.size, icy ? iceRgb : rock(i), style(icy ? CLS.ledge : CLS.wall, i));
      }
    }
  }

  // pines along the edges and beyond the walls, snow-covered boulders scattered
  const outdoor = !cut && !cave;
  if (outdoor) {
    for (const { x, z, k } of ring(bounds, 120, 3, 26, 300)) trees.push({ p: [x, groundY, z], s: [1 + rnd(k) * 0.6, 0.9 + rnd(k + 1) * 0.9, 1 + rnd(k) * 0.6], r: rnd(k + 2) * 6 });
    const spots = b.entities.map((e) => e.pos);
    for (let k = 0; k < 40; k++) {
      const x = bounds.minX + 2 + rnd(k * 5 + 1) * (bounds.maxX - bounds.minX - 4);
      const z = bounds.minZ + 2 + rnd(k * 5 + 2) * (bounds.maxZ - bounds.minZ - 4);
      if (!clear(pieces, x, z, 1) || spots.some((e) => Math.hypot(e[0] - x, e[2] - z) < 2.5)) continue;
      const s = 0.3 + rnd(k * 5 + 3) * 0.4;
      rocks.push({ p: [x, groundY + s * 0.2, z], s: [s, s * 0.6, s], r: rnd(k) * 6, color: "#ffffff" });
    }
  }
  // the horizon: white-capped peaks (or, in a cave, the dark rock closing in)
  const peaks = ring(bounds, cave ? 30 : 22, cave ? 4 : 40, cave ? 10 : 50, 700).map(({ x, z, k }): Item => {
    const r = cave ? 6 + rnd(k) * 6 : 18 + rnd(k) * 24;
    const h = cave ? 14 + rnd(k + 1) * 10 : 24 + rnd(k + 1) * 40;
    return { p: [x, groundY + h / 2 - 1, z], s: [r, h, r], r: rnd(k + 2) * 6 };
  });

  // ---- materials ----------------------------------------------------------------------------
  // floors and the rest are separate draws, so each pixel runs only the pattern it shows
  const drifts = staticsMaterial((a) => {
    // drifts: soft undulation, glitter where the light lines up
    const k = noise01(a.p, 0.4).mul(0.12).add(noise01(a.p, 4, 3).mul(0.05)).add(0.88);
    return { color: vec3(k, k, k), emissive: hex3(cave ? "#7fe8ff" : "#ffffff").mul(glitter(a.p, 40).mul(cave ? 0.4 : 2.2)) };
  }, { roughness: 0.75 });
  const blocks = staticsMaterial((a) => {
    const n1 = noise01(a.p, 0.4);
    const fine = noise01(a.p, 4, 3);
    // sides: blocks of packed ice with blue depth, or stone; tops always carry a snow cap
    const m = masonry(a.along, a.up, 1.4, 0.7, 0.03);
    const iceSide = mix(m.id.mul(0.12).add(0.92), float(0.7), m.mortar).mul(fine.mul(0.1).add(0.95));
    // rock: rough and cracked, darker in the creases
    const crack = smoothstep(0.02, 0.0, abs(noise01(vec3(a.along.mul(0.6), a.p.y.mul(0.25), a.seed), 1).sub(0.5)));
    const stone = fine.mul(0.3).add(n1.mul(0.3)).add(0.6).mul(oneMinus(crack.mul(0.2)));
    const drift = n1.mul(0.12).add(fine.mul(0.05)).add(0.88);
    const k = mix(mix(stone, iceSide, is(a.cls, CLS.ledge)), drift, a.top);
    // the cap is white whatever the box's own colour: divide out the vertex colour the material multiplies in
    const white = hex3(cave ? "#b8cce4" : "#f6f9fc").div(max(vertexColor().xyz, vec3(0.02, 0.02, 0.02)));
    const color = mix(vec3(k, k, k), white.mul(drift), a.top.mul(smoothstep(0.35, 0.55, n1.add(0.25))));
    return { color, roughness: mix(float(0.75), float(0.35), is(a.cls, CLS.ledge).mul(oneMinus(a.top))), emissive: hex3(cave ? "#7fe8ff" : "#ffffff").mul(glitter(a.p, 40).mul(cave ? 0.4 : 2.2)).mul(a.top), bump: m.mortar.mul(is(a.cls, CLS.ledge)).mul(-0.02) };
  }, { roughness: 0.8, bump: 1 });
  batchMesh(c, floors, drifts, "floors");
  batchMesh(c, solid, blocks, "statics");
  batchMesh(c, ice, liquidMaterial({ deep: cave ? "#2a5a8a" : "#8ab8d8", shallow: cave ? "#4a8ac8" : "#d0ecfa", roughness: 0.05, metalness: 0.2, flow: 0.05 }), "ice");
  batchMesh(c, hot, liquidMaterial({ deep: "#5a1a08", shallow: "#ff6a1a", glow: "#ff5a10", glowScale: 2.2, roughness: 0.6, flow: 0.4 }), "lava");

  instances(c, pine(), new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85, flatShading: true }), trees, "pines");
  // boulders: grey rock under a snow cap (white on whatever faces up)
  const boulder = new MeshStandardNodeMaterial({ roughness: 0.85, flatShading: true });
  boulder.colorNode = mix(vec3(1, 1, 1), vec3(3.2, 3.2, 3.4), smoothstep(0.35, 0.6, normalWorld.y)).mul(0.32);
  instances(c, new DodecahedronGeometry(1, 0), boulder, rocks, "rocks");
  // peaks: rock below, snow above a ragged snow line
  const peak = new MeshStandardNodeMaterial({ roughness: 0.9, flatShading: true });
  const line = positionWorld.y.sub(groundY).add(noise01(positionWorld, 0.08).mul(10));
  peak.colorNode = mix(hex3(cave ? "#1a2638" : "#6a7686"), hex3(cave ? "#2a4a6a" : "#f4f8fc"), smoothstep(cave ? 30 : 16, cave ? 34 : 19, line));
  instances(c, cave ? new DodecahedronGeometry(1, 0) : new ConeGeometry(1, 1, 7), peak, peaks, "peaks");
  if (crystals.length) {
    const glow = new MeshBasicNodeMaterial();
    glow.colorNode = vec3(1, 1, 1).mul(float(0.85).add(noise01(positionWorld, 2).mul(0.3)));
    instances(c, new OctahedronGeometry(1, 0), glow, crystals, "crystals");
    lamps(c, glowAt, "#7fe8ff", 9, 9, 3);
  }

  const ground = groundMaterial((p) => {
    const n1 = noise01(p, 0.18);
    const fine = noise01(p, 3, 5);
    const color = hex3(cave ? "#4a6a8a" : "#eef3f9").mul(n1.mul(0.12).add(fine.mul(0.04)).add(0.86));
    return { color, roughness: float(cave ? 0.3 : 0.8), emissive: hex3(cave ? "#7fe8ff" : "#ffffff").mul(glitter(p, 36).mul(cave ? 0.3 : 1.8)), bump: n1.mul(0.4) };
  }, { bump: 1 });

  return { floorTops, groundY, bounds, groundHex: cave ? "#7a94b0" : "#eef3f9", ground, shelter: look.indoor ? bounds : null };
}
