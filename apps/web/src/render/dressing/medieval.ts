// Medieval: sunlit grey stone in coursed blocks, cobbled courtyards and flagstone halls, merlons
// along every wall top, heraldic banners, torches in iron sconces, crates and barrels, towers on the
// horizon. The magic variant (a wizard school) adds floating candles, a glowing circle on the
// floor and violet banners.
import type { WorldBundle } from "@ghostrun/ir";
import { BoxGeometry, ConeGeometry, CylinderGeometry, DoubleSide, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, Object3D, PlaneGeometry, RingGeometry } from "three/webgpu";
import { abs, float, fract, hash, instanceIndex, length, max, mix, mx_worley_noise_vec2, oneMinus, positionLocal, positionWorld, sin, smoothstep, step, time, uv, vec3 } from "three/tsl";
import { BoxBatch } from "../boxes";
import type { LookStyle } from "../looks";
import { glowMaterial, lin } from "../materials";
import { CLS, groundMaterial, hex3, is, liquidMaterial, masonry, noise01, planks, staticsMaterial } from "../surfaces";
import { batchMesh, classify, cutWall, instances, lamps, merged, ring, rnd, style, type Ctx, type Dressed, type Item, type V3 } from "./common";

/** A round tower with a conical roof, 10 m to the eaves at scale 1. */
function tower(roof: string) {
  return merged([
    { geo: new CylinderGeometry(1, 1.08, 10, 12), color: "#8a8680", at: [0, 5, 0] },
    { geo: new CylinderGeometry(1.15, 1.15, 0.6, 12), color: "#7a766e", at: [0, 10.1, 0] },
    { geo: new ConeGeometry(1.3, 3.4, 12), color: roof, at: [0, 12.1, 0] },
  ]);
}

/** An iron sconce and its torch (the flame is its own instance). */
function sconce() {
  return merged([
    { geo: new BoxGeometry(0.06, 0.06, 0.3), color: "#2a2420", at: [0, 0, 0.15] },
    { geo: new CylinderGeometry(0.05, 0.035, 0.42, 6), color: "#5a3a22", at: [0, 0.16, 0.3] },
  ]);
}

export function dressMedieval(b: WorldBundle, look: LookStyle, c: Ctx): Dressed {
  const magic = look.variant === "magic";
  const { pieces, bounds, groundY } = classify(b);
  const solid = new BoxBatch();
  const pool = new BoxBatch();
  const floorTops: number[] = [];
  const merlons: Item[] = [];
  const banners: Item[] = [];
  const sconces: Item[] = [];
  const flames: Item[] = [];
  const trees: Item[] = [];
  const lightAt: V3[] = [];
  const cut = look.cutaway;
  const paved = b.pack.id !== "outdoor" && b.pack.id !== "course";
  const stone = (i: number) => lin(["#9a958c", "#a8a398", "#8c877e", "#b0aa9e"][i % 4]!);
  const heraldry = magic ? ["#5a2a8a", "#2a3a8a"] : ["#a82a2a", "#2a4a9a"];

  /** Merlons along a wall top, a banner and a torch here and there on its face. */
  const crown = (x0: number, z0: number, x1: number, z1: number, top: number, face: number, i: number, outward: [number, number]) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const along = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    for (let k = 0; k < len / 1.3; k++) {
      const t = (k + 0.5) / Math.ceil(len / 1.3);
      merlons.push({ p: [x0 + (x1 - x0) * t, top + 0.35, z0 + (z1 - z0) * t], s: along ? [0.65, 0.7, face] : [face, 0.7, 0.65] });
    }
    if (cut) return;
    const yaw = Math.atan2(outward[0], outward[1]);
    for (let k = 1; k < len / 7; k++) {
      const t = k / Math.ceil(len / 7);
      const x = x0 + (x1 - x0) * t + outward[0] * 0.02;
      const z = z0 + (z1 - z0) * t + outward[1] * 0.02;
      if (k % 2) banners.push({ p: [x + outward[0] * (face / 2 + 0.03), top - 1.8, z + outward[1] * (face / 2 + 0.03)], s: [1.1, 2.6, 1], r: yaw, color: heraldry[(i + k) % 2]! });
      else {
        const sx = x + outward[0] * (face / 2);
        const sz = z + outward[1] * (face / 2);
        sconces.push({ p: [sx, groundY + 2.4, sz], s: [1, 1, 1], r: yaw });
        flames.push({ p: [sx + outward[0] * 0.3, groundY + 2.75, sz + outward[1] * 0.3], s: [0.09, 0.2, 0.09], color: "#ff9a3a", scale: 4 });
        lightAt.push([sx + outward[0] * 0.6, groundY + 2.8, sz + outward[1] * 0.6]);
      }
    }
  };
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;

  for (const p of pieces) {
    const { s, i } = p;
    const [x, , z] = s.pos;
    const [w, h, d] = s.size;
    switch (p.kind) {
      case "ground":
      case "floor":
      case "mound":
      case "path":
        floorTops.push(p.top);
        solid.add(s.pos, s.size, lin(p.kind === "path" ? "#a89a80" : magic && cut ? "#6e6670" : paved || cut ? "#9a948a" : "#6a8a4a"), style(p.kind === "path" ? CLS.path : CLS.ground, i, 0, paved || cut ? 1 : 0));
        break;
      case "water":
      case "hazard":
        pool.add([x, p.top - 0.01, z], [w, 0.04, d], [1, 1, 1]);
        break;
      case "wall":
        if (cut) cutWall(solid, p, stone(i));
        else solid.add(s.pos, s.size, stone(i), style(CLS.wall, i, h));
        if (!cut && b.pack.id === "maze" && rnd(i) < 0.12) {
          // torches in the maze's walls
          const along = w > d;
          const o: [number, number] = along ? [0, 1] : [1, 0];
          sconces.push({ p: [x + o[0] * (w / 2), groundY + 1.9, z + o[1] * (d / 2)], s: [1, 1, 1], r: Math.atan2(o[0], o[1]) });
          flames.push({ p: [x + o[0] * (w / 2 + 0.3), groundY + 2.25, z + o[1] * (d / 2 + 0.3)], s: [0.09, 0.2, 0.09], color: "#ff9a3a", scale: 4 });
          lightAt.push([x + o[0] * (w / 2 + 0.6), groundY + 2.3, z + o[1] * (d / 2 + 0.6)]);
        }
        break;
      case "boundary": {
        solid.add(s.pos, s.size, stone(i), style(CLS.wall, i, h));
        const along = w > d;
        const out: [number, number] = along ? [0, Math.sign(cz - z) || 1] : [Math.sign(cx - x) || 1, 0];
        if (along) crown(x - w / 2, z, x + w / 2, z, p.top, d, i, out);
        else crown(x, z - d / 2, x, z + d / 2, p.top, w, i, out);
        break;
      }
      case "ledge":
      case "block": {
        solid.add(s.pos, s.size, stone(i), style(CLS.ledge, i, p.top));
        // battlements along the platform's long outer edge
        if (b.pack.id !== "course") {
          const along = w >= d;
          const sideZ = z + (d / 2 - 0.2) * (Math.sign(z - cz) || 1);
          const sideX = x + (w / 2 - 0.2) * (Math.sign(x - cx) || 1);
          if (along) crown(x - w / 2, sideZ, x + w / 2, sideZ, p.top, 0.4, i, [0, Math.sign(cz - z) || 1]);
          else crown(sideX, z - d / 2, sideX, z + d / 2, p.top, 0.4, i, [Math.sign(cx - x) || 1, 0]);
        }
        break;
      }
      case "trunk":
        trees.push({ p: [x, p.min[1], z], s: [Math.max(w, d) * 1.5, h, Math.max(w, d) * 1.5], r: rnd(i) * 6 });
        break;
      case "lintel": // over a doorway, above the cut-away walls
        break;
      default:
        // crates and barrels: the box in planks with a dark frame
        solid.add(s.pos, s.size, lin(["#8a5a32", "#7a4e2a", "#94643a"][i % 3]!), style(CLS.cover, i, p.top));
    }
  }

  // towers on the horizon
  const towers = ring(bounds, cut ? 8 : 12, 10, 30, 400).map(({ x, z, k }): Item => {
    const s = 1.6 + rnd(k) * 1.8;
    return { p: [x, groundY - 0.5, z], s: [s, 0.8 + rnd(k + 1) * 0.9, s], r: rnd(k + 2) * 6 };
  });

  // ---- materials ----------------------------------------------------------------------------
  const mat = staticsMaterial((a) => {
    const fine = noise01(a.p, 3.3, 4);
    const n1 = noise01(a.p, 0.4);
    const m = masonry(a.along, a.up, 1.0, 0.5, 0.05);
    const blocks = mix(m.id.mul(0.22).add(0.86), float(0.55), m.mortar).mul(fine.mul(0.18).add(0.9));
    // floors: grass, cobbles in a courtyard, big flagstones in a hall
    // cobbles: round stones (cells of a Voronoi pattern) with dark joints between them
    const cell = mx_worley_noise_vec2(vec3(a.p.x.mul(2.2), a.p.z.mul(2.2), 0));
    const cob = smoothstep(0.02, 0.14, cell.y.sub(cell.x));
    const cobbles = mix(float(0.42), noise01(a.p, 1.7, 3).mul(0.3).add(0.75), cob);
    const flags = masonry(a.p.x, a.p.z, 1.4, 1.1, 0.03);
    const paving = mix(cobbles, mix(flags.id.mul(0.2).add(0.85), float(0.5), flags.mortar), cut ? 1 : 0);
    const grass = mix(n1.mul(0.25).add(0.8), fine.mul(0.2).add(0.7), smoothstep(0.6, 0.75, noise01(a.p, 0.12, 9)));
    const floorTone = mix(grass, paving, is(a.alt, 1));
    // crates: planks inside a dark frame
    const pl = planks(a.p.y, a.along, 0.24, 9);
    const edge = max(smoothstep(0.12, 0.0, fract(a.along.div(1.2))), smoothstep(0.12, 0.0, abs(a.p.y.sub(a.extra))));
    const crate = mix(pl.id.mul(0.2).add(0.85), float(0.45), max(pl.seam, edge.mul(0.8)));
    const isCover = is(a.cls, CLS.cover);
    const flat = max(is(a.cls, CLS.ground), is(a.cls, CLS.path));
    const side = mix(blocks, crate, isCover);
    const top = mix(mix(blocks, crate, isCover), floorTone, flat);
    const k = mix(side, top, max(a.top, flat));
    const floorBump = cut ? flags.mortar.mul(-0.02) : cob.mul(0.035);
    // a wizard school's flagstones: a faint violet glow along their joints
    const emissive = magic ? hex3("#b07aff", 0.22).mul(flags.mortar).mul(flat).mul(is(a.alt, 1)) : vec3(0, 0, 0);
    return { color: vec3(k, k, k), emissive, roughness: float(0.88), bump: mix(m.mortar.mul(-0.03), floorBump.mul(is(a.alt, 1)), flat) };
  }, { roughness: 0.88, bump: 1 });
  batchMesh(c, solid, mat, "statics");
  batchMesh(c, pool, liquidMaterial({ deep: "#1a3a4a", shallow: "#3a7a8a", roughness: 0.1 }), "water");

  const stoneMat = new MeshStandardNodeMaterial({ color: "#a29d92", roughness: 0.9 });
  stoneMat.colorNode = hex3("#a29d92").mul(noise01(positionWorld, 2.5).mul(0.2).add(0.88));
  instances(c, new BoxGeometry(1, 1, 1), stoneMat, merlons, "merlons");
  // banners: a field, a gold border, a diamond device; they sway a little
  const banner = new MeshStandardNodeMaterial({ side: DoubleSide, roughness: 0.8 });
  const bu = uv();
  const border = max(step(0.88, abs(bu.x.sub(0.5)).mul(2)), step(0.94, bu.y));
  const device = step(abs(bu.x.sub(0.5)).add(abs(bu.y.sub(0.58)).mul(0.7)), 0.18);
  const tail = step(bu.y, abs(bu.x.sub(0.5)).mul(0.5).add(0.05)); // a swallowtail cut
  banner.colorNode = mix(vec3(1, 1, 1), hex3("#e8c050").div(0.4), max(border, device));
  banner.opacityNode = oneMinus(tail);
  banner.alphaTest = 0.5;
  banner.positionNode = sway();
  instances(c, new PlaneGeometry(1, 1, 1, 6), banner, banners, "banners");
  instances(c, sconce(), new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.3 }), sconces, "sconces");
  const flame = new MeshBasicNodeMaterial();
  const ph = hash(instanceIndex.toFloat().add(1.7)).mul(40);
  flame.colorNode = vec3(1, 1, 1).mul(sin(time.mul(12).add(ph)).mul(0.15).add(sin(time.mul(29).add(ph.mul(2))).mul(0.1)).add(0.9));
  instances(c, new ConeGeometry(1, 1, 6), flame, flames, "torch flames");
  lamps(c, lightAt, "#ff9a4a", look.night ? 14 : 6, 9, 3, 0.3);
  instances(c, merged([{ geo: new CylinderGeometry(0.15, 0.22, 1, 6), color: "#5a4030", at: [0, 0.5, 0] }, { geo: new IcosahedronGeometry(0.75, 1), color: "#3f6a32", at: [0, 0.85, 0], scale: [1, 0.8, 1] }]), new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85, flatShading: true }), trees, "trees");
  instances(c, tower(magic ? "#4a2a7a" : "#3a4a6a"), new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }), towers, "towers");

  if (magic) {
    // a glowing circle in the middle of the floor, and candles floating over the rooms
    const circle = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const r = length(uv().sub(0.5)).mul(2);
    const runes = step(0.5, fract(hash(uv().sub(0.5).x.atan(uv().sub(0.5).y).mul(12).floor()).add(time.mul(0.2))));
    circle.colorNode = hex3("#b07aff", 2.2);
    circle.opacityNode = smoothstep(0.02, 0.0, abs(r.sub(0.95))).add(smoothstep(0.02, 0.0, abs(r.sub(0.72)))).add(step(0.74, r).mul(step(r, 0.93)).mul(runes).mul(0.5)).min(1);
    const disc = new Mesh(c.keep(new RingGeometry(0, 3.2, 64, 1)), c.keep(circle));
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(cx, groundY + 0.02, cz);
    c.root.add(disc);
    const n = 70;
    const wax = new InstancedMesh(c.keep(merged([{ geo: new CylinderGeometry(0.045, 0.045, 0.3, 6), color: "#f0e6d0", at: [0, 0, 0] }])), c.keep(new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6 })), n);
    const fire = new InstancedMesh(c.keep(new ConeGeometry(0.04, 0.1, 6)), c.keep(glowMaterial("#ffc070", 4)), n);
    const seeds = Array.from({ length: n }, (_, k) => [bounds.minX + rnd(k * 3 + 50) * (bounds.maxX - bounds.minX), groundY + 1.9 + rnd(k * 3 + 51) * 1.3, bounds.minZ + rnd(k * 3 + 52) * (bounds.maxZ - bounds.minZ)] as V3);
    const o = new Object3D();
    const m4 = new Matrix4();
    c.animated.push((t) => {
      seeds.forEach((sd, k) => {
        o.position.set(sd[0], sd[1] + Math.sin(t * 0.8 + k) * 0.12, sd[2]);
        o.updateMatrix();
        wax.setMatrixAt(k, m4.copy(o.matrix));
        o.position.y += 0.2;
        o.updateMatrix();
        fire.setMatrixAt(k, m4.copy(o.matrix));
      });
      wax.instanceMatrix.needsUpdate = true;
      fire.instanceMatrix.needsUpdate = true;
    });
    wax.frustumCulled = fire.frustumCulled = false;
    c.root.add(wax, fire);
  }

  const ground = groundMaterial((p) => {
    const n1 = noise01(p, 0.15);
    const fine = noise01(p, 2.8, 3);
    const dirt = smoothstep(0.55, 0.72, noise01(p, 0.07, 8));
    return { color: mix(hex3("#5a7a3e"), hex3("#7a6a4a"), dirt).mul(n1.mul(0.25).add(fine.mul(0.15)).add(0.72)), roughness: float(0.95) };
  });

  return { floorTops, groundY, bounds, groundHex: "#5a7a3e", ground, shelter: look.indoor ? bounds : null };
}

/** A gentle sway down a banner (the top edge stays pinned). Instancing has already placed positionLocal. */
function sway() {
  const free = oneMinus(uv().y);
  return positionLocal.add(vec3(sin(time.mul(1.6).add(positionWorld.x.mul(0.3))).mul(free).mul(0.05), 0, sin(time.mul(1.3).add(positionWorld.z.mul(0.3))).mul(free).mul(0.05)));
}
