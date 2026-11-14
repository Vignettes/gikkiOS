// Dates are plain YYYY-MM-DD strings in the user's local calendar; arithmetic uses day numbers.
export const DAY_MS = 86_400_000;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n: number) => String(n).padStart(2, "0");

export function dayNum(s: string): number {
  if (!DATE_RE.test(s)) throw new Error(`Bad date: ${s}`);
  return Math.floor(Date.parse(`${s}T00:00:00Z`) / DAY_MS);
}
export const dayStr = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export function todayLocal(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Day number of the Monday starting the ISO week containing day n. */
export const weekStart = (n: number) => n - ((n + 3) % 7); // 1970-01-01 (day 0) was a Thursday
export function addMonths(s: string, months: number): string {
  const [y, m, d] = s.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
export function monthLabel(s: string): string {
  return new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
}

/** "today" · "tomorrow" · "yesterday" · "Feb 14" (this year) · "Feb 14, 2028". */
export function shortDate(s: string, today = todayLocal()): string {
  const d = dayNum(s), t = dayNum(today);
  if (d === t) return "today";
  if (d === t + 1) return "tomorrow";
  if (d === t - 1) return "yesterday";
  const sameYear = s.slice(0, 4) === today.slice(0, 4);
  return new Date(`${s}T00:00:00Z`).toLocaleDateString(undefined,
    { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/** "in 5 days" · "in 3 weeks" · "in 4 months" · "2 days ago" … */
export function relDays(s: string, today = todayLocal()): string {
  const n = dayNum(s) - dayNum(today);
  if (n === 0) return "today";
  const a = Math.abs(n);
  const [v, u] = a < 14 ? [a, "day"] : a < 60 ? [Math.round(a / 7), "week"] : a < 730 ? [Math.round(a / 30.44), "month"] : [Math.round(a / 365.25), "year"];
  const span = `${v} ${u}${v === 1 ? "" : "s"}`;
  return n > 0 ? `in ${span}` : `${span} ago`;
}
