// A jump claim broken by the things on the way: with fewer jumps the roof is reached over a crate
// stack, and the counterexample says so, with the highest single step of that climb (never the
// straight rise from the street, which is higher than the jump).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFill, type WorldBundle } from "@ghostrun/ir";
import { placeWorld } from "@ghostrun/layout";
import { cityBlock } from "@ghostrun/pack-city-block";
import { surfaces, t1 } from "../src/t1";

const ctf = readFileSync(new URL("../../ir/fixtures/ctf-neon.jsonl", import.meta.url), "utf8");
const ENGINE = "e".repeat(64);

function world(): WorldBundle {
  const fill = parseFill(ctf, { seed: 7 });
  const layout = cityBlock.generate({ seed: 7, params: cityBlock.defaults, sub: fill.draft.pack.sub, laws: fill.draft.laws, harder: false });
  return placeWorld({ ...fill.draft, engine: ENGINE }, layout).bundle;
}

describe("T1 on a jump claim reached with fewer jumps", () => {
  it("names what the climb goes over and its highest step", () => {
    const b = world();
    const x = b.expects.find((e) => e.id === "x_roof")!;
    expect(t1(b, b.laws).find((c) => c.id === "T1:x_roof")?.status).toBe("verified");
    // a crate stack against the lowest roof of the lane, half its height: one jump to the crates, one to the roof
    const ss = surfaces(b);
    const roof = ss.filter((s) => s.zone === x.b).sort((p, q) => p.top - q.top)[0]!;
    const ground = 0;
    const h = (roof.top - ground) / 2;
    const like = b.entities.find((e) => e.body === "fixed")!;
    b.entities.push({ ...like, id: "crates", noun: "stack of crates", kind: "prop", body: "fixed", shape: "box", pos: [roof.min[0] - 0.5, ground + h / 2, (roof.min[1] + roof.max[1]) / 2], size: [1, h, 1.6] } as (typeof b.entities)[number]);
    const chip = t1(b, b.laws).find((c) => c.id === "T1:x_roof")!;
    expect(chip.status).toBe("counterexample");
    expect(chip.cx!.text).toMatch(/^reachable with 1 jump by way of the stack of crates: highest step [\d.]+ m, apex [\d.]+ m$/);
    expect(chip.cx!.need).toBeLessThanOrEqual(chip.cx!.have); // the step it names is one the jump clears
  });
});
