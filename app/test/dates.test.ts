import { describe, expect, it } from "vitest";
import { relDays, shortDate } from "../src/dates";

const T = "2026-11-14";
describe("friendly dates", () => {
  it("short dates", () => {
    expect(shortDate("2026-11-14", T)).toBe("today");
    expect(shortDate("2026-11-15", T)).toBe("tomorrow");
    expect(shortDate("2026-11-13", T)).toBe("yesterday");
    expect(shortDate("2026-12-25", T)).toBe("Dec 25");
    expect(shortDate("2027-02-14", T)).toBe("Feb 14, 2027");
  });
  it("relative spans", () => {
    expect(relDays("2026-11-20", T)).toBe("in 6 days");
    expect(relDays("2026-12-14", T)).toBe("in 4 weeks");
    expect(relDays("2027-05-14", T)).toBe("in 6 months");
    expect(relDays("2029-11-14", T)).toBe("in 3 years");
    expect(relDays("2026-11-13", T)).toBe("1 day ago");
  });
});
