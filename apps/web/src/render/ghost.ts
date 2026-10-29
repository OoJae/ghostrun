// The ghost you race: the player's silhouette in light, translucent and additive. It is not in the
// simulation, so it collides with nothing and changes nothing; the engine moves it by tick. Its
// colour and fade are uniforms, so switching rivals never recompiles a shader mid-run.
import { AdditiveBlending, CapsuleGeometry, Color, ConeGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, RingGeometry } from "three/webgpu";
import { abs, normalView, oneMinus, positionViewDirection, uniform } from "three/tsl";
import { lin, PALETTE } from "./materials";

/** The AI par runner glows magenta (the neon pair to the player's cyan); a person's run, amber. */
export const GHOST_HEX = { ai: PALETTE.magenta, run: "#ffc24a" } as const;

export interface GhostActor {
  obj: Group;
  setKind(kind: keyof typeof GHOST_HEX): void;
  /** 1 while racing, lower once it has finished (it waits at the line, dimmed). */
  setFade(a: number): void;
  dispose(): void;
}

const SCALE = 3.2; // HDR: it blooms, so it reads across a plaza at night

export function ghostActor(): GhostActor {
  const tint = uniform(new Color(...lin(GHOST_HEX.ai, SCALE)));
  const fade = uniform(1);
  // brightest at the silhouette's edge, see-through face-on: reads as a ghost from any angle
  const rim = oneMinus(abs(normalView.dot(positionViewDirection.negate()))).pow(1.4);
  const body = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
  body.colorNode = tint.mul(rim.mul(0.7).add(0.3));
  body.opacityNode = rim.mul(0.5).add(0.45).mul(fade);
  const flat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, side: DoubleSide });
  flat.colorNode = tint;
  flat.opacityNode = fade.mul(0.85);
  const capsule = new CapsuleGeometry(0.33, 1.14, 6, 18);
  const visorGeo = new CapsuleGeometry(0.07, 0.3, 4, 8);
  visorGeo.rotateZ(Math.PI / 2);
  const ringGeo = new RingGeometry(0.42, 0.5, 40);
  // a marker over its head, like the player's: easy to find from far off
  const markerGeo = new ConeGeometry(0.13, 0.26, 4);
  const g = new Group();
  g.name = "ghost";
  const visor = new Mesh(visorGeo, flat);
  visor.position.set(0, 0.5, -0.27);
  const ring = new Mesh(ringGeo, flat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.88;
  const marker = new Mesh(markerGeo, flat);
  marker.rotation.x = Math.PI;
  marker.position.y = 1.35;
  const shell = new Mesh(capsule, body);
  for (const m of [shell, visor, ring, marker]) {
    // drawn after the world (it's see-through), and never culled, so a world's load compiles it
    m.renderOrder = 3;
    m.frustumCulled = false;
    g.add(m);
  }
  return {
    obj: g,
    setKind: (kind) => void tint.value.setRGB(...lin(GHOST_HEX[kind], SCALE)),
    setFade: (a) => void (fade.value = a),
    dispose() {
      for (const x of [capsule, visorGeo, ringGeo, markerGeo, body, flat]) x.dispose();
    },
  };
}
