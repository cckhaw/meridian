const cur = new Map<string, Intl.NumberFormat>();
/** Minor units -> localized currency. All Meridian currencies are modelled with 2 minor digits. */
export function money(minor: number | null | undefined, currency = 'SGD'): string {
  if (minor === null || minor === undefined) return '–';
  if (!cur.has(currency)) cur.set(currency, new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return cur.get(currency)!.format(minor / 100);
}
export const toMinor = (v: string): number => Math.round(Number(v) * 100);
export const dt = (s?: string | null) => (s ? new Date(s).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
export const d = (s?: string | null) => (s ? new Date(s.length === 10 ? s + 'T00:00:00Z' : s).toLocaleDateString('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }) : '–');
export const label = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

type Tone = 'neutral' | 'success' | 'warning' | 'danger';
export const tone = (s: string): Tone =>
  ['COMPLETED', 'ACTIVE', 'PAID', 'RESOLVED', 'CLOSED', 'ACTIVATED', 'DELIVERED'].includes(s) ? 'success'
  : ['FAILED', 'OVERDUE', 'TERMINATED', 'CANCELLED', 'VOID', 'URGENT', 'BLOCKED'].includes(s) ? 'danger'
  : ['SUSPENDED', 'PAYMENT_PENDING', 'AWAITING_INSTALLATION', 'PORTING_OUT', 'OPEN', 'HIGH', 'ISSUED', 'SHIPPED', 'FULFILMENT'].includes(s) ? 'warning' : 'neutral';
