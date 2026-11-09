// Player movement: Rapier's KinematicCharacterController driven by the world's laws, with the
// game-feel the plan requires (coyote time, jump buffer, air jumps on fresh presses only).
import type { Laws } from "@ghostrun/ir";
import { DIVE, FLOAT_DEPTH, FLY_K, SINK, SWIM_DOWN, SWIM_K, SWIM_SPEED, SWIM_UP } from "@ghostrun/kits";
import type { Rapier } from "./rapier/load";
import { BTN, DT, type InputFrame } from "./types";

type RigidBody = InstanceType<Rapier["RigidBody"]>;
type Collider = InstanceType<Rapier["Collider"]>;
type Kcc = ReturnType<InstanceType<Rapier["World"]>["createCharacterController"]>;

export const PLAYER_RADIUS = 0.35;
export const PLAYER_HALF_HEIGHT = 0.55; // capsule segment half-length; total height 1.8 m

/** A character at the wheel: the vehicle it drives, the way it faces (unit x, z), its speed and boost. */
export interface Ride {
  vehicle: string;
  feel: { speed: number; accel: number; turn: number; grip: number; boost: number; boostS: number; cooldown: number; kind: string };
  hx: number;
  hz: number;
  speed: number;
  boostLeft: number;
  boostAt: number;
}

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
  /** Extra horizontal velocity for the next step only (wind, conveyors), m/s. */
  shoveX = 0;
  shoveZ = 0;
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
    if (this.shoveX !== 0 || this.shoveZ !== 0) {
      // only when shoved: adding +0 would flip a −0 velocity to +0, and the KCC branches on it
      want.x += this.shoveX * DT;
      want.z += this.shoveZ * DT;
      this.shoveX = 0;
      this.shoveZ = 0;
    }
    this.kcc.computeColliderMovement(this.collider, want, undefined, undefined, (c) => !exclude(c));
    const mv = this.kcc.computedMovement();
    const wasGrounded = this.grounded;
    // Only count as grounded when not moving up: the KCC reports ground while a rising capsule
    // slides over a ledge edge, which would otherwise reset the jump counter mid-air (a free
    // extra jump that breaks every "requires N jumps" claim).
    this.grounded = this.kcc.computedGrounded() && this.vy <= 0;
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

  /**
   * One tick at the wheel: the arcade model. The vehicle turns toward the stick (slower when
   * nearly stopped, never stuck), speeds up toward its top speed scaled by how far the stick is
   * pushed and how well it already points that way (it slows for a corner by itself), brakes when
   * the stick points back (and reverses once stopped); its velocity slides toward where it faces by its grip (low grip
   * drifts); a fresh jump press boosts when the boost is ready. Only + − × ÷ and sqrt.
   */
  drive(input: InputFrame | null, r: Ride, tick: number, exclude: (c: Collider) => boolean): ControllerEvents {
    const btn = input?.btn ?? 0;
    const pressed = (btn & BTN.JUMP) !== 0 && (this.#prevBtn & BTN.JUMP) === 0;
    this.#prevBtn = btn;
    const f = r.feel;
    if (pressed && tick >= r.boostAt) {
      r.boostLeft = Math.round(f.boostS * 60);
      r.boostAt = tick + Math.round(f.cooldown * 60);
    }
    const boosting = r.boostLeft > 0;
    if (boosting) r.boostLeft--;
    const sx = (input?.wx ?? 0) / 127;
    const sz = (input?.wz ?? 0) / 127;
    const len = Math.sqrt(sx * sx + sz * sz);
    let target = 0;
    if (len > 0.15) {
      const [dx, dz] = [sx / len, sz / len];
      const align = r.hx * dx + r.hz * dz;
      const cross = r.hx * dz - r.hz * dx;
      const k = f.turn * DT * (0.4 + 0.6 * Math.min(1, Math.abs(r.speed) / (0.5 * f.speed)));
      if (align > 0 && Math.abs(cross) <= k) [r.hx, r.hz] = [dx, dz];
      else {
        const side = cross > 0 || (cross === 0 && align < 0) ? 1 : -1;
        const nx = r.hx - r.hz * k * side;
        const nz = r.hz + r.hx * k * side;
        const n = Math.sqrt(nx * nx + nz * nz);
        [r.hx, r.hz] = [nx / n, nz / n];
      }
      const a2 = r.hx * dx + r.hz * dz;
      // (pointing back: brakes, and once stopped backs up slowly while it turns, off a wall it drove into)
      target = a2 > -0.5 ? f.speed * Math.min(1, len) * Math.min(1, Math.max(0.3, (a2 + 0.5) / 1.5)) * (boosting ? f.boost : 1) : r.speed <= 0.5 ? -0.3 * f.speed * Math.min(1, len) : 0;
    }
    const up = f.accel * (boosting ? 2 : 1) * DT;
    r.speed += Math.max(-2 * f.accel * DT, Math.min(up, target - r.speed));
    this.vx += (r.hx * r.speed - this.vx) * f.grip;
    this.vz += (r.hz * r.speed - this.vz) * f.grip;
    const g = this.#g;
    if (!this.grounded || this.vy > 0) this.vy = Math.max(-50, this.vy - g * DT);
    const want = { x: this.vx * DT, y: this.vy * DT, z: this.vz * DT };
    if (this.shoveX !== 0 || this.shoveZ !== 0) {
      want.x += this.shoveX * DT;
      want.z += this.shoveZ * DT;
      this.shoveX = 0;
      this.shoveZ = 0;
    }
    this.kcc.computeColliderMovement(this.collider, want, undefined, undefined, (c) => !exclude(c));
    const mv = this.kcc.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.kcc.computedGrounded() && this.vy <= 0;
    if (this.grounded && this.vy < 0) this.vy = 0;
    // a wall takes the speed it stopped (a head-on crash halts it; a scrape keeps most of it)
    if (Math.abs(mv.x - want.x) + Math.abs(mv.z - want.z) > 1e-6) {
      const got = Math.sqrt(mv.x * mv.x + mv.z * mv.z) / DT;
      if (got < Math.abs(r.speed)) r.speed = r.speed < 0 ? -got : got;
      [this.vx, this.vz] = [mv.x / DT, mv.z / DT];
    }
    const p = this.body.translation();
    this.body.setNextKinematicTranslation({ x: p.x + mv.x, y: p.y + mv.y, z: p.z + mv.z });
    return { jumped: false, airJumped: false, landed: this.grounded && !wasGrounded };
  }

  /** Powered flight left, in ticks (a jetpack's fuel); ticks the head has been under water. */
  fuel = 0;
  under = 0;

  /** The stick as a unit-or-less vector (x, z). */
  #stick(input: InputFrame | null): [number, number] {
    let mx = (input?.wx ?? 0) / 127;
    let mz = (input?.wz ?? 0) / 127;
    const len = Math.sqrt(mx * mx + mz * mz);
    if (len > 1) ((mx /= len), (mz /= len));
    return [mx, mz];
  }

  /** Move by this tick's velocity through the KCC; grounded and ceiling handled as on foot. Returns the movement made. */
  #slide(exclude: (c: Collider) => boolean, ceiling: ((headY: number, up: number) => boolean) | null): { x: number; y: number; z: number } {
    const want = { x: this.vx * DT, y: this.vy * DT, z: this.vz * DT };
    if (this.shoveX !== 0 || this.shoveZ !== 0) {
      want.x += this.shoveX * DT;
      want.z += this.shoveZ * DT;
      this.shoveX = 0;
      this.shoveZ = 0;
    }
    this.kcc.computeColliderMovement(this.collider, want, undefined, undefined, (c) => !exclude(c));
    const mv = this.kcc.computedMovement();
    this.grounded = this.kcc.computedGrounded() && this.vy <= 0;
    if (this.grounded && this.vy < 0) this.vy = 0;
    if (ceiling && this.vy > 0 && mv.y < want.y - 1e-6) {
      const p0 = this.body.translation();
      if (ceiling(p0.y + PLAYER_HALF_HEIGHT + PLAYER_RADIUS, want.y + 0.02)) this.vy = 0;
    }
    const p = this.body.translation();
    this.body.setNextKinematicTranslation({ x: p.x + mv.x, y: p.y + mv.y, z: p.z + mv.z });
    return { x: mv.x, y: mv.y, z: mv.z };
  }

  /**
   * One tick with a jetpack (wings, a suit) in gravity: on the ground you walk, and holding jump
   * takes off; in the air under power, jump climbs at `climb` m/s, crouch dives, neither sinks
   * slowly, and the stick flies at full speed; every powered tick in the air burns one tick of
   * fuel, and landing fills it again. Out of fuel you fall as from a jump. Only + − × ÷ and sqrt.
   */
  fly(input: InputFrame | null, climb: number, fuelTicks: number, exclude: (c: Collider) => boolean, ceiling: (headY: number, up: number) => boolean): ControllerEvents {
    const btn = input?.btn ?? 0;
    this.#prevBtn = btn;
    const up = (btn & BTN.JUMP) !== 0;
    const down = (btn & BTN.DOWN) !== 0;
    const ev: ControllerEvents = { jumped: false, airJumped: false, landed: false };
    if (this.grounded) this.fuel = fuelTicks;
    const [mx, mz] = this.#stick(input);
    const tx = mx * this.laws.speed;
    const tz = mz * this.laws.speed;
    const powered = this.fuel > 0 && (!this.grounded || up);
    if (powered) {
      if (this.grounded) ((ev.jumped = true), (this.grounded = false), (this.jumpsUsed = 1));
      this.fuel--;
      const ty = up ? climb : down ? -Math.max(climb, DIVE) : -SINK;
      this.vy += (ty - this.vy) * FLY_K;
      this.vx += (tx - this.vx) * FLY_K;
      this.vz += (tz - this.vz) * FLY_K;
    } else if (this.grounded) {
      this.vx = tx;
      this.vz = tz;
    } else {
      const k = Math.min(1, this.laws.airControl * 0.15);
      this.vx += (tx - this.vx) * k;
      this.vz += (tz - this.vz) * k;
    }
    if (!powered && (!this.grounded || this.vy > 0)) this.vy = Math.max(-50, this.vy - this.#g * DT);
    const was = this.grounded;
    this.#slide(exclude, ceiling);
    if (this.grounded && !was) ev.landed = true;
    if (this.grounded) this.fuel = fuelTicks; // landed: full again
    return ev;
  }

  /**
   * The zero-g thrust law: no gravity; the velocity closes on where the stick, jump (up) and crouch
   * (down) point, at `speed`, by at most `thrust` m/s each second, so every course is a straight
   * line that speeds up and slows down. A suit with fuel (fuelTicks > 0) burns a tick of it for
   * each tick of thrust and fills up on landing; out of it, you drift. Bumping a wall stops you.
   */
  float(input: InputFrame | null, fuelTicks: number, exclude: (c: Collider) => boolean): ControllerEvents {
    const btn = input?.btn ?? 0;
    this.#prevBtn = btn;
    const ev: ControllerEvents = { jumped: false, airJumped: false, landed: false };
    if (this.grounded && fuelTicks > 0) this.fuel = fuelTicks;
    const [mx, mz] = this.#stick(input);
    const my = ((btn & BTN.JUMP) !== 0 ? 1 : 0) - ((btn & BTN.DOWN) !== 0 ? 1 : 0);
    let tx = mx * this.laws.speed;
    let ty = my * this.laws.speed;
    let tz = mz * this.laws.speed;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl > this.laws.speed) ((tx = (tx / tl) * this.laws.speed), (ty = (ty / tl) * this.laws.speed), (tz = (tz / tl) * this.laws.speed));
    let dx = tx - this.vx;
    let dy = ty - this.vy;
    let dz = tz - this.vz;
    const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const most = Math.max(1, this.laws.thrust) * DT;
    if (dl > most) ((dx = (dx / dl) * most), (dy = (dy / dl) * most), (dz = (dz / dl) * most));
    const burns = dl > 1e-6 && fuelTicks > 0;
    if (!burns || this.fuel > 0) {
      if (burns) this.fuel--;
      this.vx += dx;
      this.vy += dy;
      this.vz += dz;
    }
    const was = this.grounded;
    const want = { x: this.vx * DT, y: this.vy * DT, z: this.vz * DT };
    const mv = this.#slide(exclude, null);
    // a wall takes the velocity it stopped (no bouncing off into space)
    if (Math.abs(mv.x - want.x) > 1e-6) this.vx = mv.x / DT;
    if (Math.abs(mv.y - want.y) > 1e-6) this.vy = mv.y / DT;
    if (Math.abs(mv.z - want.z) > 1e-6) this.vz = mv.z / DT;
    if (this.grounded && !was) ev.landed = true;
    return ev;
  }

  /**
   * One tick in water whose surface is at `surface`: the stick swims at 60 % speed, jump rises,
   * crouch dives, and with neither you float up to the surface (your centre FLOAT_DEPTH under it);
   * a fresh jump press at the surface jumps out. Water drag closes the velocity gently, so a dive
   * from a height slows in the water. Breath is the world's to count (it knows the surface).
   */
  swim(input: InputFrame | null, surface: number, exclude: (c: Collider) => boolean, ceiling: (headY: number, up: number) => boolean): ControllerEvents {
    const btn = input?.btn ?? 0;
    const pressed = (btn & BTN.JUMP) !== 0 && (this.#prevBtn & BTN.JUMP) === 0;
    this.#prevBtn = btn;
    const up = (btn & BTN.JUMP) !== 0;
    const down = (btn & BTN.DOWN) !== 0;
    const ev: ControllerEvents = { jumped: false, airJumped: false, landed: false };
    const y = this.body.translation().y;
    const float = surface - FLOAT_DEPTH;
    const [mx, mz] = this.#stick(input);
    const s = this.laws.speed * SWIM_SPEED;
    this.vx += (mx * s - this.vx) * SWIM_K;
    this.vz += (mz * s - this.vz) * SWIM_K;
    if (pressed && y >= float - 0.3 && this.laws.jumpsMax > 0) {
      this.vy = this.#vJump;
      this.jumpsUsed = 1;
      ev.jumped = true;
    } else if (this.vy > SWIM_UP + 0.1) {
      this.vy -= this.#g * DT; // still flying up out of a jump
    } else {
      // (holding jump at the surface keeps you there: you swim, not fly)
      const rise = Math.min(1, Math.max(-1, (float - y) * 3));
      const ty = down ? -SWIM_DOWN : up ? Math.min(SWIM_UP, Math.max(rise, (float - y) * 6)) : rise;
      this.vy += (ty - this.vy) * SWIM_K;
    }
    const was = this.grounded;
    this.#slide(exclude, ceiling);
    if (this.grounded && !was) ev.landed = true;
    return ev;
  }

  /** Feet height above the capsule centre's floor contact. */
  static feetY(centreY: number): number {
    return centreY - PLAYER_HALF_HEIGHT - PLAYER_RADIUS;
  }
}

/** Launch straight up (jump pads): airborne now, and any remaining air jumps still count. */
export function launch(c: PlayerController, vy: number) {
  c.vy = vy;
  c.grounded = false;
  if (c.jumpsUsed === 0) c.jumpsUsed = 1;
}
