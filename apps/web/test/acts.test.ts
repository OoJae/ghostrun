import { describe, expect, it } from "vitest";
import { acceptsOf, icsFor, slotInstant, slotWords } from "../src/acts";
import { buildWorld } from "../src/pipeline";

describe("speech acts on the client", () => {
  it("what each character accepts is read off the world's rules: the guard's price and the option it earns, the agent's bookings", () => {
    expect(acceptsOf(buildWorld("", "museum").bundle, "guard")).toEqual([{ act: "offer", what: "coins", n: 20, gives: "guard.look_away" }]);
    expect(acceptsOf(buildWorld("", "villa").bundle, "guide")).toEqual([{ act: "book", what: "", n: 0, gives: "" }]);
    expect(acceptsOf(buildWorld("", "ctf").bundle, "rival_1")).toEqual([]);
  });

  it("a slot is a wall time in the reader's zone, across a clock change too", () => {
    expect(new Date(slotInstant("2026-11-07T15:00", "Europe/Prague")!).toISOString()).toBe("2026-11-07T14:00:00.000Z"); // CET
    expect(new Date(slotInstant("2026-07-04T15:00", "Europe/Prague")!).toISOString()).toBe("2026-07-04T13:00:00.000Z"); // CEST
    expect(new Date(slotInstant("2026-11-07T15:00", "America/New_York")!).toISOString()).toBe("2026-11-07T20:00:00.000Z");
    expect(slotWords("2026-11-07T15:00", "Europe/Prague", "en-GB")).toBe("Saturday 7 November, 15:00");
  });

  it("the booking's calendar file: an hour from the slot with a TZID and its offset, the world's words, nothing about the person", () => {
    const ics = icsFor({ tick: 900, with: "guide", what: "Viewing at Villa Aurelia", slot: "2026-11-07T15:00" }, "Europe/Prague", "estate agent", Date.UTC(2026, 10, 3, 9, 30), "test-uid@ghostrun")!;
    const lines = ics.split("\r\n");
    expect(lines).toContain("DTSTART;TZID=Europe/Prague:20261107T150000");
    expect(lines).toContain("DTEND;TZID=Europe/Prague:20261107T160000");
    expect(lines).toContain("TZOFFSETTO:+0100");
    expect(lines).toContain("SUMMARY:Viewing at Villa Aurelia");
    expect(lines).toContain("DTSTAMP:20261103T093000Z");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).not.toMatch(/ORGANIZER|ATTENDEE|MAILTO|@(?!ghostrun)/i);
    expect(lines.every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(icsFor({ tick: 1, with: "guide", what: "x", slot: "" }, "Europe/Prague", "agent")).toBe(null);
  });
});
