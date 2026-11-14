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
  path?: PathEval;
}

export interface PathPoint {
  due: string;
  target: number;
  state: "met" | "missed" | "next" | "upcoming";
}
export interface PathEval {
  points: PathPoint[];   // checkpoints only, ascending
  next?: PathPoint;
  note?: string;         // "$350 ahead of plan"
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
  if (!series.length) return { milestone: m, status: "no_data", progress: 0, summary: `No ${metricLabel(m.metric).toLowerCase()} data yet`, hint: "Use Log to add a first reading, or connect a source" };
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
  if (!series.length) return { ...base, status: "no_data", hint: "Use Log to add a first reading, or connect a source" };
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

/**
 * Where the value stands against the planned path (start → checkpoints → target),
 * and which checkpoints were met on their dates.
 */
function evaluatePath(m: ThresholdMilestone | CumulativeMilestone, o: Outcome, series: SeriesPoint[], today: number): PathEval | undefined {
  if (!m.checkpoints?.length) return undefined;
  const cps = [...m.checkpoints].sort((a, b) => a.due.localeCompare(b.due));
  const cumulativeKind = m.kind === "cumulative";
  const start = dayNum(cumulativeKind ? (m.start ?? o.start) : o.start);
  const pts = cumulativeKind ? [] : smoothSeries(series, m.smooth);
  const valueAt = (d: number): number | undefined => {
    if (cumulativeKind) return series.reduce((a, p) => { const x = dayNum(p.t); return x >= start && x <= d ? a + p.value : a; }, 0);
    let v: number | undefined;
    for (const p of pts) if (p.d <= d) v = p.v;
    return v;
  };
  const comparator = m.kind === "threshold" ? m.comparator : ">=";
  const dir = comparator === ">=" ? 1 : -1;
  const points: PathPoint[] = cps.map((c) => {
    const d = dayNum(c.due);
    if (d >= today) return { ...c, state: "upcoming" };
    const v = valueAt(d);
    return { ...c, state: v !== undefined && cmp(v, comparator, c.target) ? "met" : "missed" };
  });
  const next = points.find((p) => p.state === "upcoming");
  if (next) next.state = "next";

  const current = valueAt(today);
  if (current === undefined || !series.length) return { points, next };
  const baseline = cumulativeKind ? 0 : (m.baseline ?? (pts.find((p) => p.d >= start) ?? pts[0]).v);
  const anchors = [{ d: start, v: baseline }, ...cps.map((c) => ({ d: dayNum(c.due), v: c.target })), { d: dayNum(m.due), v: m.target }];
  let expected = anchors[anchors.length - 1].v;
  for (let i = 1; i < anchors.length; i++) {
    if (today <= anchors[i].d) {
      const a = anchors[i - 1], b = anchors[i];
      expected = b.d === a.d ? b.v : a.v + ((b.v - a.v) * (today - a.d)) / (b.d - a.d);
      break;
    }
  }
  const unit = series[0].unit;
  const diff = (current - expected) * dir;
  const tolerance = Math.abs(m.target - baseline) * 0.01;
  const shown = fmt(Math.abs(diff), unit, m.metric);
  const roundsToZero = shown === fmt(0, unit, m.metric);   // "0 bpm behind" reads as noise
  const note = Math.abs(diff) <= tolerance || roundsToZero ? "right on plan"
    : `${shown} ${diff > 0 ? "ahead of" : "behind"} plan`;
  return { points, next, note };
}

export function evaluateMilestone(m: Milestone, o: Outcome, idx: SeriesIndex, today: string, settings: Partial<EvalSettings> = {}): MilestoneEval {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const t = dayNum(today);
  switch (m.kind) {
    case "threshold": {
      const series = idx.get(m.metric) ?? [];
      return { ...threshold(m, o, series, t, s), path: evaluatePath(m, o, series, t) };
    }
    case "cumulative": {
      const series = idx.get(m.metric) ?? [];
      return { ...cumulative(m, o, series, t, s), path: evaluatePath(m, o, series, t) };
    }
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
