// The volume pack's worlds, crossed through the air or the water rather than on foot, dressed for
// their medium whatever look they wear (the look still lights them and paints their sky): islands
// floating over a sea of cloud (a grass top, a rock underside), a beach and its lagoon on an open
// sea, a station's modules and asteroids in space. There is no ground plane under any of them. The
// water itself (any entity bound with the swim verb, in any world) is drawn by `waterActor`.
// Colliders are never changed: each static keeps its exact box; the rock under an island hangs
// below its box, where nothing stands.
import type { Entity, WorldBundle } from "@ghostrun/ir";
import {
  BoxGeometry, Color, ConeGeometry, CylinderGeometry, DodecahedronGeometry, DoubleSide, Group, IcosahedronGeometry, Mesh, MeshBasicNodeMaterial,
  MeshStandardNodeMaterial, Path, PlaneGeometry, Shape, ShapeGeometry, type BufferGeometry, type Material,
} from "three/webgpu";
import { mx_noise_float, positionWorld, vec3, vertexColor } from "three/tsl";
import { BoxBatch } from "./boxes";
import type { LookStyle } from "./looks";
import { lin, stripMaterial } from "./materials";
import type { Medium } from "./pick";
import type { Scenery } from "./scenery";
import { liquidMaterial } from "./surfaces";
import { instances, rnd, type Ctx, type Item, type V3 } from "./dressing/common";

/** Vertex-coloured lit boxes with a little world-space noise so big faces don't read flat. */
function terrain(roughness: number, noise: number): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness, metalness: 0 });
  m.colorNode = vertexColor().mul(mx_noise_float(positionWorld.mul(0.35)).mul(noise).add(1));
  return m;
}

const add = (batch: BoxBatch, c: V3, s: V3, hex: string, k = 1) => batch.add(c, s, lin(hex, k), [0, 0, 0, 0], false);

/** Dress a volume world's statics for its medium. */
export function dressVolume(b: WorldBundle, look: LookStyle, medium: Medium, c: Ctx): Scenery {
  const tag = new Map(b.zones.map((z) => [z.id, z.tag]));
  let bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  const floorTops: number[] = [];
  let main = { area: -1, top: 0 };
  for (const s of b.statics) {
    bounds = { minX: Math.min(bounds.minX, s.pos[0] - s.size[0] / 2), maxX: Math.max(bounds.maxX, s.pos[0] + s.size[0] / 2), minZ: Math.min(bounds.minZ, s.pos[2] - s.size[2] / 2), maxZ: Math.max(bounds.maxZ, s.pos[2] + s.size[2] / 2) };
    const top = s.pos[1] + s.size[1] / 2;
    if (s.surf === "floor") floorTops.push(top);
    if (s.surf === "floor" && s.size[0] * s.size[2] > main.area) main = { area: s.size[0] * s.size[2], top };
  }
  if (!Number.isFinite(bounds.minX)) bounds = { minX: -30, maxX: 30, minZ: -30, maxZ: 30 };
  const night = look.night;
  const solid = new BoxBatch();
  const glow = new BoxBatch();
  const done = (groundHex: string): Scenery => {
    if (solid.count) {
      const m = new Mesh(c.keep(solid.build()), c.keep(terrain(0.9, 0.16)));
      m.name = "statics";
      c.root.add(m);
    }
    if (glow.count) {
      const m = new Mesh(c.keep(glow.build()), c.keep(stripMaterial()));
      m.name = "trim";
      c.root.add(m);
    }
    return { floorTops, bounds, groundY: main.top, groundHex };
  };

  if (medium === "sky") {
    const grass = night ? "#2a5a44" : "#6fa64a";
    const dirt = night ? "#3a2e28" : "#7a5a3c";
    const rock: Item[] = [];
    const puffs: Item[] = [];
    const bushes: Item[] = [];
    b.statics.forEach((s, i) => {
      const [x, y, z] = s.pos;
      const [w, h, d] = s.size;
      const top = y + h / 2;
      if (s.surf === "floor" && h <= 0.6) {
        // a cloud step: a soft white slab with puffs round its rim
        add(solid, s.pos, s.size, night ? "#8a93b8" : "#f4f6fb", 1.1);
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + rnd(i * 7 + k);
          const r = 0.6 + rnd(i * 13 + k) * 0.5;
          puffs.push({ p: [x + Math.cos(a) * w * 0.45, top - 0.25, z + Math.sin(a) * d * 0.45], s: [r, r * 0.6, r] });
        }
        return;
      }
      if (s.surf === "floor") {
        // an island: turf on top, earth under it, and a cone of rock hanging below
        const turf = Math.min(0.4, h);
        add(solid, [x, top - turf / 2, z], [w, turf, d], grass);
        if (h > turf) add(solid, [x, y - turf / 2, z], [w, h - turf, d], dirt);
        const r = Math.hypot(w, d) * 0.42;
        rock.push({ p: [x, y - h / 2 - r * 0.7, z], s: [r, r * 1.4, r], r: rnd(i) * 6, tilt: [Math.PI, 0] });
        // a few bushes on its corners, low enough never to hide anything
        if (w * d >= 30) for (const [sx, sz] of [[-1, -1], [1, 1], [1, -1], [-1, 1]] as const) {
          if (rnd(i * 5 + sx * 3 + sz) < 0.35) continue;
          const k = 0.25 + rnd(i * 9 + sx + sz * 2) * 0.2;
          bushes.push({ p: [x + sx * (w / 2 - 0.5), top + k * 0.5, z + sz * (d / 2 - 0.5)], s: [k, k * 0.8, k] });
        }
        return;
      }
      add(solid, s.pos, s.size, night ? "#3c4246" : "#8c8f88");
    });
    // a sea of cloud far below, and a few banks drifting at the islands' height far out
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cz = (bounds.minZ + bounds.maxZ) / 2;
    const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2 + 40;
    const lowest = Math.min(0, ...floorTops) - 26;
    for (let k = 0; k < 70; k++) {
      const r = 4 + rnd(k * 3) * 7;
      puffs.push({ p: [cx + (rnd(k * 3 + 1) * 2 - 1) * span, lowest - rnd(k * 5) * 6, cz + (rnd(k * 3 + 2) * 2 - 1) * span], s: [r * 1.6, r * 0.5, r * 1.3], r: rnd(k) * 6 });
    }
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      const rad = span + 10 + rnd(k + 40) * 30;
      const r = 3 + rnd(k + 50) * 4;
      puffs.push({ p: [cx + Math.cos(a) * rad, main.top + rnd(k + 60) * 24 - 6, cz + Math.sin(a) * rad], s: [r * 1.8, r * 0.6, r * 1.2], r: rnd(k) * 6 });
    }
    instances(c, new ConeGeometry(1, 1, 7), new MeshStandardNodeMaterial({ color: new Color(night ? "#2c2f36" : "#76706a"), roughness: 0.95, flatShading: true }), rock, "island-rock");
    const cloud = new MeshStandardNodeMaterial({ color: new Color(night ? "#5a6488" : "#ffffff"), roughness: 1, flatShading: true });
    cloud.emissiveNode = vec3(...lin(night ? "#20284a" : "#cfd8ea", night ? 0.6 : 0.35));
    instances(c, new IcosahedronGeometry(1, 1), cloud, puffs, "clouds");
    instances(c, new IcosahedronGeometry(1, 0), new MeshStandardNodeMaterial({ color: new Color(night ? "#1f4a38" : "#4f8a3a"), roughness: 0.9, flatShading: true }), bushes, "bushes");
    return done(grass);
  }

  if (medium === "water") {
    const sand = night ? "#6f6656" : "#e2cf9c";
    const wet = night ? "#4a463c" : "#b8a576";
    const wood = night ? "#3a2a1e" : "#6b4a2c";
    const palms: { at: V3; h: number; lean: number }[] = [];
    b.statics.forEach((s, i) => {
      const top = s.pos[1] + s.size[1] / 2;
      if (s.surf === "floor") {
        // dry sand above the water line, wet sand on the seabed
        add(solid, s.pos, s.size, top > -0.5 ? sand : wet, 1 - rnd(i) * 0.06);
        // an islet out in the water gets its palm
        if (top > -0.5 && s.size[0] * s.size[2] < 40) palms.push({ at: [s.pos[0], top, s.pos[2]], h: 4 + rnd(i) * 1.5, lean: 0.18 });
        return;
      }
      // the wreck: its hull and its mast, old timber
      add(solid, s.pos, s.size, wood, 0.9 + rnd(i) * 0.2);
    });
    // palms along the back of the beach (the largest floor), clear of its middle
    const beach = [...b.statics].filter((s) => s.surf === "floor").sort((x, y) => y.size[0] * y.size[2] - x.size[0] * x.size[2])[0];
    if (beach) {
      const bt = beach.pos[1] + beach.size[1] / 2;
      const zBack = beach.pos[2] - beach.size[2] / 2 + 1.5;
      for (const fx of [-0.42, -0.3, 0.32, 0.44]) palms.push({ at: [beach.pos[0] + fx * beach.size[0], bt, zBack + rnd(fx * 10) * 2], h: 4.5 + rnd(fx * 7) * 2, lean: 0.12 + rnd(fx * 3) * 0.12 });
    }
    const trunks: Item[] = palms.map((p, k) => ({ p: [p.at[0], p.at[1] + p.h / 2, p.at[2]], s: [0.18, p.h, 0.18], tilt: [p.lean, 0], r: rnd(k) * 6 }));
    const fronds: Item[] = palms.flatMap((p, k) =>
      [0, 1, 2, 3, 4].map((j) => ({ p: [p.at[0] + Math.sin(p.lean) * p.h * 0.5, p.at[1] + p.h, p.at[2]] as V3, s: [0.35, 0.12, 1.9] as V3, r: (j / 5) * Math.PI * 2 + rnd(k) * 2, tilt: [0.35, 0] as [number, number] })),
    );
    instances(c, new CylinderGeometry(0.7, 1, 1, 6), new MeshStandardNodeMaterial({ color: new Color(night ? "#3a3024" : "#8a6a44"), roughness: 0.95, flatShading: true }), trunks, "palm-trunks");
    const frond = new BoxGeometry(1, 1, 1);
    frond.translate(0, 0, 0.5);
    instances(c, frond, new MeshStandardNodeMaterial({ color: new Color(night ? "#1d3d2a" : "#3f8a3a"), roughness: 0.85, flatShading: true }), fronds, "palm-fronds");
    // the open sea to the horizon, with holes where the swimmable water is (that draws its own surface)
    const waters = b.entities.filter((e) => b.verbs.some((v) => v.verb === "locomotion.swim" && v.on === e.id));
    const seaY = (waters.length ? Math.max(...waters.map((e) => e.pos[1] + e.size[1] / 2)) : main.top) - 0.35;
    c.root.add(sea(c, waters, seaY, night));
    return done(sand);
  }

  // space: hull plates with light strips, trusses and wings, asteroids for the rocks
  const plate = night || look.id === "space" ? "#9aa3b2" : "#b8c0cc";
  const rocks: Item[] = [];
  b.statics.forEach((s, i) => {
    const [x, y, z] = s.pos;
    const [w, h, d] = s.size;
    const top = y + h / 2;
    if (tag.get(s.zone) === "asteroids" || (Math.abs(w - h) < 0.01 && Math.abs(w - d) < 0.01 && s.surf !== "floor" && w < 6)) {
      rocks.push({ p: [x, y, z], s: [w * 0.66, h * 0.62, d * 0.66], r: rnd(i) * 6, tilt: [rnd(i + 1) * 0.8, rnd(i + 2) * 0.8] });
      return;
    }
    if (h <= 0.3) {
      // a solar wing: dark cells in a bright frame
      add(solid, s.pos, s.size, "#1c2a55");
      glow.strip([x - w / 2, top + 0.01, z], [x + w / 2, top + 0.01, z], 0.05, lin("#7fd8ff", 1.4));
      return;
    }
    add(solid, s.pos, s.size, h <= 1.2 ? "#5b6270" : plate, 0.92 + rnd(i) * 0.12);
    if (h > 1.2) {
      // a light band round the module just under its roof, and its roof's edges
      const band = top - 0.35;
      const cy = lin("#38e8ff", 2.2);
      glow.strip([x - w / 2 - 0.01, band, z - d / 2 - 0.01], [x + w / 2 + 0.01, band, z - d / 2 - 0.01], 0.08, cy);
      glow.strip([x - w / 2 - 0.01, band, z + d / 2 + 0.01], [x + w / 2 + 0.01, band, z + d / 2 + 0.01], 0.08, cy);
      glow.strip([x - w / 2 - 0.01, band, z - d / 2], [x - w / 2 - 0.01, band, z + d / 2], 0.08, cy);
      glow.strip([x + w / 2 + 0.01, band, z - d / 2], [x + w / 2 + 0.01, band, z + d / 2], 0.08, cy);
    }
  });
  instances(c, new DodecahedronGeometry(1, 0), new MeshStandardNodeMaterial({ color: new Color("#5e5852"), roughness: 0.95, flatShading: true }), rocks, "asteroids");
  return done("#000000");
}

/** The open sea round a water world: a plane to the horizon with a hole over each swimmable box. */
function sea(c: Ctx, waters: readonly Entity[], y: number, night: boolean): Mesh {
  const R = 400;
  const shape = new Shape();
  shape.moveTo(-R, -R).lineTo(R, -R).lineTo(R, R).lineTo(-R, R).lineTo(-R, -R);
  for (const e of waters) {
    // the shape is drawn in x / −z (the plane is laid flat by turning it about x)
    const [x0, x1, z0, z1] = [e.pos[0] - e.size[0] / 2, e.pos[0] + e.size[0] / 2, -(e.pos[2] - e.size[2] / 2), -(e.pos[2] + e.size[2] / 2)];
    shape.holes.push(new Path().moveTo(x0, z1).lineTo(x0, z0).lineTo(x1, z0).lineTo(x1, z1).lineTo(x0, z1));
  }
  const m = new Mesh(c.keep(new ShapeGeometry(shape)), c.keep(liquidMaterial({ deep: night ? "#06202e" : "#0f5f86", shallow: night ? "#0b3a4a" : "#2aa6c2", roughness: 0.12 })));
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  m.name = "sea";
  return m;
}

/**
 * A body of water you swim in (an entity bound with the swim verb, its box the water): a rippling
 * surface on top, seen from above and below, and a faint blue body to the bottom.
 */
export function waterActor(e: Entity, c: { keep<T extends BufferGeometry | Material>(x: T): T }, night: boolean): Group {
  const g = new Group();
  g.position.set(...e.pos);
  const [w, h, d] = e.size;
  const surfMat = liquidMaterial({ deep: night ? "#062a3a" : "#0e6a8e", shallow: night ? "#0d4d5e" : "#3cc0d6", roughness: 0.08 });
  surfMat.transparent = true;
  surfMat.opacity = 0.72;
  surfMat.depthWrite = false;
  surfMat.side = DoubleSide;
  const surface = new Mesh(c.keep(new PlaneGeometry(w, d)), c.keep(surfMat));
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = h / 2 - 0.02;
  surface.name = "water-surface";
  const bodyMat = new MeshBasicNodeMaterial({ color: new Color(night ? "#0a3448" : "#1a7fa8"), transparent: true, opacity: 0.16, depthWrite: false, side: DoubleSide });
  const body = new Mesh(c.keep(new BoxGeometry(w - 0.02, h - 0.06, d - 0.02)), c.keep(bodyMat));
  body.position.y = -0.03;
  body.name = "water-body";
  body.renderOrder = 2;
  surface.renderOrder = 3;
  g.add(body, surface);
  return g;
}
