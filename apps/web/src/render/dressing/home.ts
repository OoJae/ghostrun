// Home: a cosy interior seen like a dollhouse. Oak floorboards, striped wallpaper over white
// wainscot, rugs in the rooms, furniture against the walls (sofas, cabinets, low bookcases, beds,
// plants and lamps that light the room), a lawn and a garden outside. The Japanese variant is
// tatami and shoji with paper lanterns and a raked gravel garden; the library variant lines its
// walls with books.
import type { WorldBundle } from "@ghostrun/ir";
import { BoxGeometry, CylinderGeometry, IcosahedronGeometry, MeshBasicNodeMaterial, MeshStandardNodeMaterial, SphereGeometry } from "three/webgpu";
import { abs, float, fract, length, max, mix, oneMinus, sin, smoothstep, step, uv, vec3, vertexColor } from "three/tsl";
import { BoxBatch } from "../boxes";
import type { LookStyle } from "../looks";
import { lin } from "../materials";
import { books, CLS, groundMaterial, hex3, is, liquidMaterial, noise01, planks, staticsMaterial, type N, type N3 } from "../surfaces";
import { batchMesh, classify, clear, cutWall, instances, lamps, ring, rnd, style, type Ctx, type Dressed, type Item, type Piece, type V3 } from "./common";

const WOODS = ["#8a5a36", "#6a4428", "#a87a4e"];
const FABRIC = ["#5a7a9a", "#9a5a5a", "#6a8a5a", "#c8a05a", "#7a6a9a"];

export function dressHome(b: WorldBundle, look: LookStyle, c: Ctx): Dressed {
  const jp = look.variant === "japanese";
  const library = look.variant === "library";
  const { pieces, bounds, groundY } = classify(b);
  const solid = new BoxBatch();
  const floors = new BoxBatch();
  const pool = new BoxBatch();
  const floorTops: number[] = [];
  const furniture: Item[] = [];
  const pots: Item[] = [];
  const leaves: Item[] = [];
  const shades: Item[] = [];
  const rugs: Item[] = [];
  const bushes: Item[] = [];
  const lampAt: V3[] = [];
  const cut = look.cutaway;
  const walls: Piece[] = [];
  const box = (p: V3, s: V3, color: string) => furniture.push({ p, s, color });

  for (const p of pieces) {
    const { s, i } = p;
    const [x, , z] = s.pos;
    const [w, h, d] = s.size;
    switch (p.kind) {
      case "ground":
      case "floor":
      case "mound":
      case "path": {
        floorTops.push(p.top);
        const inside = cut && x > bounds.minX - 0.1 && x < bounds.maxX + 0.1 && z > bounds.minZ - 0.1 && z < bounds.maxZ + 0.1;
        // rooms get boards or tatami; the yard outside is lawn, or raked gravel at a tea house
        floors.add(s.pos, s.size, lin(inside || !cut ? (jp ? "#c8c08a" : "#b08058") : jp ? "#c8c4b8" : "#6a9a4a"), style(CLS.ground, i, 0, inside || !cut ? (jp ? 2 : 1) : jp ? 3 : 0));
        break;
      }
      case "water":
      case "hazard":
        pool.add([x, p.top - 0.01, z], [w, 0.04, d], [1, 1, 1]);
        break;
      case "wall":
      case "boundary":
        walls.push(p);
        if (cut) cutWall(solid, p, lin(jp ? "#f4efe2" : "#efe6d8"), jp ? 1 : library ? 2 : 0);
        else solid.add(s.pos, s.size, lin(library ? "#6a4630" : jp ? "#f4efe2" : "#efe6d8"), style(CLS.wall, i, h, library ? 2 : jp ? 1 : 0));
        break;
      case "trunk":
        pots.push({ p: [x, p.min[1] + 0.3, z], s: [0.45, 0.6, 0.45], color: "#b0603a" });
        leaves.push({ p: [x, p.min[1] + Math.min(h, 2.4) * 0.7, z], s: [0.9, Math.min(h, 2.4) * 0.45, 0.9], color: "#3a7a3a" });
        break;
      case "cover":
        // low obstacles become furniture: the box itself in wood with a fabric top
        solid.add(s.pos, s.size, lin(WOODS[i % 3]!), style(CLS.cover, i, p.top));
        break;
      case "lintel": // over a doorway, above the cut-away walls
        break;
      default:
        solid.add(s.pos, s.size, lin(WOODS[i % 3]!), style(CLS.ledge, i, p.top));
    }
  }

  // furniture along the walls, inside the rooms only, clear of doors, things and each other
  const inside = (x: number, z: number) => x > bounds.minX + 0.3 && x < bounds.maxX - 0.3 && z > bounds.minZ + 0.3 && z < bounds.maxZ - 0.3;
  const spots = b.entities.map((e) => e.pos);
  const taken: { x: number; z: number; r: number }[] = [];
  const free = (x: number, z: number, r: number) =>
    inside(x, z) && !spots.some((e) => Math.hypot(e[0] - x, e[2] - z) < r + 1) && !taken.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + r) && clear(pieces, x, z, 0.12, ["wall", "boundary", "cover", "ledge", "block", "trunk"]);
  if (cut || b.pack.id === "floor_plan") {
    walls.forEach((p, n) => {
      const [x, , z] = p.s.pos;
      const [w, , d] = p.s.size;
      const len = Math.max(w, d);
      if (len < 2.4) return;
      const alongX = w >= d;
      for (const side of [-1, 1]) {
        const k = n * 7 + (side > 0 ? 3 : 0);
        if (rnd(k) < 0.35) continue;
        const depth = 0.42;
        const off = (alongX ? d : w) / 2 + depth + 0.02;
        const t = (rnd(k + 1) - 0.5) * Math.max(0, len - 2.2);
        const cx = alongX ? x + t : x + side * off;
        const cz = alongX ? z + side * off : z + t;
        const span = Math.min(2, len - 0.4);
        if (!free(cx, cz, span / 2)) continue;
        taken.push({ x: cx, z: cz, r: span / 2 });
        const at = (u: number, v: number, y: number): V3 => (alongX ? [cx + u, groundY + y, cz + v * side] : [cx + v * side, groundY + y, cz + u]);
        const sz = (su: number, sv: number, sy: number): V3 => (alongX ? [su, sy, sv] : [sv, sy, su]);
        const kind = Math.floor(rnd(k + 2) * (jp ? 3 : 5));
        const wood = WOODS[k % 3]!;
        const cloth = FABRIC[k % FABRIC.length]!;
        if (jp) {
          if (kind === 0) {
            // a low table with two cushions
            box(at(0, 0, 0.32), sz(1.1, 0.7, 0.05), "#6a3a22");
            for (const u of [-0.42, 0.42]) box(at(u, 0, 0.16), sz(0.06, 0.5, 0.3), "#5a3018");
            for (const u of [-0.5, 0.5]) box(at(u, -0.55, 0.05), sz(0.5, 0.5, 0.1), cloth);
          } else if (kind === 1) {
            // a paper lantern (andon) glowing on the floor
            shades.push({ p: at(0, 0, 0.45), s: [0.32, 0.6, 0.32], color: "#ffd9a0", scale: 2.4 });
            box(at(0, 0, 0.06), sz(0.4, 0.4, 0.12), "#3a2414");
            lampAt.push(at(0, 0, 0.9));
          } else {
            // a bonsai on a stand
            box(at(0, 0, 0.2), sz(0.7, 0.4, 0.4), "#4a2a18");
            pots.push({ p: at(0, 0, 0.47), s: [0.24, 0.14, 0.24], color: "#3a4a5a" });
            leaves.push({ p: at(0, 0, 0.72), s: [0.36, 0.22, 0.36], color: "#3a6a30" });
          }
          continue;
        }
        if (kind === 0) {
          // a sofa: seat, back, arms
          box(at(0, 0, 0.22), sz(span, 0.8, 0.44), cloth);
          box(at(0, -0.32, 0.55), sz(span, 0.2, 0.5), cloth);
          for (const u of [-span / 2 + 0.1, span / 2 - 0.1]) box(at(u, 0, 0.38), sz(0.2, 0.8, 0.3), cloth);
        } else if (kind === 1) {
          // a low bookcase, filled
          box(at(0, -0.12, 0.5), sz(span * 0.8, 0.36, 1), wood);
          for (const y of [0.25, 0.65]) box(at(0, -0.1, y), sz(span * 0.74, 0.3, 0.28), FABRIC[(k + Math.round(y * 10)) % FABRIC.length]!);
        } else if (kind === 2) {
          // a sideboard with a lamp on it
          box(at(0, -0.1, 0.4), sz(span * 0.7, 0.45, 0.8), wood);
          shades.push({ p: at(span * 0.2, -0.1, 1.05), s: [0.22, 0.26, 0.22], color: "#ffe2b0", scale: 2.2 });
          lampAt.push(at(span * 0.2, 0.2, 1.3));
        } else if (kind === 3) {
          // a bed against the wall
          box(at(0, 0.3, 0.25), sz(Math.min(span, 1.4), 1.6, 0.5), "#f4f0e8");
          box(at(0, 0.3, 0.52), sz(Math.min(span, 1.4), 1.0, 0.06), cloth);
          box(at(0, -0.4, 0.62), sz(Math.min(span, 1.4), 0.12, 0.7), wood);
        } else {
          // a plant in a pot and a floor lamp
          pots.push({ p: at(-0.4, 0, 0.25), s: [0.28, 0.5, 0.28], color: "#c8704a" });
          leaves.push({ p: at(-0.4, 0, 0.8), s: [0.5, 0.5, 0.5], color: "#3f7f3a" });
          box(at(0.45, 0, 0.6), sz(0.04, 0.04, 1.2), "#2a2420");
          shades.push({ p: at(0.45, 0, 1.25), s: [0.26, 0.3, 0.26], color: "#ffe2b0", scale: 2.2 });
          lampAt.push(at(0.45, 0.3, 1.4));
        }
      }
    });
    // a rug in the middle of each big room (flat: walking on it is fine)
    for (const p of pieces) {
      if (p.kind !== "floor" && p.kind !== "ground") continue;
      const [x, , z] = p.s.pos;
      const [w, , d] = p.s.size;
      if (w * d < 30 || !inside(x, z)) continue;
      rugs.push({ p: [x, p.top + 0.012, z], s: [Math.min(w * 0.5, 5), 0.02, Math.min(d * 0.5, 3.5)], color: jp ? "#d8c89a" : FABRIC[Math.floor(rnd(p.i) * FABRIC.length)]! });
    }
  }
  // a garden outside: hedges round the yard and trees beyond
  for (const { x, z, k } of ring(bounds, 46, 6, 20, 1700)) bushes.push({ p: [x, groundY + 1.2, z], s: [1.4 + rnd(k), 1.6 + rnd(k + 1) * 1.6, 1.4 + rnd(k)], r: rnd(k) * 6, color: ["#3a7a3a", "#4a8a3e", "#2f6a32"][k % 3]! });

  // ---- materials ----------------------------------------------------------------------------
  // floors and the rest are separate draws, so each pixel runs only the pattern it shows
  const floorMat = staticsMaterial((a) => {
    const fine = noise01(a.p, 3, 2);
    if (jp) {
      // tatami: 1.8 × 0.9 m mats, every other row offset by half a mat, dark cloth edges; raked gravel outside
      const mu = fract(a.p.x.div(1.8).add(step(0.5, fract(a.p.z.div(1.8))).mul(0.5)));
      const mv = fract(a.p.z.div(0.9));
      const matEdge = max(smoothstep(0.035, 0.0, mu.min(oneMinus(mu))), smoothstep(0.07, 0.0, mv.min(oneMinus(mv))));
      const tatami = mix(fine.mul(0.1).add(0.92).mul(sin(a.p.x.mul(60)).mul(0.03).add(1)), float(0.35), matEdge);
      const gravel = sin(a.p.z.mul(9).add(noise01(a.p, 0.4).mul(2))).mul(0.12).add(fine.mul(0.06)).add(0.88);
      const k = mix(tatami, gravel, is(a.alt, 3));
      return { color: vec3(k, k, k), roughness: float(0.75) };
    }
    // oak boards inside, the lawn outside
    const pl = planks(a.p.x, a.p.z, 0.24, 2.4);
    const grain = noise01(a.p.mul(vec3(1, 1, 8)), 3).mul(0.12).add(0.94);
    const boards = mix(pl.id.mul(0.22).add(0.84).mul(grain), float(0.5), pl.seam);
    const lawn = fine.mul(0.25).add(0.75);
    const k = mix(lawn, boards, is(a.alt, 1));
    return { color: vec3(k, k, k), roughness: mix(float(0.75), float(0.4), is(a.alt, 1)), bump: pl.seam.mul(-0.02).mul(is(a.alt, 1)) };
  }, { roughness: 0.7, bump: 1 });
  const mat = staticsMaterial((a) => {
    const up = a.p.y.sub(groundY);
    // walls: wallpaper over wainscot, shoji (paper in a dark wooden grid), or books
    let wallK: N;
    let wallTint: N3;
    let shojiWood: N3 = vec3(1, 1, 1);
    if (jp) {
      const grid = max(smoothstep(0.03, 0.0, abs(fract(a.along.div(0.45)).sub(0.5)).sub(0.47).abs()), smoothstep(0.03, 0.0, abs(fract(up.div(0.4)).sub(0.5)).sub(0.47).abs()));
      const post = smoothstep(0.08, 0.0, abs(fract(a.along.div(1.8)).sub(0.5)).sub(0.45).abs());
      wallK = mix(float(1.05), float(0.28), max(grid, post));
      wallTint = vec3(1, 1, 1);
      shojiWood = mix(vec3(1, 1, 1), hex3("#5a3a22").mul(3), max(grid, post));
    } else if (library) {
      const bk = books(a.along, up);
      wallK = bk.tone;
      wallTint = bk.tint.mul(1.8);
    } else {
      const stripes = step(0.5, fract(a.along.mul(3))).mul(0.06).add(0.94);
      const wainscot = step(up, 0.8);
      const rail = smoothstep(0.03, 0.0, abs(up.sub(0.8)));
      wallK = mix(stripes, mix(float(1.06), float(0.8), rail), wainscot);
      wallTint = mix(hex3("#ffffff"), hex3("#f0dccc"), oneMinus(wainscot));
    }
    const isWall = is(a.cls, CLS.wall);
    // furniture boxes: wood with a lighter top
    const woodK = noise01(a.p.mul(vec3(1, 4, 1)), 2).mul(0.15).add(0.88);
    const side = mix(vec3(woodK, woodK, woodK), vec3(wallK, wallK, wallK).mul(wallTint).mul(shojiWood), isWall);
    // a cut wall's top is a dark wooden cap, so the rooms read from above
    const cap = hex3("#5a3a24").div(max(vertexColor().xyz, vec3(0.02, 0.02, 0.02))).mul(woodK);
    const top = mix(vec3(woodK, woodK, woodK).mul(1.12), cap, isWall);
    return { color: mix(side, top, a.top), roughness: float(0.75) };
  }, { roughness: 0.7 });
  batchMesh(c, floors, floorMat, "floors");
  batchMesh(c, solid, mat, "statics");
  batchMesh(c, pool, liquidMaterial({ deep: "#2a5a6a", shallow: "#6ab0c0", roughness: 0.08 }), "water");

  const furnish = new MeshStandardNodeMaterial({ roughness: 0.7 });
  furnish.colorNode = vec3(1, 1, 1).mul(noise01(vec3(uv().x.mul(3), uv().y.mul(3), 0), 4).mul(0.12).add(0.92));
  instances(c, new BoxGeometry(1, 1, 1), furnish, furniture, "furniture");
  instances(c, new CylinderGeometry(0.75, 1, 1, 10), new MeshStandardNodeMaterial({ roughness: 0.6 }), pots, "pots");
  instances(c, new IcosahedronGeometry(1, 1), new MeshStandardNodeMaterial({ roughness: 0.8, flatShading: true }), leaves, "plants");
  instances(c, jp ? new BoxGeometry(1, 1, 1) : new CylinderGeometry(0.7, 1, 1, 12, 1, true), new MeshBasicNodeMaterial(), shades, "lamps");
  // rugs: a border and a medallion over the rug's colour
  const rug = new MeshStandardNodeMaterial({ roughness: 0.95 });
  const ru = uv().sub(0.5).abs();
  const border = step(0.42, max(ru.x, ru.y)).mul(step(max(ru.x, ru.y), 0.46));
  const medallion = step(length(uv().sub(0.5).mul(vec3(1, 1.4, 1).xy)), 0.16);
  rug.colorNode = mix(vec3(1, 1, 1), vec3(1.8, 1.6, 1.2), max(border, medallion));
  instances(c, new BoxGeometry(1, 1, 1), rug, rugs, "rugs");
  instances(c, new SphereGeometry(1, 10, 6), new MeshStandardNodeMaterial({ roughness: 0.85, flatShading: true }), bushes, "garden");
  lamps(c, lampAt, "#ffc880", look.night ? 10 : look.phase === "dusk" ? 7 : 4, 7, 3);

  const ground = groundMaterial((p) => {
    const n1 = noise01(p, 0.2);
    const fine = noise01(p, 3, 4);
    // a tea house sits in raked gravel; a house in a lawn
    const rake = sin(p.z.mul(9).add(n1.mul(2))).mul(0.12).add(0.9);
    return { color: hex3(jp ? "#a8a89a" : "#5e8e44").mul(jp ? rake.mul(fine.mul(0.06).add(0.95)) : fine.mul(0.2).add(n1.mul(0.15)).add(0.75)), roughness: float(0.95) };
  });

  return { floorTops, groundY, bounds, groundHex: jp ? "#a8a89a" : "#5e8e44", ground, shelter: look.indoor ? bounds : null };
}
