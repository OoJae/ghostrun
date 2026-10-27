// Rain: one LineSegments draw call. Drops are animated entirely in the vertex shader from a
// per-drop seed and `time`, and wrap inside a box that follows the camera, so the CPU cost is a
// single uniform update per frame.
import { AdditiveBlending, BufferGeometry, Color, Float32BufferAttribute, LineBasicNodeMaterial, LineSegments, Vector3 } from "three/webgpu";
import { attribute, fract, time, uniform, vec3 } from "three/tsl";

const BOX = [44, 22, 44] as const;
const SPEED = 15; // m/s
const LEN = 0.55;

export function makeRain(count = 1800): { object: LineSegments; follow(p: Vector3): void; dispose(): void } {
  const seeds: number[] = [];
  const pos: number[] = [];
  // Simple LCG: cosmetic only, deterministic per load.
  let s = 1234567;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < count; i++) {
    const a = r();
    const b = r();
    const c = r();
    seeds.push(a, b, c, 0, a, b, c, 1);
    pos.push(0, 0, 0, 0, 0, 0);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  g.setAttribute("aSeed", new Float32BufferAttribute(seeds, 4));

  const centre = uniform(new Vector3());
  const seed = attribute("aSeed", "vec4");
  const m = new LineBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
  m.color = new Color(0.45, 0.62, 0.95);
  m.opacity = 0.5;
  const x = fract(seed.x.sub(centre.x.div(BOX[0]))).sub(0.5).mul(BOX[0]).add(centre.x);
  const z = fract(seed.z.sub(centre.z.div(BOX[2]))).sub(0.5).mul(BOX[2]).add(centre.z);
  const y = fract(seed.y.sub(time.mul(SPEED / BOX[1]))).mul(BOX[1]).add(centre.y).sub(BOX[1] * 0.35);
  const t = seed.w;
  m.positionNode = vec3(x.add(t.mul(0.06)), y.add(t.mul(LEN)), z.add(t.mul(0.02)));
  m.fog = true;

  const object = new LineSegments(g, m);
  object.frustumCulled = false;
  object.renderOrder = 10;
  return {
    object,
    follow: (p) => {
      centre.value.copy(p);
    },
    dispose: () => {
      g.dispose();
      m.dispose();
    },
  };
}
