import { describe, expect, it } from "vitest";
import { fmt, metricLabel } from "../src/metrics";
import { milestoneLabel } from "../src/outcomes";
import { niceRound } from "../src/templates";

describe("plain names", () => {
  it("labels known and unknown metrics", () => {
    expect(metricLabel("health.rhr")).toBe("Resting heart rate");
    expect(metricLabel("finance.side_income")).toBe("Side income");
  });
  it("formats by unit", () => {
    expect(fmt(4650, "USD")).toBe("$4,650");
    expect(fmt(-1200.4, "USD")).toBe("-$1,200");
    expect(fmt(60.34, "bpm", "health.rhr")).toBe("60 bpm");
    expect(fmt(7.46, "h", "health.sleep_h")).toBe("7.5 h");
    expect(fmt(9001, "count")).toBe("9,001");
  });
  it("milestone labels read like sentences", () => {
    expect(milestoneLabel({ id: "a", kind: "threshold", metric: "health.rhr", comparator: "<=", target: 60.3, due: "2027-01-01" })).toBe("Resting heart rate ≤ 60 bpm");
    expect(milestoneLabel({ id: "b", kind: "threshold", metric: "finance.emergency_fund", comparator: ">=", target: 12000, due: "2027-01-01" })).toBe("Emergency fund ≥ $12,000");
    expect(milestoneLabel({ id: "c", kind: "frequency", metric: "health.workouts", at_least: 3, for_weeks: 8, due: "2027-01-01" })).toBe("3+ workouts a week for 8 weeks");
    expect(milestoneLabel({ id: "d", kind: "cumulative", metric: "health.exercise_min", target: 3000, due: "2027-01-01" })).toBe("Exercise: 3,000 min total");
  });
  it("checkpoint values round to the metric's precision", () => {
    expect(niceRound(60.34, "bpm", "health.rhr")).toBe(60);
    expect(niceRound(83.33, "kg", "health.weight_kg")).toBe(83.3);
  });
});
