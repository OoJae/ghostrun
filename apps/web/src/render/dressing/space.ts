// Space station: brushed deck plates with seams and rivets, bulkheads banded with light strips,
// hazard-striped platform edges, consoles whose screens blink, pillars ringed with light, a hull
// that runs out to the stars and a ringed planet hanging in them. The moon variant is grey regolith
// pocked with craters, with the Earth in a black sky.
import type { WorldBundle } from "@ghostrun/ir";
import { CylinderGeometry, DodecahedronGeometry, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, RingGeometry, SphereGeometry, TorusGeometry, DoubleSide } from "three/webgpu";
import { abs, float, floor, fract, hash, max, mix, mx_worley_noise_float, normalView, oneMinus, positionViewDirection, positionWorld, sin, smoothstep, step, time, vec2, vec3 } from "three/tsl";
import { BoxBatch } from "../boxes";
import type { LookStyle } from "../looks";
import { lin } from "../materials";
import { sunDirection } from "../sky";
import { CLS, groundMaterial, hex3, is, liquidMaterial, noise01, seams, staticsMaterial, type N, type N3 } from "../surfaces";
import { batchMesh, classify, CUT_H, cutWall, instances, lamps, ring, rnd, style, type Ctx, type Dressed, type Item, type V3 } from "./common";

/** Deck plates: 2 m panels, a tint per panel, seams and corner rivets. */
function deck(p: N3, size: number) {
  const u = p.x.div(size);
  const v = p.z.div(size);
  const seam = seams(u, v, 0.012);
  const id = hash(floor(u).add(floor(v).mul(61)).add(3000));
  const fu = fract(u);
  const fv = fract(v);
  const corner = smoothstep(0.03, 0.0, abs(fu.sub(0.06)).max(abs(fv.sub(0.06))))
    .add(smoothstep(0.03, 0.0, abs(fu.sub(0.94)).max(abs(fv.sub(0.94)))));
  const brushed = noise01(p.mul(vec3(1, 1, 18)), 2.2).mul(0.08).add(0.96);
  return { tone: mix(id.mul(0.16).add(0.86).mul(brushed), float(0.45), max(seam, corner.mul(0.8))), seam, id };
}

/** Yellow and black diagonal hazard stripes. */
const hazard = (along: N, y: N) => step(0.5, fract(along.add(y).mul(1.6)));

export function dressSpace(b: WorldBundle, look: LookStyle, c: Ctx): Dressed {
  const moon = look.variant === "moon";
  const { pieces, bounds, groundY } = classify(b);
  const solid = new BoxBatch();
  const floors = new BoxBatch();
  const pool = new BoxBatch();
  const floorTops: number[] = [];
  const pillars: Item[] = [];
  const rings: Item[] = [];
  const rocks: Item[] = [];
  const glowAt: V3[] = [];
  const metal = (i: number) => lin(moon ? ["#8a8a88", "#9a9a96", "#7a7a78"][i % 3]! : ["#7c8694", "#8a94a2", "#6e7886"][i % 3]!);
  const deckRgb = lin(moon ? "#8e8e8a" : "#6a7280");
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
        floors.add(s.pos, s.size, p.kind === "path" ? [deckRgb[0] * 0.7, deckRgb[1] * 0.72, deckRgb[2] * 0.78] : deckRgb, style(p.kind === "path" ? CLS.path : CLS.ground, i));
        break;
      case "water":
      case "hazard":
        pool.add([x, p.top - 0.01, z], [w, 0.04, d], [1, 1, 1]);
        break;
      case "wall":
        if (cut) cutWall(solid, p, metal(i));
        else solid.add(s.pos, s.size, metal(i), style(CLS.wall, i, h));
        break;
      case "trunk":
        pillars.push({ p: [x, p.min[1] + h / 2, z], s: [Math.max(w, d) * 0.75, h, Math.max(w, d) * 0.75] });
        for (const f of [0.2, 0.55, 0.9]) rings.push({ p: [x, p.min[1] + h * f, z], s: [Math.max(w, d) * 0.85, Math.max(w, d) * 0.85, Math.max(w, d) * 0.85], tilt: [Math.PI / 2, 0], color: "#4fd8ff", scale: 3 });
        break;
      case "cover":
        // consoles: the box itself, its top a screen (see the material), a light over some
        solid.add(s.pos, s.size, metal(i), style(CLS.cover, i));
        if (rnd(i) < 0.25) glowAt.push([x, p.top + 0.6, z]);
        break;
      case "boundary":
        if (moon) rocks.push({ p: [x, y, z], s: [w / 2 + 0.6, h / 2 + 0.4, d / 2 + 0.6], r: 0, color: "#7a7a78" });
        solid.add(s.pos, s.size, metal(i), moon ? style(CLS.trim, i) : style(CLS.wall, i, h));
        break;
      case "lintel": // over a doorway, above the cut-away walls
        break;
      default:
        solid.add(s.pos, s.size, metal(i), style(CLS.ledge, i, p.top));
    }
  }

  // ---- materials ----------------------------------------------------------------------------
  // floors and the rest are separate draws, so each pixel runs only the pattern it shows
  const decks = staticsMaterial((a) => {
    const d = deck(a.p, 2);
    // a path: a lit centre line
    const line = hex3("#ffb02e", 1.4).mul(is(a.cls, CLS.path)).mul(step(0.6, fract(a.p.x.add(a.p.z).mul(0.5)))).mul(0.25);
    return { color: vec3(d.tone, d.tone, d.tone), emissive: line.mul(a.top), metalness: float(moon ? 0.1 : 0.55), roughness: float(moon ? 0.85 : 0.42), bump: d.seam.mul(-0.02) };
  }, { roughness: 0.45, metalness: 0.5, bump: 1 });
  const hull = staticsMaterial((a) => {
    const d = deck(a.p, 2);
    // bulkheads: tall panels, a light strip near the top of each wall (just under a cut-away's edge)
    const panelU = a.along.div(1.5);
    const wallSeam = seams(panelU, a.p.y.div(0.9), 0.015);
    const wallId = hash(floor(panelU).add(a.seed.mul(7)));
    const strip = smoothstep(0.05, 0.0, abs(a.p.y.sub(groundY).sub(cut ? CUT_H - 0.18 : 2.0)));
    const wall = mix(wallId.mul(0.12).add(0.88), float(0.5), wallSeam);
    // platform edges: hazard stripes in a band under the top edge (aStyle.z: the platform's top)
    const stripes = hazard(a.along, a.p.y);
    // console screens: a blue grid whose cells blink at their own pace
    const cellU = a.p.x.mul(5).floor();
    const cellV = a.p.z.mul(5).floor();
    const blink = step(0.55, fract(hash(cellU.add(cellV.mul(37))).add(time.mul(hash(cellU.mul(3).add(cellV)).mul(0.6).add(0.1)))));
    const isCover = is(a.cls, CLS.cover);
    const isLedge = is(a.cls, CLS.ledge);
    const top = mix(d.tone, float(0.25), isCover); // a screen is dark glass
    // the moon's cliffs: plain grey rock
    const rock = moon ? noise01(a.p, 0.6).mul(0.3).add(noise01(a.p, 3, 4).mul(0.15)).add(0.6) : float(1);
    const sideTone = mix(mix(wall, d.tone, isLedge), rock, is(a.cls, CLS.trim));
    const k = mix(sideTone, top, a.top);
    let emissive: N3 = hex3("#4fd8ff", 2.2).mul(strip.mul(is(a.cls, CLS.wall)).mul(oneMinus(a.top)));
    emissive = emissive.add(hex3("#3ab0ff", 1.3).mul(blink.mul(0.7).add(0.3)).mul(isCover).mul(a.top));
    const yellow = mix(vec3(1, 1, 1), mix(hex3("#ffc21a").mul(1.6), vec3(0.08, 0.08, 0.08), stripes), isLedge.mul(oneMinus(a.top)).mul(step(a.extra.sub(0.3), a.p.y)));
    const color = vec3(k, k, k).mul(yellow);
    const metalness: N = mix(float(moon ? 0.1 : 0.55), float(0.2), isCover.mul(a.top));
    const roughness: N = mix(float(moon ? 0.85 : 0.42), float(0.15), isCover.mul(a.top));
    return { color, emissive, metalness, roughness, bump: mix(wallSeam, d.seam, a.top).mul(-0.02) };
  }, { roughness: 0.45, metalness: 0.5, bump: 1 });
  batchMesh(c, floors, decks, "floors");
  batchMesh(c, solid, hull, "statics");
  batchMesh(c, pool, liquidMaterial({ deep: "#08203a", shallow: "#1a6aff", glow: "#3ab0ff", glowScale: 1.6, roughness: 0.2, flow: 0.6 }), "coolant");

  const steel = new MeshStandardNodeMaterial({ color: "#8a94a2", roughness: 0.35, metalness: 0.75 });
  instances(c, new CylinderGeometry(0.5, 0.5, 1, 14), steel, pillars, "pillars");
  instances(c, new TorusGeometry(0.62, 0.06, 6, 24), new MeshBasicNodeMaterial(), rings, "pillar lights");
  lamps(c, glowAt, "#4fd8ff", 8, 8, 2);

  if (moon) {
    // regolith boulders and the base's domes on the horizon
    for (const { x, z, k } of ring(bounds, 40, 2, 30, 500)) rocks.push({ p: [x, groundY, z], s: [1 + rnd(k) * 3, 0.6 + rnd(k + 1) * 1.6, 1 + rnd(k + 2) * 3], r: rnd(k + 3) * 6, color: "#8a8a86" });
    instances(c, new DodecahedronGeometry(1, 0), new MeshStandardNodeMaterial({ roughness: 0.95, flatShading: true }), rocks, "rocks");
    const domes = ring(bounds, 7, 18, 20, 610).map(({ x, z, k }): Item => ({ p: [x, groundY, z], s: [4 + rnd(k) * 4, 3 + rnd(k) * 3, 4 + rnd(k) * 4], color: "#e8ecf2" }));
    instances(c, new SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.3 }), domes, "domes");
  }

  // a planet hanging in the sky: lit from the look's sun, rimmed by its atmosphere
  const sun = sunDirection(look).clone();
  const at = sun.clone().multiplyScalar(-1).setY(0.32).normalize().multiplyScalar(230);
  const planet = new MeshStandardNodeMaterial({ roughness: 0.9 });
  planet.fog = false;
  const bands = noise01(positionWorld.mul(vec3(0.02, 0.12, 0.02)), 1).mul(0.4).add(sin(positionWorld.y.mul(0.35)).mul(0.15)).add(0.6);
  planet.colorNode = moon ? mix(hex3("#1a4a9a"), hex3("#f4f8ff"), smoothstep(0.55, 0.75, noise01(positionWorld, 0.08))) : mix(hex3("#6a3a8a"), hex3("#e8a46a"), bands);
  const rim = oneMinus(abs(normalView.dot(positionViewDirection.negate()))).pow(3);
  planet.emissiveNode = hex3(moon ? "#5aa8ff" : "#ffb88a", 1.2).mul(rim);
  const ball = new Mesh(c.keep(new SphereGeometry(moon ? 22 : 38, 48, 24)), c.keep(planet));
  ball.position.copy(at);
  ball.name = "planet";
  c.root.add(ball);
  if (!moon) {
    const band = new MeshBasicNodeMaterial({ side: DoubleSide, transparent: true, depthWrite: false });
    band.fog = false;
    const r = positionWorld.sub(vec3(at.x, at.y, at.z)).length();
    band.colorNode = hex3("#d8b890", 0.9);
    band.opacityNode = smoothstep(48, 52, r).mul(oneMinus(smoothstep(70, 76, r))).mul(sin(r.mul(1.7)).mul(0.25).add(0.55));
    const disc = new Mesh(c.keep(new RingGeometry(46, 78, 96, 1)), c.keep(band));
    disc.position.copy(at);
    disc.rotation.set(-1.2, 0.3, 0.25);
    c.root.add(disc);
  }

  // the ground: hull plating to the horizon with running lights, or the moon's cratered dust
  const ground = groundMaterial((p) => {
    if (moon) {
      const w = mx_worley_noise_float(vec2(p.x.mul(0.09), p.z.mul(0.09)));
      const crater = smoothstep(0.12, 0.3, w).mul(0.4).add(smoothstep(0.32, 0.26, w).mul(0.25)).add(0.6);
      const dust = noise01(p, 0.6).mul(0.15).add(noise01(p, 4, 2).mul(0.08)).add(0.8);
      return { color: hex3("#8e8e8a").mul(crater.mul(dust)), roughness: float(0.95), bump: crater.mul(0.6) };
    }
    const d = deck(p, 4);
    const lane = step(0.97, fract(p.x.div(24))).add(step(0.97, fract(p.z.div(24)))).min(1);
    const run = step(0.7, fract(p.x.add(p.z).mul(0.08).sub(time.mul(0.6))));
    return { color: hex3("#4a525e").mul(d.tone), metalness: float(0.6), roughness: float(0.38), emissive: hex3("#4fd8ff", 1.6).mul(lane.mul(run)), bump: d.seam.mul(-0.03) };
  }, { roughness: 0.4, metalness: moon ? 0 : 0.6, bump: 1 });

  return { floorTops, groundY, bounds, groundHex: moon ? "#8e8e8a" : "#4a525e", ground, shelter: look.indoor ? bounds : null };
}
