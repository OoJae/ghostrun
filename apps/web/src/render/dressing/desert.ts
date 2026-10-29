// Desert: sandstone in layered strata under a hard sun, rippled sand, saguaros and boulders, mesas
// on the horizon. The beach variant trades cacti for palms and the mesas for a turquoise sea; the
// underwater variant is a sandy seabed under shifting caustics, with coral and kelp.
import type { WorldBundle } from "@ghostrun/ir";
import { ConeGeometry, CylinderGeometry, DodecahedronGeometry, IcosahedronGeometry, MeshStandardNodeMaterial, SphereGeometry } from "three/webgpu";
import { abs, float, fract, max, mix, mx_worley_noise_float, oneMinus, positionWorld, sin, smoothstep, time, vec3 } from "three/tsl";
import { BoxBatch } from "../boxes";
import type { LookStyle } from "../looks";
import { lin } from "../materials";
import { CLS, groundMaterial, hex3, is, liquidMaterial, masonry, noise01, staticsMaterial, type N, type N3 } from "../surfaces";
import { batchMesh, classify, clear, cutWall, instances, merged, ring, rnd, style, type Ctx, type Dressed, type Item } from "./common";

const SAND = { desert: "#dcb47c", beach: "#e6cf9c", underwater: "#b8b08c" } as const;
const STONE = {
  desert: ["#c8784a", "#d4905c", "#b8693e", "#dea06c"],
  beach: ["#a89a88", "#bcae98", "#9a8c7a", "#b4a38c"],
  underwater: ["#6a7a74", "#5a6a66", "#7a8a80", "#687872"],
} as const;

/** Slight per-plant colour variation (instance tints over the vertex colours). */
const TINTS = ["#ffffff", "#e6f2dc", "#f6ffe6", "#dce8d0"];

/** A saguaro, 4 m tall at scale 1: a trunk and two arms. */
function cactus() {
  const g = "#4f8a3c";
  const trunk = new CylinderGeometry(0.3, 0.34, 4, 9);
  const cap = new SphereGeometry(0.3, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  return merged([
    { geo: trunk, color: g, at: [0, 2, 0] },
    { geo: cap, color: g, at: [0, 4, 0] },
    { geo: new CylinderGeometry(0.2, 0.2, 0.7, 8), color: g, at: [0.45, 1.8, 0], rot: [0, 0, Math.PI / 2] },
    { geo: new CylinderGeometry(0.2, 0.22, 1.3, 8), color: g, at: [0.75, 2.4, 0] },
    { geo: new SphereGeometry(0.2, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), color: g, at: [0.75, 3.05, 0] },
    { geo: new CylinderGeometry(0.18, 0.18, 0.55, 8), color: g, at: [-0.38, 2.4, 0], rot: [0, 0, Math.PI / 2] },
    { geo: new CylinderGeometry(0.18, 0.2, 0.9, 8), color: g, at: [-0.62, 2.85, 0] },
    { geo: new SphereGeometry(0.18, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), color: g, at: [-0.62, 3.3, 0] },
  ]);
}

/** A palm, 6 m tall at scale 1: a leaning, ringed trunk and a crown of drooping fronds. */
function palm() {
  const parts = [];
  for (let k = 0; k < 6; k++) {
    const y = k * 0.95;
    parts.push({ geo: new CylinderGeometry(0.17 - k * 0.012, 0.2 - k * 0.012, 1, 7), color: k % 2 ? "#8a6a48" : "#7a5c3e", at: [k * k * 0.03, y + 0.5, 0] as [number, number, number], rot: [0, 0, -0.06 * k] as [number, number, number] });
  }
  const top: [number, number, number] = [1.05, 5.8, 0];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    parts.push({ geo: new ConeGeometry(0.35, 3.2, 4, 1), color: k % 2 ? "#4a9a3e" : "#3c8a36", at: [top[0] + Math.cos(a) * 1.3, top[1] - 0.35, Math.sin(a) * 1.3] as [number, number, number], rot: [Math.sin(a) * 1.25, 0, -Math.cos(a) * 1.25] as [number, number, number], scale: [1, 1, 0.18] as [number, number, number] });
  }
  parts.push({ geo: new SphereGeometry(0.3, 7, 5), color: "#5a4a2a", at: top });
  return merged(parts);
}

export function dressDesert(b: WorldBundle, look: LookStyle, c: Ctx): Dressed {
  const v = look.variant === "beach" || look.variant === "underwater" ? look.variant : "desert";
  const beach = v === "beach";
  const under = v === "underwater";
  const { pieces, bounds, groundY } = classify(b);
  const solid = new BoxBatch();
  const water = new BoxBatch();
  const hot = new BoxBatch();
  const floorTops: number[] = [];
  const trees: Item[] = [];
  const rocks: Item[] = [];
  const shrubs: Item[] = [];
  const stones = STONE[v];
  const sand = lin(SAND[v]);
  const tone = (i: number) => lin(stones[Math.floor(rnd(i) * stones.length)]!);
  const cut = look.cutaway;

  for (const p of pieces) {
    const { s, i } = p;
    const [x, y, z] = s.pos;
    const [w, h, d] = s.size;
    switch (p.kind) {
      case "ground":
      case "floor":
      case "mound":
        floorTops.push(p.top);
        solid.add(s.pos, s.size, p.kind === "mound" ? [sand[0] * 1.05, sand[1] * 1.03, sand[2]] : sand, style(CLS.ground, i));
        break;
      case "path":
        solid.add(s.pos, s.size, [sand[0] * 0.88, sand[1] * 0.84, sand[2] * 0.8], style(CLS.path, i));
        break;
      case "water":
        water.add([x, p.top - 0.01, z], [w, 0.02, d], [1, 1, 1]);
        break;
      case "hazard":
        hot.add([x, p.top - 0.01, z], [w, 0.04, d], [1, 1, 1]);
        break;
      case "wall":
        if (cut) cutWall(solid, p, tone(i), 1);
        else solid.add(s.pos, s.size, tone(i), style(CLS.wall, i));
        break;
      case "trunk":
        trees.push({ p: [x, p.min[1], z], s: [Math.max(w, d) * (beach ? 2.2 : 2.6), h / (beach ? 6 : 4), Math.max(w, d) * (beach ? 2.2 : 2.6)], r: rnd(i) * 6, color: TINTS[Math.floor(rnd(i + 2) * TINTS.length)]! });
        break;
      case "cover":
        rocks.push({ p: [x, y, z], s: [w / 2 + 0.05, h / 2 + 0.05, d / 2 + 0.05], r: rnd(i) * 6, color: stones[Math.floor(rnd(i + 1) * stones.length)]! });
        break;
      case "lintel": // over a doorway, above the cut-away walls
        break;
      case "boundary":
        // the beach stays open to the sea: its edge is a low line of rocks (the collider keeps its height)
        if (beach) solid.add([x, p.min[1] + 0.7, z], [w, 1.4, d], tone(i), style(CLS.ledge, i));
        else solid.add(s.pos, s.size, tone(i), style(CLS.ledge, i));
        break;
      default:
        // ledges, perimeter cliffs and anything blocky: sandstone in strata
        solid.add(s.pos, s.size, tone(i), style(CLS.ledge, i));
    }
  }

  // small dressing on open ground near the edges, where nobody runs: shrubs, pebbles, young cacti
  const open = b.pack.id === "outdoor" || b.pack.id === "arena" || b.pack.id === "maze";
  if (open && !cut) {
    const spots = b.entities.map((e) => e.pos);
    for (let k = 0; k < 90; k++) {
      const x = bounds.minX + 1.5 + rnd(k * 7 + 1) * (bounds.maxX - bounds.minX - 3);
      const z = bounds.minZ + 1.5 + rnd(k * 7 + 2) * (bounds.maxZ - bounds.minZ - 3);
      const edge = Math.min(x - bounds.minX, bounds.maxX - x, z - bounds.minZ, bounds.maxZ - z);
      if (!clear(pieces, x, z, 0.8) || spots.some((e) => Math.hypot(e[0] - x, e[2] - z) < 2.2)) continue;
      const s = 0.25 + rnd(k * 7 + 3) * 0.35;
      if (edge < 4 && rnd(k * 7 + 4) < 0.35 && !under) trees.push({ p: [x, groundY, z], s: [0.7, beach ? 0.3 : 0.35, 0.7], r: rnd(k) * 6, color: "#ffffff" });
      else (rnd(k * 7 + 5) < 0.5 ? rocks : shrubs).push({ p: [x, groundY + s * 0.3, z], s: [s, s * 0.7, s], r: rnd(k) * 6, color: rnd(k * 7 + 5) < 0.5 ? stones[k % stones.length]! : under ? ["#ff7a8a", "#ffb04a", "#c86aff", "#ff5a7a"][k % 4]! : beach ? "#5a8a3a" : "#8a8a4a" });
    }
  }

  // the horizon: mesas, or a ring of headland rocks at the beach, or reef rocks under the sea
  const far = ring(bounds, under ? 40 : beach ? 26 : 34, 14, 40, 900).map(({ x, z, k }): Item => {
    const r = (beach ? 4 : 7) + rnd(k) * (beach ? 6 : 12);
    const h = beach ? 3 + rnd(k + 1) * 6 : under ? 4 + rnd(k + 1) * 10 : 8 + rnd(k + 1) * 24;
    return { p: [x, groundY + h / 2 - 0.5, z], s: [r, h, r * (0.6 + rnd(k + 2) * 0.6)], r: rnd(k + 3) * 6, color: stones[k % stones.length]! };
  });

  // ---- materials ----------------------------------------------------------------------------
  const mat = staticsMaterial((a) => {
    const n1 = noise01(a.p, 0.32);
    const fine = noise01(a.p, 3.1, 7);
    const ripple = sin(a.p.x.mul(0.9).add(a.p.z.mul(2.4)).add(n1.mul(5))).mul(0.5).add(0.5);
    const grains = mix(float(0.9), float(1.06), ripple.mul(0.45).add(fine.mul(0.55)));
    // cliffs in layered strata, wavering, with vertical streaks where water once ran
    const layer = fract(a.p.y.mul(0.85).add(n1.mul(0.9)));
    const streak = noise01(vec3(a.along.mul(1.4), a.p.y.mul(0.12), a.seed), 1).mul(0.22).add(0.88);
    const strata = mix(float(0.8), float(1.1), smoothstep(0.15, 0.85, layer)).mul(fine.mul(0.2).add(0.88)).mul(streak);
    // temple walls in dressed blocks
    const m = masonry(a.along, a.up, 1.7, 0.85, 0.03);
    const blocks = mix(m.id.mul(0.14).add(0.92).mul(fine.mul(0.16).add(0.9)), float(0.72), m.mortar);
    const flat = max(is(a.cls, CLS.ground), is(a.cls, CLS.path));
    const rockTop = mix(strata, grains.mul(1.08), smoothstep(0.4, 0.62, n1)); // sand settles on the tops
    const side = mix(strata, blocks, is(a.cls, CLS.wall));
    const k = mix(mix(side, rockTop, a.top), grains, flat);
    // under the sea, the same caustics play over every floor as over the seabed
    const emissive = under ? caustics(a.p).mul(a.top) : vec3(0, 0, 0);
    return { color: vec3(k, k, k), emissive, bump: mix(fine.mul(0.02).add(m.mortar.mul(is(a.cls, CLS.wall)).mul(-0.03)), ripple.mul(0.015), flat) };
  }, { roughness: 0.92, bump: 1 });
  batchMesh(c, solid, mat, "statics");
  batchMesh(c, water, liquidMaterial(under ? { deep: "#0a5a66", shallow: "#2aa6b0", roughness: 0.2 } : { deep: beach ? "#0a7a9a" : "#1a6a7a", shallow: beach ? "#3ad0d0" : "#4ab0a8" }), "water");
  batchMesh(c, hot, liquidMaterial({ deep: "#5a1a08", shallow: "#ff6a1a", glow: "#ff5a10", glowScale: 2.2, roughness: 0.6, flow: 0.4 }), "lava");

  const plant = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8, flatShading: true });
  instances(c, beach || under ? (under ? kelp() : palm()) : cactus(), plant, trees, beach ? "palms" : "cacti");
  instances(c, new DodecahedronGeometry(1, 0), new MeshStandardNodeMaterial({ roughness: 0.95, flatShading: true }), rocks, "rocks");
  instances(c, new IcosahedronGeometry(1, under ? 1 : 0), new MeshStandardNodeMaterial({ roughness: under ? 0.5 : 0.9, flatShading: true }), shrubs, under ? "coral" : "shrubs");
  // mesas: flat-topped, tapering, banded like the cliffs they were cut from
  const mesa = new MeshStandardNodeMaterial({ roughness: 0.95, flatShading: true });
  {
    const n1 = noise01(positionWorld, 0.05);
    const layer = fract(positionWorld.y.mul(0.35).add(n1));
    mesa.colorNode = vec3(1, 1, 1).mul(mix(float(0.78), float(1.08), smoothstep(0.2, 0.8, layer)));
  }
  instances(c, beach ? new DodecahedronGeometry(1, 0) : new CylinderGeometry(0.82, 1, 1, 7), mesa, far, "mesas");

  // the ground: rippled sand; at the beach it runs out into a turquoise sea beyond the play area
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cz = (bounds.minZ + bounds.maxZ) / 2;
  const half = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2;
  const ground = groundMaterial((p) => {
    const n1 = noise01(p, 0.25);
    const ripple = sin(p.x.mul(0.8).add(p.z.mul(2.2)).add(n1.mul(5))).mul(0.5).add(0.5);
    const fine = noise01(p, 2.7, 3);
    let color: N3 = hex3(SAND[v]).mul(mix(float(0.88), float(1.04), ripple.mul(0.5).add(fine.mul(0.5))));
    let emissive: N3 = vec3(0, 0, 0);
    let roughness: N = float(0.95);
    if (beach) {
      const dist = max(abs(p.x.sub(cx)), abs(p.z.sub(cz))).sub(half + 9).add(n1.mul(5));
      const sea = smoothstep(0, 4, dist);
      const wet = smoothstep(-3, 0, dist).mul(oneMinus(sea));
      const swell = noise01(vec3(p.x.mul(0.3).add(time.mul(0.15)), p.z.mul(0.3), time.mul(0.1)), 1);
      color = mix(color.mul(oneMinus(wet.mul(0.35))), mix(hex3("#0a6a8a"), hex3("#40c8c8"), swell.mul(oneMinus(smoothstep(0, 30, dist)))), sea);
      roughness = mix(float(0.95), float(0.12), max(sea, wet.mul(0.6)));
    }
    if (under) emissive = caustics(p);
    return { color, roughness, emissive, bump: ripple.mul(0.02) };
  }, { bump: 1 });

  return { floorTops, groundY, bounds, groundHex: SAND[v], ground, shelter: look.indoor ? bounds : null };
}

/** Caustics: bright, shifting cells of light thrown down through the waves. */
function caustics(p: N3): N3 {
  const w = mx_worley_noise_float(vec3(p.x.mul(0.7), p.z.mul(0.7), time.mul(0.35)));
  return hex3("#9ff4ff", 0.5).mul(smoothstep(0.25, 0.0, w).add(smoothstep(0.55, 0.15, w).mul(0.25)));
}

/** Kelp: a tall, thin, swaying ribbon of fronds (4 m at scale 1). */
function kelp() {
  return merged([
    { geo: new ConeGeometry(0.25, 4, 5, 1), color: "#3a7a3a", at: [0, 2, 0] },
    { geo: new ConeGeometry(0.4, 1.4, 5, 1), color: "#4a8a3a", at: [0.15, 1.2, 0], rot: [0, 0, -0.3], scale: [1, 1, 0.3] },
    { geo: new ConeGeometry(0.35, 1.2, 5, 1), color: "#4a8a3a", at: [-0.12, 2.4, 0], rot: [0, 0, 0.35], scale: [1, 1, 0.3] },
  ]);
}
