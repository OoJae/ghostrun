// Vehicles and races, drawn: a low-poly vehicle per kind (wheels that roll with its speed and steer
// the way it turns, a rider at the controls while someone drives, a flame on a boost), the chase
// camera swinging in behind and pulling back with speed, dust, snow or spray behind anyone going
// fast, speed lines past the camera, the gates turned across the line of the race, a chequered
// finish, and an arrow over you to the next gate. Cosmetic only: it reads the sim's rides and race
// progress and never writes them (the trigonometry lives here, on the client, for that reason).
import type { Entity, WorldBundle } from "@ghostrun/ir";
import type { SimWorld } from "@ghostrun/sim";
import {
  AdditiveBlending, BoxGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, PlaneGeometry, SphereGeometry, TorusGeometry, Vector3,
  type BufferGeometry, type Material, type Object3D, type PerspectiveCamera,
} from "three/webgpu";
import type { FollowCamera } from "./camera";
import { PALETTE, beamMaterial, bodyMaterial, glowMaterial } from "./materials";

interface Ctx {
  keep<T extends BufferGeometry | Material>(x: T): T;
}

/** What the race layer animates on a vehicle actor (kept on its userData). */
interface Parts {
  kind: string;
  body: Group;
  wheels: { steer: Group; spin: Object3D | null; r: number; front: boolean }[];
  spinners: Object3D[];
  legs: { pivot: Group; phase: number }[];
  rider: Group | null;
  flame: Mesh;
  /** Where the dust leaves from, in the actor's frame (the rear, at the ground). */
  rear: Vector3;
  size: [number, number, number];
}

/** Each kind as the placer sizes it (layout's RIDE_SIZE): meshes are built to these and scaled to the entity. */
const BUILT: Record<string, [number, number, number]> = {
  kart: [1.3, 0.7, 1.9], car: [1.8, 1.2, 3.6], buggy: [1.7, 1.1, 2.8], truck: [2.2, 2, 5], van: [2, 2, 4.4], boat: [1.8, 1, 3.8],
  snowmobile: [1.1, 1, 2.6], hovercraft: [2, 1, 3], bike: [0.6, 1.1, 1.9], horse: [0.8, 1.6, 2.2],
};
const PAINT: Record<string, string> = { red: "#c8283f", blue: "#1f6fd1", "": "#b9bccf" };
const TRIM: Record<string, string> = { red: PALETTE.red, blue: PALETTE.blue, "": PALETTE.cyan };
/** What flies up behind each kind at speed. */
const DUST: Record<string, string> = { boat: "#d8f4ff", hovercraft: "#d8f4ff", snowmobile: "#ffffff" };
const UP = new Vector3(0, 1, 0);

/** The low-poly vehicle for a vehicle entity, by kind; its parts on userData.vehicle. */
export function vehicleActor(e: Entity, kind: string, c: Ctx): Object3D {
  const { keep } = c;
  const k = BUILT[kind] ? kind : "car";
  const [bx, by, bz] = BUILT[k]!;
  const g = new Group();
  g.position.set(...e.pos);
  const body = new Group();
  body.scale.set(e.size[0] / bx, e.size[1] / by, e.size[2] / bz);
  g.add(body);
  const paint = keep(bodyMaterial(PAINT[e.team] ?? PAINT[""]!, 0.32, 0.45));
  const dark = keep(bodyMaterial("#14151f", 0.7, 0.2));
  const glass = keep(bodyMaterial("#0a0c16", 0.08, 0.7));
  const trim = keep(glowMaterial(TRIM[e.team] ?? PALETTE.cyan, 3));
  const head = keep(glowMaterial("#fff6dd", 4));
  const tail = keep(glowMaterial("#ff2236", 3));
  const tyre = keep(bodyMaterial("#0d0d12", 0.9, 0));
  const y0 = -by / 2;
  const box = (w: number, h: number, d: number, m: Material, x: number, y: number, z: number, parent: Object3D = body) => {
    const mesh = new Mesh(keep(new BoxGeometry(w, h, d)), m);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  const wheels: Parts["wheels"] = [];
  const wheel = (r: number, w: number, x: number, z: number, front: boolean) => {
    const steer = new Group();
    steer.position.set(x, y0 + r, z);
    const spin = new Mesh(keep(new CylinderGeometry(r, r, w, 14)), tyre);
    spin.rotation.z = Math.PI / 2;
    // a spoke across the hub, so the roll shows
    const spoke = new Mesh(keep(new BoxGeometry(r * 1.5, w * 1.06, r * 0.22)), trim);
    spin.add(spoke);
    steer.add(spin);
    body.add(steer);
    wheels.push({ steer, spin, r, front });
  };
  const lights = (w: number, y: number, z: number, gap: number) => {
    for (const s of [-1, 1]) {
      box(w, 0.1, 0.04, head, s * gap, y, -z);
      box(w, 0.08, 0.04, tail, s * gap, y, z);
    }
  };
  const spinners: Object3D[] = [];
  const legs: Parts["legs"] = [];
  let rider: [number, number, number] | null = null;
  let exhaust: [number, number, number] = [0, y0 + 0.3, bz / 2];

  switch (k) {
    case "kart": {
      box(1.0, 0.12, 1.75, dark, 0, y0 + 0.17, 0);
      box(0.92, 0.14, 0.34, paint, 0, y0 + 0.24, -0.82);
      box(0.9, 0.04, 0.04, trim, 0, y0 + 0.32, -0.99);
      for (const s of [-1, 1]) box(0.2, 0.18, 0.8, paint, s * 0.46, y0 + 0.28, 0.05);
      box(0.44, 0.34, 0.28, dark, 0, y0 + 0.4, 0.3);
      box(0.5, 0.24, 0.3, dark, 0, y0 + 0.32, 0.74);
      box(1.1, 0.06, 0.06, trim, 0, y0 + 0.2, 0.93);
      const wheelRing = new Mesh(keep(new TorusGeometry(0.12, 0.022, 6, 18)), dark);
      wheelRing.position.set(0, y0 + 0.52, -0.22);
      wheelRing.rotation.x = -1.1;
      body.add(wheelRing);
      for (const [x, z, f] of [[-0.58, -0.66, true], [0.58, -0.66, true], [-0.6, 0.66, false], [0.6, 0.66, false]] as const) wheel(f ? 0.19 : 0.22, f ? 0.2 : 0.26, x, z, f);
      rider = [0, y0 + 0.62, 0.2];
      exhaust = [0.18, y0 + 0.34, 0.92];
      break;
    }
    case "buggy": {
      box(1.1, 0.26, 2.3, dark, 0, y0 + 0.52, 0);
      box(1.2, 0.2, 0.6, paint, 0, y0 + 0.6, -1.0);
      box(1.2, 0.16, 0.5, paint, 0, y0 + 0.6, 1.05);
      for (const [x, z] of [[-0.5, -0.25], [0.5, -0.25], [-0.5, 0.65], [0.5, 0.65]] as const) box(0.06, 0.62, 0.06, trim, x, y0 + 0.95, z);
      box(1.06, 0.06, 0.06, trim, 0, y0 + 1.26, -0.25);
      box(1.06, 0.06, 0.06, trim, 0, y0 + 1.26, 0.65);
      for (const s of [-1, 1]) box(0.06, 0.06, 0.96, trim, s * 0.5, y0 + 1.26, 0.2);
      for (const [x, z, f] of [[-0.78, -0.95, true], [0.78, -0.95, true], [-0.78, 0.95, false], [0.78, 0.95, false]] as const) wheel(0.4, 0.32, x, z, f);
      box(0.3, 0.08, 0.04, head, -0.3, y0 + 0.66, -1.31);
      box(0.3, 0.08, 0.04, head, 0.3, y0 + 0.66, -1.31);
      rider = [0, y0 + 0.92, 0.2];
      exhaust = [0, y0 + 0.62, 1.32];
      break;
    }
    case "truck": {
      box(2.0, 0.3, 4.8, dark, 0, y0 + 0.6, 0);
      box(2.1, 1.3, 1.6, paint, 0, y0 + 1.3, -1.6);
      box(1.9, 0.5, 0.05, glass, 0, y0 + 1.62, -2.41);
      box(2.2, 0.8, 3.0, paint, 0, y0 + 1.15, 0.95);
      box(2.22, 0.05, 3.02, trim, 0, y0 + 1.56, 0.95);
      box(0.12, 0.9, 0.12, dark, 0.92, y0 + 2.05, -0.75);
      lights(0.3, y0 + 0.95, 2.42, 0.75);
      for (const z of [-1.6, 1.0, 1.9]) for (const s of [-1, 1]) wheel(0.45, 0.34, s * 0.98, z, z < 0);
      exhaust = [0.92, y0 + 2.5, -0.75];
      break;
    }
    case "van": {
      box(2.0, 1.55, 4.3, paint, 0, y0 + 1.12, 0);
      box(1.8, 0.55, 0.05, glass, 0, y0 + 1.5, -2.16);
      for (const s of [-1, 1]) box(0.05, 0.42, 3.0, glass, s * 1.01, y0 + 1.5, 0.3);
      for (const s of [-1, 1]) box(0.04, 0.05, 4.1, trim, s * 1.02, y0 + 0.6, 0);
      lights(0.3, y0 + 0.7, 2.16, 0.7);
      for (const z of [-1.45, 1.45]) for (const s of [-1, 1]) wheel(0.38, 0.3, s * 0.9, z, z < 0);
      exhaust = [0.6, y0 + 0.3, 2.2];
      break;
    }
    case "boat": {
      box(1.7, 0.55, 2.7, paint, 0, y0 + 0.33, 0.5);
      const bow = box(1.2, 0.55, 1.2, paint, 0, y0 + 0.33, -0.85);
      bow.rotation.y = Math.PI / 4;
      bow.scale.set(1, 1, 1);
      box(1.72, 0.05, 2.72, trim, 0, y0 + 0.62, 0.5);
      box(1.3, 0.36, 0.05, glass, 0, y0 + 0.82, -0.25).rotation.x = -0.5;
      box(0.32, 0.6, 0.32, dark, 0, y0 + 0.55, 1.95);
      const prop = new Group();
      prop.position.set(0, y0 + 0.15, 2.15);
      box(0.5, 0.06, 0.06, trim, 0, 0, 0, prop);
      body.add(prop);
      spinners.push(prop);
      rider = [0, y0 + 0.86, 0.6];
      exhaust = [0, y0 + 0.1, 2.0];
      break;
    }
    case "snowmobile": {
      for (const s of [-1, 1]) {
        const steer = new Group();
        steer.position.set(s * 0.42, y0 + 0.03, -0.75);
        box(0.12, 0.05, 1.1, trim, 0, 0, 0, steer);
        box(0.12, 0.05, 0.25, trim, 0, 0.07, -0.6, steer).rotation.x = 0.6;
        box(0.05, 0.4, 0.05, dark, 0, 0.22, 0, steer);
        body.add(steer);
        wheels.push({ steer, spin: null, r: 0, front: true });
      }
      box(0.56, 0.3, 1.2, dark, 0, y0 + 0.2, 0.6);
      const roller = new Mesh(keep(new CylinderGeometry(0.16, 0.16, 0.58, 10)), tyre);
      roller.rotation.z = Math.PI / 2;
      roller.position.set(0, y0 + 0.17, 1.15);
      roller.add(new Mesh(keep(new BoxGeometry(0.24, 0.6, 0.04)), trim));
      body.add(roller);
      wheels.push({ steer: new Group(), spin: roller, r: 0.16, front: false });
      box(0.8, 0.42, 1.2, paint, 0, y0 + 0.56, -0.35);
      box(0.6, 0.3, 0.05, glass, 0, y0 + 0.92, -0.55).rotation.x = -0.6;
      box(0.42, 0.16, 0.9, dark, 0, y0 + 0.66, 0.5);
      box(0.72, 0.04, 0.04, trim, 0, y0 + 0.86, -0.15);
      box(0.3, 0.08, 0.04, head, 0, y0 + 0.6, -0.96);
      rider = [0, y0 + 0.95, 0.35];
      exhaust = [0, y0 + 0.2, 1.25];
      break;
    }
    case "hovercraft": {
      box(2.0, 0.36, 3.0, dark, 0, y0 + 0.18, 0);
      box(2.04, 0.06, 3.04, trim, 0, y0 + 0.04, 0);
      box(1.6, 0.26, 2.2, paint, 0, y0 + 0.5, -0.1);
      box(0.5, 0.3, 0.5, dark, 0, y0 + 0.75, 0.15);
      const ring = new Mesh(keep(new TorusGeometry(0.55, 0.07, 8, 28)), trim);
      ring.position.set(0, y0 + 1.05, 1.25);
      body.add(ring);
      const fan = new Group();
      fan.position.copy(ring.position);
      box(1.0, 0.1, 0.04, dark, 0, 0, 0, fan);
      box(0.1, 1.0, 0.04, dark, 0, 0, 0, fan);
      body.add(fan);
      spinners.push(fan);
      for (const s of [-1, 1]) {
        const rudder = new Group();
        rudder.position.set(s * 0.3, y0 + 1.05, 1.62);
        box(0.04, 0.8, 0.3, paint, 0, 0, 0, rudder);
        body.add(rudder);
        wheels.push({ steer: rudder, spin: null, r: 0, front: false });
      }
      rider = [0, y0 + 0.95, 0.15];
      exhaust = [0, y0 + 0.2, 1.4];
      break;
    }
    case "bike": {
      for (const [z, f] of [[-0.66, true], [0.66, false]] as const) wheel(0.32, 0.12, 0, z, f);
      box(0.18, 0.3, 1.0, paint, 0, y0 + 0.62, 0);
      box(0.3, 0.22, 0.45, paint, 0, y0 + 0.78, -0.2);
      box(0.24, 0.1, 0.5, dark, 0, y0 + 0.8, 0.28);
      box(0.06, 0.6, 0.06, dark, 0, y0 + 0.62, -0.58).rotation.x = 0.35;
      box(0.62, 0.04, 0.04, trim, 0, y0 + 0.92, -0.48);
      box(0.16, 0.1, 0.04, head, 0, y0 + 0.82, -0.62);
      rider = [0, y0 + 1.08, 0.12];
      exhaust = [0.12, y0 + 0.42, 0.85];
      break;
    }
    case "horse": {
      const coat = keep(bodyMaterial("#6b4a32", 0.8, 0));
      box(0.6, 0.6, 1.4, coat, 0, y0 + 1.05, 0);
      box(0.64, 0.1, 0.6, trim, 0, y0 + 1.38, 0.05);
      const neck = box(0.3, 0.62, 0.3, coat, 0, y0 + 1.45, -0.72);
      neck.rotation.x = 0.5;
      box(0.26, 0.26, 0.56, coat, 0, y0 + 1.72, -0.98);
      box(0.08, 0.5, 0.08, dark, 0, y0 + 1.1, 0.78).rotation.x = -0.4;
      for (const [x, z, phase] of [[-0.2, -0.52, 0], [0.2, -0.52, Math.PI], [-0.2, 0.5, Math.PI], [0.2, 0.5, 0]] as const) {
        const pivot = new Group();
        pivot.position.set(x, y0 + 0.78, z);
        box(0.14, 0.78, 0.14, coat, 0, -0.39, 0, pivot);
        body.add(pivot);
        legs.push({ pivot, phase });
      }
      rider = [0, y0 + 1.6, 0.05];
      exhaust = [0, y0 + 0.05, 0.6];
      break;
    }
    default: {
      // a car
      box(1.8, 0.5, 3.6, paint, 0, y0 + 0.56, 0);
      box(1.5, 0.42, 1.7, glass, 0, y0 + 1.01, 0.15);
      box(1.46, 0.06, 1.5, paint, 0, y0 + 1.24, 0.18);
      for (const s of [-1, 1]) box(0.04, 0.04, 3.4, trim, s * 0.91, y0 + 0.4, 0);
      box(1.6, 0.05, 0.3, trim, 0, y0 + 0.92, 1.62);
      lights(0.36, y0 + 0.64, 1.81, 0.55);
      for (const [x, z, f] of [[-0.82, -1.18, true], [0.82, -1.18, true], [-0.82, 1.18, false], [0.82, 1.18, false]] as const) wheel(0.34, 0.26, x, z, f);
      exhaust = [0.5, y0 + 0.3, 1.82];
    }
  }
  // a rider at the controls (open vehicles), shown while someone drives
  let riderG: Group | null = null;
  if (rider) {
    riderG = new Group();
    riderG.position.set(...rider);
    const torso = new Mesh(keep(new BoxGeometry(0.42, 0.5, 0.3)), keep(bodyMaterial(TRIM[e.team] ?? PALETTE.cyan, 0.5, 0.1)));
    const helmet = new Mesh(keep(new SphereGeometry(0.17, 14, 10)), keep(bodyMaterial("#eef1ff", 0.25, 0.3)));
    helmet.position.y = 0.42;
    const visor = new Mesh(keep(new BoxGeometry(0.26, 0.08, 0.06)), keep(glowMaterial(PALETTE.cyan, 3)));
    visor.position.set(0, 0.44, -0.15);
    riderG.add(torso, helmet, visor);
    // (the rider keeps human size whatever the vehicle's scale)
    riderG.scale.set(bx / e.size[0], by / e.size[1], bz / e.size[2]);
    body.add(riderG);
  }
  // the boost flame at the exhaust, pointing back
  const flame = new Mesh(keep(new ConeGeometry(0.14, 0.7, 10, 1, true)), (() => {
    const m = keep(glowMaterial("#ff9a2e", 6, 0.85));
    m.blending = AdditiveBlending;
    return m;
  })());
  flame.rotation.x = Math.PI / 2;
  flame.position.set(exhaust[0], exhaust[1], exhaust[2] + 0.35);
  body.add(flame); // (shown, like the rider, until the race layer's first frame: the world's compile builds its shader)
  const parts: Parts = { kind: k, body, wheels, spinners, legs, rider: riderG, flame, rear: new Vector3(0, -e.size[1] / 2 + 0.15, e.size[2] / 2), size: [...e.size] };
  g.userData.vehicle = parts;
  g.rotation.y = e.rotY;
  return g;
}

export interface RaceView {
  root: Group;
  /**
   * `vr`: in a headset the vehicles, gates and dust still animate, but the headset owns the camera
   * (no chase camera, field of view or speed lines) and the arrow to the next gate floats ahead of
   * you at eye level rather than over your head.
   */
  update(dt: number, t: number, actors: ReadonlyMap<string, Object3D>, camera: PerspectiveCamera, follow: FollowCamera, vr?: boolean): void;
  dispose(camera: PerspectiveCamera, follow: FollowCamera): void;
}

const PUFFS = 64;
const LINES = 28;
const FOV = 60;

/**
 * The race layer for a world with vehicles or a track (null for any other world). `ground` is what
 * the look's ground kicks up behind a wheel (sand in the desert, snow on snow, spray in the rain).
 */
export function raceView(bundle: WorldBundle, sim: SimWorld, ground = "#bfa88a"): RaceView | null {
  const drives = bundle.verbs.filter((v) => v.verb === "vehicle.drive" && bundle.entities.some((e) => e.id === v.on));
  const track = bundle.verbs.find((v) => v.verb === "racing.track");
  if (!drives.length && !track) return null;
  const root = new Group();
  root.name = "race";
  const geos: BufferGeometry[] = [];
  const mats: Material[] = [];
  const keep = <T extends BufferGeometry | Material>(x: T): T => {
    if ((x as Material).isMaterial) mats.push(x as Material);
    else geos.push(x as BufferGeometry);
    return x;
  };
  const additive = <T extends Material>(m: T) => ((m.blending = AdditiveBlending), (m.depthWrite = false), m);

  // the gates in race order, and the line after them
  const order = track ? [...String(track.params.gates ?? "").split(",").map((s) => s.trim()).filter((id) => bundle.entities.some((e) => e.id === id)), track.on] : [];
  const posOf = (id: string) => bundle.entities.find((e) => e.id === id)!.pos;

  // a chequered strip across the finish line
  const line = track && bundle.entities.find((e) => e.id === track.on);
  const flag = new Group();
  if (line) {
    const [w] = line.size;
    const n = Math.max(6, Math.round(w / 0.5));
    const sq = keep(new PlaneGeometry(w / n, w / n));
    const white = keep(glowMaterial("#ffffff", 1.6));
    const black = keep(bodyMaterial("#08080c", 0.9, 0));
    for (let i = 0; i < n; i++) for (let j = 0; j < 2; j++) {
      const m = new Mesh(sq, (i + j) % 2 ? white : black);
      m.rotation.x = -Math.PI / 2;
      m.position.set(-w / 2 + (i + 0.5) * (w / n), 0, (j - 0.5) * (w / n));
      flag.add(m);
    }
    flag.position.set(line.pos[0], line.pos[1] - line.size[1] / 2 + 0.03, line.pos[2]);
    root.add(flag);
  }
  // across the line of the race: the way in to each gate from the one before, out to the one after
  const across = (id: string) => {
    const i = order.indexOf(id);
    const a = posOf(order[(i - 1 + order.length) % order.length]!);
    const b = posOf(order[(i + 1) % order.length]!);
    return Math.atan2(b[0] - a[0], b[2] - a[2]);
  };
  if (line && order.length > 1) flag.rotation.y = across(line.id);

  // the next gate: a beam over it, and an arrow over you pointing at it
  // (everything here is shown until the first frame, so the world's compile builds its shaders)
  const beam = new Mesh(keep(new CylinderGeometry(0.9, 0.9, 10, 24, 1, true)), keep(beamMaterial("#ffb02e", 1, 0.22)));
  root.add(beam);
  const arrow = new Group();
  const tip = new Mesh(keep(new ConeGeometry(0.34, 0.9, 3)), keep(glowMaterial("#ffb02e", 4)));
  tip.rotation.x = -Math.PI / 2;
  tip.scale.set(1, 1, 0.35);
  arrow.add(tip);
  root.add(arrow);

  // dust, snow or spray: a pool of puffs, one material per colour
  const puffGeo = keep(new SphereGeometry(0.28, 8, 6));
  const puffMats = new Map<string, Material>();
  const puffMat = (hex: string) => {
    let m = puffMats.get(hex);
    if (!m) puffMats.set(hex, (m = keep(additive(glowMaterial(hex, 0.6, 0.35)))));
    return m;
  };
  const colours = [ground, ...new Set(Object.values(DUST))];
  const puffs = Array.from({ length: PUFFS }, (_, i) => {
    const m = new Mesh(puffGeo, puffMat(colours[i % colours.length]!));
    m.frustumCulled = false;
    m.position.set(0, -500, 0);
    root.add(m);
    return { m, age: 1, life: 1, vy: 0 };
  });
  let nextPuff = 0;
  const lastPuff = new Map<string, number>();

  // speed lines: streaks round the view, rushing past at speed
  const lines = new Group();
  const streak = keep(new BoxGeometry(0.01, 0.01, 1.8));
  const streakMat = keep(additive(glowMaterial("#dff6ff", 1.6, 0.3)));
  const seeds = Array.from({ length: LINES }, (_, i) => {
    // round the edges of the view, never across the middle of it
    const a = (i / LINES) * Math.PI * 2 + Math.random() * 0.2;
    const r = 3.2 + Math.random() * 2.4;
    const m = new Mesh(streak, streakMat);
    m.frustumCulled = false;
    m.position.set(Math.cos(a) * r, Math.sin(a) * r * 0.62, -4 - Math.random() * 18);
    lines.add(m);
    return m;
  });
  root.add(lines);
  const tall = new Map(bundle.entities.map((e) => [e.id, e.size[1]]));

  const yaw = new Map<string, number>();
  const steer = new Map<string, number>();
  let hidden = new Set<string>();
  let turned = false;
  let fov = FOV;
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const _p = new Vector3();

  return {
    root,
    update(dt, t, actors, camera, follow, vr = false) {
      // the gates face across the race (once their actors exist)
      if (!turned && order.length > 1) {
        for (const id of order) {
          const inner = actors.get(id)?.children[0];
          if (inner) inner.rotation.y = across(id);
        }
        turned = true;
      }
      // vehicles: the way they point, wheels, rider, boost; drivers sit in them (their own figure hidden)
      const now = new Set<string>();
      for (const v of drives) {
        const obj = actors.get(v.on);
        const parts = obj?.userData.vehicle as Parts | undefined;
        if (!obj || !parts) continue;
        const driver = sim.driverOf(v.on);
        const r = driver ? sim.ride(driver) : undefined;
        const was = yaw.get(v.on) ?? obj.rotation.y;
        let y = was;
        if (r) {
          const want = Math.atan2(-r.hx, -r.hz);
          y = was + wrap(want - was) * (1 - Math.exp(-dt * 16));
        }
        yaw.set(v.on, y);
        obj.quaternion.setFromAxisAngle(UP, y);
        const turn = dt > 0 ? wrap(y - was) / dt : 0;
        const s = (steer.get(v.on) ?? 0) + (Math.max(-0.5, Math.min(0.5, turn * 0.35)) - (steer.get(v.on) ?? 0)) * (1 - Math.exp(-dt * 10));
        steer.set(v.on, s);
        const speed = r ? r.speed : 0;
        for (const w of parts.wheels) {
          if (w.front) w.steer.rotation.y = s;
          else if (!w.spin) w.steer.rotation.y = -s; // rudders
          if (w.spin) w.spin.rotation.x -= (speed * dt) / w.r;
        }
        for (const f of parts.spinners) f.rotation.z += (5 + Math.abs(speed) * 1.5) * dt;
        for (const l of parts.legs) l.pivot.rotation.x = Math.sin(t * (2 + Math.abs(speed) * 0.9) + l.phase) * Math.min(0.75, Math.abs(speed) * 0.09);
        if (parts.kind === "bike") parts.body.rotation.z = -s * 0.7;
        if (parts.rider) parts.rider.visible = Boolean(driver);
        parts.flame.visible = Boolean(r && r.boostLeft > 0);
        if (parts.flame.visible) parts.flame.scale.set(1, 0.8 + Math.random() * 0.5, 1);
        if (driver) {
          now.add(driver);
          const d = actors.get(driver);
          if (d) d.visible = false;
        }
        // dust behind anyone going fast
        if (Math.abs(speed) > 4 && t - (lastPuff.get(v.on) ?? 0) > 0.045) {
          lastPuff.set(v.on, t);
          const p = puffs[nextPuff]!;
          nextPuff = (nextPuff + 1) % PUFFS;
          _p.copy(parts.rear).applyQuaternion(obj.quaternion).add(obj.position);
          p.m.position.set(_p.x + (Math.random() - 0.5) * parts.size[0] * 0.8, _p.y, _p.z + (Math.random() - 0.5) * 0.3);
          p.m.material = puffMat(DUST[parts.kind] ?? ground);
          p.age = 0;
          p.life = 0.45 + Math.random() * 0.35;
          p.vy = 0.6 + Math.random() * 0.8;
        }
      }
      for (const id of hidden) if (!now.has(id)) {
        const d = actors.get(id);
        if (d) d.visible = true;
      }
      hidden = now;
      for (const p of puffs) {
        if (p.age >= p.life) continue;
        p.age += dt;
        const k = p.age / p.life;
        if (k >= 1) {
          p.m.position.set(0, -500, 0);
          continue;
        }
        p.m.position.y += p.vy * dt;
        p.m.scale.setScalar(0.6 + k * 2.2 * (1 - k));
      }

      // the player at the wheel: the chase camera, the field of view widening, speed lines
      const mine = sim.ride("player");
      let rush = 0;
      if (mine && !vr) {
        const top = mine.feel.speed * (mine.boostLeft > 0 ? mine.feel.boost : 1);
        const k = Math.max(0, Math.min(1, Math.abs(mine.speed) / Math.max(1, mine.feel.speed)));
        follow.chase(Math.atan2(-mine.hx, -mine.hz), k);
        rush = Math.min(1, Math.max(0, (Math.abs(mine.speed) / Math.max(1, top) - 0.75) / 0.25) * 0.5 + (mine.boostLeft > 0 ? 0.6 : 0));
        fov += (FOV + 12 * k + (mine.boostLeft > 0 ? 6 : 0) - fov) * (1 - Math.exp(-dt * 4));
      } else if (!vr) {
        follow.chase(null);
        fov += (FOV - fov) * (1 - Math.exp(-dt * 4));
      }
      if (!vr && Math.abs(camera.fov - fov) > 0.05) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      lines.visible = !vr && rush > 0.02;
      if (lines.visible) {
        lines.position.copy(camera.position);
        lines.quaternion.copy(camera.quaternion);
        const run = (14 + 26 * rush) * dt;
        (streakMat as Material).opacity = 0.32 * rush;
        for (const m of seeds) {
          m.position.z += run;
          if (m.position.z > 1.5) m.position.z -= 22;
          m.scale.set(1, 1, 0.4 + rush);
        }
      }

      // the next gate: its beam, and the arrow over you
      const race = order.length ? sim.raceOf("player") : null;
      const me = actors.get("player");
      const gate = race && !sim.result ? actors.get(race.next) : undefined;
      beam.visible = arrow.visible = Boolean(gate && me);
      if (gate && me) {
        beam.position.set(gate.position.x, gate.position.y + 3.5, gate.position.z);
        beam.scale.set(1 + Math.sin(t * 5) * 0.08, 1, 1 + Math.sin(t * 5) * 0.08);
        const yaw = Math.atan2(-(gate.position.x - me.position.x), -(gate.position.z - me.position.z));
        if (vr) {
          // over your head is out of sight in first person: 2.4 m ahead toward the gate, just under the eyes
          const up = mine ? Math.max(0.5, (tall.get(mine.vehicle) ?? 1) - 0.1) : 0.6;
          arrow.position.set(me.position.x - Math.sin(yaw) * 2.4, me.position.y + up + Math.sin(t * 3) * 0.05, me.position.z - Math.cos(yaw) * 2.4);
        } else {
          const up = mine ? Math.max(1.2, (tall.get(mine.vehicle) ?? 1) + 0.9) : 1.5;
          arrow.position.set(me.position.x, me.position.y + up + Math.sin(t * 3) * 0.08, me.position.z);
        }
        arrow.rotation.y = yaw;
      }
    },
    dispose(camera, follow) {
      follow.chase(null);
      camera.fov = FOV;
      camera.updateProjectionMatrix();
      root.removeFromParent();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
