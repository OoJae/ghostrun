// Kit entities (switches, plates, doors, coins, hazards, portals…) as neon props. Each actor keeps
// an inner group that state handlers animate, so a state change never fights the pose the sim
// drives on the outer group. Cosmetic only: nothing here feeds back into the simulation.
import type { Entity } from "@ghostrun/ir";
import {
  AdditiveBlending, BoxGeometry, CylinderGeometry, DoubleSide, Group, Mesh, OctahedronGeometry, PointLight, RingGeometry,
  TorusGeometry, type BufferGeometry, type Material, type MeshBasicNodeMaterial, type Object3D,
} from "three/webgpu";
import { PALETTE, beamMaterial, bodyMaterial, glowMaterial, lin } from "./materials";

export interface KitActor {
  obj: Object3D;
  setState?(s: string): void;
  gone?(): void;
}

interface Ctx {
  keep<T extends BufferGeometry | Material>(x: T): T;
  animated: ((t: number) => void)[];
}

const AMBER = "#ffb02e";
const LIME = "#7dff5c";
const tint = (m: Material, hex: string, scale: number) => (m as MeshBasicNodeMaterial).color.setRGB(...lin(hex, scale));
const additive = <T extends Material>(m: T) => {
  (m as unknown as MeshBasicNodeMaterial).blending = AdditiveBlending;
  (m as unknown as MeshBasicNodeMaterial).side = DoubleSide;
  return m;
};

/** Eases `get()` toward `want()` each frame (door slides, plate presses). */
function ease(c: Ctx, apply: (v: number) => void, want: () => number, rate = 10) {
  let v = want();
  let last = 0;
  c.animated.push((t) => {
    const dt = last ? Math.min(0.1, t - last) : 0;
    last = t;
    v += (want() - v) * (1 - Math.exp(-rate * dt));
    apply(v);
  });
}

export function kitActor(e: Entity, verbs: readonly string[], isKey: boolean, c: Ctx): KitActor | null {
  const { keep } = c;
  const g = new Group();
  const inner = new Group();
  g.add(inner);
  g.position.set(...e.pos);
  const [sx, sy, sz] = e.size;
  const has = (v: string) => verbs.includes(v);
  const hide = () => {
    inner.visible = false;
  };

  if (has("puzzle.collect") || isKey) {
    const hex = isKey ? AMBER : PALETTE.orb;
    const r = Math.max(0.18, Math.min(sx, sz) / 2);
    const body = isKey
      ? new Mesh(keep(new TorusGeometry(r * 0.55, r * 0.18, 10, 28)), keep(glowMaterial(hex, 4)))
      : new Mesh(keep(new CylinderGeometry(r, r, r * 0.22, 32)), keep(glowMaterial(hex, 4.5)));
    if (!isKey) body.rotation.x = Math.PI / 2;
    const halo = new Mesh(keep(new RingGeometry(r * 1.2, r * 1.5, 32)), keep(additive(glowMaterial(hex, 1.4, 0.35))));
    inner.add(body, halo);
    c.animated.push((t) => {
      inner.rotation.y = t * 2.2 + e.pos[0];
      inner.position.y = Math.sin(t * 2.6 + e.pos[2]) * 0.08;
    });
    return { obj: g, gone: hide };
  }

  if (has("locomotion.jump_pad")) {
    const r = Math.min(sx, sz) / 2;
    const pad = new Mesh(keep(new CylinderGeometry(r, r, Math.max(0.06, sy), 40)), keep(glowMaterial(LIME, 0.35)));
    const rim = new Mesh(keep(new RingGeometry(r * 0.86, r, 48)), keep(glowMaterial(LIME, 3.5)));
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = sy / 2 + 0.01;
    inner.add(pad, rim);
    const chevrons = [0, 1, 2].map(() => {
      const m = new Mesh(keep(new TorusGeometry(r * 0.6, 0.03, 6, 40)), keep(additive(glowMaterial(LIME, 2.5, 0.8))));
      m.rotation.x = Math.PI / 2;
      inner.add(m);
      return m;
    });
    c.animated.push((t) => {
      chevrons.forEach((m, i) => {
        const ph = (t * 0.9 + i / 3) % 1;
        m.position.y = sy / 2 + ph * 2.2;
        (m.material as MeshBasicNodeMaterial).opacity = (1 - ph) * 0.8;
        m.scale.setScalar(1 - ph * 0.35);
      });
    });
    return { obj: g };
  }

  if (has("motion_hazards.wind")) {
    const vol = new Mesh(keep(new BoxGeometry(sx, sy, sz)), keep(beamMaterial(PALETTE.cyan, 1, 0.05)));
    inner.add(vol);
    return { obj: g };
  }

  if (has("motion_hazards.crumble")) {
    const slab = new Mesh(keep(new BoxGeometry(sx, sy, sz)), keep(bodyMaterial("#241a1a", 0.6, 0.2)));
    const edge = new Mesh(keep(new BoxGeometry(sx + 0.04, 0.05, sz + 0.04)), keep(glowMaterial(AMBER, 2.2)));
    edge.position.y = sy / 2;
    inner.add(slab, edge);
    let fallen = false;
    ease(c, (v) => {
      inner.position.y = -v * 1.5;
      inner.visible = v < 0.95;
    }, () => (fallen ? 1 : 0), 6);
    return { obj: g, setState: (s) => void (fallen = s === "fallen") };
  }

  switch (e.kind) {
    case "switch": {
      const box = new Mesh(keep(new BoxGeometry(sx, sy, sz)), keep(bodyMaterial("#15161f", 0.4, 0.5)));
      const lamp = new Mesh(keep(new OctahedronGeometry(Math.min(sx, sz) * 0.35, 0)), keep(glowMaterial(PALETTE.red, 4)));
      lamp.position.y = sy / 2 + 0.12;
      const light = new PointLight(PALETTE.red, 6, 4, 2);
      light.position.y = sy / 2 + 0.2;
      // a pole down to the floor if the switch is wall-height
      const pole = new Mesh(keep(new BoxGeometry(0.08, Math.max(0.01, e.pos[1] - sy / 2), 0.08)), keep(bodyMaterial("#15161f")));
      pole.position.y = -sy / 2 - (e.pos[1] - sy / 2) / 2;
      inner.add(box, lamp, light, pole);
      c.animated.push((t) => void (lamp.rotation.y = t * 1.5));
      return {
        obj: g,
        setState: (s) => {
          const on = s === "on";
          tint(lamp.material as Material, on ? PALETTE.cyan : PALETTE.red, 4);
          light.color.set(on ? PALETTE.cyan : PALETTE.red);
        },
      };
    }
    case "plate": {
      const r = Math.min(sx, sz) / 2;
      const pad = new Mesh(keep(new CylinderGeometry(r, r, Math.max(0.06, sy), 40)), keep(bodyMaterial("#1a1b26", 0.5, 0.4)));
      const rim = new Mesh(keep(new RingGeometry(r * 0.8, r * 0.95, 48)), keep(glowMaterial(AMBER, 2)));
      rim.rotation.x = -Math.PI / 2;
      rim.position.y = sy / 2 + 0.01;
      inner.add(pad, rim);
      let down = false;
      ease(c, (v) => void (inner.position.y = -v * 0.05), () => (down ? 1 : 0), 18);
      return {
        obj: g,
        setState: (s) => {
          down = s === "down";
          tint(rim.material as Material, down ? PALETTE.cyan : AMBER, down ? 4 : 2);
        },
      };
    }
    case "door": {
      // build along x; a door in an east/west wall turns a quarter
      const across = sz > sx;
      const [dx, dz] = across ? [sz, sx] : [sx, sz];
      if (across) inner.rotation.y = Math.PI / 2;
      const locked = has("puzzle.lock");
      const hex = locked ? PALETTE.red : PALETTE.cyan;
      const panel = new Mesh(keep(new BoxGeometry(dx, sy, dz)), keep(bodyMaterial("#101119", 0.35, 0.6)));
      const frame = keep(glowMaterial(hex, 3));
      const t = 0.06;
      for (const [x, y, w, h] of [[-dx / 2, 0, t, sy], [dx / 2, 0, t, sy], [0, sy / 2, dx, t], [0, 0, dx * 0.6, t]] as const) {
        const bar = new Mesh(keep(new BoxGeometry(w, h, dz + 0.02)), frame);
        bar.position.set(x, y, 0);
        inner.add(bar);
      }
      inner.add(panel);
      let open = false;
      ease(c, (v) => {
        inner.position.y = -v * (sy - 0.02);
        inner.visible = v < 0.98;
      }, () => (open ? 1 : 0), 5);
      return {
        obj: g,
        setState: (s) => {
          open = s === "open";
          if (open) tint(frame, PALETTE.cyan, 3);
        },
      };
    }
    case "hazard": {
      const slab = new Mesh(keep(new BoxGeometry(sx, Math.max(0.04, sy), sz)), keep(glowMaterial("#ff4a1c", 2.4)));
      const glow = new Mesh(keep(new BoxGeometry(sx, 0.6, sz)), keep(beamMaterial("#ff4a1c", 1.2, 0.25)));
      glow.position.y = sy / 2 + 0.3;
      const light = new PointLight("#ff4a1c", 10, 6, 2);
      light.position.y = 0.6;
      inner.add(slab, glow, light);
      c.animated.push((t) => {
        tint(slab.material as Material, "#ff4a1c", 2 + Math.sin(t * 4 + e.pos[0]) * 0.8);
        light.intensity = 9 + Math.sin(t * 4 + e.pos[0]) * 3;
      });
      return { obj: g };
    }
    case "checkpoint": {
      const mat = keep(glowMaterial(AMBER, 3));
      const h = Math.max(2.2, sy);
      for (const x of [-sx / 2, sx / 2]) {
        const post = new Mesh(keep(new BoxGeometry(0.1, h, 0.1)), mat);
        post.position.set(x, -sy / 2 + h / 2, 0);
        inner.add(post);
      }
      const bar = new Mesh(keep(new BoxGeometry(sx, 0.1, 0.1)), mat);
      bar.position.y = -sy / 2 + h;
      const gate = new Mesh(keep(new BoxGeometry(sx, h, 0.02)), keep(beamMaterial(AMBER, 1, 0.06)));
      gate.position.y = -sy / 2 + h / 2;
      inner.add(bar, gate);
      return { obj: g, setState: (s) => void (s === "reached" && tint(mat, PALETTE.cyan, 3)) };
    }
    case "portal": {
      const r = Math.max(0.6, Math.min(sx, sy) / 2);
      const ring = new Mesh(keep(new TorusGeometry(r, 0.07, 12, 64)), keep(glowMaterial(PALETTE.magenta, 4)));
      const disc = new Mesh(keep(new RingGeometry(0.05, r * 0.95, 48, 1)), keep(additive(glowMaterial(PALETTE.magenta, 1.4, 0.35))));
      const light = new PointLight(PALETTE.magenta, 14, 8, 2);
      inner.add(ring, disc, light);
      inner.rotation.y = Math.atan2(-e.pos[0], -e.pos[2]);
      c.animated.push((t) => {
        disc.rotation.z = t * 1.8;
        disc.scale.setScalar(0.92 + Math.sin(t * 3) * 0.06);
      });
      return { obj: g };
    }
    default:
      if (!has("social.inspect")) return null;
      {
        const box = new Mesh(keep(new BoxGeometry(sx, sy, sz)), keep(bodyMaterial("#1d1f2c", 0.5, 0.3)));
        const marker = new Mesh(keep(new OctahedronGeometry(0.14, 0)), keep(glowMaterial(PALETTE.cyan, 3.5)));
        marker.position.y = sy / 2 + 0.45;
        inner.add(box, marker);
        c.animated.push((t) => {
          marker.rotation.y = t * 2;
          marker.position.y = sy / 2 + 0.45 + Math.sin(t * 2.4) * 0.06;
        });
        return { obj: g };
      }
  }
}
