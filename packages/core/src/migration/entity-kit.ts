import type { Queryable } from '../db.js';
import type { EntityDef, FieldDef, ReadPage, Rec } from './types.js';

/**
 * Every record type the migration engine knows. Reads use keyset paging only (never OFFSET): a page costs the same at row one and at row twenty million,
 * and each page follows the table's own index order. A composite cursor is its parts joined with "|".
 */
export type Kt = 'uuid' | 'text' | 'bigint' | 'int' | 'smallint';
export interface KeysetOptions { select: string; from: string; where?: string; order: string[]; types: Kt[]; keyOf: (r: Rec) => unknown[] }

export async function keyset(q: Queryable, o: KeysetOptions, after: string | null, limit: number): Promise<ReadPage> {
  const parts = after ? after.split('|').map(decodeURIComponent) : null;
  const cond = parts ? `(${o.order.join(', ')}) > (${parts.map((_, i) => `$${i + 2}::${o.types[i]}`).join(', ')})` : 'TRUE';
  const rows = (await q.query(`SELECT ${o.select} FROM ${o.from} WHERE ${o.where ?? 'TRUE'} AND ${cond} ORDER BY ${o.order.join(', ')} LIMIT $1`, [limit + 1, ...(parts ?? [])])).rows as Rec[];
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, next: more && last ? o.keyOf(last).map((p) => encodeURIComponent(String(p))).join('|') : null };
}
/** A table read in order of one column. */
export const simple = (o: { select: string; from: string; where?: string; key: string; type: Kt; field: string }) => (q: Queryable, after: string | null, limit: number) =>
  keyset(q, { select: o.select, from: o.from, where: o.where, order: [o.key], types: [o.type], keyOf: (r) => [r[o.field]] }, after, limit);

/** Rows of a child table for a page of parent keys. */
export const children = (o: { select: string; from: string; col: string; type: 'uuid' | 'text'; order: string }) => async (q: Queryable, field: string, keys: string[]): Promise<Rec[]> => {
  if (field !== o.col) throw new Error(`cannot nest ${o.from} by ${field}`);
  return (await q.query(`SELECT ${o.select} FROM ${o.from} WHERE ${o.col} = ANY($1::${o.type}[]) ORDER BY ${o.order}`, [keys])).rows as Rec[];
};
export const f = (name: string, type: FieldDef['type'], hint: string, example: string, more: Partial<FieldDef> = {}): FieldDef => ({ name, type, hint, example, ...more });
export const ACTIVE = ['ACTIVE', 'INACTIVE'];

// ───────────────────────── compact definitions for plain tables ─────────────────────────
const TYPES: Record<string, FieldDef['type']> = { t: 'text', i: 'int', m: 'money', d: 'date', ts: 'timestamp', b: 'bool', j: 'json', r: 'ref', l: 'list', e: 'enum' };
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const human = (s: string) => { const w = s.replace(/_/g, ' ').replace(/\bid\b/, 'key').replace(/\bminor\b/, '(minor units)').replace(/\bbps\b/, '(basis points)'); return w.charAt(0).toUpperCase() + w.slice(1); };
/** Keys whose value must never leave the system in a file, wherever they sit in a JSON document. */
const SECRET_KEY = /secret|password|passphrase|token|credential|private|api_?key|authorization|bearer/i;
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Rec).map(([k, x]) => [k, SECRET_KEY.test(k) ? (x ? '(not exported)' : x) : redact(x)]));
  return v;
}

/**
 * One column of a plain table, in a single string: `name[:type][*][!m|!p][=ref][?hint]`.
 * Types: t text (default), i whole number, m money in minor units, d date, ts timestamp, b true/false, j JSON, r reference to another data set (`=entity`), l list, e enum (`=A|B`).
 * `_minor` columns are money and `_at` columns timestamps without saying so. `*` is required, `!m` masks the value in a masked export, `!p` replaces it with a keyed code.
 */
export function col(spec: string): FieldDef {
  const [head, hint] = spec.split('?') as [string, string | undefined];
  const m = /^([a-z0-9_]+)(?::([a-z]+))?(\*)?(?:!([mp]))?(?:=(.+))?$/.exec(head!.trim());
  if (!m) throw new Error(`bad column spec ${spec}`);
  const [, name, ty, req, sens, tail] = m as unknown as [string, string, string | undefined, string | undefined, 'm' | 'p' | undefined, string | undefined];
  const type = ty ? TYPES[ty]! : name.endsWith('_minor') ? 'money' : name.endsWith('_at') ? 'timestamp' : 'text';
  const d: FieldDef = { name, type, hint: hint ?? human(name), example: '' };
  if (req) d.required = true;
  if (sens) d.sensitive = sens === 'm' ? 'MASK' : 'PSEUDONYM';
  if (type === 'ref' && tail) d.ref = tail;
  if (type === 'enum' && tail) d.values = tail.split('|');
  return d;
}

export interface TableSpec {
  id: string; label: string; domain: EntityDef['domain']; phase: EntityDef['phase']; table: string; description: string; note?: string;
  dependsOn?: string[];
  /** The columns that go in the file. A column that holds a secret is left out here, not masked. */
  cols: string[];
  /** The key the table is read in order of (default `id` uuid). */
  key?: Array<[string, Kt]>;
  /** Columns read only to page by (not in the file). */
  from?: string; where?: string;
  /** JSON: rows of this table can be nested under a parent through this column. */
  parent?: { col: string; type: 'uuid' | 'text'; order?: string };
  nest?: EntityDef['nest'];
  /** JSON columns whose secrets (keys that look like a secret, password or token) are replaced before the row leaves. */
  scrub?: string[];
}
export function tbl(s: TableSpec): EntityDef {
  const fields = s.cols.map(col);
  const key = s.key ?? [['id', 'uuid']];
  const names = fields.map((x) => x.name);
  const select = [...names, ...key.map((k) => k[0]).filter((k) => !names.includes(k))].join(', ');
  const order = key.map((k) => k[0]);
  const scrub = (rows: Rec[]) => (s.scrub?.length ? rows.map((r) => { const o = { ...r }; for (const c of s.scrub!) if (camel(c) in o) o[camel(c)] = redact(o[camel(c)]); return o; }) : rows);
  const from = s.from ?? s.table;
  const def: EntityDef = {
    id: s.id, label: s.label, domain: s.domain, phase: s.phase, description: s.description, note: s.note, fields, dependsOn: s.dependsOn ?? [], importable: false, table: s.table, nest: s.nest,
    async read(q, after, limit) { const p = await keyset(q, { select, from, where: s.where, order, types: key.map((k) => k[1]), keyOf: (r) => key.map((k) => r[camel(k[0])]) }, after, limit); return { rows: scrub(p.rows), next: p.next }; },
  };
  if (s.parent) {
    const p = s.parent;
    def.byParent = async (q, field, keys) => {
      if (field !== p.col) throw new Error(`cannot nest ${from} by ${field}`);
      return scrub((await q.query(`SELECT ${select} FROM ${from} WHERE ${p.col} = ANY($1::${p.type}[]) ORDER BY ${p.order ?? [p.col, ...order.filter((o) => o !== p.col)].join(', ')}`, [keys])).rows as Rec[]);
    };
  }
  return def;
}
