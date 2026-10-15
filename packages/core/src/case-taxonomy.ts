import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { conflict, invalid, notFound } from './errors.js';

/**
 * Case taxonomy and SLA matrix. Cases are classified Category → Sub-category → Issue type (for example Broadband / Fiber → No signal / down → LOS red light on).
 * The levels are rows of one table, so an operator adds, renames or switches off any of them in Settings. Only an issue type carries behaviour: the kind of case it
 * makes, how severe it usually is, whether it normally needs a technician, and the skills and equipment that visit needs. Nodes that cases point at are
 * never deleted, only switched off.
 */
export const SEVERITIES = ['CRITICAL_OUTAGE', 'MAJOR_DEGRADATION', 'MINOR_INQUIRY'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const TIERS = ['VIP', 'ENTERPRISE', 'STANDARD'] as const;
export type Tier = (typeof TIERS)[number];
export const CASE_TYPES = ['FIBER_ASSURANCE', 'BILLING_REFUND', 'MNP_PORT_OUT', 'GENERAL'] as const;
export type CaseType = (typeof CASE_TYPES)[number];
/** What the old four-level priority becomes: priority is now derived from severity. */
export const PRIORITY_OF: Record<Severity, string> = { CRITICAL_OUTAGE: 'URGENT', MAJOR_DEGRADATION: 'HIGH', MINOR_INQUIRY: 'NORMAL' };

export interface CaseTaxonomyNode {
  id: string; parentId: string | null; level: 1 | 2 | 3; name: string; description: string | null; active: boolean; sortOrder: number;
  caseType: CaseType | null; defaultSeverity: Severity | null; needsDispatch: boolean; skills: string[]; equipment: string[]; children?: CaseTaxonomyNode[];
}

export async function listCaseTaxonomy(q: Queryable, o: { activeOnly?: boolean } = {}): Promise<CaseTaxonomyNode[]> {
  const rows = (await q.query(`SELECT * FROM case_taxonomy ${o.activeOnly ? 'WHERE active' : ''} ORDER BY level, sort_order, name`)).rows as unknown as CaseTaxonomyNode[];
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] as CaseTaxonomyNode[] }]));
  const roots: CaseTaxonomyNode[] = [];
  for (const n of byId.values()) (n.parentId ? byId.get(n.parentId)?.children!.push(n) : roots.push(n));
  return roots;
}

export async function getCaseNode(q: Queryable, id: string): Promise<CaseTaxonomyNode> {
  const r = (await q.query('SELECT * FROM case_taxonomy WHERE id=$1', [id])).rows[0];
  if (!r) throw notFound('Case classification', id);
  return r as unknown as CaseTaxonomyNode;
}

/** An issue type, with the readable path from its category ("Broadband / Fiber › No signal / down › LOS red light on"). */
export async function issueType(q: Queryable, id: string): Promise<CaseTaxonomyNode & { path: string; categoryId: string; subCategoryId: string }> {
  const n = await getCaseNode(q, id);
  if (n.level !== 3) throw invalid('Choose an issue type: the third level of the classification.');
  const sub = await getCaseNode(q, n.parentId!), cat = await getCaseNode(q, sub.parentId!);
  if (!n.active || !sub.active || !cat.active) throw invalid(`“${n.name}” is switched off.`);
  return { ...n, path: `${cat.name} › ${sub.name} › ${n.name}`, categoryId: cat.id, subCategoryId: sub.id };
}

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const words = (a: unknown, what: string) => { if (a === undefined) return undefined; if (!Array.isArray(a) || a.some((x) => typeof x !== 'string' || !/^[A-Z0-9_]{2,40}$/.test(x))) throw invalid(`${what} are codes in capitals, such as FIBER_SPLICING.`); return a as string[]; };

export interface CaseNodeInput { name: string; parentId?: string | null; description?: string | null; sortOrder?: number; active?: boolean; caseType?: CaseType; defaultSeverity?: Severity; needsDispatch?: boolean; skills?: string[]; equipment?: string[] }

export async function createCaseNode(q: Queryable, actor: string, i: CaseNodeInput): Promise<CaseTaxonomyNode> {
  const name = (i.name ?? '').trim();
  if (!name || name.length > 80) throw invalid('Give it a name of 1–80 characters.');
  const parent = i.parentId ? await getCaseNode(q, i.parentId) : null;
  if (parent && parent.level === 3) throw invalid('An issue type is the last level: nothing goes below it.');
  const level = (parent ? parent.level + 1 : 1) as 1 | 2 | 3;
  let id = (parent ? `${parent.id}.` : '') + slug(name);
  if (!slug(name)) throw invalid('The name needs letters or digits.');
  if ((await q.query('SELECT 1 FROM case_taxonomy WHERE id=$1', [id])).rows.length) id += `-${Math.random().toString(36).slice(2, 5)}`;
  if (level === 3) {
    if (!i.caseType || !CASE_TYPES.includes(i.caseType)) throw invalid(`An issue type needs a kind of case: ${CASE_TYPES.join(', ')}.`);
    if (!i.defaultSeverity || !SEVERITIES.includes(i.defaultSeverity)) throw invalid(`An issue type needs a usual severity: ${SEVERITIES.join(', ')}.`);
  }
  await q.query(
    `INSERT INTO case_taxonomy (id, parent_id, level, name, description, sort_order, active, case_type, default_severity, needs_dispatch, skills, equipment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, parent?.id ?? null, level, name, i.description ?? null, i.sortOrder ?? 100, i.active ?? true, level === 3 ? i.caseType : null, level === 3 ? i.defaultSeverity : null,
      level === 3 && !!i.needsDispatch, level === 3 ? words(i.skills, 'Skills') ?? [] : [], level === 3 ? words(i.equipment, 'Equipment') ?? [] : []]);
  await audit(q, actor, 'case_taxonomy', id, 'CREATE', { name, level });
  return getCaseNode(q, id);
}

export async function updateCaseNode(q: Queryable, actor: string, id: string, p: Partial<CaseNodeInput>): Promise<CaseTaxonomyNode> {
  const cur = await getCaseNode(q, id);
  if (p.name !== undefined && (!p.name.trim() || p.name.length > 80)) throw invalid('Give it a name of 1–80 characters.');
  if (cur.level === 3) {
    if (p.caseType !== undefined && !CASE_TYPES.includes(p.caseType)) throw invalid(`The kind of case is one of ${CASE_TYPES.join(', ')}.`);
    if (p.defaultSeverity !== undefined && !SEVERITIES.includes(p.defaultSeverity)) throw invalid(`The usual severity is one of ${SEVERITIES.join(', ')}.`);
  }
  const l3 = cur.level === 3;
  await q.query(
    `UPDATE case_taxonomy SET name=COALESCE($2,name), description=COALESCE($3,description), sort_order=COALESCE($4,sort_order), active=COALESCE($5,active),
       case_type=COALESCE($6,case_type), default_severity=COALESCE($7,default_severity), needs_dispatch=COALESCE($8,needs_dispatch), skills=COALESCE($9,skills), equipment=COALESCE($10,equipment) WHERE id=$1`,
    [id, p.name?.trim() ?? null, p.description ?? null, p.sortOrder ?? null, p.active ?? null, l3 ? p.caseType ?? null : null, l3 ? p.defaultSeverity ?? null : null,
      l3 && p.needsDispatch !== undefined ? p.needsDispatch : null, l3 ? words(p.skills, 'Skills') ?? null : null, l3 ? words(p.equipment, 'Equipment') ?? null : null]);
  await audit(q, actor, 'case_taxonomy', id, 'UPDATE', { ...p });
  return getCaseNode(q, id);
}

export async function deleteCaseNode(q: Queryable, actor: string, id: string) {
  await getCaseNode(q, id);
  if ((await q.query('SELECT 1 FROM case_taxonomy WHERE parent_id=$1 LIMIT 1', [id])).rows.length) throw conflict('Remove what is below it first, or switch it off.');
  if ((await q.query('SELECT 1 FROM cases WHERE issue_type_id=$1 LIMIT 1', [id])).rows.length) throw conflict('Cases use this issue type, so it is kept. Switch it off instead.');
  await q.query('DELETE FROM case_taxonomy WHERE id=$1', [id]);
  await audit(q, actor, 'case_taxonomy', id, 'DELETE', {});
  return { ok: true };
}

// ───────────────────────── SLA matrix ─────────────────────────
export interface SlaRow { tier: Tier; severity: Severity; firstResponseMinutes: number; resolutionMinutes: number; warnPercent: number }
export const listSla = async (q: Queryable): Promise<SlaRow[]> => (await q.query(`SELECT tier, severity, first_response_minutes, resolution_minutes, warn_percent FROM case_sla_config ORDER BY array_position(ARRAY['VIP','ENTERPRISE','STANDARD'], tier), array_position(ARRAY['CRITICAL_OUTAGE','MAJOR_DEGRADATION','MINOR_INQUIRY'], severity)`)).rows as unknown as SlaRow[];

export async function slaFor(q: Queryable, tier: Tier, severity: Severity): Promise<SlaRow> {
  const r = (await q.query('SELECT tier, severity, first_response_minutes, resolution_minutes, warn_percent FROM case_sla_config WHERE tier=$1 AND severity=$2', [tier, severity])).rows[0];
  if (!r) throw invalid(`No SLA is set for ${tier} / ${severity}.`);
  return r as unknown as SlaRow;
}

export async function setSla(q: Queryable, actor: string, rows: SlaRow[]): Promise<SlaRow[]> {
  for (const r of rows) {
    if (!TIERS.includes(r.tier) || !SEVERITIES.includes(r.severity)) throw invalid('Unknown tier or severity.');
    if (![r.firstResponseMinutes, r.resolutionMinutes].every((n) => Number.isInteger(n) && n > 0 && n <= 525_600)) throw invalid('Times are whole minutes, from 1 to a year.');
    if (r.firstResponseMinutes > r.resolutionMinutes) throw invalid(`${r.tier} / ${r.severity}: the first response cannot be due after the resolution.`);
    if (!Number.isInteger(r.warnPercent) || r.warnPercent < 1 || r.warnPercent > 99) throw invalid('The warning point is a percentage from 1 to 99.');
  }
  for (const r of rows) {
    await q.query(`INSERT INTO case_sla_config (tier, severity, first_response_minutes, resolution_minutes, warn_percent, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (tier, severity) DO UPDATE SET first_response_minutes=EXCLUDED.first_response_minutes, resolution_minutes=EXCLUDED.resolution_minutes, warn_percent=EXCLUDED.warn_percent, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [r.tier, r.severity, r.firstResponseMinutes, r.resolutionMinutes, r.warnPercent, actor]);
  }
  await audit(q, actor, 'case_sla', 'matrix', 'UPDATE', { rows: rows.length });
  return listSla(q);
}

// ───────────────────────── case settings ─────────────────────────
export interface CaseSettings { autoCloseHours: number; reopenDays: number; customerResponseHours: number }
export const DEFAULT_CASE_SETTINGS: CaseSettings = { autoCloseHours: 72, reopenDays: 14, customerResponseHours: 72 };
export async function getCaseSettings(q: Queryable): Promise<CaseSettings> {
  const v = (await q.query(`SELECT value FROM settings WHERE key='cases'`)).rows[0]?.value as Partial<CaseSettings> | undefined;
  return { ...DEFAULT_CASE_SETTINGS, ...(v ?? {}) };
}
export async function setCaseSettings(q: Queryable, actor: string, s: CaseSettings): Promise<CaseSettings> {
  for (const [k, max] of [['autoCloseHours', 24 * 90], ['reopenDays', 365], ['customerResponseHours', 24 * 90]] as const) {
    const n = s[k]; if (!Number.isInteger(n) || n < 1 || n > max) throw invalid(`${k} is a whole number from 1 to ${max}.`);
  }
  await q.query(`INSERT INTO settings (key, value, updated_by) VALUES ('cases', $1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(s), actor]);
  await audit(q, actor, 'settings', 'cases', 'update', { ...s });
  return s;
}
export type { Row };
