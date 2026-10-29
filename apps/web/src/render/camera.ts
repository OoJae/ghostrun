// Third-person follow camera. No pointer lock: orbit by click-drag, two-finger trackpad scroll
// (deltaX → yaw), Q/E or ←/→ (yaw), ↑/↓ (pitch); pinch or wheel zooms. Pulls in when a static
// would block the view.
import { MathUtils, Vector3, type PerspectiveCamera } from "three/webgpu";
import { rayBox, type Box } from "../sim/aabb";

const PITCH_MIN = -0.15;
const PITCH_MAX = 1.05;
const DIST_MIN = 2.5;
const DIST_MAX = 14;
const LOOK_H = 0.9; // look at a point above the capsule centre

export class FollowCamera {
  yaw = 0;
  pitch = 0.36;
  dist = 7;
  readonly #cam: PerspectiveCamera;
  readonly #el: HTMLElement;
  readonly #target = new Vector3();
  readonly #pos = new Vector3();
  #colliders: readonly Box[] = [];
  #snap = true;
  #dragId: number | null = null;
  #lastX = 0;
  #lastY = 0;
  #keys = new Set<string>();
  #pulled = DIST_MAX;
  #chase: { yaw: number; k: number } | null = null;
  #orbitAt = -Infinity;
  #extra = 0;
  onUserOrbit: (() => void) | undefined;

  constructor(cam: PerspectiveCamera, el: HTMLElement) {
    this.#cam = cam;
    this.#el = el;
    el.addEventListener("pointerdown", this.#down);
    el.addEventListener("pointermove", this.#move);
    el.addEventListener("pointerup", this.#up);
    el.addEventListener("pointercancel", this.#up);
    el.addEventListener("wheel", this.#wheel, { passive: false });
    window.addEventListener("keydown", this.#key);
    window.addEventListener("keyup", this.#key);
    window.addEventListener("blur", this.#blur);
  }

  setColliders(boxes: readonly Box[]) {
    this.#colliders = boxes;
  }

  /**
   * At the wheel: swing in behind the way the vehicle points (unless you orbited a moment ago) and
   * pull back with its speed (k, 0 to 1 of top speed). null on foot.
   */
  chase(yaw: number | null, k = 0) {
    // getting in: straight behind it at once (the stick steers the way the camera looks)
    if (yaw !== null && !this.#chase) this.yaw = yaw;
    this.#chase = yaw === null ? null : { yaw, k };
  }

  /** Jump straight to the target next update (new world / respawn). */
  reset(yaw: number, pitch = 0.36) {
    this.yaw = yaw;
    this.pitch = pitch;
    this.dist = 7;
    this.#extra = 0;
    this.#chase = null;
    this.#snap = true;
  }

  update(dt: number, target: Vector3) {
    const k = this.#keys;
    const rot = (k.has("KeyQ") || k.has("ArrowLeft") ? 1 : 0) - (k.has("KeyE") || k.has("ArrowRight") ? 1 : 0);
    const tilt = (k.has("ArrowUp") ? 1 : 0) - (k.has("ArrowDown") ? 1 : 0);
    this.yaw += rot * 2.4 * dt;
    this.pitch = MathUtils.clamp(this.pitch + tilt * 1.4 * dt, PITCH_MIN, PITCH_MAX);
    const c = this.#chase;
    if (c && !rot && this.#dragId === null && performance.now() - this.#orbitAt > 1500) {
      const off = Math.atan2(Math.sin(c.yaw - this.yaw), Math.cos(c.yaw - this.yaw));
      this.yaw += off * (1 - Math.exp(-dt * (1.8 + 2.4 * c.k)));
    }

    const goal = new Vector3(target.x, target.y + LOOK_H, target.z);
    if (this.#snap) this.#target.copy(goal);
    else this.#target.lerp(goal, 1 - Math.exp(-dt * 14));

    // Orbit offset: behind the yaw-forward direction, raised by pitch.
    const cp = Math.cos(this.pitch);
    const dir = new Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    // (the chase's pull eases both ways: only a wall in the way pulls in at once)
    this.#extra += ((c ? 1 + 3.5 * c.k : 0) - this.#extra) * (1 - Math.exp(-dt * 2.5));
    let d = this.dist + this.#extra;
    for (const b of this.#colliders) {
      const t = rayBox([this.#target.x, this.#target.y, this.#target.z], [dir.x, dir.y, dir.z], b, d);
      if (t < d) d = Math.max(0.8, t - 0.25);
    }
    // Pull in instantly, ease back out.
    this.#pulled = this.#snap || d < this.#pulled ? d : this.#pulled + (d - this.#pulled) * (1 - Math.exp(-dt * 4));
    this.#pos.copy(this.#target).addScaledVector(dir, this.#pulled);
    this.#pos.y = Math.max(this.#pos.y, 0.35);
    this.#cam.position.copy(this.#pos);
    this.#cam.lookAt(this.#target);
    this.#snap = false;
  }

  dispose() {
    const el = this.#el;
    el.removeEventListener("pointerdown", this.#down);
    el.removeEventListener("pointermove", this.#move);
    el.removeEventListener("pointerup", this.#up);
    el.removeEventListener("pointercancel", this.#up);
    el.removeEventListener("wheel", this.#wheel);
    window.removeEventListener("keydown", this.#key);
    window.removeEventListener("keyup", this.#key);
    window.removeEventListener("blur", this.#blur);
  }

  #down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.#dragId = e.pointerId;
    this.#lastX = e.clientX;
    this.#lastY = e.clientY;
    this.#el.setPointerCapture(e.pointerId);
  };

  #move = (e: PointerEvent) => {
    if (this.#dragId !== e.pointerId) return;
    const dx = e.clientX - this.#lastX;
    const dy = e.clientY - this.#lastY;
    this.#lastX = e.clientX;
    this.#lastY = e.clientY;
    if (dx || dy) ((this.#orbitAt = performance.now()), this.onUserOrbit?.());
    this.yaw -= dx * 0.006;
    this.pitch = MathUtils.clamp(this.pitch + dy * 0.004, PITCH_MIN, PITCH_MAX);
  };

  #up = (e: PointerEvent) => {
    if (this.#dragId !== e.pointerId) return;
    this.#dragId = null;
    if (this.#el.hasPointerCapture(e.pointerId)) this.#el.releasePointerCapture(e.pointerId);
  };

  #wheel = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey) {
      // Pinch-to-zoom on a trackpad arrives as ctrl+wheel.
      this.dist = MathUtils.clamp(this.dist * Math.exp(e.deltaY * 0.01), DIST_MIN, DIST_MAX);
      return;
    }
    this.yaw -= e.deltaX * 0.004;
    this.dist = MathUtils.clamp(this.dist * Math.exp(e.deltaY * 0.0015), DIST_MIN, DIST_MAX);
    if (e.deltaX) ((this.#orbitAt = performance.now()), this.onUserOrbit?.());
  };

  #key = (e: KeyboardEvent) => {
    if (isTyping(e.target)) return;
    if (e.type === "keydown") this.#keys.add(e.code);
    else this.#keys.delete(e.code);
  };

  #blur = () => {
    this.#keys.clear();
  };
}

export function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}
