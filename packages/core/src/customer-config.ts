import { audit } from './audit.js';
import type { Queryable } from './db.js';
import { invalid } from './errors.js';

// ───────────────────────── which customer details are asked for ─────────────────────────
/** The details the customer form can ask for beyond name, ID document and segment. */
export const CUSTOMER_FIELDS = ['email', 'phone', 'dateOfBirth', 'gender', 'address', 'postcode', 'city', 'state', 'country'] as const;
export type CustomerField = (typeof CUSTOMER_FIELDS)[number];
export type FieldMode = 'hidden' | 'optional' | 'required';
export const FIELD_MODES: FieldMode[] = ['hidden', 'optional', 'required'];
export const FIELD_LABELS: Record<CustomerField, string> = {
  email: 'E-mail', phone: 'Phone', dateOfBirth: 'Date of birth', gender: 'Gender', address: 'Address', postcode: 'Postcode', city: 'City', state: 'State or region', country: 'Country',
};
export const GENDERS = ['FEMALE', 'MALE', 'OTHER', 'UNDISCLOSED'] as const;
export type Gender = (typeof GENDERS)[number];

export interface CustomerAddress { line1?: string; line2?: string; postcode?: string; city?: string; state?: string; country?: string }
/** What a staff member types into the customer form (everything beyond the basics is optional unless the settings make it required). */
export interface CustomerDetails { email?: string; phone?: string; dateOfBirth?: string; gender?: string; address?: CustomerAddress }

export type CustomerFieldSettings = Record<CustomerField, FieldMode>;
export const DEFAULT_CUSTOMER_FIELDS: CustomerFieldSettings = { email: 'optional', phone: 'optional', dateOfBirth: 'optional', gender: 'optional', address: 'optional', postcode: 'optional', city: 'optional', state: 'optional', country: 'optional' };

export function normaliseFields(f: Partial<Record<string, unknown>> | undefined): CustomerFieldSettings {
  const out = { ...DEFAULT_CUSTOMER_FIELDS };
  for (const k of CUSTOMER_FIELDS) { const v = f?.[k]; if (typeof v === 'string' && (FIELD_MODES as string[]).includes(v)) out[k] = v as FieldMode; }
  return out;
}

const filled = (v: unknown) => typeof v === 'string' && v.trim() !== '';

/**
 * Applies the settings to what was entered: a hidden field is dropped (it is not asked for, so it is not stored), a required one must be filled, and
 * what is filled must be well formed. Pass `partial` when editing, where only the fields being changed are judged.
 */
export function checkCustomerDetails(fields: CustomerFieldSettings, d: CustomerDetails, o: { partial?: boolean } = {}): CustomerDetails {
  const out: CustomerDetails = {};
  const problems: string[] = [];
  const take = (k: CustomerField, v: string | undefined): string | undefined => {
    if (fields[k] === 'hidden') return undefined;
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t && fields[k] === 'required' && !(o.partial && v === undefined)) problems.push(`${FIELD_LABELS[k]} is required.`);
    return t || undefined;
  };
  out.email = take('email', d.email);
  out.phone = take('phone', d.phone);
  const dob = take('dateOfBirth', d.dateOfBirth);
  if (dob) {
    const t = Date.parse(`${dob}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(t)) problems.push('Date of birth should be a date (YYYY-MM-DD).');
    else if (t > Date.now()) problems.push('Date of birth cannot be in the future.');
    else if (dob < '1900-01-01') problems.push('Date of birth is not plausible.');
    else out.dateOfBirth = dob;
  }
  const gender = take('gender', d.gender)?.toUpperCase();
  if (gender) { if (!(GENDERS as readonly string[]).includes(gender)) problems.push(`Gender should be one of ${GENDERS.join(', ').toLowerCase()}.`); else out.gender = gender; }
  const a = d.address ?? {};
  const address: CustomerAddress = {
    line1: take('address', a.line1), line2: fields.address === 'hidden' ? undefined : (a.line2?.trim() || undefined),
    postcode: take('postcode', a.postcode), city: take('city', a.city), state: take('state', a.state), country: take('country', a.country)?.toUpperCase(),
  };
  if (address.country && !/^[A-Z]{2}$/.test(address.country)) problems.push('Country should be a two-letter country code.');
  const kept = Object.fromEntries(Object.entries(address).filter(([, v]) => v !== undefined));
  if (Object.keys(kept).length) out.address = kept;
  if (problems.length) throw invalid(problems.join(' '), problems);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as CustomerDetails;
}

// ───────────────────────── bill cycles ─────────────────────────
/** The bill cycles an account can be given: monthly on a day 1–28, and/or daily. Operators switch off the days they do not use. */
export interface BillCycleSettings { days: number[]; daily: boolean; defaultCycle: number | 'daily' }
export const DEFAULT_BILL_CYCLES: BillCycleSettings = { days: Array.from({ length: 28 }, (_, i) => i + 1), daily: true, defaultCycle: 1 };

export async function getBillCycles(q: Queryable): Promise<BillCycleSettings> {
  const r = (await q.query(`SELECT value FROM settings WHERE key='billCycles'`)).rows[0];
  const v = r?.value as Partial<BillCycleSettings> | undefined;
  if (!v) return DEFAULT_BILL_CYCLES;
  return { days: Array.isArray(v.days) ? v.days : DEFAULT_BILL_CYCLES.days, daily: v.daily ?? true, defaultCycle: v.defaultCycle ?? 1 };
}

export async function setBillCycles(q: Queryable, actor: string, s: BillCycleSettings): Promise<BillCycleSettings> {
  const days = [...new Set(s.days)].sort((a, b) => a - b);
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 28)) throw invalid('A bill cycle day is a whole number from 1 to 28.');
  if (!days.length && !s.daily) throw invalid('Keep at least one bill cycle available.');
  const defaultCycle = s.defaultCycle;
  if (defaultCycle === 'daily' ? !s.daily : !days.includes(defaultCycle as number)) throw invalid('The default bill cycle must be one of the cycles that are switched on.');
  const value: BillCycleSettings = { days, daily: !!s.daily, defaultCycle };
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('billCycles', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(value), actor]);
  await audit(q, actor, 'settings', 'billCycles', 'update', { ...value });
  return value;
}

/** The cycle a new account gets (null = daily), and a check that an explicit choice is one the operator offers. */
export const cycleToDay = (c: number | 'daily'): number | null => (c === 'daily' ? null : c);
export async function resolveBillCycle(q: Queryable, requested: number | null | undefined): Promise<number | null> {
  const s = await getBillCycles(q);
  if (requested === undefined) return cycleToDay(s.defaultCycle);
  if (requested === null ? !s.daily : !s.days.includes(requested)) throw invalid(requested === null ? 'A daily bill cycle is not offered. Choose one of the bill cycles in Settings.' : `Bill cycle day ${requested} is not offered. Choose one of the bill cycles in Settings.`);
  return requested;
}
