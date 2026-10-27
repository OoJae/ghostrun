import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFill } from "@ghostrun/ir";
import { cityBlock } from "@ghostrun/pack-city-block";
import { placeWorld } from "@ghostrun/layout";
import { buildNav } from "../src";
import { loadNavNode } from "../src/node";

const ctf = readFileSync(new URL("../../ir/fixtures/ctf-neon.jsonl", import.meta.url), "utf8");

beforeAll(async () => {
  await loadNavNode();
});

describe("navmesh on the CTF world", () => {
  it("connects spawn → orb → goal on foot, but not the rooftop lane", () => {
    const fill = parseFill(ctf, { seed: 7 });
    const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
    const world = placeWorld({ ...fill.draft, engine: "e".repeat(64) }, layout).bundle;
    const nav = buildNav(world);
    const at = (id: string) => world.entities.find((e) => e.id === id)!.pos;
    expect(nav.polys).toBeGreaterThan(10);
    expect(nav.path(at("sp_red"), at("orb"))).not.toBeNull();
    expect(nav.path(at("orb"), at("goal_red"))).not.toBeNull();
    const lane = world.statics.find((s) => s.surf === "ledge" && Math.abs(s.pos[0]) < 1)!;
    const laneTop: [number, number, number] = [lane.pos[0], lane.pos[1] + lane.size[1] / 2, lane.pos[2]];
    expect(nav.path(at("sp_red"), laneTop)).toBeNull(); // only a double jump gets you up there
    nav.destroy();
  });
});
