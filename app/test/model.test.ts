import { describe, expect, it } from "vitest";
import { manualSnapshot, type Snapshot, summarize } from "../src/model";

const snap = (source: string, at: string, pts: [string, string, number][], kind: "auto" | "manual" = "auto"): Snapshot =>
  ({ v: 1, source, kind, ingested_at: at, points: pts.map(([metric, t, value]) => ({ metric, t, value, unit: "u" })) });

describe("summarize", () => {
  const now = "2026-11-13";

  it("groups by metric, sorts by day, latest ingest wins per day", () => {
    const s = summarize([
      snap("apple_health", "2026-11-12T21:00:00Z", [["health.rhr", "2026-11-12", 60]]),
      snap("apple_health", "2026-11-11T21:00:00Z", [["health.rhr", "2026-11-11", 62]]),
      snap("apple_health", "2026-11-12T22:00:00Z", [["health.rhr", "2026-11-12", 58]]), // resend
    ], now);
    expect(s).toHaveLength(1);
    expect(s[0].series.map((p) => p.value)).toEqual([62, 58]);
    expect(s[0].latest.value).toBe(58);
    expect(s[0].stale).toBe(false);
  });

  it("flags stale auto sources, never manual ones", () => {
    const s = summarize([
      snap("apple_health", "2026-11-01T21:00:00Z", [["health.steps", "2026-11-01", 9000]]),
      snap("manual", "2026-10-01T00:00:00Z", [["finance.ef", "2026-10-01", 5000]], "manual"),
    ], now);
    expect(s.find((m) => m.metric === "health.steps")!.stale).toBe(true);
    expect(s.find((m) => m.metric === "finance.ef")!.stale).toBe(false);
  });

  it("drops malformed points", () => {
    const bad = { v: 1, source: "x", kind: "auto", ingested_at: "z", points: [{ metric: "NoDot", t: "2026-01-01", value: 1, unit: "" }, { metric: "a.b", t: "2026-01-01", value: NaN, unit: "" }] } as Snapshot;
    expect(summarize([bad, null as unknown as Snapshot], now)).toEqual([]);
  });
});

describe("manualSnapshot", () => {
  it("validates", () => {
    expect(manualSnapshot("finance.emergency_fund", 1200, "USD", "2026-11-13").points[0].value).toBe(1200);
    expect(() => manualSnapshot("emergency", 1, "USD", "2026-11-13")).toThrow();
    expect(() => manualSnapshot("a.b", NaN, "USD", "2026-11-13")).toThrow();
    expect(() => manualSnapshot("a.b", 1, "<script>", "2026-11-13")).toThrow();
  });
});
