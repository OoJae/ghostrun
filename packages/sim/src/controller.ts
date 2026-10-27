// Player movement: Rapier's KinematicCharacterController driven by the world's laws, with the
// game-feel the plan requires (coyote time, jump buffer, air jumps on fresh presses only).
import type { Laws } from "@ghostrun/ir";
import type { Rapier } from "./rapier/load";
import { BTN, DT, type InputFrame } from "./types";

type RigidBody = InstanceType<Rapier["RigidBody"]>;
type Collider = InstanceType<Rapier["Collider"]>;
type Kcc = ReturnType<InstanceType<Rapier["World"]>["createCharacterController"]>;

export const PLAYER_RADIUS = 0.35;
export const PLAYER_HALF_HEIGHT = 0.55; // capsule segment half-length; total height 1.8 m

export interface ControllerEvents {
  jumped: boolean;
  airJumped: boolean;
  landed: boolean;
}

export class PlayerController {
  vx = 0;
  vy = 0;
  vz = 0;
  grounded = false;
  jumpsUsed = 0;
  #coyote = 0;
  #buffer = 0;
  #prevBtn = 0;
  readonly #g: number;
  readonly #vJump: number;

  constructor(
    readonly body: RigidBody,
    readonly collider: Collider,
    readonly kcc: Kcc,
    readonly laws: Laws,
  ) {
    this.#g = 9.81 * laws.gravityScale;
    this.#vJump = Math.sqrt(2 * this.#g * laws.jumpH);
  }

  /** Advance one tick; `exclude` is a collider the KCC must ignore (e.g. the carried item). */
  step(input: InputFrame | null, exclude: (c: Collider) => boolean, ceiling: (headY: number, up: number) => boolean): ControllerEvents {
    const laws = this.laws;
    const btn = input?.btn ?? 0;
    const pressed = (btn & BTN.JUMP) !== 0 && (this.#prevBtn & BTN.JUMP) === 0;
    this.#prevBtn = btn;
    const ev: ControllerEvents = { jumped: false, airJumped: false, landed: false };

    if (pressed) this.#buffer = Math.round((laws.bufferMs / 1000) * 60);
    if (this.grounded) {
      this.#coyote = Math.round((laws.coyoteMs / 1000) * 60);
      this.jumpsUsed = 0;
    } else if (this.#coyote > 0) {
      this.#coyote--;
      if (this.#coyote === 0 && this.jumpsUsed === 0) this.jumpsUsed = 1; // walked off a ledge
    }

    if (this.#buffer > 0 && laws.jumpsMax > 0) {
      if (this.grounded || this.#coyote > 0) {
        this.vy = this.#vJump;
        this.jumpsUsed = 1;
        this.#buffer = 0;
        this.#coyote = 0;
        ev.jumped = true;
      } else if (pressed && this.jumpsUsed < laws.jumpsMax) {
        this.vy = this.#vJump;
        this.jumpsUsed++;
        this.#buffer = 0;
        ev.airJumped = true;
      } else {
        this.#buffer--;
      }
    }

    // Horizontal: full control on the ground, partial in the air.
    let mx = (input?.wx ?? 0) / 127;
    let mz = (input?.wz ?? 0) / 127;
    const len = Math.sqrt(mx * mx + mz * mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    const tx = mx * laws.speed;
    const tz = mz * laws.speed;
    if (this.grounded) {
      this.vx = tx;
      this.vz = tz;
    } else {
      const k = Math.min(1, laws.airControl * 0.15);
      this.vx += (tx - this.vx) * k;
      this.vz += (tz - this.vz) * k;
    }

    if (!this.grounded || this.vy > 0) this.vy = Math.max(-50, this.vy - this.#g * DT);

    const want = { x: this.vx * DT, y: this.vy * DT, z: this.vz * DT };
    this.kcc.computeColliderMovement(this.collider, want, undefined, undefined, (c) => !exclude(c));
    const mv = this.kcc.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.kcc.computedGrounded();
    if (this.grounded && this.vy < 0) this.vy = 0;
    // Bumped a ceiling? Ask the world with an upward ray from the head (sliding up a wall also
    // shortens mv.y, so mv alone can't tell the difference).
    if (this.vy > 0 && mv.y < want.y - 1e-6) {
      const p0 = this.body.translation();
      if (ceiling(p0.y + PLAYER_HALF_HEIGHT + PLAYER_RADIUS, want.y + 0.02)) this.vy = 0;
    }
    if (this.grounded && !wasGrounded) ev.landed = true;

    const p = this.body.translation();
    this.body.setNextKinematicTranslation({ x: p.x + mv.x, y: p.y + mv.y, z: p.z + mv.z });
    return ev;
  }

  /** Feet height above the capsule centre's floor contact. */
  static feetY(centreY: number): number {
    return centreY - PLAYER_HALF_HEIGHT - PLAYER_RADIUS;
  }
}
