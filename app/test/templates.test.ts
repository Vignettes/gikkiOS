import { describe, expect, it } from "vitest";
import { validateOutcome } from "../src/outcomes";
import { checkpointDates, fromTemplate, niceRound, TEMPLATES } from "../src/templates";

const T = (id: string) => TEMPLATES.find((t) => t.id === id)!;

describe("templates", () => {
  it("checkpoint cadence scales with horizon", () => {
    expect(checkpointDates("2026-11-13", "2027-02-13")).toEqual(["2026-12-13", "2027-01-13"]);
    expect(checkpointDates("2026-11-13", "2027-11-13")).toEqual(["2027-02-13", "2027-05-13", "2027-08-13"]);
    expect(checkpointDates("2026-11-13", "2029-11-13").length).toBe(5);
  });
  it("emergency fund: one goal with a checkpoint path, plus tasks", () => {
    const o = fromTemplate(T("emergency_fund"), { target: 12000, current: 2000, horizon: "2027-11-13", checkpoints: true, start: "2026-11-13" });
    const th = o.milestones.filter((m) => m.kind === "threshold");
    expect(th).toHaveLength(1);
    expect(th[0]).toMatchObject({ target: 12000, weight: 2, checkpoints: [
      { due: "2027-02-13", target: 4500 }, { due: "2027-05-13", target: 7000 }, { due: "2027-08-13", target: 9500 }] });
    expect(o.milestones.some((m) => m.kind === "boolean")).toBe(true);
    expect(validateOutcome(o)).toEqual([]);
  });
  it("weight infers direction", () => {
    const down = fromTemplate(T("weight"), { target: 80, current: 90, horizon: "2027-05-13", checkpoints: false, start: "2026-11-13" });
    expect(down.milestones[0]).toMatchObject({ comparator: "<=", target: 80, smooth: 7 });
    const up = fromTemplate(T("weight"), { target: 70, current: 65, horizon: "2027-05-13", checkpoints: false, start: "2026-11-13" });
    expect(up.milestones[0]).toMatchObject({ comparator: ">=" });
  });
  it("habit and cumulative templates are valid", () => {
    for (const id of ["workouts", "exercise_minutes"]) {
      expect(validateOutcome(fromTemplate(T(id), { target: 3000, horizon: "2027-02-13", checkpoints: true, start: "2026-11-13" }))).toEqual([]);
    }
  });
  it("rounds sensibly", () => {
    expect(niceRound(4523.3, "USD")).toBe(4500);
    expect(niceRound(83.33, "kg")).toBe(83.3);
  });
  it("validation catches bad input", () => {
    const o = fromTemplate(T("sleep"), { target: 7.5, current: 6.5, horizon: "2027-02-13", checkpoints: false, start: "2026-11-13" });
    expect(validateOutcome({ ...o, title: "", horizon: "2026-01-01" })).toEqual(expect.arrayContaining(["Outcome needs a title", "Target date must be after the start date"]));
    expect(validateOutcome({ ...o, milestones: [{ id: "x", kind: "boolean", due: "2027-01-01" }] })[0]).toMatch(/needs a title/);
  });
});
