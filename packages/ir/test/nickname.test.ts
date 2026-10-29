import { describe, expect, it } from "vitest";
import { nickname } from "../src";

describe("best-times nicknames", () => {
  it("keeps 3 to 12 letters, digits and spaces, tidied", () => {
    expect(nickname("OoJae")).toEqual({ ok: true, name: "OoJae" });
    expect(nickname("  ana   b 2 ")).toEqual({ ok: true, name: "ana b 2" });
    expect(nickname("Jiří")).toEqual({ ok: true, name: "Jiří" }); // letters are any script's letters
    expect(nickname("Łukasz99").ok).toBe(true);
    expect(nickname("abc").ok).toBe(true);
    expect(nickname("abcdefghijkl").ok).toBe(true);
  });

  it("refuses the wrong length or anything but letters, digits and spaces", () => {
    expect(nickname("ab")).toEqual({ ok: false, why: "3 to 12 characters" });
    expect(nickname("abcdefghijklm")).toEqual({ ok: false, why: "3 to 12 characters" });
    expect(nickname("   ")).toEqual({ ok: false, why: "3 to 12 characters" });
    for (const bad of ["a_b_c", "<b>hi</b>", "x@y.com", "hey!", "semi;colon", "nul\u0000x", "emoji😀"]) expect(nickname(bad).ok).toBe(false);
    expect(nickname("tab\there")).toEqual({ ok: true, name: "tab here" }); // whitespace is tidied to one space
  });

  it("refuses swearwords and slurs, look-alike digits and spacing included, without catching ordinary names", () => {
    for (const bad of ["fuck", "Sh1tHead", "f u c k", "ass", "big ass", "B1TCH", "nazi99"]) expect(nickname(bad)).toEqual({ ok: false, why: "pick another name" });
    for (const fine of ["Cassie", "Grape", "Dickens", "Titan", "Sexton", "Bass Player", "Swank"]) expect(nickname(fine).ok).toBe(true);
  });
});
