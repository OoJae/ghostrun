// A flat panel of words and buttons for the headset: a plane in the scene whose canvas texture is
// painted only when what it says changes (or the button under the pointer does), never per frame.
// Sizes are physical: a panel knows its metres per pixel, so a font can be checked against the
// angle it covers at the distance the panel is read from.
import { CanvasTexture, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3 } from "three/webgpu";

/** The smallest a character may look: 0.02 rad of height (about 1.15°) where it is read from. */
export const MIN_RAD = 0.02;

/** The smallest font (px) that stays readable on a panel `mPerPx` metres per pixel, read from `dist` metres. */
export const minFont = (mPerPx: number, dist: number) => Math.ceil((MIN_RAD * dist) / mPerPx);

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PanelButton extends Rect {
  id: string;
}

export const INK = "#eef0ff";
export const DIM = "rgba(222, 226, 255, 0.66)";
export const CYAN = "#19e3ff";
export const TONE: Record<string, string> = { good: "#3dffa8", bad: "#ff3b5c", pending: "#ffc24a", warn: "#ffb13b" };
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** The painter a panel hands its paint function: text that wraps, buttons that remember where they are. */
export class Ui {
  readonly buttons: PanelButton[] = [];
  /** Every string drawn, in order (what the test probe reads). */
  readonly words: string[] = [];

  constructor(
    readonly g: CanvasRenderingContext2D,
    readonly w: number,
    readonly h: number,
    readonly hover: string | null,
  ) {}

  /** The panel's glass: a dark rounded card (from `top` down, when the words need less than the whole panel). */
  card(fill = "rgba(10, 7, 22, 0.9)", edge = "rgba(255, 255, 255, 0.14)", top = 0) {
    const g = this.g;
    round(g, 3, top + 3, this.w - 6, this.h - top - 6, 28);
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = edge;
    g.stroke();
  }

  font(px: number, weight = 600) {
    this.g.font = `${weight} ${px}px ${FONT}`;
  }

  /** Lines of at most `maxW` px, at most `max` of them (the last one ends in … when cut). */
  wrap(text: string, px: number, maxW: number, max = 3, weight = 600): string[] {
    this.font(px, weight);
    const out: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (this.g.measureText(next).width <= maxW || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
    if (out.length > max) {
      out.length = max;
      let last = out[max - 1]!;
      while (last && this.g.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
      out[max - 1] = `${last.trimEnd()}…`;
    }
    return out;
  }

  /** Wrapped text from (x, y) (its top); returns the y under the last line. */
  text(text: string, x: number, y: number, px: number, color = INK, opts: { maxW?: number; max?: number; weight?: number; align?: CanvasTextAlign } = {}): number {
    const g = this.g;
    const lines = this.wrap(text, px, opts.maxW ?? this.w - x - 28, opts.max ?? 3, opts.weight ?? 600);
    g.fillStyle = color;
    g.textAlign = opts.align ?? "left";
    g.textBaseline = "top";
    for (const [i, l] of lines.entries()) g.fillText(l, x, y + i * px * 1.25);
    if (lines.length) this.words.push(lines.join(" "));
    return y + lines.length * px * 1.25;
  }

  dot(x: number, y: number, r: number, color: string) {
    this.g.beginPath();
    this.g.arc(x, y, r, 0, Math.PI * 2);
    this.g.fillStyle = color;
    this.g.fill();
  }

  /** A pill button; the one under the pointer lights up. */
  button(id: string, label: string, r: Rect, px: number, primary = false) {
    const g = this.g;
    const on = this.hover === id;
    round(g, r.x, r.y, r.w, r.h, r.h / 2);
    g.fillStyle = on ? CYAN : primary ? "rgba(25, 227, 255, 0.22)" : "rgba(255, 255, 255, 0.1)";
    g.fill();
    g.lineWidth = on ? 4 : 2;
    g.strokeStyle = on ? "#ffffff" : primary ? CYAN : "rgba(255, 255, 255, 0.3)";
    g.stroke();
    this.font(px, 700);
    g.fillStyle = on ? "#07040f" : INK;
    g.textAlign = "center";
    g.textBaseline = "middle";
    let shown = label;
    while (shown.length > 3 && g.measureText(shown).width > r.w - px) shown = `${shown.slice(0, -2)}…`;
    g.fillText(shown, r.x + r.w / 2, r.y + r.h / 2 + 1);
    this.buttons.push({ id, ...r });
    this.words.push(`[${label}]`);
  }
}

function round(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2));
}

const _inv = new Matrix4();
const _o = new Vector3();
const _e = new Vector3();

export class Panel {
  readonly mesh: Mesh;
  readonly id: string;
  readonly widthM: number;
  readonly heightM: number;
  /** Metres per canvas pixel at scale 1. */
  readonly mPerPx: number;
  /** Redraws so far: each one re-uploads the texture, so there is one per change and none per frame. */
  draws = 0;
  /** What it says now (for the probe). */
  words: readonly string[] = [];
  buttons: readonly PanelButton[] = [];
  readonly #canvas: HTMLCanvasElement;
  readonly #g: CanvasRenderingContext2D;
  readonly #tex: CanvasTexture;
  readonly #mat: MeshBasicMaterial;
  #key: string | null = null;
  #paint: ((ui: Ui) => void) | null = null;
  #hover: string | null = null;

  /**
   * `px` is the canvas size, `widthM` the panel's width in metres. `onTop` panels draw over the
   * world (a card you must be able to read even if a wall stands between); the rest are depth tested.
   */
  constructor(id: string, px: [number, number], widthM: number, onTop = true) {
    this.id = id;
    this.#canvas = document.createElement("canvas");
    [this.#canvas.width, this.#canvas.height] = px;
    this.#g = this.#canvas.getContext("2d")!;
    this.widthM = widthM;
    this.mPerPx = widthM / px[0];
    this.heightM = px[1] * this.mPerPx;
    const tex = new CanvasTexture(this.#canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 8; // crisp when read at a slant (a wrist), mipmapped so it never shimmers at the lower VR resolution
    this.#tex = tex;
    this.#mat = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: !onTop, fog: false, toneMapped: false });
    this.mesh = new Mesh(new PlaneGeometry(this.widthM, this.heightM), this.#mat);
    this.mesh.name = `panel:${id}`;
    this.mesh.renderOrder = onTop ? 20 : 5;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  get shown(): boolean {
    return this.mesh.visible;
  }

  set shown(on: boolean) {
    this.mesh.visible = on;
    if (!on) this.hover = null;
  }

  /** What it shows: painted again only when `key` differs from what is on it now. */
  show(key: string, paint: (ui: Ui) => void) {
    this.#paint = paint;
    this.mesh.visible = true;
    if (key === this.#key) return;
    this.#key = key;
    this.#redraw();
  }

  get hover(): string | null {
    return this.#hover;
  }

  /** The button under the pointer (repainted only when that changes). */
  set hover(id: string | null) {
    if (id === this.#hover) return;
    this.#hover = id;
    if (this.#paint) this.#redraw();
  }

  #redraw() {
    const g = this.#g;
    g.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    const ui = new Ui(g, this.#canvas.width, this.#canvas.height, this.#hover);
    this.#paint!(ui);
    this.buttons = ui.buttons;
    this.words = ui.words;
    this.#tex.needsUpdate = true;
    this.draws++;
  }

  /**
   * Where a world-space ray (origin, unit direction) meets the panel's face: the distance along the
   * ray and the button there (null between buttons). Null if it misses or the panel is hidden.
   */
  hit(o: Vector3, d: Vector3): { t: number; button: string | null } | null {
    if (!this.mesh.visible) return null;
    this.mesh.updateWorldMatrix(true, false);
    _inv.copy(this.mesh.matrixWorld).invert();
    _o.copy(o).applyMatrix4(_inv);
    _e.copy(o).add(d).applyMatrix4(_inv).sub(_o); // the direction, scaled as the panel is, so t stays in world metres
    if (Math.abs(_e.z) < 1e-6) return null;
    const t = -_o.z / _e.z;
    if (t <= 0) return null;
    const x = _o.x + _e.x * t;
    const y = _o.y + _e.y * t;
    if (Math.abs(x) > this.widthM / 2 || Math.abs(y) > this.heightM / 2) return null;
    const px = (x / this.widthM + 0.5) * this.#canvas.width;
    const py = (0.5 - y / this.heightM) * this.#canvas.height;
    const b = this.buttons.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
    return { t, button: b ? b.id : null };
  }

  /** A button's centre in world space (the tests aim a controller at it). */
  centreOf(id: string, out = new Vector3()): Vector3 | null {
    const b = this.buttons.find((r) => r.id === id);
    if (!b || !this.mesh.visible) return null;
    const x = ((b.x + b.w / 2) / this.#canvas.width - 0.5) * this.widthM;
    const y = (0.5 - (b.y + b.h / 2) / this.#canvas.height) * this.heightM;
    this.mesh.updateWorldMatrix(true, false);
    return out.set(x, y, 0).applyMatrix4(this.mesh.matrixWorld);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.#mat.dispose();
    this.#tex.dispose();
  }
}
