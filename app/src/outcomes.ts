// Outcomes document: stored encrypted at config/outcomes.age in the vault.
import { DATE_RE, dayNum } from "./dates";
import { fmt, METRICS, metricLabel } from "./metrics";
import { METRIC_RE } from "./model";

export type Category = "finance" | "health" | "learning" | "other";
export const CATEGORIES: Category[] = ["finance", "health", "learning", "other"];
export type Comparator = ">=" | "<=";

/** An intermediate stop on the way to a milestone's target (shown as a path, not a separate goal). */
export interface Checkpoint {
  due: string;
  target: number;
}

interface MilestoneBase {
  id: string;
  title?: string;
  due: string;      // YYYY-MM-DD
  weight?: number;  // default 1
}
export interface ThresholdMilestone extends MilestoneBase {
  kind: "threshold";
  metric: string;
  comparator: Comparator;
  target: number;
  smooth?: number;    // trailing-mean window in days, for noisy metrics (weight, RHR, sleep)
  baseline?: number;  // starting value for progress %; defaults to first value since outcome start
  checkpoints?: Checkpoint[];
}
export interface CumulativeMilestone extends MilestoneBase {
  kind: "cumulative";
  metric: string;
  target: number;     // sum of daily values from start to due
  start?: string;     // defaults to outcome start
  checkpoints?: Checkpoint[];
}
export interface FrequencyMilestone extends MilestoneBase {
  kind: "frequency";
  metric: string;
  at_least: number;   // weekly sum must reach this…
  for_weeks: number;  // …for this many consecutive weeks
}
export interface BooleanMilestone extends MilestoneBase {
  kind: "boolean";
  done?: boolean;
  done_at?: string;
}
export type Milestone = ThresholdMilestone | CumulativeMilestone | FrequencyMilestone | BooleanMilestone;
export type MilestoneKind = Milestone["kind"];
export const KINDS: MilestoneKind[] = ["threshold", "cumulative", "frequency", "boolean"];

export interface Outcome {
  id: string;
  title: string;
  why: string;
  category: Category;
  start: string;
  horizon: string;
  archived?: boolean;
  milestones: Milestone[];
}

export interface EvalSettings {
  lookback_days: number;
  at_risk_ratio: number;
  stale_days: number;
}
export const DEFAULT_SETTINGS: EvalSettings = { lookback_days: 28, at_risk_ratio: 0.85, stale_days: 3 };

export interface OutcomesDoc {
  v: 1;
  outcomes: Outcome[];
  settings?: Partial<EvalSettings>;
}
export const emptyDoc = (): OutcomesDoc => ({ v: 1, outcomes: [] });

export function newId(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return `${prefix}-${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** Returns a list of human-readable problems; empty means valid. */
export function validateOutcome(o: Outcome): string[] {
  const e: string[] = [];
  if (!o.title?.trim()) e.push("Outcome needs a title");
  if (!CATEGORIES.includes(o.category)) e.push("Pick a category");
  if (!DATE_RE.test(o.start ?? "")) e.push("Start date is required");
  if (!DATE_RE.test(o.horizon ?? "")) e.push("Target date is required");
  else if (DATE_RE.test(o.start ?? "") && dayNum(o.horizon) <= dayNum(o.start)) e.push("Target date must be after the start date");
  if (!o.milestones?.length) e.push("Add at least one milestone");
  (o.milestones ?? []).forEach((m, i) => {
    const at = `Milestone ${i + 1}`;
    if (!DATE_RE.test(m.due ?? "")) e.push(`${at}: due date is required`);
    if (m.weight !== undefined && (!num(m.weight) || m.weight <= 0)) e.push(`${at}: weight must be > 0`);
    switch (m.kind) {
      case "threshold":
        if (!METRIC_RE.test(m.metric ?? "")) e.push(`${at}: metric must look like area.name`);
        if (m.comparator !== ">=" && m.comparator !== "<=") e.push(`${at}: comparator must be >= or <=`);
        if (!num(m.target)) e.push(`${at}: target must be a number`);
        if (m.smooth !== undefined && (!Number.isInteger(m.smooth) || m.smooth < 1 || m.smooth > 90)) e.push(`${at}: smoothing must be 1–90 days`);
        if (m.baseline !== undefined && !num(m.baseline)) e.push(`${at}: baseline must be a number`);
        break;
      case "cumulative":
        if (!METRIC_RE.test(m.metric ?? "")) e.push(`${at}: metric must look like area.name`);
        if (!num(m.target) || m.target <= 0) e.push(`${at}: target must be > 0`);
        if (m.start !== undefined && !DATE_RE.test(m.start)) e.push(`${at}: start must be a date`);
        break;
      case "frequency":
        if (!METRIC_RE.test(m.metric ?? "")) e.push(`${at}: metric must look like area.name`);
        if (!num(m.at_least) || m.at_least <= 0) e.push(`${at}: "at least" must be > 0`);
        if (!Number.isInteger(m.for_weeks) || m.for_weeks < 1 || m.for_weeks > 104) e.push(`${at}: weeks must be 1–104`);
        break;
      case "boolean":
        if (!m.title?.trim()) e.push(`${at}: a done/not-done milestone needs a title`);
        break;
      default:
        e.push(`${at}: unknown kind`);
    }
    if ((m.kind === "threshold" || m.kind === "cumulative") && m.checkpoints) {
      m.checkpoints.forEach((c, j) => {
        if (!DATE_RE.test(c.due ?? "")) e.push(`${at}, checkpoint ${j + 1}: date is required`);
        else if (DATE_RE.test(m.due ?? "") && dayNum(c.due) >= dayNum(m.due)) e.push(`${at}, checkpoint ${j + 1}: must be before the milestone's due date`);
        if (!num(c.target)) e.push(`${at}, checkpoint ${j + 1}: target must be a number`);
      });
    }
  });
  return e;
}

export function milestoneLabel(m: Milestone): string {
  if (m.title?.trim()) return m.title.trim();
  if (m.kind === "boolean") return "Done";
  const info = METRICS[m.metric];
  const unit = info?.unit ?? "";
  const name = metricLabel(m.metric);
  switch (m.kind) {
    case "threshold": return `${name} ${m.comparator === ">=" ? "≥" : "≤"} ${fmt(m.target, unit, m.metric)}`;
    case "cumulative": return `${name}: ${fmt(m.target, unit, m.metric)} total`;
    case "frequency": return `${fmt(m.at_least, "", m.metric)}+ ${info?.noun ?? name.toLowerCase()} a week for ${m.for_weeks} weeks`;
  }
}
