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

/**
 * The limits a posting rule is checked against. ONE definition: `cleanRule` enforces them, the API sends them to the Finance screen (`GET /finance/meta`), and
 * the screen's inputs (min, max, maxLength, counters) read them from there, so the screen allows exactly what the server accepts and the browser bundle never
 * imports this file.
 */
export const COA_LIMITS = {
  nameMin: 2, nameMax: 80,
  priorityMin: 1, priorityMax: 9999, priorityDefault: 100,
  /** BSS ledger account, event type, source type. */
  accountMax: 10, eventMax: 40, sourceMax: 20,
  /** SAP side. */
  sapAccountMax: 10, costCenterMax: 10, profitCenterMax: 10, taxCodeMax: 4,
  /** The note is free text and is shortened to this (the one field that is shortened rather than refused; the result says so). */
  noteMax: 200,
  /** What the API accepts on the wire for any text field, so that core, not the schema, gives the precise message (and the note warning). */
  inputMax: 1000,
} as const;

/** One thing `cleanRule` changed on the way in: the caller shows it after saving. */
export interface RuleAdjustment { field: keyof RuleInput; label: string; kind: 'SHORTENED' | 'UPPERCASED' | 'TRIMMED'; from: string; to: string; message: string }
export type SavedCoaRule = CoaRule & { adjustments: RuleAdjustment[] };

const FIELD_LABEL: Partial<Record<keyof RuleInput, string>> = { name: 'Name', matchAccount: 'Ledger account', matchStream: 'Revenue stream', matchEvent: 'Event', matchSource: 'Source', sapAccount: 'SAP G/L account', costCenter: 'Cost centre', profitCenter: 'Profit centre', taxCode: 'Tax code', note: 'Note' };

function cleaner(adj: RuleAdjustment[]) {
  const note = (field: keyof RuleInput, kind: RuleAdjustment['kind'], from: string, to: string, message: string) => { adj.push({ field, label: FIELD_LABEL[field] ?? String(field), kind, from, to, message }); };
  const text = (field: keyof RuleInput, v: unknown): string => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') throw invalid(`${FIELD_LABEL[field] ?? field} must be text.`);
    const t = v.trim();
    if (t !== v && t) note(field, 'TRIMMED', v, t, `${FIELD_LABEL[field]}: spaces at the start and end were removed.`);
    return t;
  };
  const code = (field: keyof RuleInput, v: unknown, what: string, max: number, required = false): string | null => {
    const t = text(field, v);
    if (!t) { if (required) throw invalid(`${what} is needed.`); return null; }
    if (t.length > max || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t)) throw invalid(`${what} is up to ${max} letters, digits, dots or dashes.`);
    const up = t.toUpperCase();
    if (up !== t) note(field, 'UPPERCASED', t, up, `${FIELD_LABEL[field]}: saved in capitals (${t} became ${up}).`);
    return up;
  };
  return { note, text, code };
}
const date = (v: unknown, what: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(v).getTime())) throw invalid(`${what} is a date, like 2026-12-31.`);
  return v;
};

/**
 * Checks a rule and puts it in its stored form. Nothing is changed silently: a value that is wrong is refused with a message, and the only things done to a
 * value that is accepted are listed in `adjustments`: spaces at the ends removed, codes put in capitals, and the note shortened to COA_LIMITS.noteMax.
 */
export function cleanRuleChecked(i: RuleInput): { rule: Omit<CoaRule, 'id'>; adjustments: RuleAdjustment[] } {
  const adjustments: RuleAdjustment[] = [];
  const c = cleaner(adjustments), L = COA_LIMITS;
  const name = c.text('name', i.name);
  if (name.length < L.nameMin || name.length > L.nameMax) throw invalid(`Give the rule a name of ${L.nameMin} to ${L.nameMax} characters.`);
  const stream = c.code('matchStream', i.matchStream, 'The stream', 40);
  if (stream && !(REVENUE_STREAMS as readonly string[]).includes(stream)) throw invalid(`The stream is one of ${REVENUE_STREAMS.join(', ')}.`);
  const priority = i.priority ?? L.priorityDefault;
  if (!Number.isInteger(priority) || priority < L.priorityMin || priority > L.priorityMax) throw invalid(`Priority is a whole number from ${L.priorityMin} to ${L.priorityMax}.`);
  const from = date(i.validFrom, 'Valid from'), to = date(i.validTo, 'Valid to');
  if (from && to && to < from) throw invalid('The rule ends before it starts.');
  if (i.status !== undefined && i.status !== 'ACTIVE' && i.status !== 'INACTIVE') throw invalid('The status is active or inactive.');
  let note: string | null = c.text('note', i.note);
  if (note.length > L.noteMax) {
    const short = note.slice(0, L.noteMax);
    c.note('note', 'SHORTENED', note, short, `Note: only the first ${L.noteMax} characters were kept (${note.length - L.noteMax} dropped).`);
    note = short;
  }
  const rule: Omit<CoaRule, 'id'> = {
    name, priority, matchAccount: c.code('matchAccount', i.matchAccount, 'The BSS account', L.accountMax), matchStream: stream, matchEvent: c.code('matchEvent', i.matchEvent, 'The event type', L.eventMax), matchSource: c.code('matchSource', i.matchSource, 'The source type', L.sourceMax),
    sapAccount: c.code('sapAccount', i.sapAccount, 'The SAP G/L account', L.sapAccountMax, true)!, costCenter: c.code('costCenter', i.costCenter, 'The cost centre', L.costCenterMax), profitCenter: c.code('profitCenter', i.profitCenter, 'The profit centre', L.profitCenterMax), taxCode: c.code('taxCode', i.taxCode, 'The tax code', L.taxCodeMax),
    status: i.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE', validFrom: from, validTo: to, note: note || null,
  };
  return { rule, adjustments };
}
export const cleanRule = (i: RuleInput): Omit<CoaRule, 'id'> => cleanRuleChecked(i).rule;

export async function listCoaRules(q: Queryable): Promise<CoaRule[]> {
  return (await q.query(`SELECT id, name, priority, match_account, match_stream, match_event, match_source, sap_account, cost_center, profit_center, tax_code, status, valid_from::text AS valid_from, valid_to::text AS valid_to, note
                           FROM coa_mappings ORDER BY match_account NULLS LAST, match_stream NULLS FIRST, priority, name`)).rows as CoaRule[];
}
export async function createCoaRule(q: Queryable, actor: string, i: RuleInput): Promise<SavedCoaRule> {
  const { rule: r, adjustments } = cleanRuleChecked(i);
  const id = randomUUID();
  await q.query(`INSERT INTO coa_mappings (id, name, priority, match_account, match_stream, match_event, match_source, sap_account, cost_center, profit_center, tax_code, status, valid_from, valid_to, note, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, r.name, r.priority, r.matchAccount, r.matchStream, r.matchEvent, r.matchSource, r.sapAccount, r.costCenter, r.profitCenter, r.taxCode, r.status, r.validFrom, r.validTo, r.note, actor]);
  await audit(q, actor, 'coa_mapping', id, 'CREATED', { ...r });
  return { ...(await listCoaRules(q)).find((x) => x.id === id)!, adjustments };
}
export async function updateCoaRule(q: Queryable, actor: string, id: string, i: RuleInput): Promise<SavedCoaRule> {
  if (!(await q.query('SELECT 1 FROM coa_mappings WHERE id=$1', [id])).rows.length) throw notFound('posting rule', id);
  const { rule: r, adjustments } = cleanRuleChecked(i);
  await q.query(`UPDATE coa_mappings SET name=$2, priority=$3, match_account=$4, match_stream=$5, match_event=$6, match_source=$7, sap_account=$8, cost_center=$9, profit_center=$10, tax_code=$11, status=$12, valid_from=$13, valid_to=$14, note=$15, updated_at=now() WHERE id=$1`,
    [id, r.name, r.priority, r.matchAccount, r.matchStream, r.matchEvent, r.matchSource, r.sapAccount, r.costCenter, r.profitCenter, r.taxCode, r.status, r.validFrom, r.validTo, r.note]);
  await audit(q, actor, 'coa_mapping', id, 'UPDATED', { ...r });
  return { ...(await listCoaRules(q)).find((x) => x.id === id)!, adjustments };
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
