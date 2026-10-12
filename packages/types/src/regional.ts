/**
 * Regional settings: how money, dates and tax are presented for the whole deployment.
 * Pure functions (no Node or DOM APIs) so the CRM, the store-front and the server render identically.
 */
export type SymbolPosition = 'before' | 'after';
export type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD MMM YYYY' | 'DD.MM.YYYY';
export const DATE_FORMATS: DateFormat[] = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY', 'DD.MM.YYYY'];
export const THOUSAND_SEPARATORS = [',', '.', ' ', "'", '’', ''] as const;
export const DECIMAL_SEPARATORS = ['.', ','] as const;

export interface RegionalSettings {
  /** ISO 4217 code. One currency per deployment; fixed once transactions exist. */
  currency: string;
  /** Symbol shown instead of the code, e.g. "$", "RM", "Rp". */
  symbol: string;
  symbolPosition: SymbolPosition;
  /** Put a space between the symbol and the number ("RM 10.00" vs "RM10.00"). */
  symbolSpacing: boolean;
  thousandSeparator: string;
  decimalSeparator: string;
  /** Digits shown after the decimal separator (0..exponent). */
  decimals: number;
  /** Minor-unit digits of the currency (ISO 4217 exponent): amounts are stored as integers of 10^-exponent. */
  exponent: number;
  /** "indian" groups 12,34,567; "standard" groups 1,234,567. */
  grouping: 'standard' | 'indian';
  dateFormat: DateFormat;
  timeFormat: '24h' | '12h';
  /** IANA zone, e.g. "Asia/Singapore". */
  timezone: string;
  /** 0 = Sunday, 1 = Monday, 6 = Saturday */
  weekStart: 0 | 1 | 6;
  /** Two-letter country the deployment trades in; default market for new customers. */
  country: string;
  dialCode: string;
  taxName: string;
  taxBps: number;
}

export const DEFAULT_REGIONAL: RegionalSettings = {
  currency: 'SGD', symbol: '$', symbolPosition: 'before', symbolSpacing: false, thousandSeparator: ',', decimalSeparator: '.', decimals: 2, exponent: 2, grouping: 'standard',
  dateFormat: 'DD MMM YYYY', timeFormat: '24h', timezone: 'Asia/Singapore', weekStart: 1, country: 'SG', dialCode: '+65', taxName: 'GST', taxBps: 900,
};

const pow10 = (n: number) => 10 ** n;

function group(int: string, sep: string, mode: RegionalSettings['grouping']): string {
  if (!sep || int.length <= 3) return int;
  if (mode === 'indian') {
    const last3 = int.slice(-3), rest = int.slice(0, -3);
    return rest.replace(/\B(?=(\d{2})+(?!\d))/g, sep) + sep + last3;
  }
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** Integer minor units -> display string, using only integer arithmetic so no float artefacts appear. */
export function formatMoney(minor: number | null | undefined, r: RegionalSettings, opts: { symbol?: boolean } = {}): string {
  if (minor === null || minor === undefined || Number.isNaN(minor)) return '–';
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const decimals = Math.min(Math.max(r.decimals, 0), r.exponent);
  const drop = r.exponent - decimals;
  const scaled = drop > 0 ? Math.round(abs / pow10(drop)) : abs; // round half up when displaying fewer digits than are stored
  const int = Math.floor(scaled / pow10(decimals));
  const frac = decimals > 0 ? String(scaled % pow10(decimals)).padStart(decimals, '0') : '';
  const num = group(String(int), r.thousandSeparator, r.grouping) + (decimals > 0 ? r.decimalSeparator + frac : '');
  const body = opts.symbol === false ? num : r.symbolPosition === 'before' ? `${r.symbol}${r.symbolSpacing ? ' ' : ''}${num}` : `${num}${r.symbolSpacing ? ' ' : ''}${r.symbol}`;
  return neg ? `-${body}` : body;
}

/** User-typed amount (in the configured format or a plain "12.50") -> integer minor units, or null when it is not a valid amount. */
export function parseMoney(input: string, r: RegionalSettings): number | null {
  let s = input.trim().replace(r.symbol, '').replace(new RegExp(`\\s|\\u00a0|${escapeRe(r.currency)}`, 'gi'), '');
  if (!s) return null;
  if (r.thousandSeparator) s = s.split(r.thousandSeparator).join('');
  if (r.decimalSeparator !== '.') s = s.replace(r.decimalSeparator, '.');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[3] ?? '';
  if (frac.length > r.exponent) return null; // would silently lose precision
  const minor = Number(m[2]) * pow10(r.exponent) + (frac ? Number(frac.padEnd(r.exponent, '0')) : 0);
  if (!Number.isSafeInteger(minor)) return null;
  return m[1] ? -minor : minor;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Number to put in an `<input type="number">` for an amount: plain, dot-decimal, no grouping. */
export const toPlain = (minor: number, r: Pick<RegionalSettings, 'exponent'>): string => (r.exponent === 0 ? String(minor) : (minor / pow10(r.exponent)).toFixed(r.exponent));
export const fromPlain = (v: string, r: Pick<RegionalSettings, 'exponent'>): number => Math.round(Number(v) * pow10(r.exponent));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
interface Parts { y: string; m: string; d: string; hh: string; mm: string }

function partsOf(value: string | Date, tz: string): Parts | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return { y: value.slice(0, 4), m: value.slice(5, 7), d: value.slice(8, 10), hh: '00', mm: '00' };
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  let zone = tz;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); } catch { zone = 'UTC'; }
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: p.year!, m: p.month!, d: p.day!, hh: p.hour!, mm: p.minute! };
}
function formatDay(p: Parts, f: DateFormat): string {
  switch (f) {
    case 'DD/MM/YYYY': return `${p.d}/${p.m}/${p.y}`;
    case 'MM/DD/YYYY': return `${p.m}/${p.d}/${p.y}`;
    case 'YYYY-MM-DD': return `${p.y}-${p.m}-${p.d}`;
    case 'DD.MM.YYYY': return `${p.d}.${p.m}.${p.y}`;
    case 'DD MMM YYYY': return `${p.d} ${MONTHS[Number(p.m) - 1]} ${p.y}`;
  }
}
export function formatDate(value: string | Date | null | undefined, r: Pick<RegionalSettings, 'dateFormat' | 'timezone'>): string {
  if (!value) return '–';
  const p = partsOf(value, r.timezone);
  return p ? formatDay(p, r.dateFormat) : '–';
}
export function formatDateTime(value: string | Date | null | undefined, r: Pick<RegionalSettings, 'dateFormat' | 'timezone' | 'timeFormat'>): string {
  if (!value) return '–';
  const p = partsOf(value, r.timezone);
  if (!p) return '–';
  const h = Number(p.hh);
  const time = r.timeFormat === '24h' ? `${p.hh}:${p.mm}` : `${h % 12 === 0 ? 12 : h % 12}:${p.mm} ${h < 12 ? 'am' : 'pm'}`;
  return `${formatDay(p, r.dateFormat)} ${time}`;
}

/** Why a regional configuration is unusable (empty = valid). Shared by the form and the API. */
export function regionalProblems(r: RegionalSettings): string[] {
  const out: string[] = [];
  if (!/^[A-Z]{3}$/.test(r.currency)) out.push('Currency must be a 3-letter ISO code.');
  if (!r.symbol.trim() || r.symbol.length > 6) out.push('Currency symbol must be 1–6 characters.');
  if (r.thousandSeparator === r.decimalSeparator) out.push('The thousand and decimal separators must be different.');
  if (!DECIMAL_SEPARATORS.includes(r.decimalSeparator as '.' | ',')) out.push('The decimal separator must be a dot or a comma.');
  if (!(THOUSAND_SEPARATORS as readonly string[]).includes(r.thousandSeparator)) out.push('Unsupported thousand separator.');
  if (!Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > r.exponent) out.push(`Decimals must be between 0 and ${r.exponent} for ${r.currency}.`);
  if (!Number.isInteger(r.taxBps) || r.taxBps < 0 || r.taxBps > 10_000) out.push('Tax rate must be between 0% and 100%.');
  if (!/^\+\d{1,4}$/.test(r.dialCode)) out.push('Dial code must look like +65.');
  if (!/^[A-Z]{2}$/.test(r.country)) out.push('Country must be a 2-letter code.');
  return out;
}
