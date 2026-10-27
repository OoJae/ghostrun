// Placed WorldBundle → three.js scene graph. Statics merge into two batches (solid + neon strips),
// entities become small groups whose transforms the engine drives from FrameSource poses.
import type { Entity, WorldBundle } from "@ghostrun/ir";
import {
  AdditiveBlending, CapsuleGeometry, CircleGeometry, ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide,
  Color, Group, HemisphereLight, Mesh, MeshBasicNodeMaterial, MeshStandardNodeMaterial, Object3D, PlaneGeometry, PointLight, RingGeometry, SphereGeometry,
  TorusGeometry, type BufferGeometry, type Material,
} from "three/webgpu";
import { length, oneMinus, smoothstep, uv, vec2, vec3 } from "three/tsl";
import { collidersOf, groundBelow, type Box } from "../sim/aabb";
import { PLAYER_ID } from "../sim/types";
import { BoxBatch } from "./boxes";
import { PALETTE, beamMaterial, bodyMaterial, buildingMaterial, glowMaterial, groundMaterial, lin, rimBodyMaterial, stripMaterial } from "./materials";
import { kitActor, type KitActor } from "./kits";
import type { LookStyle } from "./looks";
import { buildScenery, type Scenery } from "./scenery";
import { signMaterial } from "./sign";
import { verb } from "@ghostrun/kits";

export interface WorldView {
  root: Group;
  /** Pose-driven objects by entity id, plus the player under PLAYER_ID. */
  actors: Map<string, Object3D>;
  colliders: Box[];
  /** Cosmetic per-frame animation only; never moves an actor's pose. */
  update(t: number): void;
  /** Sim state changes and removals (switch on, door open, coin collected). */
  setState(id: string, s: string): void;
  gone(id: string): void;
  dispose(): void;
}

type V3 = [number, number, number];
const TEAM_HEX: Record<string, string> = { red: PALETTE.red, blue: PALETTE.blue, "": PALETTE.cyan };

/** Cosmetic hash in [0, 1) (rendering only; the sim never sees it). */
const rnd = (i: number) => {
  const x = Math.sin(i * 91.345 + 47.853) * 43758.5453;
  return x - Math.floor(x);
};

export function buildWorldView(bundle: WorldBundle, look: LookStyle): WorldView {
  const neonLook = look.id === "neon";
  const city = neonLook && bundle.pack.id === "city_block";
  // entity glow lights were tuned for dark streets; pale rooms and daylight need far less
  const lightK = neonLook ? 1 : look.night ? 0.45 : 0.15;
  const root = new Group();
  root.name = "world";
  const actors = new Map<string, Object3D>();
  const geos: BufferGeometry[] = [];
  const mats: Material[] = [];
  const keep = <T extends BufferGeometry | Material>(x: T): T => {
    if ((x as Material).isMaterial) mats.push(x as Material);
    else geos.push(x as BufferGeometry);
    return x;
  };
  const animated: ((t: number) => void)[] = [];

  // ---- Statics -------------------------------------------------------------------------------
  const solid = new BoxBatch();
  const neon = new BoxBatch();
  const floorTops: number[] = [];
  let arena = { minX: -40, maxX: 40, minZ: -20, maxZ: 20 };

  if (neonLook) bundle.statics.forEach((s, i) => {
    const [x, y, z] = s.pos;
    const [w, h, d] = s.size;
    const min: V3 = [x - w / 2, y - h / 2, z - d / 2];
    const max: V3 = [x + w / 2, y + h / 2, z + d / 2];
    const hue = rnd(i * 3 + 1) < 0.5 ? 0 : 1;
    const neonHex = hue === 0 ? PALETTE.magenta : PALETTE.cyan;
    if (s.surf === "floor") {
      floorTops.push(max[1]);
      arena = { minX: min[0], maxX: max[0], minZ: min[2], maxZ: max[2] };
      return;
    }
    if (s.surf === "ledge") {
      solid.add(s.pos, s.size, lin("#10111b"), [0, i, 1, 0]);
      const cy = lin(PALETTE.cyan, 3.2);
      neon.strip([min[0], max[1], min[2]], [max[0], max[1], min[2]], 0.09, cy);
      neon.strip([min[0], max[1], max[2]], [max[0], max[1], max[2]], 0.07, lin(PALETTE.cyan, 1.6));
      neon.strip([min[0], max[1] * 0.5, min[2]], [max[0], max[1] * 0.5, min[2]], 0.04, lin(PALETTE.cyan, 0.9));
      for (const ex of [min[0], max[0]]) neon.strip([ex, min[1], min[2]], [ex, max[1], min[2]], 0.07, lin(PALETTE.cyan, 2));
      return;
    }
    if (h < 3) {
      // Low cover (base kiosks): team trim from which half of the arena it sits in.
      const team = x < 0 ? PALETTE.red : PALETTE.blue;
      solid.add(s.pos, s.size, lin("#17141f"), [0, i, 0, 0]);
      const t = lin(team, 2.6);
      neon.strip([min[0], max[1], min[2]], [max[0], max[1], min[2]], 0.07, t);
      neon.strip([min[0], max[1], max[2]], [max[0], max[1], max[2]], 0.07, t);
      neon.strip([min[0], max[1], min[2]], [min[0], max[1], max[2]], 0.07, t);
      neon.strip([max[0], max[1], min[2]], [max[0], max[1], max[2]], 0.07, t);
      return;
    }
    // Buildings and perimeter walls: dark blocks, window grid, neon roofline and bands.
    const shade = 0.75 + rnd(i * 7) * 0.5;
    solid.add(s.pos, s.size, lin("#0e0d16", shade), [1, i, hue, 0]);
    const roof = lin(neonHex, 2.6 + rnd(i) * 1.2);
    const o = 0.02;
    neon.strip([min[0] - o, max[1], min[2] - o], [max[0] + o, max[1], min[2] - o], 0.1, roof);
    neon.strip([min[0] - o, max[1], max[2] + o], [max[0] + o, max[1], max[2] + o], 0.1, roof);
    neon.strip([min[0] - o, max[1], min[2] - o], [min[0] - o, max[1], max[2] + o], 0.1, roof);
    neon.strip([max[0] + o, max[1], min[2] - o], [max[0] + o, max[1], max[2] + o], 0.1, roof);
    if (rnd(i * 5 + 2) < 0.65 && h > 4.5) {
      const by = 2.2 + Math.floor(rnd(i * 11) * Math.max(1, (h - 3) / 1.4)) * 1.4;
      const band = lin(hue === 0 ? PALETTE.cyan : PALETTE.magenta, 2.2);
      neon.strip([min[0] - o, by, min[2] - o], [max[0] + o, by, min[2] - o], 0.06, band);
      neon.strip([min[0] - o, by, max[2] + o], [max[0] + o, by, max[2] + o], 0.06, band);
    }
    if (rnd(i * 13 + 4) < 0.5) {
      const vc = lin(neonHex, 1.8);
      for (const [cx, cz] of [[min[0], min[2]], [max[0], min[2]], [min[0], max[2]], [max[0], max[2]]] as const) {
        neon.strip([cx, 0, cz], [cx, max[1], cz], 0.06, vc);
      }
    }
  });

  // Cosmetic skyline beyond the perimeter (not collidable, not in the bundle).
  const margin = 6;
  if (neonLook) for (let gx = -110; gx <= 110; gx += 11) {
    for (let gz = -80; gz <= 80; gz += 11) {
      if (gx > arena.minX - margin - 6 && gx < arena.maxX + margin + 6 && gz > arena.minZ - margin - 6 && gz < arena.maxZ + margin + 6) continue;
      const k = (gx + 200) * 1000 + gz + 200;
      if (rnd(k) < 0.18) continue;
      const w = 6 + rnd(k + 1) * 4;
      const dd = 6 + rnd(k + 2) * 4;
      const near = Math.max(Math.abs(gx) / 110, Math.abs(gz) / 80);
      const h = 12 + rnd(k + 3) * 30 * (0.5 + near);
      const hue = rnd(k + 4) < 0.5 ? 0 : 1;
      solid.add([gx, h / 2, gz], [w, h, dd], lin("#0b0a12", 0.8 + rnd(k + 5) * 0.4), [0.8, k % 4096, hue, 0]);
      if (rnd(k + 6) < 0.45) {
        const c = lin(hue === 0 ? PALETTE.magenta : PALETTE.cyan, 2.4);
        neon.strip([gx - w / 2, h, gz - dd / 2], [gx + w / 2, h, gz - dd / 2], 0.18, c);
        neon.strip([gx - w / 2, h, gz + dd / 2], [gx + w / 2, h, gz + dd / 2], 0.18, c);
        neon.strip([gx - w / 2, h, gz - dd / 2], [gx - w / 2, h, gz + dd / 2], 0.18, c);
        neon.strip([gx + w / 2, h, gz - dd / 2], [gx + w / 2, h, gz + dd / 2], 0.18, c);
      }
    }
  }

  let scenery: Scenery | null = null;
  if (!neonLook) {
    scenery = buildScenery(bundle, look, { keep, animated, root });
    arena = scenery.bounds;
  }

  // Ground markings (part of the neon batch): base lines, street centre dashes, curb glow.
  const gy = (scenery ? scenery.groundY : floorTops.length ? Math.max(...floorTops) : 0) + 0.012;
  const flat = (x0: number, z0: number, x1: number, z1: number, rgb: V3, wdt = 0.12) =>
    neon.add([(x0 + x1) / 2, gy, (z0 + z1) / 2], [Math.abs(x1 - x0) || wdt, 0.02, Math.abs(z1 - z0) || wdt], rgb);
  const baseX = 24;
  if (city) for (let zz = -11; zz < 11; zz += 2.2) {
    flat(-baseX, zz, -baseX, zz + 1.4, lin(PALETTE.red, 2.2), 0.16);
    flat(baseX, zz, baseX, zz + 1.4, lin(PALETTE.blue, 2.2), 0.16);
  }
  if (city) for (let xx = -baseX + 1; xx < baseX - 1; xx += 3) {
    if (Math.abs(xx + 0.75) < 8) continue;
    flat(xx, 0, xx + 1.5, 0, lin("#ffcf7a", 0.9), 0.1);
  }
  if (city) for (const zz of [-12, 12]) flat(arena.minX + 2, zz, arena.maxX - 2, zz, lin(PALETTE.cyan, 0.7), 0.06);

  const solidMesh = new Mesh(keep(solid.build()), keep(buildingMaterial()));
  solidMesh.name = "statics";
  const neonMesh = new Mesh(keep(neon.build()), keep(stripMaterial()));
  neonMesh.name = "neon";
  if (neonLook) root.add(solidMesh, neonMesh);

  const groundMat = neonLook ? groundMaterial() : new MeshStandardNodeMaterial({ color: new Color(scenery!.groundHex), roughness: 0.95, metalness: 0 });
  const ground = new Mesh(keep(new PlaneGeometry(320, 240)), keep(groundMat));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = gy - 0.012;
  ground.name = "ground";
  root.add(ground);

  // Plaza rings around the orb's plinth.
  const plaza = new Mesh(keep(new RingGeometry(6.7, 6.85, 128)), keep(glowMaterial(PALETTE.cyan, 1.6)));
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = gy + 0.004;
  if (city) root.add(plaza);

  // ---- Lights ----------------------------------------------------------------------------------
  const hemi = new HemisphereLight(look.hemi.sky, look.hemi.ground, look.hemi.intensity);
  const moon = new DirectionalLight(look.sun.color, look.sun.intensity);
  moon.position.set(-20, 40, 18);
  root.add(hemi, moon);
  if (neonLook) for (const [hex, p] of [[PALETTE.magenta, [-14, 5, -9]], [PALETTE.cyan, [14, 5, 9]]] as const) {
    const l = new PointLight(hex, 38, 24, 1.6);
    l.position.set(p[0], p[1], p[2]);
    root.add(l);
  }

  // ---- Entities --------------------------------------------------------------------------------
  const shadowGeo = keep(new CircleGeometry(0.62, 32));
  const shadowMat = keep(new MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
  shadowMat.colorNode = vec3(0, 0, 0);
  shadowMat.opacityNode = oneMinus(smoothstep(0.15, 1, length(uv().sub(vec2(0.5))).mul(2))).mul(0.6);
  const blob = (x: number, y: number, z: number) => {
    const m = new Mesh(shadowGeo, shadowMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y + 0.006, z);
    m.renderOrder = 1;
    root.add(m);
    return m;
  };

  const colliders = collidersOf(bundle);
  const capsuleGeo = keep(new CapsuleGeometry(0.33, 1.14, 6, 18));
  const visorGeo = keep(new CapsuleGeometry(0.07, 0.3, 4, 8));
  visorGeo.rotateZ(Math.PI / 2);
  const footRingGeo = keep(new RingGeometry(0.42, 0.5, 40));
  const npcBody = keep(bodyMaterial("#1b1d2b", 0.4, 0.45));
  const npcShadows: [Object3D, Mesh][] = [];

  const character = (e: Pick<Entity, "pos" | "team">, body: Material, visorHex: string, visorScale: number) => {
    const g = new Group();
    g.add(new Mesh(capsuleGeo, body));
    const visor = new Mesh(visorGeo, keep(glowMaterial(visorHex, visorScale)));
    visor.position.set(0, 0.5, -0.27);
    g.add(visor);
    const ring = new Mesh(footRingGeo, keep(glowMaterial(TEAM_HEX[e.team] ?? PALETTE.cyan, 2.2)));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.88;
    g.add(ring);
    g.position.set(...e.pos);
    return g;
  };

  // kit verbs bound per entity, lock keys, and each entity's starting state
  const verbsOn = new Map<string, string[]>();
  const keys = new Set<string>();
  const initial = new Map<string, string>();
  for (const v of bundle.verbs) {
    verbsOn.set(v.on, [...(verbsOn.get(v.on) ?? []), v.verb]);
    if (v.verb === "puzzle.lock" && v.params.key) keys.add(String(v.params.key));
    const first = verb(v.verb)?.initial;
    if (first && !initial.has(v.on)) initial.set(v.on, first);
  }
  const kits = new Map<string, KitActor>();

  for (const e of bundle.entities) {
    const team = TEAM_HEX[e.team] ?? PALETTE.cyan;
    let obj: Object3D | undefined;
    const kit = kitActor(e, verbsOn.get(e.id) ?? [], keys.has(e.id), { keep, animated });
    if (kit) {
      kits.set(e.id, kit);
      kit.setState?.(e.init || initial.get(e.id) || "");
      kit.obj.name = e.id;
      root.add(kit.obj);
      actors.set(e.id, kit.obj);
      continue;
    }
    switch (e.kind) {
      case "spawn": {
        const g = new Group();
        const disc = new Mesh(keep(new CylinderGeometry(0.95, 0.95, 0.05, 48)), keep(glowMaterial(team, 0.18)));
        disc.position.y = 0.025;
        const ring = new Mesh(keep(new RingGeometry(0.9, 1.04, 64)), keep(glowMaterial(team, 3.2)));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.055;
        const beam = new Mesh(keep(new CylinderGeometry(0.95, 0.95, 4.5, 40, 1, true)), keep(beamMaterial(team, 1, neonLook ? 0.07 : look.night ? 0.03 : 0.012)));
        beam.position.y = 2.25;
        g.add(disc, ring, beam);
        g.position.set(...e.pos);
        obj = g;
        break;
      }
      case "goal": {
        const g = new Group();
        const ring = new Mesh(keep(new TorusGeometry(1.25, 0.085, 14, 72)), keep(glowMaterial(team, 4)));
        ring.rotation.y = Math.PI / 2;
        const ring2 = new Mesh(keep(new TorusGeometry(1.42, 0.025, 8, 72)), keep(glowMaterial(team, 2)));
        ring2.rotation.y = Math.PI / 2;
        const film = new Mesh(keep(new CircleGeometry(1.2, 48)), keep(glowMaterial(team, 0.9, 0.12)));
        film.rotation.y = Math.PI / 2;
        (film.material as MeshBasicNodeMaterial).side = DoubleSide;
        (film.material as MeshBasicNodeMaterial).blending = AdditiveBlending;
        const pad = new Mesh(keep(new RingGeometry(1.3, 1.45, 64)), keep(glowMaterial(team, 2.4)));
        pad.rotation.x = -Math.PI / 2;
        pad.position.y = -e.size[1] / 2 + 0.01;
        const light = new PointLight(team, 30 * lightK, 14, 1.6);
        g.add(ring, ring2, film, pad, light);
        g.position.set(...e.pos);
        animated.push((t) => {
          ring2.rotation.x = t * 0.6;
        });
        obj = g;
        break;
      }
      case "pickup": {
        const g = new Group();
        const r = e.size[0] / 2;
        const core = new Mesh(keep(new SphereGeometry(r, 32, 16)), keep(glowMaterial(PALETTE.orb, 6)));
        const halo = new Mesh(keep(new SphereGeometry(r * 1.9, 24, 12)), keep(glowMaterial(PALETTE.orb, 1.2, 0.16)));
        (halo.material as MeshBasicNodeMaterial).blending = AdditiveBlending;
        const light = new PointLight(PALETTE.orb, 22 * lightK, 12, 1.6);
        const ring = new Mesh(keep(new RingGeometry(1.0, 1.08, 64)), keep(glowMaterial(PALETTE.orb, 2.2)));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = -e.size[1] / 2 + 0.015;
        g.add(core, halo, light, ring);
        g.position.set(...e.pos);
        animated.push((t) => {
          const s = 1 + Math.sin(t * 3.1) * 0.12;
          halo.scale.setScalar(s);
          light.intensity = (20 + Math.sin(t * 3.1) * 4) * lightK;
        });
        obj = g;
        break;
      }
      case "platform": {
        const g = new Group();
        const slabGeo = new BoxBatch().add([0, 0, 0], e.size, lin("#1a1c2a"), [0, 0, 0, 0], false).build();
        const slab = new Mesh(keep(slabGeo), keep(bodyMaterial("#1a1c2a", 0.35, 0.5)));
        const edges = new BoxBatch();
        const [hx, hy, hz] = [e.size[0] / 2, e.size[1] / 2, e.size[2] / 2];
        const c = lin(PALETTE.cyan, 3);
        edges.strip([-hx, hy, -hz], [hx, hy, -hz], 0.06, c).strip([-hx, hy, hz], [hx, hy, hz], 0.06, c);
        edges.strip([-hx, hy, -hz], [-hx, hy, hz], 0.06, c).strip([hx, hy, -hz], [hx, hy, hz], 0.06, c);
        const glow = new Mesh(keep(edges.build()), keep(stripMaterial()));
        const under = new Mesh(keep(new CircleGeometry(1.1, 32)), keep(glowMaterial(PALETTE.cyan, 1.2, 0.25)));
        under.rotation.x = Math.PI / 2;
        under.position.y = -hy - 0.02;
        g.add(slab, glow, under);
        g.position.set(...e.pos);
        obj = g;
        break;
      }
      case "sign": {
        const g = new Group();
        const face = new Group();
        face.rotation.y = Math.atan2(-e.pos[0], -e.pos[2]);
        const panel = new Mesh(keep(new PlaneGeometry(e.size[0], e.size[1])), keep(signMaterial("NOODLES", "OPEN 24H  ·  CTF FINALS")));
        panel.position.z = e.size[2] / 2 + 0.005;
        const back = new Mesh(keep(new PlaneGeometry(e.size[0] + 0.12, e.size[1] + 0.12)), keep(bodyMaterial("#0c0b12", 0.6, 0.3)));
        back.position.z = -0.005;
        back.rotation.y = Math.PI;
        face.add(panel, back);
        g.add(face);
        g.position.set(...e.pos);
        obj = g;
        break;
      }
      case "npc": {
        const g = character(e, npcBody, TEAM_HEX[e.team] ?? PALETTE.cyan, 4);
        npcShadows.push([g, blob(e.pos[0], e.pos[1] - e.size[1] / 2, e.pos[2])]);
        obj = g;
        break;
      }
      default: {
        const b = new BoxBatch().add([0, 0, 0], e.size, lin("#22243a"), [0, 0, 0, 0], false);
        const m = new Mesh(keep(b.build()), keep(bodyMaterial("#22243a")));
        m.position.set(...e.pos);
        obj = m;
      }
    }
    obj.name = e.id;
    root.add(obj);
    actors.set(e.id, obj);
  }

  // ---- Player ----------------------------------------------------------------------------------
  const spawn = bundle.entities.find((e) => e.id === "sp_red") ?? bundle.entities.find((e) => e.kind === "spawn");
  const player = character({ pos: spawn ? [spawn.pos[0], spawn.pos[1] + 0.9, spawn.pos[2]] : [0, 0.9, 0], team: spawn?.team ?? "red" }, keep(rimBodyMaterial("#eef1ff", PALETTE.cyan, 1.8)), PALETTE.cyan, 6);
  const waist = new Mesh(keep(new TorusGeometry(0.335, 0.03, 8, 40)), keep(glowMaterial(PALETTE.red, 3)));
  waist.rotation.x = Math.PI / 2;
  waist.position.y = -0.08;
  const marker = new Mesh(keep(new ConeGeometry(0.13, 0.26, 4)), keep(glowMaterial("#ffffff", 3)));
  marker.rotation.x = Math.PI;
  marker.position.y = 1.35;
  player.add(waist, marker);
  player.name = PLAYER_ID;
  root.add(player);
  actors.set(PLAYER_ID, player);
  const playerShadow = blob(player.position.x, 0, player.position.z);

  return {
    root,
    actors,
    colliders,
    setState(id: string, st: string) {
      kits.get(id)?.setState?.(st);
    },
    gone(id: string) {
      const k = kits.get(id);
      if (k?.gone) k.gone();
      else {
        const a = actors.get(id);
        if (a) a.visible = false;
      }
    },
    update(t: number) {
      for (const f of animated) f(t);
      marker.position.y = 1.35 + Math.sin(t * 2.4) * 0.06;
      marker.rotation.y = t * 1.5;
      const p = player.position;
      const gyp = groundBelow(colliders, p.x, p.y - 0.9, p.z);
      const top = Number.isFinite(gyp) ? gyp : gy;
      playerShadow.position.set(p.x, top + 0.008, p.z);
      const s = Math.max(0.35, 1 - (p.y - 0.9 - top) * 0.18);
      playerShadow.scale.setScalar(s);
      for (const [g, sh] of npcShadows) {
        const q = g.position;
        const y = groundBelow(colliders, q.x, q.y - 0.9, q.z);
        sh.position.set(q.x, (Number.isFinite(y) ? y : gy) + 0.006, q.z);
      }
    },
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) {
        (m as MeshBasicNodeMaterial).map?.dispose();
        m.dispose();
      }
      root.removeFromParent();
    },
  };
}
