// Evaluates milestones against metric series. Pure functions: everything runs client-side.
import { dayNum, dayStr, monthLabel, weekStart } from "./dates";
import { fmt, metricLabel } from "./metrics";
import type { SeriesPoint } from "./model";
import {
  type BooleanMilestone, type CumulativeMilestone, DEFAULT_SETTINGS, type EvalSettings, type FrequencyMilestone,
  type Milestone, type Outcome, type ThresholdMilestone,
} from "./outcomes";

export { fmt };

export type Status = "achieved" | "on_track" | "at_risk" | "off_track" | "missed" | "stale" | "no_data";

export const STATUS_LABEL: Record<Status, string> = {
  achieved: "achieved", on_track: "on track", at_risk: "at risk", off_track: "off track",
  missed: "missed", stale: "stale data", no_data: "needs data",
};

export interface MilestoneEval {
  milestone: Milestone;
  status: Status;
  progress: number;      // 0..1
  current?: number;
  unit?: string;
  projected?: number;
  summary: string;       // one line: where it stands
  hint?: string;         // what would get it (back) on track
}

export interface OutcomeEval {
  outcome: Outcome;
  status: Status;
  progress: number;
  milestones: MilestoneEval[];
  next?: MilestoneEval;  // earliest-due milestone not yet achieved
}

export type SeriesIndex = Map<string, SeriesPoint[]>; // metric -> ascending by day, one per day

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const cmp = (v: number, c: ">=" | "<=", t: number) => (c === ">=" ? v >= t : v <= t);

function rate(perDay: number, unit: string, daysLeft: number): string {
  const [mult, per] = daysLeft > 90 ? [30.44, "mo"] : [7, "wk"];
  const v = perDay * mult;
  const small = unit !== "USD" && Math.abs(v) < 10;  // keep "-2.4 bpm/mo" rather than "-2 bpm/mo"
  return `${v >= 0 ? "+" : ""}${fmt(v, unit, undefined, small ? 1 : undefined)}/${per}`;
}

/** Least-squares slope (value per day). */
export function slope(points: { d: number; v: number }[]): number | undefined {
  if (points.length < 2) return undefined;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.d, 0) / n;
  const my = points.reduce((s, p) => s + p.v, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.d - mx) * (p.v - my); den += (p.d - mx) ** 2; }
  return den === 0 ? undefined : num / den;
}

/** Trailing mean over `window` days for each point (window 1 = raw). */
export function smoothSeries(series: SeriesPoint[], window = 1): { d: number; v: number }[] {
  const pts = series.map((p) => ({ d: dayNum(p.t), v: p.value }));
  if (window <= 1) return pts;
  return pts.map((p, i) => {
    let s = 0, n = 0;
    for (let j = i; j >= 0 && pts[j].d > p.d - window; j--) { s += pts[j].v; n++; }
    return { d: p.d, v: s / n };
  });
}

function isStale(series: SeriesPoint[], today: number, staleDays: number) {
  const last = series[series.length - 1];
  return last.kind === "auto" && today - dayNum(last.t) > staleDays;
}

function threshold(m: ThresholdMilestone, o: Outcome, series: SeriesPoint[], today: number, s: EvalSettings): MilestoneEval {
  const unit = series[0]?.unit;
  if (!series.length) return { milestone: m, status: "no_data", progress: 0, summary: `No ${metricLabel(m.metric).toLowerCase()} data yet`, hint: "Add a check-in or connect a source" };
  const pts = smoothSeries(series, m.smooth);
  const last = pts[pts.length - 1];
  const current = last.v;
  const start = dayNum(o.start);
  const baseline = m.baseline ?? (pts.find((p) => p.d >= start) ?? pts[0]).v;
  const span = m.target - baseline;
  const progress = span === 0 ? (cmp(current, m.comparator, m.target) ? 1 : 0) : clamp01((current - baseline) / span);
  const due = dayNum(m.due);
  const base = { milestone: m, progress, current, unit };
  const summary = `${fmt(current, unit)} now · target ${m.comparator === ">=" ? "≥" : "≤"} ${fmt(m.target, unit)} by ${m.due}`;

  if (cmp(current, m.comparator, m.target)) return { ...base, status: "achieved", progress: 1, summary };
  if (today > due) return { ...base, status: "missed", summary, hint: "Past due. Move the date or adjust the target" };

  // Pace from the lookback window; widen to the last 3 points if the window is sparse (monthly check-ins).
  let win = pts.filter((p) => p.d > last.d - s.lookback_days);
  if (win.length < 3) win = pts.slice(-3);
  const perDay = slope(win);
  const stale = isStale(series, today, s.stale_days);
  if (perDay === undefined) {
    return { ...base, status: stale ? "stale" : "no_data", summary, hint: "Need at least two readings on different days to estimate pace" };
  }
  const dir = m.comparator === ">=" ? 1 : -1;
  const daysLeft = due - last.d;
  const gapNeeded = (m.target - current) * dir;                // > 0 here
  const projected = current + perDay * daysLeft;
  const ratio = daysLeft <= 0 ? 0 : ((projected - current) * dir) / gapNeeded;
  const status = stale ? "stale" : ratio >= 1 ? "on_track" : ratio >= s.at_risk_ratio ? "at_risk" : "off_track";
  const required = daysLeft > 0 ? (m.target - current) / daysLeft : Infinity;
  const eta = perDay * dir > 0 ? last.d + Math.ceil(gapNeeded / (perDay * dir)) : undefined;

  let hint: string;
  if (ratio >= 1) hint = `At this pace (${rate(perDay, unit, daysLeft)}) you'll get there around ${monthLabel(dayStr(eta!))}`;
  else if (eta !== undefined) hint = `Needs ${rate(required, unit, daysLeft)} (now ${rate(perDay, unit, daysLeft)}), or move the date to ${monthLabel(dayStr(eta))}`;
  else hint = `Needs ${rate(required, unit, daysLeft)}; the trend is moving the wrong way (${rate(perDay, unit, daysLeft)})`;
  return { ...base, status, projected, summary, hint };
}

function cumulative(m: CumulativeMilestone, o: Outcome, series: SeriesPoint[], today: number, s: EvalSettings): MilestoneEval {
  const unit = series[0]?.unit;
  const start = dayNum(m.start ?? o.start), due = dayNum(m.due);
  const inRange = series.filter((p) => { const d = dayNum(p.t); return d >= start && d <= due; });
  const sum = inRange.reduce((a, p) => a + p.value, 0);
  const progress = clamp01(sum / m.target);
  const summary = `${fmt(sum, unit)} of ${fmt(m.target, unit)} since ${dayStr(start)}`;
  const base = { milestone: m, progress, current: sum, unit, summary };
  if (sum >= m.target) return { ...base, status: "achieved", progress: 1 };
  if (today > due) return { ...base, status: "missed", hint: "Past due. Move the date or adjust the target" };
  if (!series.length) return { ...base, status: "no_data", hint: "Add a check-in or connect a source" };
  const elapsed = Math.max(1, Math.min(today, due) - start + 1);
  const total = due - start + 1;
  const projected = (sum / elapsed) * total;
  const ratio = projected / m.target;
  const daysLeft = Math.max(1, due - today);
  const status: Status = isStale(series, today, s.stale_days) ? "stale"
    : ratio >= 1 ? "on_track" : ratio >= s.at_risk_ratio ? "at_risk" : "off_track";
  return { ...base, status, projected,
    hint: `Needs ${rate((m.target - sum) / daysLeft, unit, daysLeft)} from here (averaging ${rate(sum / elapsed, unit, daysLeft)})` };
}

function frequency(m: FrequencyMilestone, o: Outcome, series: SeriesPoint[], today: number): MilestoneEval {
  const unit = series[0]?.unit;
  const firstWeek = weekStart(dayNum(o.start));
  const thisWeek = weekStart(today);
  const due = dayNum(m.due);
  const sums = new Map<number, number>();
  for (const p of series) {
    const w = weekStart(dayNum(p.t));
    if (w >= firstWeek) sums.set(w, (sums.get(w) ?? 0) + p.value);
  }
  const ok = (w: number) => (sums.get(w) ?? 0) >= m.at_least;
  // Longest run of qualifying weeks so far, and the run still alive at the last complete week.
  let best = 0, run = 0;
  for (let w = firstWeek; w < thisWeek; w += 7) { run = ok(w) ? run + 1 : 0; best = Math.max(best, run); }
  const thisWeekSum = sums.get(thisWeek) ?? 0;
  const liveRun = run + (ok(thisWeek) ? 1 : 0);
  best = Math.max(best, liveRun);
  const progress = clamp01(best / m.for_weeks);
  const summary = `This week ${fmt(thisWeekSum, unit)} of ${m.at_least} · streak ${liveRun}/${m.for_weeks} weeks`;
  const base = { milestone: m, progress, current: liveRun, unit, summary };
  if (best >= m.for_weeks) return { ...base, status: "achieved", progress: 1 };
  if (today > due) return { ...base, status: "missed", hint: "Past due. Move the date or start a new streak" };
  const weeksLeft = Math.floor((weekStart(due) - thisWeek) / 7) + 1;   // including this week
  const needed = m.for_weeks - run;                                     // weeks still to qualify, this one included
  if (weeksLeft < needed) {
    return { ...base, status: "off_track", hint: `Not enough weeks left for a ${m.for_weeks}-week streak; move the date to ${dayStr(thisWeek + (needed - 1) * 7 + 6)} or later` };
  }
  const lastWeekMissed = thisWeek > firstWeek && !ok(thisWeek - 7);
  const status: Status = lastWeekMissed ? "at_risk" : "on_track";
  const left = Math.max(0, m.at_least - thisWeekSum);
  return { ...base, status, hint: left > 0 ? `${fmt(left, unit)} more this week keeps the streak going` : "This week is done; keep going next week" };
}

function boolean(m: BooleanMilestone, today: number): MilestoneEval {
  const due = dayNum(m.due);
  if (m.done) return { milestone: m, status: "achieved", progress: 1, summary: `Done${m.done_at ? ` ${m.done_at}` : ""}` };
  const left = due - today;
  const summary = left >= 0 ? `Due ${m.due} (${left} day${left === 1 ? "" : "s"})` : `Was due ${m.due}`;
  const status: Status = left < 0 ? "missed" : left <= 14 ? "at_risk" : "on_track";
  return { milestone: m, status, progress: 0, summary, hint: left <= 14 ? "Schedule it, or mark it done" : undefined };
}

export function evaluateMilestone(m: Milestone, o: Outcome, idx: SeriesIndex, today: string, settings: Partial<EvalSettings> = {}): MilestoneEval {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const t = dayNum(today);
  switch (m.kind) {
    case "threshold": return threshold(m, o, idx.get(m.metric) ?? [], t, s);
    case "cumulative": return cumulative(m, o, idx.get(m.metric) ?? [], t, s);
    case "frequency": return frequency(m, o, idx.get(m.metric) ?? [], t);
    case "boolean": return boolean(m, t);
  }
}

const SCORE: Partial<Record<Status, number>> = { achieved: 1, on_track: 1, at_risk: 0.5, off_track: 0, missed: 0 };

export function evaluateOutcome(o: Outcome, idx: SeriesIndex, today: string, settings: Partial<EvalSettings> = {}): OutcomeEval {
  const ms = o.milestones
    .map((m) => evaluateMilestone(m, o, idx, today, settings))
    .sort((a, b) => a.milestone.due.localeCompare(b.milestone.due));
  const w = (e: MilestoneEval) => e.milestone.weight ?? 1;
  const totalW = ms.reduce((a, e) => a + w(e), 0) || 1;
  const progress = ms.reduce((a, e) => a + e.progress * w(e), 0) / totalW;
  const next = ms.find((e) => e.status !== "achieved");
  if (!next) return { outcome: o, status: "achieved", progress: 1, milestones: ms };

  // Score only open milestones that can be judged; achieved ones don't mask current trouble.
  const open = ms.filter((e) => e.status !== "achieved" && SCORE[e.status] !== undefined);
  let status: Status;
  if (open.length === 0) status = ms.some((e) => e.status === "stale") ? "stale" : "no_data";
  else {
    const ow = open.reduce((a, e) => a + w(e), 0);
    const score = open.reduce((a, e) => a + SCORE[e.status]! * w(e), 0) / ow;
    status = score >= 0.85 ? "on_track" : score >= 0.5 ? "at_risk" : "off_track";
  }
  return { outcome: o, status, progress, milestones: ms, next };
}
