import { describe, expect, it } from "vitest";
import { buildWorld, type World } from "../src/pipeline";
import { contextPrompt, lineageOf, lineText, MAX_LINEAGE, receiptsLine, receiptVersion, shareSource, type Lineage, type RemixSource } from "../src/remix";

const SPEC_A = "a".repeat(64);
const SPEC_B = "b".repeat(64);
const SHARE = "abcdefghijklmnop";

/** A world with these accepted edits (as editWorld leaves them on its source). */
function edited(...edits: string[]): World {
  const w = buildWorld("", "ctf");
  if (edits.length) w.source = { prompt: "", intent: null, fill: w.fill, seed: w.seed, pack: w.bundle.pack.id, base: "", edits };
  return w;
}

const gallery: RemixSource = { ref: "g:museum-heist", kind: "gallery", prompt: "A museum heist", spec: SPEC_A, line: null };

describe("a remix's line", () => {
  it("an untouched copy of an original is no remix; the first accepted edit makes it one", () => {
    expect(lineageOf(gallery, edited(), "")).toBeNull();
    expect(lineageOf(null, edited("make it night"), "")).toBeNull(); // your own world: an original
    expect(lineageOf(gallery, edited("make it night", "add three more coins"), "Tester")).toEqual({
      remixOf: "g:museum-heist",
      origin: { id: "g:museum-heist", prompt: "A museum heist", spec: SPEC_A },
      lineage: [
        { id: "g:museum-heist", change: "make it night", name: "Tester" },
        { id: "g:museum-heist", change: "add three more coins", name: "Tester" },
      ],
      changes: 2,
    });
  });

  it("a remix of a remix keeps the original at the top, adds its changes, and keeps the newest eight", () => {
    const first: Lineage = { remixOf: "g:museum-heist", origin: { id: "g:museum-heist", prompt: "A museum heist", spec: SPEC_A }, lineage: [{ id: "g:museum-heist", change: "make it night" }], changes: 1 };
    const src = shareSource(SHARE, { specHash: SPEC_B, prompt: "A museum heist", ...first });
    expect(src.line).toEqual(first);
    // shared again unchanged: the same line as before
    expect(lineageOf(src, edited(), "")).toEqual(first);
    const next = lineageOf(src, edited("lava floor"), "")!;
    expect(next.remixOf).toBe(SHARE);
    expect(next.origin.id).toBe("g:museum-heist");
    expect(next.lineage.map((s) => [s.id, s.change])).toEqual([
      ["g:museum-heist", "make it night"],
      [SHARE, "lava floor"],
    ]);
    const many = lineageOf(src, edited(...Array.from({ length: 10 }, (_, i) => `change ${i}`)), "")!;
    expect(many.lineage).toHaveLength(MAX_LINEAGE);
    expect(many.lineage.at(-1)!.change).toBe("change 9");
    expect(many.changes).toBe(11);
    // what the next edit is told was asked for: the original, then each change
    expect(contextPrompt(src)).toBe("A museum heist\nThen: make it night");
  });

  it("stores what was asked as one short line", () => {
    const l = lineageOf(gallery, edited(`make it\nnight ${"x".repeat(400)}`), "")!;
    expect(l.lineage[0]!.change).toMatch(/^make it night x+$/);
    expect(l.lineage[0]!.change.length).toBe(300);
  });

  it("a share record without a whole line is an original", () => {
    expect(shareSource(SHARE, { specHash: SPEC_A, prompt: "A plain world" })).toEqual({ ref: SHARE, kind: "share", prompt: "A plain world", spec: SPEC_A, line: null });
    expect(shareSource(SHARE, { specHash: SPEC_A, remixOf: SHARE }).line).toBeNull();
  });

  it("says where it came from, and which receipt is for which version", () => {
    const l = lineageOf(gallery, edited("make it night", "add three more coins"), "")!;
    expect(lineText(l)).toEqual({ from: "Remixed from “A museum heist”", changes: "2 changes: “make it night”, “add three more coins”" });
    const long = { ...l, lineage: [...l.lineage, { id: SHARE, change: "lava", name: "Tester" }, { id: SHARE, change: "fog" }], changes: 9 };
    expect(lineText(long).changes).toBe("9 changes: 6 earlier, then “add three more coins”, “lava” (Tester), “fog”");
    expect(lineText({ ...l, origin: { ...l.origin, prompt: "" } }).from).toBe("Remixed from a shared world");
    expect(receiptsLine(l, SPEC_B)).toBe("This version (spec bbbbbbbb) is the one AI runners are proving on your device now; the original (spec aaaaaaaa) has its own receipt, not this one.");
    expect(receiptsLine(l, SPEC_A)).toMatch(/^Only the looks changed: it plays the same as the original \(both spec aaaaaaaa\)/);
    expect(receiptVersion(l, SPEC_B)).toBe("Remix of “A museum heist” (2 changes): this receipt is for this version (spec bbbbbbbb) only; the original (spec aaaaaaaa) has its own.");
    expect(receiptVersion(null, SPEC_B)).toBeNull();
  });
});
