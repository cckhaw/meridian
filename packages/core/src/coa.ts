import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { invalid, notFound } from './errors.js';
import { REVENUE_STREAMS } from './ledger.js';

/**
 * Chart-of-accounts mapping (posting rules). The sub-ledger records every line against a BSS account and, for revenue, a stream. Finance decides in the
 * admin portal which SAP G/L account, cost centre, profit centre and tax code each combination goes to, without a deployment. For one ledger line the
 * most specific matching rule wins (account, then stream, then event, then source); equally specific rules are ordered by priority (lower first).
 */
export interface CoaRule {
  id: string; name: string; priority: number;
  matchAccount: string | null; matchStream: string | null; matchEvent: string | null; matchSource: string | null;
  sapAccount: string; costCenter: string | null; profitCenter: string | null; taxCode: string | null;
  status: 'ACTIVE' | 'INACTIVE'; validFrom: string | null; validTo: string | null; note: string | null;
}
export interface RuleInput {
  name: string; priority?: number; matchAccount?: string | null; matchStream?: string | null; matchEvent?: string | null; matchSource?: string | null;
  sapAccount: string; costCenter?: string | null; profitCenter?: string | null; taxCode?: string | null; status?: 'ACTIVE' | 'INACTIVE'; validFrom?: string | null; validTo?: string | null; note?: string | null;
}
export interface LineFacts { accountCode: string; stream: string | null; eventType: string | null; sourceType: string; entryDate: string }
export interface Resolved { sapAccount: string; costCenter: string | null; profitCenter: string | null; taxCode: string | null; ruleId: string; ruleName: string }

const WEIGHT = { account: 8, stream: 4, event: 2, source: 1 };
const specificity = (r: CoaRule) => (r.matchAccount ? WEIGHT.account : 0) + (r.matchStream ? WEIGHT.stream : 0) + (r.matchEvent ? WEIGHT.event : 0) + (r.matchSource ? WEIGHT.source : 0);

/** The rule a ledger line goes by, or null when nothing covers it. Pure, so the preview in the portal and the export always agree. */
export function pickRule(rules: CoaRule[], l: LineFacts): CoaRule | null {
  let best: CoaRule | null = null;
  for (const r of rules) {
    if (r.status !== 'ACTIVE') continue;
    if (r.matchAccount && r.matchAccount !== l.accountCode) continue;
    if (r.matchStream && r.matchStream !== l.stream) continue;
    if (r.matchEvent && r.matchEvent !== l.eventType) continue;
    if (r.matchSource && r.matchSource !== l.sourceType) continue;
    if (r.validFrom && l.entryDate < r.validFrom) continue;
    if (r.validTo && l.entryDate > r.validTo) continue;
    if (!best) { best = r; continue; }
    const a = specificity(r), b = specificity(best);
    if (a > b || (a === b && r.priority < best.priority)) best = r;
  }
  return best;
}
export const resolveWith = (rules: CoaRule[], l: LineFacts): Resolved | null => {
  const r = pickRule(rules, l);
  return r ? { sapAccount: r.sapAccount, costCenter: r.costCenter, profitCenter: r.profitCenter, taxCode: r.taxCode, ruleId: r.id, ruleName: r.name } : null;
};

const code = (v: unknown, what: string, max: number, required = false): string | null => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t) { if (required) throw invalid(`${what} is needed.`); return null; }
  if (t.length > max || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t)) throw invalid(`${what} is up to ${max} letters, digits, dots or dashes.`);
  return t.toUpperCase();
};
const date = (v: unknown, what: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v).getTime())) throw invalid(`${what} is a date, like 2026-12-31.`);
  return v;
};

export function cleanRule(i: RuleInput): Omit<CoaRule, 'id'> {
  const name = (i.name ?? '').trim();
  if (name.length < 2 || name.length > 80) throw invalid('Give the rule a name of 2 to 80 characters.');
  const stream = i.matchStream ? String(i.matchStream).toUpperCase() : null;
  if (stream && !(REVENUE_STREAMS as readonly string[]).includes(stream)) throw invalid(`The stream is one of ${REVENUE_STREAMS.join(', ')}.`);
  const priority = i.priority ?? 100;
  if (!Number.isInteger(priority) || priority < 1 || priority > 9999) throw invalid('Priority is a whole number from 1 to 9999.');
  const from = date(i.validFrom, 'Valid from'), to = date(i.validTo, 'Valid to');
  if (from && to && to < from) throw invalid('The rule ends before it starts.');
  const note = (i.note ?? '').trim();
  return {
    name, priority, matchAccount: code(i.matchAccount, 'The BSS account', 10), matchStream: stream, matchEvent: code(i.matchEvent, 'The event type', 40), matchSource: code(i.matchSource, 'The source type', 20),
    sapAccount: code(i.sapAccount, 'The SAP G/L account', 10, true)!, costCenter: code(i.costCenter, 'The cost centre', 10), profitCenter: code(i.profitCenter, 'The profit centre', 10), taxCode: code(i.taxCode, 'The tax code', 4),
    status: i.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE', validFrom: from, validTo: to, note: note.slice(0, 200) || null,
  };
}

export async function listCoaRules(q: Queryable): Promise<CoaRule[]> {
  return (await q.query(`SELECT id, name, priority, match_account, match_stream, match_event, match_source, sap_account, cost_center, profit_center, tax_code, status, valid_from::text AS valid_from, valid_to::text AS valid_to, note
                           FROM coa_mappings ORDER BY match_account NULLS LAST, match_stream NULLS FIRST, priority, name`)).rows as CoaRule[];
}
export async function createCoaRule(q: Queryable, actor: string, i: RuleInput): Promise<CoaRule> {
  const r = cleanRule(i);
  const id = randomUUID();
  await q.query(`INSERT INTO coa_mappings (id, name, priority, match_account, match_stream, match_event, match_source, sap_account, cost_center, profit_center, tax_code, status, valid_from, valid_to, note, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, r.name, r.priority, r.matchAccount, r.matchStream, r.matchEvent, r.matchSource, r.sapAccount, r.costCenter, r.profitCenter, r.taxCode, r.status, r.validFrom, r.validTo, r.note, actor]);
  await audit(q, actor, 'coa_mapping', id, 'CREATED', { ...r });
  return (await listCoaRules(q)).find((x) => x.id === id)!;
}
export async function updateCoaRule(q: Queryable, actor: string, id: string, i: RuleInput): Promise<CoaRule> {
  if (!(await q.query('SELECT 1 FROM coa_mappings WHERE id=$1', [id])).rows.length) throw notFound('posting rule', id);
  const r = cleanRule(i);
  await q.query(`UPDATE coa_mappings SET name=$2, priority=$3, match_account=$4, match_stream=$5, match_event=$6, match_source=$7, sap_account=$8, cost_center=$9, profit_center=$10, tax_code=$11, status=$12, valid_from=$13, valid_to=$14, note=$15, updated_at=now() WHERE id=$1`,
    [id, r.name, r.priority, r.matchAccount, r.matchStream, r.matchEvent, r.matchSource, r.sapAccount, r.costCenter, r.profitCenter, r.taxCode, r.status, r.validFrom, r.validTo, r.note]);
  await audit(q, actor, 'coa_mapping', id, 'UPDATED', { ...r });
  return (await listCoaRules(q)).find((x) => x.id === id)!;
}
export async function deleteCoaRule(q: Queryable, actor: string, id: string): Promise<void> {
  const r = await q.query('DELETE FROM coa_mappings WHERE id=$1', [id]);
  if (!r.rowCount) throw notFound('posting rule', id);
  await audit(q, actor, 'coa_mapping', id, 'DELETED', {});
}

/** What a ledger line would be posted to, for the "try it" box. */
export async function previewCoaRule(q: Queryable, f: { accountCode: string; stream?: string | null; eventType?: string | null; sourceType?: string; entryDate?: string }): Promise<Resolved | null> {
  return resolveWith(await listCoaRules(q), { accountCode: f.accountCode.trim(), stream: f.stream || null, eventType: f.eventType || null, sourceType: f.sourceType ?? 'INVOICE', entryDate: f.entryDate ?? new Date().toISOString().slice(0, 10) });
}

/** The kinds of ledger line waiting to be exported that no active rule covers: Finance fixes these before the next run, and an export refuses to go with them. */
export async function unmappedLines(q: Queryable, rules?: CoaRule[]): Promise<Array<{ accountCode: string; stream: string | null; eventType: string | null; sourceType: string; lines: number }>> {
  const rs = rules ?? (await listCoaRules(q));
  const kinds = (await q.query(
    `SELECT account_code, stream, event_type, source_type, min(entry_date)::text AS entry_date, max(entry_date)::text AS last_date, count(*)::int AS lines
       FROM gl_entries WHERE exported_batch_id IS NULL GROUP BY account_code, stream, event_type, source_type ORDER BY account_code, stream NULLS FIRST`)).rows;
  return kinds.filter((k) => !pickRule(rs, { accountCode: k.accountCode, stream: k.stream, eventType: k.eventType, sourceType: k.sourceType, entryDate: k.entryDate })
                          || !pickRule(rs, { accountCode: k.accountCode, stream: k.stream, eventType: k.eventType, sourceType: k.sourceType, entryDate: k.lastDate }))
    .map((k) => ({ accountCode: k.accountCode, stream: k.stream, eventType: k.eventType, sourceType: k.sourceType, lines: k.lines }));
}
export type { Row };
