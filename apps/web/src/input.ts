// Keyboard → InputFrame. WASD moves relative to the camera yaw, Space jumps, F uses. Presses are
// latched until the next sample so a tap between two frames is never lost.
import { isTyping } from "./render/camera";
import { BTN_JUMP, BTN_USE, type InputFrame } from "./sim/types";

const GAME_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyF", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export class InputCollector {
  readonly #down = new Set<string>();
  #latched = 0;
  /** Fires on every gameplay input (keys or camera orbit); the HUD collapses on it. */
  onInput: (() => void) | undefined;
  /** Fires when the held-key set changes, so the sim can get input between render frames. */
  onChange: (() => void) | undefined;

  constructor() {
    window.addEventListener("keydown", this.#onDown);
    window.addEventListener("keyup", this.#onUp);
    window.addEventListener("blur", this.#onBlur);
  }

  sample(tick: number, yaw: number): InputFrame {
    const d = this.#down;
    const mx = (d.has("KeyD") ? 1 : 0) - (d.has("KeyA") ? 1 : 0);
    const my = (d.has("KeyW") ? 1 : 0) - (d.has("KeyS") ? 1 : 0);
    let btn = this.#latched;
    if (d.has("Space")) btn |= BTN_JUMP;
    if (d.has("KeyF")) btn |= BTN_USE;
    this.#latched = 0;
    return { tick, mx, my, yaw, btn };
  }

  markInput() {
    this.onInput?.();
  }

  dispose() {
    window.removeEventListener("keydown", this.#onDown);
    window.removeEventListener("keyup", this.#onUp);
    window.removeEventListener("blur", this.#onBlur);
  }

  #onDown = (e: KeyboardEvent) => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey) return;
    if (!GAME_KEYS.has(e.code)) return;
    e.preventDefault(); // no page scroll on Space / arrows
    if (!e.repeat) {
      if (e.code === "Space") this.#latched |= BTN_JUMP;
      if (e.code === "KeyF") this.#latched |= BTN_USE;
    }
    const fresh = !this.#down.has(e.code);
    this.#down.add(e.code);
    this.markInput();
    if (fresh) this.onChange?.();
  };

  #onUp = (e: KeyboardEvent) => {
    if (this.#down.delete(e.code)) this.onChange?.();
  };

  #onBlur = () => {
    this.#down.clear();
  };
}
