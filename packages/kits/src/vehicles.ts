// Vehicles and races: karts, cars, boats, snowmobiles, horses, all one arcade model with a
// different feel per kind (the sim drives it: the same input frame steers toward the stick, jump
// boosts), and a track that counts gates in order and laps. As with every kit, the verbs only
// produce events (a lap done); the world's rules turn them into wins and losses.
import type { Bound, VerbCtx, VerbPlugin } from "@ghostrun/plugin-api";

export const DRIVE = "vehicle.drive";
export const TRACK = "racing.track";

export const VEHICLE_KINDS = ["kart", "car", "buggy", "truck", "van", "boat", "snowmobile", "hovercraft", "bike", "horse"] as const;
export type VehicleKind = (typeof VEHICLE_KINDS)[number];

/**
 * How a vehicle feels: top speed (m/s), acceleration (m/s²), turn rate (rad/s), grip (how much of
 * its sideways slide it loses each tick: low drifts, a boat or a hovercraft), boost (× top speed),
 * boost seconds and cooldown. A walker runs at 6 m/s.
 */
export interface Feel {
  speed: number;
  accel: number;
  turn: number;
  grip: number;
  boost: number;
  boostS: number;
  cooldown: number;
}

export const FEEL: Record<VehicleKind, Feel> = {
  kart: { speed: 14, accel: 12, turn: 2.8, grip: 0.35, boost: 1.5, boostS: 1, cooldown: 4 },
  car: { speed: 18, accel: 10, turn: 2.2, grip: 0.3, boost: 1.4, boostS: 1.2, cooldown: 5 },
  buggy: { speed: 16, accel: 11, turn: 2.5, grip: 0.22, boost: 1.4, boostS: 1, cooldown: 4 },
  truck: { speed: 13, accel: 6, turn: 1.6, grip: 0.4, boost: 1.3, boostS: 1.5, cooldown: 6 },
  van: { speed: 14, accel: 7, turn: 1.8, grip: 0.35, boost: 1.3, boostS: 1.2, cooldown: 6 },
  boat: { speed: 12, accel: 6, turn: 1.8, grip: 0.08, boost: 1.5, boostS: 1.2, cooldown: 5 },
  snowmobile: { speed: 15, accel: 9, turn: 2.6, grip: 0.2, boost: 1.5, boostS: 1, cooldown: 4 },
  hovercraft: { speed: 14, accel: 8, turn: 2.6, grip: 0.05, boost: 1.5, boostS: 1, cooldown: 4 },
  bike: { speed: 17, accel: 12, turn: 3, grip: 0.35, boost: 1.4, boostS: 1, cooldown: 4 },
  horse: { speed: 11, accel: 9, turn: 3.2, grip: 0.5, boost: 1.4, boostS: 1.5, cooldown: 5 },
};

const kindOf = (s: string): VehicleKind => (VEHICLE_KINDS as readonly string[]).includes(s) ? (s as VehicleKind) : "car";

/**
 * A binding's feel: its kind's, with any number the fill gave instead (clamped). `given` is the
 * fill's own params (clamped params always carry a default, so they can't say what was given).
 */
export function feelOf(given: Readonly<Record<string, unknown>>, clamped: Readonly<Record<string, unknown>>): Feel & { kind: VehicleKind } {
  const kind = kindOf(String(clamped.kind));
  const f = { ...FEEL[kind] };
  for (const k of ["speed", "accel", "turn", "grip", "boost", "cooldown"] as const) if (given[k] !== undefined) f[k] = Number(clamped[k]);
  return { ...f, kind };
}

export const driveVerb: VerbPlugin = {
  id: DRIVE,
  line: 'on a vehicle (kind kart|car|buggy|truck|van|boat|snowmobile|hovercraft|bike|horse): USE next to it gets in, the stick steers, jump boosts; "driver" starts someone in it; params {"kind":"kart","speed":4-30,"driver":"player"}',
  on: ["vehicle", "prop"],
  params: {
    kind: { def: "car", one: VEHICLE_KINDS },
    speed: { def: 18, min: 4, max: 30 },
    accel: { def: 10, min: 2, max: 30 },
    turn: { def: 2.2, min: 0.8, max: 5 },
    grip: { def: 0.3, min: 0.02, max: 1 },
    boost: { def: 1.4, min: 1, max: 2.5 },
    cooldown: { def: 5, min: 1, max: 20 },
    driver: { def: "" },
  },
  body: "kinematic",
  // (getting in logs touch a=driver b=it, as using anything does: "when you get in the kart")
  use: {
    radius: 2.2,
    label: "drive",
    run(c, b, actor) {
      const r = c.riding(actor);
      if (r.vehicle === b.on) return r.speed < 2 && c.ride(actor, null); // out only when nearly stopped (a horn press at speed does nothing)
      if (r.vehicle) return false;
      return c.ride(actor, b.on);
    },
  },
};

/** Gate ids of a track binding, in order (the finish line is the binding's own entity). */
export const gatesOf = (b: Pick<Bound, "params">): string[] => String(b.params.gates ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** A racer's progress on a track: laps done, the next gate (gates.length: the finish line). */
export function progress(b: Bound, agent: string): { laps: number; next: number } {
  return { laps: Number(b.mem[`l:${agent}`] ?? 0), next: Number(b.mem[`n:${agent}`] ?? 0) };
}

export const trackVerb: VerbPlugin = {
  id: TRACK,
  line: 'on the start/finish line (a checkpoint sensor): racers pass the "gates" in order, then the line: lap_done (a=racer b=it n=laps so far); params {"gates":"cp_1,cp_2,cp_3","laps":1-10}',
  on: ["checkpoint", "goal", "plate", "prop"],
  params: { gates: { def: "" }, laps: { def: 3, min: 1, max: 10 } },
  body: "sensor",
  tick(c: VerbCtx, b: Bound) {
    const order = [...gatesOf(b).filter((id) => c.ent(id)), b.on];
    for (const a of c.agents()) {
      const at = Number(b.mem[`n:${a}`] ?? 0);
      const target = order[Math.min(at, order.length - 1)]!;
      const now = c.inside(a, target);
      const was = b.mem[`i:${a}`] === target;
      b.mem[`i:${a}`] = now ? target : "";
      if (!now || was) continue;
      // through the gate it was heading for: on to the next; through the line after them all, a lap
      if (at < order.length - 1) b.mem[`n:${a}`] = at + 1;
      else {
        const laps = Number(b.mem[`l:${a}`] ?? 0) + 1;
        b.mem[`l:${a}`] = laps;
        b.mem[`n:${a}`] = 0;
        c.emit("lap_done", a, b.on, laps);
      }
    }
  },
  produces: (b) => [{ k: "lap_done", a: "player", b: b.on, cause: { do: "drive", track: b.on } }],
};

export const VEHICLES: VerbPlugin[] = [driveVerb, trackVerb];
