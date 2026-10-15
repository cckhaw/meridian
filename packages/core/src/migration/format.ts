import { csvCell } from '../csv.js';
import type { EntityDef, FieldDef, Rec } from './types.js';
import { exportFields } from './entities.js';

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** A field's value from a row read from the database (camelCased) or built by hand (named as the file column). */
export const valueOf = (r: Rec, name: string): unknown => (name in r ? r[name] : r[camel(name)]);

/** A value as the text of a CSV cell: lists with |, documents as JSON, nothing as empty. */
export function cellText(f: FieldDef, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return f.type === 'list' ? v.join('|') : JSON.stringify(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Spreadsheets treat a cell that starts with = + - @ as a formula. Text fields get a leading apostrophe-free guard only where it cannot change a number. */
const FORMULA = /^[=@]/;
const guard = (f: FieldDef, s: string) => (f.type === 'text' && FORMULA.test(s) ? `'${s}` : s);

export const csvHeader = (def: EntityDef) => exportFields(def).filter((f) => !f.jsonOnly).map((f) => f.name).join(',') + '\r\n';
export const csvRow = (def: EntityDef, r: Rec) => exportFields(def).filter((f) => !f.jsonOnly).map((f) => csvCell(guard(f, cellText(f, valueOf(r, f.name))))).join(',') + '\r\n';

/** A row as a JSON document: typed values (numbers stay numbers), the fields of the definition in order, nothing the file layout leaves out. */
export function jsonRecord(def: EntityDef, r: Rec): Rec {
  const o: Rec = {};
  for (const f of exportFields(def)) o[f.name] = valueOf(r, f.name) ?? null;
  return o;
}
