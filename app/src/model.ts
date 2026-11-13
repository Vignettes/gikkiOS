export interface MetricPoint {
  metric: string; // e.g. "health.rhr", "finance.emergency_fund"
  t: string;      // YYYY-MM-DD
  value: number;
  unit: string;
}

export interface Snapshot {
  v: 1;
  source: string;            // "apple_health", "plaid", "manual", …
  kind: "auto" | "manual";
  ingested_at: string;
  points: MetricPoint[];
}

export interface SeriesPoint extends MetricPoint {
  source: string;
  kind: "auto" | "manual";
  ingested_at: string;
}

export interface MetricSummary {
  metric: string;
  unit: string;
  latest: SeriesPoint;
  count: number;
  series: SeriesPoint[]; // one point per day, ascending
  ageDays: number;
  stale: boolean;
}

export const METRIC_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const DAY = 86_400_000;

/**
 * Merge snapshots into per-metric daily series. If several snapshots report the same
 * metric/day, the most recently ingested one wins (re-sent Shortcut runs, corrections).
 */
export function summarize(snapshots: Snapshot[], now = new Date(), staleAfterDays = 3): MetricSummary[] {
  const byKey = new Map<string, SeriesPoint>();
  for (const s of snapshots) {
    if (s?.v !== 1 || !Array.isArray(s.points)) continue;
    for (const p of s.points) {
      if (!METRIC_RE.test(p.metric) || !Number.isFinite(p.value)) continue;
      const key = `${p.metric}|${p.t}`;
      const prev = byKey.get(key);
      if (!prev || prev.ingested_at < s.ingested_at) {
        byKey.set(key, { ...p, source: s.source, kind: s.kind, ingested_at: s.ingested_at });
      }
    }
  }
  const groups = new Map<string, SeriesPoint[]>();
  for (const p of byKey.values()) {
    const g = groups.get(p.metric) ?? [];
    g.push(p);
    groups.set(p.metric, g);
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return [...groups.entries()]
    .map(([metric, series]) => {
      series.sort((a, b) => a.t.localeCompare(b.t));
      const latest = series[series.length - 1];
      const ageDays = Math.max(0, Math.round((today - Date.parse(latest.t)) / DAY));
      return {
        metric,
        unit: latest.unit,
        latest,
        count: series.length,
        series,
        ageDays,
        stale: latest.kind === "auto" && ageDays > staleAfterDays,
      };
    })
    .sort((a, b) => a.metric.localeCompare(b.metric));
}

export function manualSnapshot(metric: string, value: number, unit: string, t: string, now = new Date()): Snapshot {
  if (!METRIC_RE.test(metric)) throw new Error("Metric must look like area.name, e.g. finance.emergency_fund");
  if (!Number.isFinite(value)) throw new Error("Value must be a number");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error("Date must be YYYY-MM-DD");
  if (!/^[\w%$/ .-]{1,16}$/.test(unit)) throw new Error("Unit must be short plain text");
  return { v: 1, source: "manual", kind: "manual", ingested_at: now.toISOString(), points: [{ metric, t, value, unit }] };
}
