// The headset's pure parts: where a teleport may land (a walk must be able to take you there),
// that every panel's text is big enough where it is read, the panels' words, and that a shot aimed
// with a controller reaches the simulation as a quantised push in the recorded frame.
import { beforeAll, describe, expect, it } from "vitest";
import { BTN, type Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { buildWorld } from "../src/pipeline";
import type { Box } from "../src/sim/aabb";
import { RapierSim } from "../src/sim/rapier";
import { BTN_USE } from "../src/sim/types";
import { minFont, MIN_RAD } from "../src/xr/panel";
import { aimScore, PANELS } from "../src/xr/vr";
import { arc, reachable, type V3 } from "../src/xr/teleport";
import { scoreText } from "../src/xr/model";

const box = (min: V3, max: V3): Box => ({ min, max });
/** A 40 × 40 m floor whose top is at y = 0. */
const FLOOR = box([-20, -1, -20], [20, 0, 20]);
const feet: V3 = [0, 0, 0];
const hand: V3 = [0.2, 1.4, -0.3];
const level: V3 = [0, 0, -1];

describe("teleport", () => {
  it("lands a level arc on the floor about four metres ahead, and a walk can take you there", () => {
    const a = arc([FLOOR], [], hand, level, feet);
    expect(a.valid).toBe(true);
    expect(a.target![1]).toBe(0);
    expect(-a.target![2]).toBeGreaterThan(3.5);
    expect(-a.target![2]).toBeLessThan(5.5);
    expect(a.points.length).toBeGreaterThan(5);
  });

  it("stops at a wall: an arc into one goes nowhere", () => {
    const wall = box([-3, 0, -2.2], [3, 3, -2]);
    const a = arc([FLOOR, wall], [], hand, level, feet);
    expect(a.valid).toBe(false);
    expect(a.target).toBeNull();
  });

  it("lands on a ledge only a step up: higher than the autostep climbs is out of a walk's reach", () => {
    const step = box([-3, 0, -6], [3, 0.3, -3]);
    const ledge = box([-3, 0, -6], [3, 1.2, -3]);
    const up: V3 = [0, 0.35, -0.94];
    expect(arc([FLOOR, step], [], hand, up, feet).valid).toBe(true);
    const high = arc([FLOOR, ledge], [], hand, up, feet);
    expect(high.target?.[1]).toBe(1.2);
    expect(high.valid).toBe(false);
  });

  it("refuses a target across a wall, over a hole, or in lava", () => {
    expect(reachable([FLOOR], [], feet, [0, 0, -4])).toBe(true);
    const low = box([-3, 0, -2.1], [3, 1, -2]); // knee-high: the arc flies over it, a walk can't
    expect(reachable([FLOOR, low], [], feet, [0, 0, -4])).toBe(false);
    const split = [box([-20, -1, -20], [20, 0, -3]), box([-20, -1, -1], [20, 0, 20])]; // a 2 m gap
    expect(reachable(split, [], feet, [0, 0, -4])).toBe(false);
    expect(reachable([FLOOR], [box([-1, 0, -5], [1, 0.2, -3])], feet, [0, 0, -4])).toBe(false);
    expect(reachable([FLOOR], [], feet, [0, 0, -0.3])).toBe(false); // too near to be worth a blink
    expect(reachable([FLOOR], [], feet, [0, 0, -12])).toBe(false); // too far
  });
});

describe("grab", () => {
  const hand = [0.2, 1.5, 0];
  const level = [0, 0, -1];
  it("a hand held level points at the pickup on the floor ahead, not at one at its feet, to the side or overhead", () => {
    expect(aimScore(hand, level, [0.2, 0.25, -2.6])).not.toBeNull(); // 26° below the ray
    expect(aimScore(hand, level, [0.2, 0.25, -5])).not.toBeNull();
    expect(aimScore(hand, level, [0.2, 0.25, -1])).toBeNull(); // 51° down: look at it
    expect(aimScore(hand, level, [2.2, 0.25, -2])).toBeNull(); // 45° to the side
    expect(aimScore(hand, level, [0.2, 3.5, -2.6])).toBeNull(); // well over the ray
  });
  it("a hand pointed down at it reaches it, and the nearer of two in line wins", () => {
    expect(aimScore(hand, [0, -1, 0], [0.25, 0.2, 0.1])).not.toBeNull();
    expect(aimScore(hand, level, [0.2, 0.3, -2])!).toBeLessThan(aimScore(hand, level, [0.6, 0.3, -2])!);
  });
});

describe("panels", () => {
  it("every panel's smallest text covers at least 0.02 rad where the panel is read", () => {
    for (const [id, p] of Object.entries(PANELS)) {
      const mPerPx = p.width / p.px[0];
      expect(p.font, id).toBeGreaterThanOrEqual(minFont(mPerPx, p.at));
      expect((p.font * mPerPx) / p.at, id).toBeGreaterThanOrEqual(MIN_RAD);
    }
  });

  it("says the score as the desktop does", () => {
    expect(scoreText({ red: 0, blue: 0, result: null }, true, null, { found: 0, of: 0 })).toBe("");
    expect(scoreText({ red: 2, blue: 1, result: null }, true, 75, { found: 1, of: 3 })).toBe("RED 2 – 1 BLUE · 1:15 · ★ 1/3");
    expect(scoreText({ red: 3, blue: 0, result: "win" }, false, 10, { found: 0, of: 0 })).toBe("SCORE 3");
  });
});

describe("aim", () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await loadRapierNode();
  });

  // the zombie yard: the player's own blaster is the use in reach from the spawn
  for (const [aim, push] of [[undefined, [0, -25]], [Math.PI / 2, [-25, 0]]] as const) {
    it(`fires ${aim === undefined ? "where the camera looks" : "where the controller points"}: the press's push is in the logged frame`, async () => {
      const game = new RapierSim(R, buildWorld("", "zombies").bundle, false);
      game.start(() => undefined);
      // the camera looks down −z; the controller (when given) points down −x
      game.input({ tick: 1, mx: 0, my: 0, yaw: 0, btn: BTN_USE, ...(aim === undefined ? {} : { aim }) });
      await new Promise((r) => setTimeout(r, 100));
      game.stop();
      const press = game.inputs.find((f) => f.btn & BTN.USE)!;
      expect([press.wx + 0, press.wz + 0]).toEqual(push);
    });
  }
});
