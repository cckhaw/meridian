import { currencyInfo } from '@meridian/types';
import { audit } from './audit.js';
import { hashIdDocument } from './customers.js';
import type { Queryable, Row } from './db.js';
import { invalid, notFound, rejected } from './errors.js';
import { hubEndpointWithSecret } from './integration-hub.js';

/**
 * Device financing. A device sold on a contract is paid for by the price after the subsidy, spread evenly over the whole contract and billed with the monthly plan
 * fee. A customer with a weak credit profile pays part of that price upfront first, and the rest is spread evenly. The profile comes from a credit bureau
 * connection (Settings → Integration hub → Finance → credit bureau), which either returns a score that the bands below turn into the upfront share, or returns the
 * upfront amount itself. The customer's ID number is sent only with their consent and only a hash of it is kept.
 */
export interface FinancingBand { label: string; minScore: number; maxScore: number; upfrontBps: number }
export interface FinancingSettings {
  /** A device on a contract is paid in instalments across the whole contract (the customer may still choose to pay in full). */
  financeOverContract: boolean;
  /** A credit profile is checked before a device is financed. Needs a bureau connection; without one the fallback applies. */
  creditCheckRequired: boolean;
  providerReturns: 'SCORE' | 'UPFRONT_AMOUNT';
  bands: FinancingBand[];
  /** When the bureau cannot be reached or is not set up: apply the fallback share, or stop the sale. */
  onProviderFailure: 'FALLBACK_SHARE' | 'BLOCK';
  fallbackUpfrontBps: number;
  validityDays: number;
  /** Never ask for less than this upfront when the check asks for something. */
  minUpfrontMinor: number;
}
export const DEFAULT_FINANCING: FinancingSettings = {
  financeOverContract: true, creditCheckRequired: false, providerReturns: 'SCORE', onProviderFailure: 'FALLBACK_SHARE', fallbackUpfrontBps: 2500, validityDays: 30, minUpfrontMinor: 0,
  bands: [
    { label: 'Good', minScore: 700, maxScore: 1000, upfrontBps: 0 },
    { label: 'Fair', minScore: 600, maxScore: 699, upfrontBps: 1000 },
    { label: 'Low', minScore: 500, maxScore: 599, upfrontBps: 2500 },
    { label: 'Poor', minScore: 0, maxScore: 499, upfrontBps: 5000 },
  ],
};
export async function getFinancing(q: Queryable): Promise<FinancingSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='deviceFinancing'`)).rows[0]?.value as Partial<FinancingSettings> | undefined;
  return { ...DEFAULT_FINANCING, ...(v ?? {}), bands: v?.bands?.length ? v.bands : DEFAULT_FINANCING.bands };
}
export function financingProblems(s: FinancingSettings): string[] {
  const p: string[] = [];
  if (!['SCORE', 'UPFRONT_AMOUNT'].includes(s.providerReturns)) p.push('The bureau returns either a score or an upfront amount.');
  if (!['FALLBACK_SHARE', 'BLOCK'].includes(s.onProviderFailure)) p.push('When the bureau fails, apply the fallback share or stop the sale.');
  if (!Number.isInteger(s.fallbackUpfrontBps) || s.fallbackUpfrontBps < 0 || s.fallbackUpfrontBps > 10000) p.push('The fallback upfront share is 0% to 100%.');
  if (!Number.isInteger(s.validityDays) || s.validityDays < 1 || s.validityDays > 365) p.push('A credit check stays valid 1 to 365 days.');
  if (!Number.isInteger(s.minUpfrontMinor) || s.minUpfrontMinor < 0) p.push('The least upfront payment is zero or more.');
  if (!s.bands.length || s.bands.length > 12) p.push('Give 1 to 12 score bands.');
  for (const b of s.bands) {
    if (!b.label?.trim() || b.label.length > 30) p.push('Each band needs a name of up to 30 characters.');
    if (!Number.isInteger(b.minScore) || !Number.isInteger(b.maxScore) || b.minScore < 0 || b.maxScore > 1000 || b.minScore > b.maxScore) p.push(`Band ${b.label}: scores run from 0 to 1000 and the first is not above the last.`);
    if (!Number.isInteger(b.upfrontBps) || b.upfrontBps < 0 || b.upfrontBps > 10000) p.push(`Band ${b.label}: the upfront share is 0% to 100%.`);
  }
  const sorted = [...s.bands].sort((a, b) => a.minScore - b.minScore);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.minScore <= sorted[i - 1]!.maxScore) p.push(`The bands ${sorted[i - 1]!.label} and ${sorted[i]!.label} overlap.`);
  return p;
}
export async function setFinancing(q: Queryable, actor: string, i: Partial<FinancingSettings>): Promise<FinancingSettings> {
  const next: FinancingSettings = { ...(await getFinancing(q)), ...i, bands: (i.bands ?? (await getFinancing(q)).bands).map((b) => ({ ...b, label: b.label?.trim() })) };
  const problems = financingProblems(next);
  if (problems.length) throw invalid(problems.slice(0, 4).join(' '), problems);
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('deviceFinancing', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(next), actor]);
  await audit(q, actor, 'settings', 'deviceFinancing', 'update', { required: next.creditCheckRequired, bands: next.bands.length });
  return next;
}
export const bandFor = (s: FinancingSettings, score: number): FinancingBand | null => s.bands.find((b) => score >= b.minScore && score <= b.maxScore) ?? null;

// ───────────────────────── the bureau ─────────────────────────
export interface BureauAnswer { score: number | null; upfrontMinor: number | null; reference: string | null; provider: string; source: 'BUREAU' | 'SIMULATOR' }
const dig = (o: unknown, path: string): unknown => path.split('.').filter(Boolean).reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);

/** A made-up but steady answer for trying the flow without a bureau: the score follows the last digit of the ID number (0 → 350, 9 → 890). */
export const simulatedScore = (idNumber: string): number => { const d = /(\d)\D*$/.exec(idNumber)?.[1]; return d === undefined ? 500 : 350 + Number(d) * 60; };

export async function askBureau(q: Queryable, c: { idNumber: string; fullName?: string; dateOfBirth?: string; financedMinor: number; currency: string; months: number | null; reference: string }): Promise<BureauAnswer | null> {
  const ep = await hubEndpointWithSecret(q, 'finance', 'CREDIT_BUREAU');
  if (!ep) return null;
  const cfg = ep.config as { mode?: string; idField?: string; scorePath?: string; upfrontPath?: string; upfrontUnit?: 'MINOR' | 'MAJOR'; referencePath?: string; extraBody?: Record<string, unknown>; auth?: 'BEARER' | 'HEADER'; headerName?: string };
  if (cfg.mode === 'SIMULATOR') return { score: simulatedScore(c.idNumber), upfrontMinor: null, reference: `SIM-${c.reference.slice(0, 8)}`, provider: ep.name, source: 'SIMULATOR' };
  if (!ep.url) throw new Error('The credit bureau has no address.');
  const body = JSON.stringify({ [cfg.idField || 'idNumber']: c.idNumber, fullName: c.fullName, dateOfBirth: c.dateOfBirth, requestedFinancing: { amountMinor: c.financedMinor, currency: c.currency, months: c.months }, reference: c.reference, ...(cfg.extraBody ?? {}) });
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (ep.secret) { if (cfg.auth === 'HEADER') headers[cfg.headerName || 'x-api-key'] = ep.secret; else headers.authorization = `Bearer ${ep.secret}`; }
  let last: unknown;
  for (const url of [ep.url, ep.fallbackUrl].filter(Boolean) as string[]) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(ep.timeoutMs) });
      if (!res.ok) throw new Error(`The credit bureau answered HTTP ${res.status}.`);
      const j = await res.json();
      const rawScore = dig(j, cfg.scorePath || 'score'); const rawUp = cfg.upfrontPath ? dig(j, cfg.upfrontPath) : undefined;
      const score = rawScore === undefined || rawScore === null || rawScore === '' ? null : Number(rawScore);
      const exp = currencyInfo(c.currency)?.exponent ?? 2;
      const up = rawUp === undefined || rawUp === null || rawUp === '' ? null : Math.round(Number(rawUp) * (cfg.upfrontUnit === 'MAJOR' ? 10 ** exp : 1));
      if ((score !== null && !Number.isFinite(score)) || (up !== null && !Number.isFinite(up))) throw new Error('The credit bureau answer could not be read.');
      if (score === null && up === null) throw new Error('The credit bureau answer has no score or upfront amount.');
      return { score, upfrontMinor: up, reference: cfg.referencePath ? String(dig(j, cfg.referencePath) ?? '') || null : null, provider: ep.name, source: 'BUREAU' };
    } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error('The credit bureau could not be reached.');
}

// ───────────────────────── a check ─────────────────────────
export interface CreditCheckView { id: string; customerId: string | null; score: number | null; band: string | null; ratioBps: number; upfrontMinor: number; financedMinor: number; decision: 'NO_UPFRONT' | 'UPFRONT' | 'PAY_IN_FULL'; source: string; provider: string; expiresAt: string; fallback: boolean }
const viewOf = (r: Row): CreditCheckView => ({ id: r.id, customerId: r.customerId, score: r.score, band: r.band, ratioBps: r.ratioBps, upfrontMinor: Math.round((Number(r.financedMinor) * r.ratioBps) / 10000), financedMinor: Number(r.financedMinor), decision: r.decision, source: r.source, provider: r.provider, expiresAt: String(r.expiresAt), fallback: r.source === 'FALLBACK' });

/**
 * Asks the bureau about a customer, with their consent, and records the answer. `financedMinor` is what would be financed (the device price after the subsidy).
 * The ID number is checked against the customer's stored hash first, so a typo or a different person is caught before anything is sent.
 */
export async function runCreditCheck(db: Queryable, i: { customerId?: string | null; idNumber: string; fullName?: string; dateOfBirth?: string; financedMinor: number; months?: number | null; currency: string; consent: { given: boolean; by: string; how: string }; actor: string; skipCustomerMatch?: boolean }): Promise<CreditCheckView> {
  if (!i.consent?.given) throw rejected('The customer must agree to a credit check before their ID number is sent.');
  const idNumber = (i.idNumber ?? '').trim();
  if (idNumber.length < 3 || idNumber.length > 40) throw invalid('Enter the customer’s ID number.');
  if (!Number.isInteger(i.financedMinor) || i.financedMinor <= 0) throw invalid('There is nothing to finance.');
  const idHash = hashIdDocument(idNumber);
  if (i.customerId) {
    const c = (await db.query('SELECT id_document_hash FROM customers WHERE id=$1', [i.customerId])).rows[0];
    if (!c) throw notFound('customer', i.customerId);
    if (!i.skipCustomerMatch && c.idDocumentHash !== idHash) throw rejected('That ID number is not the one this customer was registered with.');
  }
  const s = await getFinancing(db);
  const reference = crypto.randomUUID();
  let answer: BureauAnswer | null = null, failure: string | null = null;
  try { answer = await askBureau(db, { idNumber, fullName: i.fullName, dateOfBirth: i.dateOfBirth, financedMinor: i.financedMinor, currency: i.currency, months: i.months ?? null, reference }); if (!answer) failure = 'No credit bureau is set up.'; }
  catch (e) { failure = (e as Error).message; }
  let ratio: number, band: string | null = null, score: number | null = null, source: 'BUREAU' | 'SIMULATOR' | 'FALLBACK' = 'FALLBACK', provider = 'FALLBACK', providerUpfront: number | null = null, ref: string | null = null;
  if (answer) {
    source = answer.source; provider = answer.provider; score = answer.score; providerUpfront = answer.upfrontMinor; ref = answer.reference;
    if (s.providerReturns === 'UPFRONT_AMOUNT' && answer.upfrontMinor !== null) ratio = Math.min(10000, Math.round((answer.upfrontMinor * 10000) / i.financedMinor));
    else if (answer.score !== null) { const b = bandFor(s, answer.score); band = b?.label ?? null; ratio = b ? b.upfrontBps : s.fallbackUpfrontBps; }
    else { ratio = s.fallbackUpfrontBps; source = 'FALLBACK'; failure = 'The credit bureau did not return what the settings expect.'; }
  } else {
    if (s.onProviderFailure === 'BLOCK') throw rejected(`The credit check could not be done (${failure}). Try again, or ask a supervisor.`);
    ratio = s.fallbackUpfrontBps;
  }
  let up = Math.round((i.financedMinor * ratio) / 10000);
  if (ratio > 0 || (ratio === 0 && s.minUpfrontMinor > 0 && source === 'FALLBACK')) up = Math.max(up, Math.min(s.minUpfrontMinor, i.financedMinor));
  ratio = Math.min(10000, Math.round((up * 10000) / i.financedMinor));
  const decision = ratio >= 10000 ? 'PAY_IN_FULL' : ratio > 0 ? 'UPFRONT' : 'NO_UPFRONT';
  const row = (await db.query(`INSERT INTO credit_checks (customer_id, id_hash, provider, source, score, band, provider_upfront_minor, ratio_bps, financed_minor, months, currency, decision, consent, reference, expires_at, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() + ($15 || ' days')::interval, $16) RETURNING *`,
    [i.customerId ?? null, idHash, provider, source, score, band, providerUpfront, ratio, i.financedMinor, i.months ?? null, i.currency, decision, JSON.stringify({ ...i.consent, at: new Date().toISOString() }), ref, String(s.validityDays), i.actor])).rows[0]!;
  await audit(db, i.actor, 'credit_check', row.id, failure ? 'RUN_FALLBACK' : 'RUN', { customerId: i.customerId ?? null, provider, source, score, band, decision, ratioBps: ratio, failure });
  return viewOf(row);
}

/** A check that can be used for this customer's order: theirs, not expired, not used by another order. */
export async function usableCheck(q: Queryable, id: string, customerId: string | null | undefined): Promise<CreditCheckView> {
  const r = (await q.query('SELECT * FROM credit_checks WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('credit check', id);
  if (customerId && r.customerId && r.customerId !== customerId) throw rejected('That credit check belongs to another customer.');
  if (new Date(r.expiresAt) < new Date()) throw rejected('The credit check has expired. Run it again.');
  if (r.orderId) throw rejected('That credit check was already used for an order.');
  return viewOf(r);
}
export async function attachCheckToOrder(q: Queryable, id: string, orderId: string, customerId: string): Promise<void> {
  await q.query('UPDATE credit_checks SET order_id=$2, customer_id=COALESCE(customer_id,$3) WHERE id=$1 AND order_id IS NULL', [id, orderId, customerId]);
}
/** Is a bureau connection set up (so a credit check is meaningful)? */
export const bureauConfigured = async (q: Queryable) => !!(await hubEndpointWithSecret(q, 'finance', 'CREDIT_BUREAU'));
export const listChecksFor = async (q: Queryable, customerId: string): Promise<CreditCheckView[]> => (await q.query('SELECT * FROM credit_checks WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 20', [customerId])).rows.map(viewOf);

/** For the Settings page: asks the bureau about a made-up amount and shows what came back and how the settings read it. Stores nothing. */
export async function testBureau(q: Queryable, idNumber: string, financedMinor: number): Promise<{ ok: boolean; error?: string; score?: number | null; band?: string | null; providerUpfrontMinor?: number | null; ratioBps?: number; upfrontMinor?: number; source?: string }> {
  const s = await getFinancing(q);
  try {
    const a = await askBureau(q, { idNumber: idNumber.trim(), financedMinor, currency: 'XXX', months: 24, reference: crypto.randomUUID() });
    if (!a) return { ok: false, error: 'No credit bureau is set up (Integration hub → Finance → Credit bureau).' };
    let ratio: number; let band: string | null = null;
    if (s.providerReturns === 'UPFRONT_AMOUNT' && a.upfrontMinor !== null) ratio = Math.min(10000, Math.round((a.upfrontMinor * 10000) / financedMinor));
    else if (a.score !== null) { const b = bandFor(s, a.score); band = b?.label ?? null; ratio = b ? b.upfrontBps : s.fallbackUpfrontBps; } else return { ok: false, error: 'The bureau answered, but not with what the settings expect (a score, or an upfront amount).' };
    return { ok: true, score: a.score, band, providerUpfrontMinor: a.upfrontMinor, ratioBps: ratio, upfrontMinor: Math.round((financedMinor * ratio) / 10000), source: a.source };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
