// Candy: a toy world in sugar. Frosting underfoot with sprinkles, candy-cane walls with icing
// dripping off their tops, platforms that are slabs of layer cake, glossy gumdrops for cover, giant
// swirl lollipops for trees and pastel gumdrop hills on the horizon.
import type { WorldBundle } from "@ghostrun/ir";
import { CylinderGeometry, MeshStandardNodeMaterial, SphereGeometry } from "three/webgpu";
import { abs, atan, float, floor, fract, fwidth, hash, max, mix, normalView, oneMinus, positionViewDirection, sin, smoothstep, step, uv, vec3 } from "three/tsl";
import { BoxBatch } from "../boxes";
import type { LookStyle } from "../looks";
import { lin } from "../materials";
import { CLS, groundMaterial, hex3, is, liquidMaterial, noise01, staticsMaterial, type N, type N3 } from "../surfaces";
import { batchMesh, classify, clear, cutWall, instances, ring, rnd, style, type Ctx, type Dressed, type Item } from "./common";

const SWEETS = ["#ff5a9a", "#5ad8ff", "#ffd84a", "#8aff8a", "#c08aff", "#ff8a4a"];

/** Sprinkles: little dashes in every colour scattered over a surface (0 where there are none). */
function sprinkles(u: N, v: N, density: number): { mask: N; color: N3 } {
  const cu = floor(u.mul(density));
  const cv = floor(v.mul(density));
  const h = hash(cu.add(cv.mul(173)).add(4000));
  const fu = fract(u.mul(density)).sub(0.5);
  const fv = fract(v.mul(density)).sub(0.5);
  const a = h.mul(6.283);
  const along = fu.mul(sin(a.add(1.57))).add(fv.mul(sin(a)));
  const across = fu.mul(sin(a)).sub(fv.mul(sin(a.add(1.57))));
  const dash = smoothstep(0.32, 0.26, abs(along)).mul(smoothstep(0.1, 0.06, abs(across))).mul(step(0.55, h));
  const k = hash(cu.mul(7).add(cv.mul(3)).add(11));
  const color = mix(mix(hex3("#ff4a8a"), hex3("#4ac8ff"), step(0.33, k)), mix(hex3("#ffe04a"), hex3("#8aff6a"), step(0.8, k)), step(0.6, k));
  return { mask: dash, color };
}

export function dressCandy(b: WorldBundle, look: LookStyle, c: Ctx): Dressed {
  const { pieces, bounds, groundY } = classify(b);
  const solid = new BoxBatch();
  const pool = new BoxBatch();
  const floorTops: number[] = [];
  const drops: Item[] = [];
  const sticks: Item[] = [];
  const pops: Item[] = [];
  const cut = look.cutaway;
  const frost = lin("#ffc8e4");

  const lolly = (x: number, y: number, z: number, h: number, k: number) => {
    const r = 0.7 + rnd(k) * 0.5;
    sticks.push({ p: [x, y + h / 2, z], s: [0.09, h, 0.09] });
    pops.push({ p: [x, y + h + r * 0.85, z], s: [r, r, r * 0.28], r: rnd(k + 1) * 6, color: SWEETS[k % SWEETS.length]! });
  };

  for (const p of pieces) {
    const { s, i } = p;
    const [x, y, z] = s.pos;
    const [w, h, d] = s.size;
    switch (p.kind) {
      case "ground":
      case "floor":
      case "mound":
        floorTops.push(p.top);
        solid.add(s.pos, s.size, cut ? lin("#ffffff") : frost, style(CLS.ground, i, 0, cut ? 1 : 0));
        break;
      case "path":
        solid.add(s.pos, s.size, lin("#7a4a2a"), style(CLS.path, i));
        break;
      case "water":
      case "hazard":
        pool.add([x, p.top - 0.01, z], [w, 0.04, d], [1, 1, 1]);
        break;
      case "wall":
        if (cut) cutWall(solid, p, lin("#ffffff"));
        else solid.add(s.pos, s.size, lin("#ffffff"), style(CLS.wall, i, p.top));
        break;
      case "boundary":
        solid.add(s.pos, s.size, lin("#ffffff"), style(CLS.wall, i, p.top));
        break;
      case "trunk":
        lolly(x, p.min[1], z, h, i);
        break;
      case "cover":
        drops.push({ p: [x, p.min[1], z], s: [w / 2 + 0.12, h * 1.05, d / 2 + 0.12], r: rnd(i) * 6, color: SWEETS[i % SWEETS.length]! });
        break;
      case "lintel": // over a doorway, above the cut-away walls
        break;
      default:
        // layer cake: sponge and cream in bands under a pink icing top
        solid.add(s.pos, s.size, lin("#ffffff"), style(CLS.ledge, i, p.top));
    }
  }

  // lollipops along the edges and beyond, gumdrop hills on the horizon
  if (!cut) {
    for (const { x, z, k } of ring(bounds, 60, 3, 22, 1200)) lolly(x, groundY, z, 2.5 + rnd(k) * 4, k);
    const spots = b.entities.map((e) => e.pos);
    for (let k = 0; k < 30; k++) {
      const x = bounds.minX + 2 + rnd(k * 5 + 7) * (bounds.maxX - bounds.minX - 4);
      const z = bounds.minZ + 2 + rnd(k * 5 + 8) * (bounds.maxZ - bounds.minZ - 4);
      if (!clear(pieces, x, z, 1) || spots.some((e) => Math.hypot(e[0] - x, e[2] - z) < 2.5)) continue;
      const s = 0.25 + rnd(k) * 0.3;
      drops.push({ p: [x, groundY, z], s: [s, s * 1.3, s], color: SWEETS[k % SWEETS.length]! });
    }
  }
  const hills = ring(bounds, 22, 16, 34, 1300).map(({ x, z, k }): Item => {
    const r = 10 + rnd(k) * 14;
    return { p: [x, groundY - 1, z], s: [r, r * (0.7 + rnd(k + 1) * 0.5), r], color: ["#ffb4d8", "#b4f0ff", "#fff0a0", "#c8ffc0", "#e0c8ff"][k % 5]! };
  });

  // ---- materials ----------------------------------------------------------------------------
  const mat = staticsMaterial((a) => {
    const sp = sprinkles(a.p.x, a.p.z, 3.2);
    // candy-cane walls: diagonal stripes; icing drips from each wall's top edge (aStyle.z)
    const st = a.along.add(a.p.y).mul(0.8);
    const sw = fwidth(st).max(1e-4);
    // anti-aliased, and melting to pink far away where a stripe would be thinner than a pixel
    const stripe = mix(smoothstep(float(0.5).sub(sw), float(0.5).add(sw), fract(st)), float(0.5), smoothstep(0.2, 0.5, sw));
    const cane = mix(hex3("#ff3a6a"), hex3("#fff6f8"), stripe);
    const drip = sin(a.along.mul(5.3)).mul(0.1).add(sin(a.along.mul(11.7)).mul(0.05)).add(0.22);
    const icing = step(a.extra.sub(a.p.y), drip);
    // cake: sponge with two cream layers, a pink top
    const band = fract(a.p.y.mul(1.3));
    const cake = mix(hex3("#f4c87a"), hex3("#fff4ea"), step(0.72, band));
    const isWall = is(a.cls, CLS.wall);
    const isCake = is(a.cls, CLS.ledge);
    const side = mix(mix(cane, cake, isCake), hex3("#fff8fc"), icing.mul(max(isWall, isCake)));
    // floors: frosting with sprinkles; a factory floor in pink and white tiles; chocolate paths
    const tiles = step(0.5, fract(floor(a.p.x.div(1.2)).add(floor(a.p.z.div(1.2))).mul(0.5)));
    const frosting = mix(vec3(1, 1, 1), sp.color.div(0.9), sp.mask);
    const floorCol = mix(frosting, mix(hex3("#ff8abc"), hex3("#fff0f6"), tiles), is(a.alt, 1));
    const choc = hex3("#ffffff").mul(noise01(a.p, 2).mul(0.15).add(0.9));
    const flat = is(a.cls, CLS.ground);
    const topCol = mix(mix(hex3("#ff9ac8"), frosting.mul(hex3("#ff9ac8")), sp.mask), floorCol, flat);
    const color = mix(mix(side, topCol, a.top), choc, is(a.cls, CLS.path));
    return { color, roughness: mix(float(0.42), float(0.25), max(isWall, is(a.cls, CLS.path))) };
  }, { roughness: 0.4 });
  batchMesh(c, solid, mat, "statics");
  batchMesh(c, pool, liquidMaterial({ deep: "#5a2a14", shallow: "#9a5a2a", roughness: 0.15, flow: 0.4 }), "chocolate");

  // gumdrops: glossy, with a sugar sparkle at the rim
  const gum = new MeshStandardNodeMaterial({ roughness: 0.25 });
  gum.emissiveNode = vec3(1, 1, 1).mul(oneMinus(abs(normalView.dot(positionViewDirection.negate()))).pow(3).mul(0.25));
  instances(c, new SphereGeometry(1, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), gum, drops, "gumdrops");
  instances(c, new CylinderGeometry(1, 1, 1, 8), new MeshStandardNodeMaterial({ color: "#fffaf2", roughness: 0.5 }), sticks, "sticks");
  // lollipop discs: a white swirl over the instance colour
  const pop = new MeshStandardNodeMaterial({ roughness: 0.3 });
  const q = uv().sub(0.5); // the caps' uvs run round the disc: a spiral in angle and radius
  const swirl = step(0.5, fract(atan(q.y, q.x).div(6.283).mul(3).add(q.length().mul(4.4))));
  pop.colorNode = mix(vec3(1, 1, 1), vec3(3, 3, 3), swirl.mul(0.25));
  instances(c, new CylinderGeometry(1, 1, 1, 24).rotateX(Math.PI / 2), pop, pops, "lollipops");
  instances(c, new SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new MeshStandardNodeMaterial({ roughness: 0.6 }), hills, "hills");

  const ground = groundMaterial((p) => {
    const sp = sprinkles(p.x, p.z, 2.4);
    const n1 = noise01(p, 0.2);
    const base = mix(hex3("#bff4dc"), hex3("#ffd6ea"), smoothstep(0.4, 0.6, noise01(p, 0.05, 2)));
    return { color: mix(base.mul(n1.mul(0.08).add(0.94)), sp.color, sp.mask), roughness: float(0.55) };
  });

  return { floorTops, groundY, bounds, groundHex: "#ffd6ea", ground, shelter: look.indoor ? bounds : null };
}
