// Fights, drawn: shots in flight (a glowing bolt with a short tracer, in the shooter's team colour),
// a flash where one lands, and a small hit-point bar over everyone who has hit points. Cosmetic
// only: it reads the sim's shots and hit points and never writes them.
import type { WorldBundle } from "@ghostrun/ir";
import type { SimWorld } from "@ghostrun/sim";
import { AdditiveBlending, CylinderGeometry, Group, Mesh, PlaneGeometry, SphereGeometry, Vector3, type BufferGeometry, type Camera, type Material, type Object3D } from "three/webgpu";
import { glowMaterial, PALETTE } from "./materials";

const PER_TEAM = 12; // shots drawn at once, per team colour
const FLASHES = 8;
const FLASH_S = 0.3;
const BAR_W = 0.8;
/** Fireballs for red, frost for blue, magenta for anyone without a team. */
const SHOT_HEX: Record<string, string> = { red: "#ff8a3b", blue: PALETTE.cyan, "": PALETTE.magenta };
const BAR_HEX: Record<string, string> = { red: PALETTE.red, blue: PALETTE.blue, "": "#7dff9a" };
const UP = new Vector3(0, 1, 0);
const _d = new Vector3();

export interface CombatView {
  root: Group;
  /** Something was hit: a flash on it. */
  hit(id: string): void;
  update(t: number, actors: ReadonlyMap<string, Object3D>, camera: Camera): void;
  dispose(): void;
}

/** The fight layer for a world with weapons or hit points (null for any other world). */
export function combatView(bundle: WorldBundle, sim: SimWorld): CombatView | null {
  if (!bundle.verbs.some((v) => v.verb === "combat_sport.shoot" || v.verb === "combat_sport.health")) return null;
  const root = new Group();
  root.name = "combat";
  const geos: BufferGeometry[] = [];
  const mats: Material[] = [];
  const keep = <T extends BufferGeometry | Material>(x: T): T => {
    if ((x as Material).isMaterial) mats.push(x as Material);
    else geos.push(x as BufferGeometry);
    return x;
  };

  // shots: a pool per team colour (one material each), parked visible until the first frame so the
  // world's compile builds their shaders, then hidden until used
  const boltGeo = keep(new SphereGeometry(0.17, 16, 10));
  const tailGeo = keep(new CylinderGeometry(0.05, 0.02, 0.9, 8, 1, true));
  const pools = new Map<string, { bolt: Mesh; tail: Mesh }[]>();
  for (const [team, hex] of Object.entries(SHOT_HEX)) {
    const core = keep(glowMaterial(hex, 7));
    const trail = keep(glowMaterial(hex, 3, 0.6));
    trail.blending = AdditiveBlending;
    pools.set(team, Array.from({ length: PER_TEAM }, () => {
      const bolt = new Mesh(boltGeo, core);
      const tail = new Mesh(tailGeo, trail);
      for (const m of [bolt, tail]) ((m.frustumCulled = false), m.position.set(0, -500, 0), root.add(m));
      return { bolt, tail };
    }));
  }

  // flashes where a shot lands
  const flashGeo = keep(new SphereGeometry(0.5, 16, 10));
  const flashes = Array.from({ length: FLASHES }, () => {
    const mat = keep(glowMaterial("#ffffff", 3, 0.8));
    mat.blending = AdditiveBlending;
    const m = new Mesh(flashGeo, mat);
    m.frustumCulled = false;
    m.position.set(0, -500, 0);
    root.add(m);
    return { m, mat, on: "", at: -1 };
  });
  let next = 0;
  let pending: string[] = [];

  // a bar over everyone with hit points, facing the camera
  const team = (id: string) => (id === "player" ? sim.entity("player")?.team ?? "red" : bundle.entities.find((e) => e.id === id)?.team ?? "");
  const backGeo = keep(new PlaneGeometry(BAR_W + 0.06, 0.13));
  const fillGeo = keep(new PlaneGeometry(BAR_W, 0.08).translate(BAR_W / 2, 0, 0));
  const backMat = keep(glowMaterial("#000000", 1, 0.55));
  const fillMats = new Map(Object.entries(BAR_HEX).map(([k, hex]) => [k, keep(glowMaterial(hex, 1.8))]));
  const bars = sim.order
    .filter((id) => sim.maxHp(id) !== null)
    .map((id) => {
      const g = new Group();
      const fill = new Mesh(fillGeo, fillMats.get(team(id)) ?? fillMats.get("")!);
      fill.position.set(-BAR_W / 2, 0, 0.001);
      g.add(new Mesh(backGeo, backMat), fill);
      root.add(g);
      return { id, g, fill };
    });

  let primed = false;
  return {
    root,
    hit(id) {
      pending.push(id);
    },
    update(t, actors, camera) {
      // shots in flight, from the sim's own list
      const used = new Map<string, number>();
      for (const s of sim.shots) {
        const k = SHOT_HEX[team(s.by)] ? team(s.by) : "";
        const n = used.get(k) ?? 0;
        const slot = pools.get(k)![n];
        if (!slot) continue;
        used.set(k, n + 1);
        _d.set(s.dir[0], s.dir[1], s.dir[2]);
        slot.bolt.position.set(s.p[0], s.p[1], s.p[2]);
        slot.tail.position.set(s.p[0] - s.dir[0] * 0.45, s.p[1] - s.dir[1] * 0.45, s.p[2] - s.dir[2] * 0.45);
        slot.tail.quaternion.setFromUnitVectors(UP, _d);
        slot.bolt.visible = slot.tail.visible = true;
      }
      for (const [k, pool] of pools) for (let i = used.get(k) ?? 0; i < pool.length; i++) if (primed) pool[i]!.bolt.visible = pool[i]!.tail.visible = false;
      // flashes
      for (const id of pending) {
        const f = flashes[next++ % FLASHES]!;
        f.on = id;
        f.at = t;
      }
      pending = [];
      for (const f of flashes) {
        const k = f.at < 0 ? 1 : (t - f.at) / FLASH_S;
        const a = actors.get(f.on);
        if (k >= 1 || !a) {
          if (primed) f.m.visible = false;
          continue;
        }
        f.m.visible = true;
        f.m.position.set(a.position.x, a.position.y + 0.2, a.position.z);
        f.m.scale.setScalar(0.4 + k * 1.4);
        f.mat.opacity = 0.8 * (1 - k);
      }
      // hit-point bars
      for (const b of bars) {
        const a = actors.get(b.id);
        const hp = sim.hp(b.id) ?? 0;
        const max = sim.maxHp(b.id) ?? 1;
        b.g.visible = Boolean(a?.visible) && hp > 0 && !sim.entity(b.id)?.destroyed;
        if (!b.g.visible || !a) continue;
        b.g.position.set(a.position.x, a.position.y + 1.3, a.position.z);
        b.g.quaternion.copy(camera.quaternion);
        b.fill.scale.x = Math.max(0.001, hp / max);
      }
      primed = true;
    },
    dispose() {
      root.removeFromParent();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
