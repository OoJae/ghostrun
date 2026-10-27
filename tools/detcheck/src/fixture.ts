import type { Rapier } from "./load";
import { hex32, xxh32 } from "./xxh32";

// sfc32: integer-only PRNG, identical on every engine. Setup must not use Math.sin/cos/random.
function sfc32(a: number, b: number, c: number, d: number) {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export interface FixtureResult {
  runtime: string;
  ticks: number;
  bodies: number;
  checkpoints: string[]; // chained hash every 100 ticks
  final: string;
  ms: number;
}

/**
 * Worst-case-ish S0 world: a static arena with walls and ramps, 240 mixed dynamic bodies dropped
 * into a pile (lots of contacts), and a kinematic character driven by a scripted input pattern
 * through KinematicCharacterController (the controller GHOSTRUN's player and runners use).
 */
export function runFixture(R: Rapier, ticks: number, runtime: string, now: () => number): FixtureResult {
  const t0 = now();
  const rand = sfc32(0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x12345678);
  const world = new R.World({ x: 0, y: -9.81, z: 0 });

  const fixed = world.createRigidBody(R.RigidBodyDesc.fixed());
  world.createCollider(R.ColliderDesc.cuboid(30, 0.5, 30).setTranslation(0, -0.5, 0), fixed);
  world.createCollider(R.ColliderDesc.cuboid(30, 3, 0.5).setTranslation(0, 3, 30), fixed);
  world.createCollider(R.ColliderDesc.cuboid(30, 3, 0.5).setTranslation(0, 3, -30), fixed);
  world.createCollider(R.ColliderDesc.cuboid(0.5, 3, 30).setTranslation(30, 3, 0), fixed);
  world.createCollider(R.ColliderDesc.cuboid(0.5, 3, 30).setTranslation(-30, 3, 0), fixed);
  // Ramps: rotations given as precomputed unit quaternions (no trig at setup).
  world.createCollider(
    R.ColliderDesc.cuboid(4, 0.25, 2).setTranslation(8, 1, 0).setRotation({ x: 0, y: 0, z: 0.25881904510252074, w: 0.9659258262890683 }),
    fixed,
  );
  world.createCollider(
    R.ColliderDesc.cuboid(4, 0.25, 2).setTranslation(-8, 1, 6).setRotation({ x: 0.17364817766693033, y: 0, z: 0, w: 0.984807753012208 }),
    fixed,
  );

  const bodies: InstanceType<Rapier["RigidBody"]>[] = [];
  for (let i = 0; i < 240; i++) {
    const x = (rand() - 0.5) * 16;
    const z = (rand() - 0.5) * 16;
    const y = 2 + i * 0.35;
    const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, y, z));
    const k = i % 3;
    const desc =
      k === 0
        ? R.ColliderDesc.cuboid(0.25 + rand() * 0.3, 0.25 + rand() * 0.3, 0.25 + rand() * 0.3)
        : k === 1
          ? R.ColliderDesc.ball(0.2 + rand() * 0.3)
          : R.ColliderDesc.capsule(0.2 + rand() * 0.3, 0.15 + rand() * 0.2);
    world.createCollider(desc.setFriction(0.4 + rand() * 0.5).setRestitution(rand() * 0.3), body);
    bodies.push(body);
  }

  // Player: kinematic capsule moved by the character controller.
  const player = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(-12, 1.2, -12));
  const playerCollider = world.createCollider(R.ColliderDesc.capsule(0.5, 0.35), player);
  const controller = world.createCharacterController(0.01);
  controller.enableAutostep(0.4, 0.2, true);
  controller.enableSnapToGround(0.3);
  controller.setApplyImpulsesToDynamicBodies(true);
  bodies.push(player);

  const dt = 1 / 60;
  let vy = 0;
  const buf = new Float64Array(bodies.length * 10);
  const bytes = new Uint8Array(buf.buffer);
  let chain = 0;
  const checkpoints: string[] = [];

  for (let tick = 1; tick <= ticks; tick++) {
    // Scripted input: square-wave walk pattern + jump every 90 ticks (pure integer arithmetic).
    const phase = Math.floor(tick / 120) % 4;
    const sx = phase === 0 ? 1 : phase === 2 ? -1 : 0;
    const sz = phase === 1 ? 1 : phase === 3 ? -1 : 0;
    if (tick % 90 === 0 && controller.computedGrounded()) vy = 6;
    vy -= 9.81 * dt;
    controller.computeColliderMovement(playerCollider, { x: sx * 5 * dt, y: vy * dt, z: sz * 5 * dt });
    const mv = controller.computedMovement();
    if (controller.computedGrounded() && vy < 0) vy = 0;
    const p = player.translation();
    player.setNextKinematicTranslation({ x: p.x + mv.x, y: p.y + mv.y, z: p.z + mv.z });

    world.step();

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]!;
      const t = b.translation();
      const r = b.rotation();
      const v = b.linvel();
      const o = i * 10;
      buf[o] = t.x; buf[o + 1] = t.y; buf[o + 2] = t.z;
      buf[o + 3] = r.x; buf[o + 4] = r.y; buf[o + 5] = r.z; buf[o + 6] = r.w;
      buf[o + 7] = v.x; buf[o + 8] = v.y; buf[o + 9] = v.z;
    }
    for (let j = 0; j < buf.length; j++) {
      const x = buf[j]!;
      if (x !== x) throw new Error(`NaN in state at tick ${tick}`);
      if (x === 0) buf[j] = 0; // canonicalize -0
    }
    chain = xxh32(bytes, chain);
    if (tick % 100 === 0) checkpoints.push(hex32(chain));
  }
  world.free();
  return { runtime, ticks, bodies: bodies.length, checkpoints, final: hex32(chain), ms: Math.round(now() - t0) };
}
