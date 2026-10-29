// Comfort in the headset: a vignette that narrows the view while you move without moving (smooth
// walking, driving, a turn), and the blink that hides a teleport's walk and a world swapping in.
// One head-locked plane whose shader is a uniform or two: changing them never re-uploads anything.
import { Mesh, MeshBasicNodeMaterial, PlaneGeometry } from "three/webgpu";
import { length, smoothstep, uniform, uv, vec3 } from "three/tsl";

/** The plane hangs this far in front of the eyes (far enough that both eyes see the same tunnel). */
const AT = 1;
/** Its half size: at 1 m it reaches 76° off centre, past any headset's field of view. */
const HALF = 4;
const deg = (d: number) => (d * Math.PI) / 180;

export class Vignette {
  readonly mesh: Mesh;
  /** The clear circle's radius (0…1 of the plane's half size) and how dark the rest is. */
  readonly #inner = uniform(1.5);
  readonly #alpha = uniform(0);
  #strength = 0;
  #blink = 0;

  constructor() {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
    const r = length(uv().sub(0.5)).mul(2);
    m.colorNode = vec3(0, 0, 0);
    m.opacityNode = smoothstep(this.#inner, this.#inner.add(0.22), r).mul(this.#alpha);
    this.mesh = new Mesh(new PlaneGeometry(HALF * 2, HALF * 2), m);
    this.mesh.name = "vignette";
    this.mesh.renderOrder = 40;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** How narrow (0 open … 1 a tunnel of about ±32°) and the blink (0 … 1 dark), eased per frame. */
  set(strength: number, blink: number, dt: number) {
    this.#strength += (strength - this.#strength) * (1 - Math.exp(-dt * (strength > this.#strength ? 10 : 4)));
    this.#blink += (blink - this.#blink) * (1 - Math.exp(-dt * (blink > this.#blink ? 22 : 9)));
    if (this.#strength < 0.01) this.#strength = 0;
    if (this.#blink < 0.01) this.#blink = 0;
    const s = this.#strength;
    const b = this.#blink;
    this.mesh.visible = s > 0 || b > 0;
    // the clear cone narrows from 70° to 32° off centre; a blink closes it like an iris
    const open = Math.tan(deg(70 - 38 * s)) / (HALF / AT);
    this.#inner.value = open + (-0.3 - open) * b;
    this.#alpha.value = Math.max(0.85 * Math.min(1, s * 1.5), b > 0 ? 0.94 : 0);
  }

  /** In front of the eyes, from the headset's pose in the world. */
  place(pos: { x: number; y: number; z: number }, quat: { x: number; y: number; z: number; w: number }) {
    this.mesh.position.set(pos.x, pos.y, pos.z);
    this.mesh.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    this.mesh.translateZ(-AT);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}
