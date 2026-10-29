// The playtest's heat map: where every AI run of every level spent its time, as glowing tiles on
// the ground each part of it stood on (a rooftop's time is drawn on the rooftop). Cosmetic: one
// mesh of flat quads, added light (so a cell nobody stood in adds nothing), under the routes.
import { AdditiveBlending, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial } from "three/webgpu";

export interface HeatCells {
  cell: number;
  /** x, y, z (the ground) and a weight 0…1 per cell. */
  cells: readonly number[];
}

// cool to hot: a little time is a faint blue, the most is a hot amber
const RAMP = [new Color(0x1a4dff), new Color(0x19e3ff), new Color(0x3dffa8), new Color(0xffd23d), new Color(0xff6a2e)];
const _c = new Color();

function ramp(w: number): Color {
  const t = Math.min(0.999, Math.max(0, w)) * (RAMP.length - 1);
  const i = Math.floor(t);
  return _c.copy(RAMP[i]!).lerp(RAMP[i + 1]!, t - i);
}

export function heatView(h: HeatCells): Mesh | null {
  const pos: number[] = [];
  const col: number[] = [];
  const s = (h.cell / 2) * 0.94; // a hair of gap between tiles reads as a grid
  for (let i = 0; i + 3 < h.cells.length; i += 4) {
    const [x, y, z, w] = [h.cells[i]!, h.cells[i + 1]! + 0.04, h.cells[i + 2]!, h.cells[i + 3]!];
    if (w < 0.02) continue;
    // brighter with time spent, and never so faint it's noise: a square root lifts the quiet cells
    const c = ramp(w);
    const k = 0.25 + 0.75 * Math.sqrt(w);
    pos.push(x - s, y, z - s, x + s, y, z - s, x + s, y, z + s, x - s, y, z - s, x + s, y, z + s, x - s, y, z + s);
    for (let v = 0; v < 6; v++) col.push(c.r * k, c.g * k, c.b * k);
  }
  if (!pos.length) return null;
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new Float32BufferAttribute(col, 3));
  const mesh = new Mesh(geo, new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }));
  mesh.name = "heat";
  mesh.renderOrder = -1; // under the route ribbons
  return mesh;
}
