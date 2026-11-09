import { describe, expect, it } from "vitest";
import { cosDeg, stream, xxh32 } from "../src";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("xxh32", () => {
  it("matches the reference test vectors", () => {
    expect(xxh32(utf8(""), 0)).toBe(0x02cc5d05);
    expect(xxh32(utf8("abc"), 0)).toBe(0x32d153ff);
    expect(xxh32(utf8("Nobody inspects the spammish repetition"), 0)).toBe(0xe2293b2f);
  });
});

describe("stream", () => {
  it("is reproducible and independent per name", () => {
    const a1 = stream(42, "t3:runner:1");
    const a2 = stream(42, "t3:runner:1");
    const b = stream(42, "t3:runner:2");
    const xs = [a1(), a1(), a1()];
    expect([a2(), a2(), a2()]).toEqual(xs);
    expect(b()).not.toBe(xs[0]);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
  });
});

describe("cosDeg", () => {
  it("is the cosine to 1e-14 over a whole turn, without Math.cos in the simulation", () => {
    for (let d = -360; d <= 720; d += 7.5) expect(Math.abs(cosDeg(d) - Math.cos((d * Math.PI) / 180)), `${d}°`).toBeLessThan(1e-14);
    expect(cosDeg(0)).toBe(1);
    expect(cosDeg(180)).toBe(-1);
  });
});
