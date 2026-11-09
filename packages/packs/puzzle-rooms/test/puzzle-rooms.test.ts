import { beforeAll, describe, expect, it } from "vitest";
import { BUDGETS, DEFAULT_LAWS } from "@ghostrun/ir";
import { buildNav } from "@ghostrun/nav";
import { loadNavNode } from "@ghostrun/nav/node";
import { conformance, placeShell } from "@ghostrun/pack-common/conformance";
import type { PackLayout } from "@ghostrun/plugin-api";
import { puzzleRooms, PUZZLE_ROOMS_SCHEMA, SWITCH_Y } from "../src";

beforeAll(async () => {
  await loadNavNode();
});

const gen = (seed: number, params = puzzleRooms.defaults) => puzzleRooms.generate({ seed, params, sub: [], laws: DEFAULT_LAWS, harder: false });
const zone = (l: PackLayout, slot: string) => l.zones.find((z) => z.slot === slot)!;
const SPAWN = { spawn: { slot: "yard", anchor: "spawn_pad" } };
const PUZZLE = ["switch", "plate", "key", "lever", "chest"];

describe("puzzle_rooms pack", () => {
  it("conforms on 50 of 50 seeds, every chain length from 3 to 6 rooms", () => {
    const bad = puzzleRooms.ci.seeds.flatMap((seed) => {
      const params = { ...puzzleRooms.defaults, rooms: 3 + (seed % 4) };
      return conformance("puzzle_rooms", gen(seed, params), seed, SPAWN).map((p) => `seed ${seed} (${params.rooms} rooms): ${p}`);
    });
    expect(bad).toEqual([]);
  });

  it("conforms at the ends of its schema (8 seeds each)", () => {
    const bad: string[] = [];
    for (const end of ["min", "max"] as const) {
      const params = { rooms: PUZZLE_ROOMS_SCHEMA.rooms![end], size: PUZZLE_ROOMS_SCHEMA.size![end] };
      for (const seed of puzzleRooms.ci.seeds.slice(0, 8)) bad.push(...conformance("puzzle_rooms", gen(seed, params), seed, SPAWN).map((p) => `${end} seed ${seed}: ${p}`));
    }
    expect(bad).toEqual([]);
  });

  it("is one chain: each room's way in is the last one's way on, from the yard's front door to the exit yard", () => {
    for (const rooms of [3, 4, 5, 6]) {
      for (const seed of [1, 9, 23]) {
        const l = gen(seed, { ...puzzleRooms.defaults, rooms });
        expect(l.zones.map((z) => z.slot)).toEqual(["yard", ...Array.from({ length: rooms }, (_, i) => `room_${i + 1}`), "exit"]);
        expect(l.zones.length).toBeLessThanOrEqual(BUDGETS.zone);
        const yard = zone(l, "yard").anchors;
        expect(zone(l, "room_1").anchors.doorway_in![0]).toBe(yard.gate![0]);
        for (let k = 2; k <= rooms; k++) expect(zone(l, `room_${k}`).anchors.doorway_in).toEqual(zone(l, `room_${k - 1}`).anchors.doorway_out);
        expect(zone(l, `room_${rooms}`).anchors.doorway_out![0]).toBe(zone(l, "exit").anchors.gate![0]);
      }
    }
  });

  it("a gate in any doorway cuts the chain there: nothing past it is reachable on foot (20 seeds)", () => {
    for (const seed of puzzleRooms.ci.seeds.slice(0, 20)) {
      const rooms = 3 + (seed % 4);
      const l = gen(seed, { ...puzzleRooms.defaults, rooms });
      const cut = 1 + (seed % rooms); // the gate stands in this room's way on
      const b = placeShell("puzzle_rooms", l, seed, DEFAULT_LAWS, SPAWN.spawn);
      const d = zone(l, `room_${cut}`).anchors.doorway_out!;
      b.entities.push({ id: "gate", src: "ai", layer: "gameplay", kind: "door", zone: `z_room_${cut}`, anchor: "doorway_out", pos: [d[0], 1.05, d[2]], rotY: 0, size: [1, 2.1, 1], noun: "gate", hyper: "door", asset: "", body: "fixed", shape: "box", team: "", tags: [], states: [], init: "", props: {} });
      const nav = buildNav(b, { closed: ["gate"] });
      const from = zone(l, "yard").anchors.spawn_pad!;
      for (let k = 1; k <= rooms + 1; k++) {
        const there = k <= rooms ? zone(l, `room_${k}`).anchors.center! : zone(l, "exit").anchors.center!;
        expect(nav.path(from, there) !== null, `seed ${seed}: gate after room ${cut}, room ${k}`).toBe(k <= cut);
      }
      nav.destroy();
    }
  });

  it("every room has a switch on a wall, and a plate, key, lever and chest on the floor, a metre or more apart and clear of its doorways", () => {
    for (const seed of puzzleRooms.ci.seeds) {
      const l = gen(seed, { ...puzzleRooms.defaults, rooms: 3 + (seed % 4) });
      for (const z of l.zones.filter((x) => x.tag === "room")) {
        const a = z.anchors;
        expect(a.switch![1]).toBe(SWITCH_Y);
        for (const k of PUZZLE.slice(1)) expect(a[k]![1]).toBe(0);
        const spots = [...PUZZLE, "doorway_in", "doorway_out"].map((k) => [k, a[k]!] as const);
        for (const [i, [p, pa]] of spots.entries()) {
          for (const [q, qa] of spots.slice(i + 1)) {
            const d = Math.sqrt((pa[0] - qa[0]) * (pa[0] - qa[0]) + (pa[2] - qa[2]) * (pa[2] - qa[2]));
            expect(d, `seed ${seed} ${z.slot}: ${p} and ${q}`).toBeGreaterThanOrEqual(p === "switch" && q === "plate" ? 1.5 : 1.0);
          }
        }
      }
    }
  });

  it("is deterministic, differs across seeds, and keeps its anchor names", () => {
    const names = (l: PackLayout) => JSON.stringify(l.zones.map((z) => [z.slot, z.tag, Object.keys(z.anchors).sort()]));
    expect(JSON.stringify(gen(7))).toBe(JSON.stringify(gen(7)));
    expect(new Set(puzzleRooms.ci.seeds.map((s) => JSON.stringify(gen(s).statics))).size).toBe(puzzleRooms.ci.seeds.length);
    for (const seed of puzzleRooms.ci.seeds) expect(names(gen(seed))).toBe(names(gen(1)));
  });
});
