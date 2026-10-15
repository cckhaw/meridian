import { looksMasked } from './mask.js';
import type { EntityDef, FieldDef, Rec } from './types.js';
import { importFields } from './entities.js';

/**
 * Turns one parsed row (cells from a CSV file, or an object from a JSON record) into a clean record, or says what is wrong with it, field by field.
 * Blank cells are left out. A text value that an export had guarded with a leading ' (so a spreadsheet would not run it as a formula) is restored.
 */
export interface Issue { field: string; code: string; message: string }
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TS = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const validDate = (s: string) => { const d = new Date(s + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; };

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');

export interface HeaderMap { cols: Array<FieldDef | null>; issues: Issue[] }
/** Matches the header row to the entity's columns. Unknown columns and missing required ones are reported. */
export function mapHeader(def: EntityDef, header: string[], aliases: Record<string, string> = {}): HeaderMap {
  const fields = importFields(def).filter((f) => !f.jsonOnly);
  const byName = new Map(fields.map((f) => [f.name, f]));
  const issues: Issue[] = [];
  const seen = new Set<string>();
  const cols = header.map((h) => {
    const n = norm(h);
    if (!n) return null;
    const f = byName.get(aliases[n] ?? n);
    if (!f) { issues.push({ field: h.trim(), code: 'UNKNOWN_COLUMN', message: `The column “${h.trim()}” is not one this data set knows.` }); return null; }
    if (seen.has(f.name)) issues.push({ field: f.name, code: 'DUPLICATE_COLUMN', message: `The column ${f.name} appears twice.` });
    seen.add(f.name);
    return f;
  });
  for (const f of fields) if (f.required && !seen.has(f.name)) issues.push({ field: f.name, code: 'MISSING_COLUMN', message: `The header row has no ${f.name} column (it is required).` });
  return { cols, issues };
}

export function coerceValue(f: FieldDef, raw: unknown): { value?: unknown; issue?: Issue } {
  const bad = (code: string, message: string) => ({ issue: { field: f.name, code, message } as Issue });
  if (raw === null || raw === undefined) return {};
  let v: unknown = raw;
  if (typeof v === 'string') {
    v = v.trim();
    if (v === '') return {};
    if (f.type === 'text' || f.type === 'ref' || f.type === 'enum') v = (v as string).replace(/^'([=@])/, '$1');
  }
  if (typeof v === 'string' && f.sensitive && looksMasked(v)) return bad('MASKED_VALUE', `${f.name} holds a masked value (“${v}”), not the real one. Masked exports cannot be loaded back; export it unmasked, or leave the column empty.`);
  const s = String(v);
  switch (f.type) {
    case 'int': case 'money': {
      if (typeof v === 'number' ? !Number.isInteger(v) : !/^-?\d{1,15}$/.test(s)) return bad('NOT_A_NUMBER', `${f.name} must be a whole number${f.type === 'money' ? ' of minor units (cents), without decimals or separators' : ''}.`);
      const n = Number(v);
      if (!Number.isSafeInteger(n)) return bad('NOT_A_NUMBER', `${f.name} is too large.`);
      return check(f, n, s);
    }
    case 'bool': {
      if (typeof v === 'boolean') return { value: v };
      const t = s.toLowerCase();
      if (['true', 'yes', 'y', '1'].includes(t)) return { value: true };
      if (['false', 'no', 'n', '0'].includes(t)) return { value: false };
      return bad('NOT_A_BOOLEAN', `${f.name} must be true or false.`);
    }
    case 'date': {
      if (!DATE.test(s) || !validDate(s)) return bad('BAD_DATE', `${f.name} must be a real date written YYYY-MM-DD.`);
      return check(f, s, s);
    }
    case 'timestamp': {
      if (!TS.test(s) || Number.isNaN(new Date(s.length === 10 ? s + 'T00:00:00Z' : s).getTime())) return bad('BAD_TIME', `${f.name} must be an ISO 8601 date and time, such as 2026-01-31T09:30:00Z.`);
      return { value: s };
    }
    case 'enum': {
      const t = s.toUpperCase();
      const hit = f.values?.find((x) => x.toUpperCase() === t);
      if (!hit) return bad('BAD_VALUE', `${f.name} must be one of ${f.values?.join(', ')} (it is “${s}”).`);
      return { value: hit };
    }
    case 'json': {
      if (typeof v === 'object') return { value: v };
      try { return { value: JSON.parse(s) }; } catch { return bad('BAD_JSON', `${f.name} must be a JSON document.`); }
    }
    case 'list': {
      const items = Array.isArray(v) ? v.map(String) : s.split('|').map((x) => x.trim()).filter(Boolean);
      return { value: items };
    }
    default: return check(f, s, s);
  }
}

function check(f: FieldDef, value: unknown, s: string): { value?: unknown; issue?: Issue } {
  if (f.max && typeof value === 'string' && value.length > f.max) return { issue: { field: f.name, code: 'TOO_LONG', message: `${f.name} is too long (at most ${f.max} characters).` } };
  if (f.pattern && !new RegExp(f.pattern).test(s)) return { issue: { field: f.name, code: 'BAD_FORMAT', message: `${f.name} “${s.length > 40 ? s.slice(0, 40) + '…' : s}” is not in the form this column takes (${f.hint}).` } };
  return { value };
}

/** One row of cells (CSV) against the mapped header. */
export function coerceCells(def: EntityDef, map: HeaderMap, cells: string[]): { rec: Rec; issues: Issue[] } {
  const rec: Rec = {}; const issues: Issue[] = [];
  map.cols.forEach((f, i) => {
    if (!f) return;
    const r = coerceValue(f, cells[i]);
    if (r.issue) issues.push(r.issue); else if (r.value !== undefined) rec[f.name] = r.value;
  });
  for (const f of importFields(def)) if (f.required && rec[f.name] === undefined && !issues.some((x) => x.field === f.name)) issues.push({ field: f.name, code: 'REQUIRED', message: `${f.name} is required.` });
  return { rec, issues };
}

/** One JSON record: any key that is not a field is reported. */
export function coerceObject(def: EntityDef, obj: Record<string, unknown>, aliases: Record<string, string> = {}): { rec: Rec; issues: Issue[] } {
  const fields = new Map(importFields(def).map((f) => [f.name, f]));
  const rec: Rec = {}; const issues: Issue[] = [];
  for (const [k, raw] of Object.entries(obj)) {
    const f = fields.get(aliases[norm(k)] ?? norm(k));
    if (!f) { if (raw !== null && raw !== undefined && raw !== '' && !Array.isArray(raw)) issues.push({ field: k, code: 'UNKNOWN_COLUMN', message: `“${k}” is not a field of this data set.` }); continue; }
    const r = coerceValue(f, raw);
    if (r.issue) issues.push(r.issue); else if (r.value !== undefined) rec[f.name] = r.value;
  }
  for (const f of fields.values()) if (f.required && !f.jsonOnly && rec[f.name] === undefined && !issues.some((x) => x.field === f.name)) issues.push({ field: f.name, code: 'REQUIRED', message: `${f.name} is required.` });
  return { rec, issues };
}
