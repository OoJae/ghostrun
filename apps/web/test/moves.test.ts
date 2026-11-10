// Flying, swimming and floating in the app: which worlds get the up / dive controls, what the bars
// show from the sim's live moves, the volume pack's default looks by medium (words still win), and
// the game loop carrying a held Space and a held C into the simulation (the jetpack climbs, the
// diver goes under and the breath runs down).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadNavNode } from "@ghostrun/nav/node";
import { BTN, type Rapier } from "@ghostrun/sim";
import { loadRapierNode } from "@ghostrun/sim/node";
import { meters, movesOf, upDown } from "../src/moves";
import { buildWorld, FIXTURE_PROMPTS, FIXTURES } from "../src/pipeline";
import { cueOf, pickLook, volumeMedium, type Cue } from "../src/render/pick";
import { RapierSim } from "../src/sim/rapier";
import { BTN_DOWN, BTN_JUMP, BTN_USE } from "../src/sim/types";

const NEW = ["jetpack", "lagoon", "zero-g"];

describe("which worlds fly, swim or float", () => {
  it("only the three new fixtures get the extra controls; every older world gets none", () => {
    for (const k of Object.keys(FIXTURES)) if (!NEW.includes(k)) expect(movesOf(buildWorld("", k).bundle), k).toBeNull();
    expect(movesOf(buildWorld("", "jetpack").bundle)).toEqual({ fly: "jetpack", swim: false, zeroG: false });
    expect(movesOf(buildWorld("", "lagoon").bundle)).toEqual({ fly: "", swim: true, zeroG: false });
    expect(movesOf(buildWorld("", "zero-g").bundle)).toEqual({ fly: "", swim: false, zeroG: true });
    expect(movesOf(null)).toBeNull();
  });

  it("says what Space and C do: fly up / swim up and dive, or up and down in zero-g", () => {
    expect(upDown({ fly: "jetpack", swim: false, zeroG: false })).toEqual({ up: "fly up", down: "dive" });
    expect(upDown({ fly: "", swim: true, zeroG: false })).toEqual({ up: "swim up", down: "dive" });
    expect(upDown({ fly: "jetpack", swim: true, zeroG: false })).toEqual({ up: "fly up", down: "dive" });
    expect(upDown({ fly: "", swim: false, zeroG: true })).toEqual({ up: "up", down: "down" });
  });

  it("keeps the app's button bits the sim's", () => {
    expect([BTN_JUMP, BTN_USE, BTN_DOWN]).toEqual([BTN.JUMP, BTN.USE, BTN.DOWN]);
  });
});

describe("the fuel and breath bars", () => {
  const base = { mode: "walk" as const, kind: "", fuel: 0, fuelMax: 0, breath: 0, breathMax: 0 };
  it("shows fuel while flying on a tank and until it has filled again, never without a tank", () => {
    expect(meters(null)).toEqual({});
    expect(meters({ ...base, kind: "jetpack", fuel: 6, fuelMax: 6 })).toEqual({}); // standing, full
    expect(meters({ ...base, mode: "fly", kind: "jetpack", fuel: 4.5, fuelMax: 6 })).toEqual({ fuel: 0.75 });
    expect(meters({ ...base, mode: "fly", kind: "jetpack", fuel: 6, fuelMax: 6 })).toEqual({ fuel: 1 }); // just off the ground
    expect(meters({ ...base, kind: "jetpack", fuel: 3, fuelMax: 6 })).toEqual({ fuel: 0.5 }); // landed, refilling
    expect(meters({ ...base, mode: "float", kind: "suit" })).toEqual({}); // zero-g's thrust needs no fuel
    expect(meters({ ...base, mode: "fly", kind: "jetpack", fuel: -1, fuelMax: 6 })).toEqual({ fuel: 0 });
  });

  it("shows breath only with the head under water where a breath runs out", () => {
    expect(meters({ ...base, mode: "swim", breath: 20, breathMax: 20 })).toEqual({}); // swimming at the surface
    expect(meters({ ...base, mode: "swim", breath: 5, breathMax: 20 })).toEqual({ breath: 0.25 });
    expect(meters({ ...base, mode: "swim", breath: 0, breathMax: 0 })).toEqual({}); // no limit in this water
    expect(meters({ ...base, mode: "walk", breath: 5, breathMax: 20 })).toEqual({});
  });
});

describe("the volume pack's looks", () => {
  const cue = (medium: Cue["medium"], look = ""): Cue => ({ look, setting: "", names: "", weather: "clear", timeOfDay: 12, mood: [0, 0, 0], pack: "volume", medium });
  const label = (c: Cue) => {
    const p = pickLook(c);
    return `${p.id}${p.variant ? `/${p.variant}` : ""}`;
  };

  it("defaults by medium: the sky's islands a grove, the lagoon a beach, zero-g a space station", () => {
    expect(label(cue("sky"))).toBe("grove");
    expect(label(cue(undefined))).toBe("grove");
    expect(label(cue("water"))).toBe("desert/beach");
    expect(label(cue("space"))).toBe("space");
  });

  it("lets the words win as everywhere else", () => {
    expect(label(cue("sky", "candy floss clouds and lollipops"))).toBe("candy");
    expect(label(cue("water", "a haunted lagoon"))).toBe("haunted");
    expect(label(cue("space", "neon cyber station"))).toBe("neon");
    expect(label(cue("water", "a coral reef"))).toBe("desert/underwater");
  });

  it("reads the medium from the pack's sub-zone, only for the volume pack", () => {
    expect(volumeMedium(buildWorld("", "jetpack").bundle)).toBe("sky");
    expect(volumeMedium(buildWorld("", "lagoon").bundle)).toBe("water");
    expect(volumeMedium(buildWorld("", "zero-g").bundle)).toBe("space");
    expect(volumeMedium(buildWorld("", "ctf").bundle)).toBeNull();
    expect(cueOf(buildWorld("", "ctf").bundle)).not.toHaveProperty("medium");
    expect(cueOf(buildWorld("", "lagoon").bundle).medium).toBe("water");
  });

  it("gives the three fixtures their prompts and the look they ask for", () => {
    for (const k of NEW) expect(FIXTURE_PROMPTS[k], k).toBeTruthy();
    expect(label(cueOf(buildWorld("", "jetpack").bundle))).toBe("grove");
    expect(label(cueOf(buildWorld("", "lagoon").bundle))).toBe("desert/beach");
    expect(label(cueOf(buildWorld("", "zero-g").bundle))).toBe("space");
  });
});

describe("the game loop carries Space and C into the sim", () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await loadRapierNode();
    await loadNavNode();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Run the game's own loop for `ms` of (fake) time. */
  const run = (ms: number) => vi.advanceTimersByTime(ms);

  it("a held Space climbs on the jetpack and burns fuel; landing is the only refill", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    const game = new RapierSim(R, buildWorld("", "jetpack").bundle, false);
    game.start(() => {});
    const y0 = game.sim.pos("player")[1];
    expect(game.sim.moves("player")).toMatchObject({ kind: "jetpack", fuel: 6, fuelMax: 6 });
    game.input({ tick: 0, mx: 0, my: 0, yaw: game.spawnYaw, btn: BTN_JUMP });
    run(1500);
    const m = game.sim.moves("player")!;
    expect(game.sim.pos("player")[1]).toBeGreaterThan(y0 + 2.5);
    expect(m.mode).toBe("fly");
    expect(m.fuel).toBeLessThan(m.fuelMax);
    expect(meters(m).fuel).toBeGreaterThan(0);
    game.stop();
  });

  it("a held C dives under the lagoon, its frames carry the bit, and the breath runs down", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    const game = new RapierSim(R, buildWorld("", "lagoon").bundle, false);
    game.start(() => {});
    // forward from the spawn (it faces the chest, out over the water) until the lagoon
    game.input({ tick: 0, mx: 0, my: 1, yaw: game.spawnYaw, btn: 0 });
    for (let i = 0; i < 60 && game.sim.moves("player")!.mode !== "swim"; i++) run(100);
    expect(game.sim.moves("player")!.mode).toBe("swim");
    game.input({ tick: 0, mx: 0, my: 0, yaw: game.spawnYaw, btn: BTN_DOWN });
    run(1500);
    const m = game.sim.moves("player")!;
    expect(game.sim.pos("player")[1]).toBeLessThan(-2);
    expect(m.breathMax).toBe(20);
    expect(m.breath).toBeLessThan(20);
    expect(meters(m).breath).toBeGreaterThan(0);
    expect(game.inputs.some((f) => (f.btn & BTN.DOWN) !== 0)).toBe(true);
    game.stop();
  });

  it("in zero-g a held Space thrusts straight up", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
    const game = new RapierSim(R, buildWorld("", "zero-g").bundle, false);
    game.start(() => {});
    const y0 = game.sim.pos("player")[1];
    game.input({ tick: 0, mx: 0, my: 0, yaw: game.spawnYaw, btn: BTN_JUMP });
    run(1500);
    expect(game.sim.pos("player")[1]).toBeGreaterThan(y0 + 1.5);
    expect(game.sim.moves("player")!.mode).toBe("float");
    game.stop();
  });
});
