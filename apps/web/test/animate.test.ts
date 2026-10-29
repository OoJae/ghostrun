// Which clip a character plays: the state chosen from motion alone, the gait blend, and the
// animator driving a small rig (the carry pose and an arm cue win over the gait's arms).
import { describe, expect, it } from "vitest";
import { AnimationClip, Bone, Object3D, Quaternion, QuaternionKeyframeTrack, Vector3 } from "three/webgpu";
import { Animator, armsPose, baseOf, gait, MOVE_MIN, RUN_SPEED, targets, upperBody, WALK_SPEED, type ClipNames, type Motion } from "../src/render/animate";

const still: Motion = { speed: 0, vy: 0, grounded: true, airTime: 0, carrying: false, ko: false, cheer: false };

describe("state from motion", () => {
  it("stands, moves, leaves the ground, falls and cheers", () => {
    expect(baseOf(still)).toBe("idle");
    expect(baseOf({ ...still, speed: 0.1 })).toBe("idle");
    expect(baseOf({ ...still, speed: 3 })).toBe("move");
    // a frame or two off a kerb is still walking; a real jump is in the air
    expect(baseOf({ ...still, speed: 3, grounded: false, airTime: 0.05 })).toBe("move");
    expect(baseOf({ ...still, grounded: false, airTime: 0.3, vy: 4 })).toBe("air");
    // without the simulation's word (the stub), vertical speed decides
    expect(baseOf({ ...still, grounded: null, vy: -6 })).toBe("air");
    expect(baseOf({ ...still, grounded: null, vy: -0.4 })).toBe("idle");
    // a knock-out beats everything; a cheer waits until it stands still
    expect(baseOf({ ...still, ko: true, speed: 5, grounded: false, airTime: 1 })).toBe("ko");
    expect(baseOf({ ...still, cheer: true })).toBe("cheer");
    expect(baseOf({ ...still, cheer: true, speed: 4 })).toBe("move");
  });

  it("blends idle into walk into run with speed, and plays them at the speed it moves", () => {
    for (const s of [0, 0.5, 1, 2, 3, 4, 6, 9]) {
      const g = gait(s);
      expect(g.idle + g.walk + g.run).toBeCloseTo(1, 6);
    }
    expect(gait(0).idle).toBe(1);
    expect(gait(MOVE_MIN / 2).idle).toBe(1);
    expect(gait(1.8).walk).toBe(1);
    expect(gait(6).run).toBe(1);
    expect(gait(3.3).walk).toBeGreaterThan(0);
    expect(gait(3.3).run).toBeGreaterThan(0);
    expect(gait(WALK_SPEED).walkRate).toBeCloseTo(1);
    expect(gait(RUN_SPEED).runRate).toBeCloseTo(1);
    // never a moonwalk, never a blur
    expect(gait(0.2).walkRate).toBeGreaterThanOrEqual(0.6);
    expect(gait(12).runRate).toBeLessThanOrEqual(1.5);
  });

  it("weights one action per state, or the gait for standing and moving", () => {
    expect(targets("air", 5)).toEqual({ idle: 0, walk: 0, run: 0, air: 1, ko: 0, cheer: 0 });
    expect(targets("ko", 0).ko).toBe(1);
    expect(targets("idle", 5).idle).toBe(1); // standing still is the idle, whatever the smoothed speed lags at
    const m = targets("move", 6);
    expect(m.run).toBe(1);
  });
});

// a two-bone rig: hips (legs' parent) and an upper arm, enough to tell the layers apart
function rig() {
  const root = new Object3D();
  const hips = new Bone();
  hips.name = "hips";
  const arm = new Bone();
  arm.name = "upperarml";
  root.add(hips);
  hips.add(arm);
  return { root, hips, arm };
}
const Z = new Vector3(0, 0, 1);
const turn = (deg: number) => new Quaternion().setFromAxisAngle(Z, (deg * Math.PI) / 180);
/** A clip that holds both bones at fixed angles (two keys, so it loops). */
const hold = (name: string, hipsDeg: number, armDeg: number) =>
  new AnimationClip(name, 1, [
    new QuaternionKeyframeTrack("hips.quaternion", [0, 1], [...turn(hipsDeg).toArray(), ...turn(hipsDeg).toArray()]),
    new QuaternionKeyframeTrack("upperarml.quaternion", [0, 1], [...turn(armDeg).toArray(), ...turn(armDeg).toArray()]),
  ]);
const angle = (q: Quaternion) => (2 * Math.atan2(q.z, q.w) * 180) / Math.PI;

const NAMES: ClipNames = {
  idle: "idle", walk: "walk", run: "run", air: "air", ko: "ko", cheer: "cheer",
  cues: { hit: "hit", use: "use", shoot: "shoot", punch: "punch" },
  carry: "cheer", carryAt: 0.5,
};
const clips = new Map(
  [hold("idle", 0, 0), hold("walk", 10, 10), hold("run", 20, 20), hold("air", 30, 30), hold("ko", 90, 0), hold("cheer", 0, 100), hold("hit", 0, -40), hold("use", 0, 60), hold("shoot", 0, 80), hold("punch", 0, 70)].map((c) => [c.name, c]),
);

describe("the animator", () => {
  it("takes an arm-only pose and an upper-body cut that leave the legs alone", () => {
    const pose = armsPose(clips.get("cheer")!, 0.5);
    expect(pose.tracks.map((t) => t.name)).toEqual(["upperarml.quaternion"]);
    expect(pose.duration).toBeGreaterThan(0);
    expect(upperBody(clips.get("hit")!).tracks.map((t) => t.name)).toEqual(["upperarml.quaternion"]);
  });

  it("eases from idle to run, raises the arms to carry, and flinches on a hit", () => {
    const { root, hips, arm } = rig();
    const a = new Animator(root, clips, NAMES);
    for (let i = 0; i < 60; i++) a.update(1 / 60, still);
    expect(angle(hips.quaternion)).toBeCloseTo(0, 0);
    for (let i = 0; i < 60; i++) a.update(1 / 60, { ...still, speed: 6 });
    expect(a.state).toBe("move");
    expect(angle(hips.quaternion)).toBeCloseTo(20, 0);
    // carrying overhead: the arms go up, the legs keep running
    for (let i = 0; i < 60; i++) a.update(1 / 60, { ...still, speed: 6, carrying: true });
    expect(angle(arm.quaternion)).toBeGreaterThan(80);
    expect(angle(hips.quaternion)).toBeCloseTo(20, 0);
    // a hit takes the arms for its length, then hands them back
    a.cue("hit");
    for (let i = 0; i < 20; i++) a.update(1 / 60, { ...still, speed: 6, carrying: true });
    expect(angle(arm.quaternion)).toBeLessThan(0);
    for (let i = 0; i < 90; i++) a.update(1 / 60, { ...still, speed: 6, carrying: true });
    expect(angle(arm.quaternion)).toBeGreaterThan(80);
  });

  it("drops at once on a knock-out and gets up again", () => {
    const { root, hips } = rig();
    const a = new Animator(root, clips, NAMES);
    a.update(1 / 60, still);
    a.update(1 / 60, { ...still, ko: true });
    expect(a.state).toBe("ko");
    expect(angle(hips.quaternion)).toBeCloseTo(90, 0);
    // no cue plays over a body on the floor
    a.cue("use");
    a.update(1 / 60, { ...still, ko: true });
    expect(angle(hips.quaternion)).toBeCloseTo(90, 0);
    for (let i = 0; i < 60; i++) a.update(1 / 60, still);
    expect(a.state).toBe("idle");
    expect(angle(hips.quaternion)).toBeCloseTo(0, 0);
  });
});
