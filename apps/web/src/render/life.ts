// A place's ambient life, drawn (the creatures and what they do: ../life.ts). Simple shapes in the
// place's own light: fireflies glow, a deer and an owl in browns, people in muted coats, drones with a
// scanning beam. Cosmetic only: no colliders, nothing in the simulation, nothing in the spec hash.
import type { Vec3, WorldBundle } from "@ghostrun/ir";
import { AdditiveBlending, BoxGeometry, CapsuleGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, SphereGeometry, type BufferGeometry, type Material } from "three/webgpu";
import { lifeOf, settingOf, stepLife, type Creature, type Kind, type LifeEvent, type Setting } from "../life";
import type { LookStyle } from "./looks";
import { beamMaterial, bodyMaterial, glowMaterial } from "./materials";

export interface LifeView {
  root: Group;
  setting: Setting;
  creatures: readonly Creature[];
  /** One frame: they notice the player (or not) and move; returns what they reacted with. */
  update(dt: number, t: number, player: Vec3): LifeEvent[];
  dispose(): void;
}

interface Drawn {
  c: Creature;
  obj: Group;
  head: Mesh | undefined;
  parts: Mesh[];
  beam: Mesh | undefined;
}

/** The life of a Wander world in this look (null for a game: life is a place's contract). */
export function lifeView(b: WorldBundle, look: LookStyle): LifeView | null {
  if (b.mode !== "wander") return null;
  const setting = settingOf(b, look.id);
  const creatures = lifeOf(b, setting);
  const root = new Group();
  root.name = "life";
  const geos: BufferGeometry[] = [];
  const mats: Material[] = [];
  const g = <T extends BufferGeometry>(x: T) => (geos.push(x), x);
  const m = <T extends Material>(x: T) => (mats.push(x), x);

  const glow = m(glowMaterial(look.night ? "#d8ff6a" : "#fff3a0", look.night ? 6 : 2.5));
  glow.blending = AdditiveBlending;
  const fur = m(bodyMaterial("#8a5a36", 0.8, 0));
  const pale = m(bodyMaterial("#d9c2a0", 0.8, 0));
  const feather = m(bodyMaterial("#6f5a44", 0.85, 0));
  const eye = m(glowMaterial("#ffd24a", 3));
  const coats = ["#3b4a6b", "#6b3b4a", "#4a6b3b", "#5b5b5b", "#7a6a4a"].map((h) => m(bodyMaterial(h, 0.7, 0.05)));
  const skin = m(bodyMaterial("#d9a882", 0.7, 0));
  const uniform = m(bodyMaterial("#1f2a44", 0.6, 0.1));
  const grey = m(bodyMaterial("#8c8f99", 0.75, 0));
  const metal = m(bodyMaterial("#c9d2dc", 0.3, 0.8));
  const lamp = m(glowMaterial("#5ff6ff", 4));
  const ray = m(beamMaterial("#5ff6ff", 1.5, 0.35));

  const sphere = g(new SphereGeometry(1, 12, 8));
  const box = g(new BoxGeometry(1, 1, 1));
  const capsule = g(new CapsuleGeometry(0.22, 0.9, 4, 10));
  const leg = g(new CylinderGeometry(0.04, 0.035, 0.7, 6));
  const disc = g(new CylinderGeometry(0.22, 0.22, 0.02, 12));
  const cone = g(new ConeGeometry(0.9, 3, 16, 1, true));

  const mesh = (geo: BufferGeometry, mat: Material, at: Vec3, scale: Vec3 = [1, 1, 1]) => {
    const x = new Mesh(geo, mat);
    x.position.set(...at);
    x.scale.set(...scale);
    return x;
  };

  const build = (c: Creature): Drawn => {
    const obj = new Group();
    const parts: Mesh[] = [];
    let head: Mesh | undefined;
    let beam: Mesh | undefined;
    const add = (x: Mesh) => (obj.add(x), x);
    switch (c.kind as Kind) {
      case "firefly":
        add(mesh(sphere, glow, [0, 0, 0], [0.06, 0.06, 0.06]));
        break;
      case "deer": {
        add(mesh(box, fur, [0, 0.95, 0], [0.38, 0.42, 1.0]));
        head = add(mesh(box, fur, [0, 1.45, -0.55], [0.2, 0.24, 0.32]));
        add(mesh(box, pale, [0, 0.82, 0.48], [0.14, 0.14, 0.08]));
        for (const [x, z] of [[-0.13, -0.38], [0.13, -0.38], [-0.13, 0.38], [0.13, 0.38]] as const) parts.push(add(mesh(leg, fur, [x, 0.38, z])));
        break;
      }
      case "owl":
        add(mesh(sphere, feather, [0, 0.22, 0], [0.17, 0.24, 0.15]));
        head = add(mesh(sphere, feather, [0, 0.5, 0], [0.14, 0.12, 0.13]));
        for (const x of [-0.05, 0.05]) head.add(mesh(sphere, eye, [x / 0.14, 0.1, -0.8], [0.25, 0.3, 0.2]));
        for (const x of [-0.17, 0.17]) parts.push(add(mesh(box, feather, [x, 0.22, 0], [0.04, 0.26, 0.18])));
        break;
      case "attendant":
      case "visitor":
      case "passerby": {
        const coat = c.kind === "attendant" ? uniform : coats[c.id % coats.length]!;
        add(mesh(capsule, coat, [0, 0.78, 0]));
        head = add(mesh(sphere, skin, [0, 1.52, 0], [0.13, 0.15, 0.13]));
        if (c.kind === "attendant") head.add(mesh(box, uniform, [0, 0.75, 0], [1.3, 0.35, 1.3]));
        break;
      }
      case "pigeon":
        add(mesh(sphere, grey, [0, 0.12, 0], [0.11, 0.1, 0.16]));
        head = add(mesh(sphere, grey, [0, 0.24, -0.12], [0.06, 0.06, 0.06]));
        for (const x of [-0.1, 0.1]) parts.push(add(mesh(box, grey, [x, 0.14, 0.02], [0.02, 0.06, 0.16])));
        break;
      case "drone":
        add(mesh(sphere, metal, [0, 0, 0], [0.28, 0.16, 0.28]));
        add(mesh(sphere, lamp, [0, -0.02, -0.26], [0.07, 0.07, 0.04]));
        for (const [x, z] of [[-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.32, 0.32]] as const) parts.push(add(mesh(disc, metal, [x, 0.1, z])));
        beam = add(mesh(cone, ray, [0, -1.5, -0.6]));
        beam.rotation.x = 0.35;
        beam.visible = false;
        break;
    }
    for (const x of obj.children) x.frustumCulled = true;
    obj.position.set(...c.p);
    root.add(obj);
    return { c, obj, head, parts, beam };
  };
  const drawn = creatures.map(build);

  return {
    root,
    setting,
    creatures,
    update(dt, t, player) {
      const evs = stepLife(creatures, dt, player, t);
      for (const d of drawn) {
        const { c, obj, head, parts, beam } = d;
        obj.position.set(c.p[0], c.p[1], c.p[2]);
        obj.rotation.y = c.yaw;
        const moving = c.mood === "startled" || c.mood === "home" || c.mood === "aside" || c.mood === "fly" || c.mood === "scatter";
        switch (c.kind) {
          case "firefly": {
            const s = 0.045 + 0.03 * (0.5 + 0.5 * Math.sin(t * 6 + c.phase * 3));
            obj.scale.setScalar(s / 0.06);
            break;
          }
          case "deer":
            // legs swing while it runs; its head dips to graze when it is at ease
            parts.forEach((p, i) => (p.rotation.x = moving ? Math.sin(t * (c.mood === "startled" ? 16 : 6) + i * Math.PI) * 0.5 : 0));
            if (head) head.position.y = c.mood === "idle" ? 1.05 + Math.sin(t + c.phase) * 0.05 : 1.45;
            break;
          case "owl":
            parts.forEach((p, i) => (p.rotation.z = c.mood === "fly" || (c.mood === "home" && c.p[1] > c.home[1] + 0.3) ? Math.sin(t * 18) * 0.9 * (i ? 1 : -1) : 0));
            break;
          case "attendant":
            // the nod: the head dips twice, then it stands and watches you
            if (head) head.rotation.x = c.mood === "nod" ? Math.max(0, Math.sin(c.t * 9)) * 0.45 : 0;
            break;
          case "visitor":
          case "passerby":
            obj.position.y = c.p[1] + (moving ? Math.abs(Math.sin(t * 7 + c.phase)) * 0.04 : 0);
            break;
          case "pigeon":
            parts.forEach((p, i) => (p.rotation.z = c.mood === "scatter" ? Math.sin(t * 30) * 1.1 * (i ? 1 : -1) : 0));
            if (head && c.mood === "idle") head.position.y = 0.24 - Math.max(0, Math.sin(t * 5 + c.phase)) * 0.1; // pecking
            break;
          case "drone":
            parts.forEach((p) => (p.rotation.y += dt * 40));
            if (beam) beam.visible = c.mood === "scan";
            break;
        }
      }
      return evs;
    },
    dispose() {
      root.removeFromParent();
      for (const x of geos) x.dispose();
      for (const x of mats) x.dispose();
    },
  };
}
