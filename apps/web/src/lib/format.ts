import { currencyInfo, DEFAULT_REGIONAL, formatDate, formatDateTime, formatMoney, fromPlain, toPlain, type RegionalSettings } from '@meridian/types';

/**
 * The deployment's regional settings (Settings > Regional). The server renders the root layout with the current values and
 * SettingsProvider installs them before any page renders, so every `money()` / `d()` call below follows the operator's format.
 */
let regional: RegionalSettings = DEFAULT_REGIONAL;
export const setRegional = (r: RegionalSettings) => { regional = r; };
export const getRegional = () => regional;

/** Minor units -> text in the configured currency format. A different currency (e.g. a historic row) is shown with its own symbol and digits. */
export function money(minor: number | null | undefined, currency?: string): string {
  if (!currency || currency === regional.currency) return formatMoney(minor, regional);
  const info = currencyInfo(currency);
  return formatMoney(minor, { ...regional, currency, symbol: info?.symbol ?? currency, exponent: info?.exponent ?? 2, decimals: info?.exponent ?? 2, symbolSpacing: !info });
}
/** What a person types into an amount box (plain, dot-decimal) -> minor units, and back. */
export const toMinor = (v: string): number => fromPlain(v, regional);
export const toInput = (minor: number | undefined): string => (minor === undefined ? '' : toPlain(minor, regional));
export const step = (): string => (regional.exponent === 0 ? '1' : String(10 ** -regional.exponent));
export const dt = (s?: string | null) => formatDateTime(s, regional);
export const d = (s?: string | null) => formatDate(s, regional);
export const label = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

type Tone = 'neutral' | 'success' | 'warning' | 'danger';
export const tone = (s: string): Tone =>
  ['COMPLETED', 'ACTIVE', 'PAID', 'RESOLVED', 'CLOSED', 'ACTIVATED', 'DELIVERED'].includes(s) ? 'success'
  : ['FAILED', 'OVERDUE', 'TERMINATED', 'CANCELLED', 'VOID', 'URGENT', 'BLOCKED'].includes(s) ? 'danger'
  : ['SUSPENDED', 'PAYMENT_PENDING', 'AWAITING_INSTALLATION', 'PORTING_OUT', 'OPEN', 'HIGH', 'ISSUED', 'SHIPPED', 'FULFILMENT'].includes(s) ? 'warning' : 'neutral';
