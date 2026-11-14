// Plain-language names and number formatting for metrics.
export interface MetricInfo {
  label: string;
  unit: string;
  noun?: string;      // for habits: "3+ workouts a week"
  decimals: number;   // display precision
}

export const METRICS: Record<string, MetricInfo> = {
  "finance.emergency_fund": { label: "Emergency fund", unit: "USD", decimals: 0 },
  "finance.debt":           { label: "Debt", unit: "USD", decimals: 0 },
  "finance.net_worth":      { label: "Net worth", unit: "USD", decimals: 0 },
  "health.steps":           { label: "Daily steps", unit: "count", noun: "steps", decimals: 0 },
  "health.rhr":             { label: "Resting heart rate", unit: "bpm", decimals: 0 },
  "health.hrv":             { label: "Heart rate variability", unit: "ms", decimals: 0 },
  "health.sleep_h":         { label: "Sleep", unit: "h", decimals: 1 },
  "health.weight_kg":       { label: "Weight", unit: "kg", decimals: 1 },
  "health.body_fat_pct":    { label: "Body fat", unit: "%", decimals: 1 },
  "health.active_kcal":     { label: "Active energy", unit: "kcal", decimals: 0 },
  "health.exercise_min":    { label: "Exercise", unit: "min", decimals: 0 },
  "health.workouts":        { label: "Workouts", unit: "count", noun: "workouts", decimals: 0 },
};

/** "finance.side_income" → "Side income" for metrics without a registry entry. */
export function metricLabel(id: string): string {
  if (METRICS[id]) return METRICS[id].label;
  const last = id.split(".").pop() ?? id;
  const words = last.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const INTEGER_UNITS = new Set(["USD", "count", "bpm", "ms", "kcal", "min"]);

export function decimalsFor(unit = "", metric?: string): number {
  if (metric && METRICS[metric]) return METRICS[metric].decimals;
  return INTEGER_UNITS.has(unit) ? 0 : 1;
}

/** Human formatting: $4,650 · 58 bpm · 7.5 h · 9,000 (counts have no unit suffix). */
export function fmt(v: number, unit = "", metric?: string, decimals?: number): string {
  const abs = Math.abs(v);
  if (unit === "USD") {
    const cents = abs < 100 && !Number.isInteger(v);
    const digits = cents ? 2 : 0;
    return `${v < 0 ? "-" : ""}$${abs.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
  }
  const d = decimals ?? decimalsFor(unit, metric);
  const s = v.toLocaleString(undefined, { maximumFractionDigits: d });
  return unit && unit !== "count" ? `${s} ${unit}` : s;
}
