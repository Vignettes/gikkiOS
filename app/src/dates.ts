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
