// The models' quality tier: on by default, a lighter layer on phones and in VR, off with ?models=0.
import { describe, expect, it } from "vitest";
import { modelTier } from "../src/render/models";

describe("modelTier", () => {
  it("is full on a desktop, lite on a touch screen or in VR, and off when asked", () => {
    expect(modelTier("", false)).toBe("full");
    expect(modelTier("?fixture=zombies", true)).toBe("lite");
    expect(modelTier("?gl=webgl2&vr=1", false)).toBe("lite");
    expect(modelTier("?models=0", false)).toBe("off");
    expect(modelTier("?models=off", true)).toBe("off");
    expect(modelTier("?models=lite", false)).toBe("lite");
    // asked for in full, a phone gets it
    expect(modelTier("?models=1", true)).toBe("full");
  });
});
