import type { Queryable, Row } from './db.js';
import { invalid, notFound } from './errors.js';

/**
 * Bundle discounts: "fibre + a phone plan = 10% off the phone".
 * A rule lists what must be in the order (`when`) and which line gets the discount (`target`). Entries are `kind:SIM_DEVICE` (any offer of that
 * kind) or `offer:<id>`. The discount comes off the target line's upfront price: a percentage (`percentBps`) or a fixed amount per unit (`amountMinor`).
 */
export interface BundleRule { id: string; name: string; status: string; when: string[]; target: string; percentBps?: number; amountMinor?: number }

const TOKEN = /^(kind|offer):[A-Za-z0-9_-]{1,80}$/;
export function validateRule(r: { id?: string; name?: string; when?: string[]; target?: string; percentBps?: number; amountMinor?: number }): string[] {
  const errs: string[] = [];
  if (!r.id || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(r.id)) errs.push('rule id may contain lowercase letters, digits and dashes');
  if (!r.name?.trim()) errs.push('give the rule a name customers and agents will recognise');
  if (!r.when?.length || r.when.length > 6 || r.when.some((w) => !TOKEN.test(w))) errs.push('“when” needs 1-6 entries like kind:FIBER or offer:plan-sim-5g');
  if (!r.target || !TOKEN.test(r.target)) errs.push('choose what gets the discount, like kind:SIM_DEVICE');
  if ((r.percentBps === undefined) === (r.amountMinor === undefined)) errs.push('set either a percentage or a fixed amount');
  if (r.percentBps !== undefined && (!Number.isInteger(r.percentBps) || r.percentBps < 1 || r.percentBps > 10_000)) errs.push('the percentage must be between 0.01% and 100%');
  if (r.amountMinor !== undefined && (!Number.isInteger(r.amountMinor) || r.amountMinor < 1)) errs.push('the amount must be a positive whole number of minor units');
  return errs;
}

const fromRow = (r: Row): BundleRule => ({ id: r.id, name: r.name, status: r.status, ...r.data });

export async function listBundleRules(q: Queryable, status?: string): Promise<BundleRule[]> {
  return (await q.query(`SELECT * FROM bundle_rules ${status ? 'WHERE status=$1' : ''} ORDER BY name, id`, status ? [status] : [])).rows.map(fromRow);
}

export async function saveBundleRule(q: Queryable, r: Omit<BundleRule, 'status'> & { status?: string }, create: boolean): Promise<BundleRule> {
  const errs = validateRule(r);
  if (errs.length) throw invalid(errs.join(' '), errs);
  const data = { when: r.when, target: r.target, ...(r.percentBps !== undefined ? { percentBps: r.percentBps } : { amountMinor: r.amountMinor }) };
  if (create) {
    if ((await q.query('SELECT 1 FROM bundle_rules WHERE id=$1', [r.id])).rows.length) throw invalid(`a rule called ${r.id} already exists`);
    await q.query('INSERT INTO bundle_rules (id, name, status, data) VALUES ($1,$2,$3,$4)', [r.id, r.name, r.status ?? 'ACTIVE', JSON.stringify(data)]);
  } else {
    const n = await q.query('UPDATE bundle_rules SET name=$2, status=COALESCE($3, status), data=$4 WHERE id=$1', [r.id, r.name, r.status ?? null, JSON.stringify(data)]);
    if (!n.rowCount) throw notFound('bundle rule', r.id);
  }
  return fromRow((await q.query('SELECT * FROM bundle_rules WHERE id=$1', [r.id])).rows[0]!);
}

export async function deleteBundleRule(q: Queryable, id: string) {
  if (!(await q.query('DELETE FROM bundle_rules WHERE id=$1', [id])).rowCount) throw notFound('bundle rule', id);
}

export interface RuleLine { offerId: string; kind: string }
export const matches = (token: string, l: RuleLine) => (token.startsWith('kind:') ? l.kind === token.slice(5) : l.offerId === token.slice(6));
/** True when every `when` entry is met by some line. */
export const ruleSatisfied = (r: Pick<BundleRule, 'when'>, lines: RuleLine[]) => r.when.every((w) => lines.some((l) => matches(w, l)));
