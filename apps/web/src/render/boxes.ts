// Batches many axis-aligned boxes into one indexed BufferGeometry (one draw call per batch), with
// a per-vertex colour (may exceed 1 for HDR emissive strips) and a per-box style vec4.
import { BufferGeometry, Float32BufferAttribute, Uint32BufferAttribute } from "three/webgpu";

type V3 = readonly [number, number, number];

// Face order: +x, -x, +y, -y, +z, -z. Each face: normal and the 4 corner signs (CCW from outside).
const FACES: { n: V3; c: V3[] }[] = [
  { n: [1, 0, 0], c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { n: [0, 1, 0], c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { n: [0, -1, 0], c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];

export class BoxBatch {
  #pos: number[] = [];
  #nrm: number[] = [];
  #col: number[] = [];
  #sty: number[] = [];
  #idx: number[] = [];

  get count() {
    return this.#idx.length / 36;
  }

  /** centre, full size, linear RGB colour, style (x: window amount, y: seed, z: neon hue 0..1, w: free). */
  add(c: V3, s: V3, rgb: V3, style: readonly [number, number, number, number] = [0, 0, 0, 0], skipBottom = true): this {
    const hx = s[0] / 2;
    const hy = s[1] / 2;
    const hz = s[2] / 2;
    for (const f of FACES) {
      if (skipBottom && f.n[1] === -1) continue;
      const base = this.#pos.length / 3;
      for (const k of f.c) {
        this.#pos.push(c[0] + k[0] * hx, c[1] + k[1] * hy, c[2] + k[2] * hz);
        this.#nrm.push(f.n[0], f.n[1], f.n[2]);
        this.#col.push(rgb[0], rgb[1], rgb[2]);
        this.#sty.push(style[0], style[1], style[2], style[3]);
      }
      this.#idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }

  /** A thin strip along one axis from a to b (a and b differ on exactly one axis). */
  strip(a: V3, b: V3, thick: number, rgb: V3): this {
    const c: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const s: V3 = [Math.abs(b[0] - a[0]) || thick, Math.abs(b[1] - a[1]) || thick, Math.abs(b[2] - a[2]) || thick];
    return this.add(c, s, rgb, [0, 0, 0, 0], false);
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(this.#pos, 3));
    g.setAttribute("normal", new Float32BufferAttribute(this.#nrm, 3));
    g.setAttribute("color", new Float32BufferAttribute(this.#col, 3));
    g.setAttribute("aStyle", new Float32BufferAttribute(this.#sty, 4));
    g.setIndex(new Uint32BufferAttribute(this.#idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
