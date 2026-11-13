// Outcome templates: a target and a date in, a ready-to-edit outcome with milestones out.
import { addMonths, dayNum, todayLocal } from "./dates";
import { type Category, type Comparator, type Milestone, newId, type Outcome } from "./outcomes";

export interface Template {
  id: string;
  label: string;
  category: Category;
  title: string;
  why: string;              // placeholder prompt
  metric: string;
  unit: string;
  kind: "threshold" | "cumulative" | "frequency";
  comparator?: Comparator | "auto"; // auto: inferred from current vs target (e.g. weight)
  smooth?: number;
  defaultTarget?: number;
  targetLabel: string;
  needsCurrent?: boolean;   // threshold templates ask for (or prefill) the current value
  extras?: Milestone[];     // one-off steps, e.g. "open a high-yield savings account"
  forWeeks?: number;
}

const bool = (title: string, monthsIn: number): Milestone =>
  ({ id: "", kind: "boolean", title, due: addMonths(todayLocal(), monthsIn) });

export const TEMPLATES: Template[] = [
  { id: "emergency_fund", label: "Emergency fund", category: "finance", title: "Build an emergency fund",
    why: "e.g. Freedom to handle surprises without debt", metric: "finance.emergency_fund", unit: "USD",
    kind: "threshold", comparator: ">=", targetLabel: "Target balance", needsCurrent: true,
    extras: [bool("Open a high-yield savings account", 1), bool("Set up an automatic transfer on payday", 1)] },
  { id: "debt_payoff", label: "Pay off debt", category: "finance", title: "Pay off credit card debt",
    why: "e.g. Stop paying interest; free up monthly cash", metric: "finance.debt", unit: "USD",
    kind: "threshold", comparator: "<=", defaultTarget: 0, targetLabel: "Target balance", needsCurrent: true,
    extras: [bool("List every debt with rate and minimum payment", 1)] },
  { id: "net_worth", label: "Net worth target", category: "finance", title: "Reach a net worth milestone",
    why: "e.g. Long-term security and options", metric: "finance.net_worth", unit: "USD",
    kind: "threshold", comparator: ">=", targetLabel: "Target net worth", needsCurrent: true },
  { id: "weight", label: "Body weight", category: "health", title: "Reach a healthy weight",
    why: "e.g. More energy; lower blood pressure", metric: "health.weight_kg", unit: "kg",
    kind: "threshold", comparator: "auto", smooth: 7, targetLabel: "Target weight (kg)", needsCurrent: true },
  { id: "resting_hr", label: "Resting heart rate", category: "health", title: "Improve cardiovascular fitness",
    why: "e.g. Keep up with the kids; long-term heart health", metric: "health.rhr", unit: "bpm",
    kind: "threshold", comparator: "<=", smooth: 7, targetLabel: "Target resting HR (bpm)", needsCurrent: true,
    extras: [bool("Annual physical with bloodwork", 3)] },
  { id: "sleep", label: "Sleep", category: "health", title: "Sleep enough, consistently",
    why: "e.g. Better mood and focus", metric: "health.sleep_h", unit: "h",
    kind: "threshold", comparator: ">=", smooth: 7, defaultTarget: 7.5, targetLabel: "Nightly average (h)", needsCurrent: true },
  { id: "steps", label: "Daily steps", category: "health", title: "Move more every day",
    why: "e.g. Baseline health without a gym", metric: "health.steps", unit: "count",
    kind: "threshold", comparator: ">=", smooth: 7, defaultTarget: 8000, targetLabel: "Daily average", needsCurrent: true },
  { id: "workouts", label: "Workout habit", category: "health", title: "Build a workout habit",
    why: "e.g. Make exercise automatic", metric: "health.workouts", unit: "count",
    kind: "frequency", defaultTarget: 3, targetLabel: "Workouts per week", forWeeks: 8 },
  { id: "exercise_minutes", label: "Exercise minutes", category: "health", title: "Bank exercise minutes",
    why: "e.g. Hit the 150 min/week guideline", metric: "health.exercise_min", unit: "min",
    kind: "cumulative", targetLabel: "Total minutes by the target date" },
];

/** Checkpoint dates between start and horizon: monthly ≤ 4 mo, quarterly ≤ 2 y, else every 6 mo. */
export function checkpointDates(start: string, horizon: string): string[] {
  const days = dayNum(horizon) - dayNum(start);
  const step = days <= 122 ? 1 : days <= 731 ? 3 : 6;
  const out: string[] = [];
  for (let d = addMonths(start, step); dayNum(d) < dayNum(horizon) - 14; d = addMonths(d, step)) out.push(d);
  return out.slice(-8); // keep it short
}

export function niceRound(v: number, unit: string): number {
  if (unit === "USD") return Math.abs(v) >= 1000 ? Math.round(v / 100) * 100 : Math.round(v / 10) * 10;
  if (unit === "count" && Math.abs(v) >= 100) return Math.round(v / 100) * 100;
  return Math.round(v * 10) / 10;
}

export interface TemplateInput {
  target: number;
  horizon: string;
  current?: number;
  checkpoints: boolean;
  start?: string;
}

export function fromTemplate(t: Template, inp: TemplateInput): Outcome {
  const start = inp.start ?? todayLocal();
  const ms: Milestone[] = [];
  if (t.kind === "threshold") {
    const comparator: Comparator = t.comparator === "auto"
      ? (inp.current !== undefined && inp.current > inp.target ? "<=" : ">=")
      : t.comparator ?? ">=";
    if (inp.checkpoints && inp.current !== undefined && inp.current !== inp.target) {
      const s0 = dayNum(start), span = dayNum(inp.horizon) - s0;
      for (const d of checkpointDates(start, inp.horizon)) {
        const frac = (dayNum(d) - s0) / span;
        ms.push({ id: newId("m"), kind: "threshold", metric: t.metric, comparator,
          target: niceRound(inp.current + (inp.target - inp.current) * frac, t.unit), due: d, smooth: t.smooth });
      }
    }
    ms.push({ id: newId("m"), kind: "threshold", metric: t.metric, comparator, target: inp.target,
      due: inp.horizon, smooth: t.smooth, baseline: inp.current, weight: 2 });
  } else if (t.kind === "cumulative") {
    if (inp.checkpoints) {
      const s0 = dayNum(start), span = dayNum(inp.horizon) - s0;
      for (const d of checkpointDates(start, inp.horizon)) {
        ms.push({ id: newId("m"), kind: "cumulative", metric: t.metric,
          target: niceRound(inp.target * ((dayNum(d) - s0) / span), t.unit), due: d });
      }
    }
    ms.push({ id: newId("m"), kind: "cumulative", metric: t.metric, target: inp.target, due: inp.horizon, weight: 2 });
  } else {
    ms.push({ id: newId("m"), kind: "frequency", metric: t.metric, at_least: inp.target,
      for_weeks: t.forWeeks ?? 8, due: inp.horizon });
  }
  for (const e of t.extras ?? []) {
    if (dayNum(e.due) < dayNum(inp.horizon)) ms.push({ ...e, id: newId("m") });
  }
  ms.sort((a, b) => a.due.localeCompare(b.due));
  return { id: newId("o"), title: t.title, why: "", category: t.category, start, horizon: inp.horizon, milestones: ms };
}

export function blankOutcome(): Outcome {
  const start = todayLocal();
  return { id: newId("o"), title: "", why: "", category: "other", start, horizon: addMonths(start, 6),
    milestones: [{ id: newId("m"), kind: "boolean", title: "", due: addMonths(start, 6) }] };
}
