/** Business dates are 'YYYY-MM-DD' strings in UTC; all arithmetic goes through these helpers. */
export type DateStr = string;
const MS = 86_400_000;
export const toDate = (s: DateStr) => new Date(`${s}T00:00:00Z`);
export const fmt = (d: Date): DateStr => d.toISOString().slice(0, 10);
export const today = (): DateStr => fmt(new Date());
export const addDays = (s: DateStr, n: number): DateStr => fmt(new Date(toDate(s).getTime() + n * MS));
export const diffDays = (a: DateStr, b: DateStr) => Math.round((toDate(a).getTime() - toDate(b).getTime()) / MS);
export const dayOf = (s: DateStr) => toDate(s).getUTCDate();
/** Same day-of-month `n` months earlier, clamped to month end (31 Mar - 1 month = 28/29 Feb). */
export function addMonths(s: DateStr, n: number): DateStr {
  const d = toDate(s);
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return fmt(t);
}
