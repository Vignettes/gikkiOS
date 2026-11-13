import { describe, expect, it } from "vitest";
import { dayNum, dayStr, weekStart } from "../src/dates";
import { evaluateMilestone, evaluateOutcome, type SeriesIndex, slope, smoothSeries } from "../src/engine";
import type { SeriesPoint } from "../src/model";
import type { Milestone, Outcome } from "../src/outcomes";

const TODAY = "2026-11-13";
const pts = (metric: string, rows: [string, number][], kind: "auto" | "manual" = "manual", unit = "USD"): SeriesPoint[] =>
  rows.map(([t, value]) => ({ metric, t, value, unit, source: kind === "auto" ? "apple_health" : "manual", kind, ingested_at: `${t}T21:00:00Z` }));
const outcome = (milestones: Milestone[], start = "2026-08-01"): Outcome =>
  ({ id: "o1", title: "T", why: "", category: "finance", start, horizon: "2027-12-31", milestones });
const ef = pts("finance.ef", [["2026-08-01", 1000], ["2026-09-01", 2000], ["2026-10-01", 3000], ["2026-11-01", 4000]]);
const idx = (...series: SeriesPoint[][]): SeriesIndex => new Map(series.map((s) => [s[0].metric, s]));
const th = (target: number, due = "2027-06-30", comparator: ">=" | "<=" = ">=", metric = "finance.ef"): Milestone =>
  ({ id: "m", kind: "threshold", metric, comparator, target, due });
const ev = (m: Milestone, i: SeriesIndex, o = outcome([m])) => evaluateMilestone(m, o, i, TODAY);

describe("helpers", () => {
  it("slope and smoothing", () => {
    expect(slope([{ d: 0, v: 0 }, { d: 10, v: 20 }])).toBeCloseTo(2);
    expect(slope([{ d: 5, v: 1 }])).toBeUndefined();
    const s = smoothSeries(pts("a.b", [["2026-01-01", 10], ["2026-01-02", 20], ["2026-01-10", 30]]), 3);
    expect(s.map((p) => p.v)).toEqual([10, 15, 30]);
  });
  it("ISO weeks start Monday", () => {
    expect(dayStr(weekStart(dayNum(TODAY)))).toBe("2026-11-09");
    expect(dayStr(weekStart(dayNum("2026-11-09")))).toBe("2026-11-09");
    expect(dayStr(weekStart(dayNum("2026-11-08")))).toBe("2026-11-02");
  });
});

describe("threshold", () => {
  it("on track / at risk / off track by projected pace", () => {
    expect(ev(th(11000), idx(ef)).status).toBe("on_track");
    const risk = ev(th(12000), idx(ef));          // projects ≈ 11.9k of 12k
    expect(risk.status).toBe("at_risk");
    const off = ev(th(20000), idx(ef));
    expect(off.status).toBe("off_track");
    expect(off.hint).toMatch(/Needs \+\$[\d,]+\/mo \(now \+\$[\d,]+\/mo\), or move the date to/);
    expect(off.progress).toBeCloseTo(3000 / 19000);
  });
  it("downward targets (debt)", () => {
    const debt = pts("finance.debt", [["2026-09-01", 6000], ["2026-10-01", 5000], ["2026-11-01", 4000]]);
    expect(ev(th(0, "2027-03-31", "<=", "finance.debt"), idx(debt)).status).toBe("on_track");
    expect(ev(th(0, "2026-12-31", "<=", "finance.debt"), idx(debt)).status).toBe("off_track");
  });
  it("trend moving the wrong way", () => {
    const down = pts("finance.ef", [["2026-10-01", 5000], ["2026-11-01", 4000]]);
    const e = ev(th(10000), idx(down));
    expect(e.status).toBe("off_track");
    expect(e.hint).toMatch(/wrong way/);
  });
  it("achieved, missed, no data, single reading", () => {
    expect(ev(th(4000), idx(ef)).status).toBe("achieved");
    expect(ev(th(9000, "2026-11-01"), idx(ef)).status).toBe("missed");
    expect(ev(th(9000), new Map()).status).toBe("no_data");
    expect(ev(th(9000), idx(pts("finance.ef", [["2026-11-01", 1]]))).status).toBe("no_data");
  });
  it("stale auto source", () => {
    const rhr = pts("health.rhr", [["2026-10-20", 64], ["2026-10-27", 62], ["2026-11-01", 61]], "auto", "bpm");
    expect(ev(th(55, "2027-06-30", "<=", "health.rhr"), idx(rhr)).status).toBe("stale");
  });
  it("smoothing damps noise", () => {
    const rows: [string, number][] = [];
    for (let d = 1; d <= 13; d++) rows.push([`2026-11-${String(d).padStart(2, "0")}`, 80 - d * 0.1 + (d % 2 ? 1.5 : -1.5)]);
    const w = pts("health.weight_kg", rows, "auto", "kg");
    const m: Milestone = { ...th(78.5, "2027-02-01", "<=", "health.weight_kg"), smooth: 7 } as Milestone;
    const e = ev(m, idx(w));
    expect(e.current).toBeGreaterThan(78.5); // raw last point (78.2) would have falsely "achieved"
    expect(e.status).not.toBe("achieved");
  });
});

describe("cumulative", () => {
  const mins = pts("health.exercise_min", Array.from({ length: 13 }, (_, i) => [`2026-11-${String(i + 1).padStart(2, "0")}`, 30] as [string, number]), "auto", "min");
  const m = (target: number): Milestone => ({ id: "c", kind: "cumulative", metric: "health.exercise_min", target, due: "2026-11-30", start: "2026-11-01" });
  it("projects the running total", () => {
    expect(ev(m(1000), idx(mins)).status).toBe("at_risk");   // 390 in 13d → 900 projected
    expect(ev(m(800), idx(mins)).status).toBe("on_track");
    expect(ev(m(2000), idx(mins)).status).toBe("off_track");
    expect(ev(m(300), idx(mins)).status).toBe("achieved");
  });
});

describe("frequency", () => {
  const start = "2026-10-19"; // Monday
  const w = (rows: [string, number][]) => idx(pts("health.workouts", rows, "auto", "count"));
  const m = (forWeeks: number, due = "2027-01-31"): Milestone => ({ id: "f", kind: "frequency", metric: "health.workouts", at_least: 3, for_weeks: forWeeks, due });
  const three = (mon: string): [string, number][] => [[mon, 1], [dayStr(dayNum(mon) + 2), 1], [dayStr(dayNum(mon) + 4), 1]];
  const base = [...three("2026-10-19"), ...three("2026-10-26"), ...three("2026-11-02")];

  it("tracks a live streak and this week's remainder", () => {
    const e = evaluateMilestone(m(8), outcome([m(8)], start), w([...base, ["2026-11-10", 1]]), TODAY);
    expect(e.status).toBe("on_track");
    expect(e.summary).toMatch(/This week 1 of 3 · streak 3\/8/);
    expect(e.hint).toMatch(/2 more this week/);
  });
  it("achieves when this week completes the streak", () => {
    const e = evaluateMilestone(m(4), outcome([m(4)], start), w([...base, ...three("2026-11-09")]), TODAY);
    expect(e.status).toBe("achieved");
  });
  it("at risk after a missed week; off track if no longer feasible", () => {
    const missed = [...three("2026-10-19"), ...three("2026-10-26")]; // nothing week of 11-02
    expect(evaluateMilestone(m(4), outcome([m(4)], start), w(missed), TODAY).status).toBe("at_risk");
    const late = evaluateMilestone(m(8, "2026-12-06"), outcome([m(8, "2026-12-06")], start), w(missed), TODAY);
    expect(late.status).toBe("off_track");
    expect(late.hint).toMatch(/move the date/);
  });
});

describe("boolean & rollup", () => {
  const b = (due: string, done = false): Milestone => ({ id: `b${due}`, kind: "boolean", title: "Do it", due, done });
  it("boolean status by due date", () => {
    expect(ev(b("2027-03-01"), new Map()).status).toBe("on_track");
    expect(ev(b("2026-11-20"), new Map()).status).toBe("at_risk");
    expect(ev(b("2026-11-01"), new Map()).status).toBe("missed");
    expect(ev(b("2026-11-01", true), new Map()).status).toBe("achieved");
  });
  it("outcome rolls up open milestones by weight", () => {
    const o = outcome([b("2026-10-01", true), th(11000), { ...th(40000, "2027-12-31"), id: "m2", weight: 3 } as Milestone]);
    const e = evaluateOutcome(o, idx(ef), TODAY);
    expect(e.status).toBe("off_track");           // open only: (1·1 + 0·3)/4 = .25
    expect(e.next?.milestone.id).toBe("m");       // earliest unachieved
    const ok = evaluateOutcome(outcome([b("2026-10-01", true), th(11000)]), idx(ef), TODAY);
    expect(ok.status).toBe("on_track");
    expect(evaluateOutcome(outcome([b("2026-10-01", true)]), idx(ef), TODAY).status).toBe("achieved");
    expect(evaluateOutcome(outcome([th(9000)]), new Map(), TODAY).status).toBe("no_data");
  });
});
