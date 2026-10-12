import type { Queryable } from './db.js';
import { getRegional } from './settings.js';

/**
 * Search that stays fast on millions of rows. Free text is never matched with `%term%` (that reads every row); it is turned into one of:
 *  - an exact id (uuid)
 *  - an e-mail prefix                 -> btree on lower(email)
 *  - a phone / MSISDN prefix          -> btree on phone and services.identifier
 *  - words of a name (each as a prefix) -> GIN full-text index
 * so "alex ta" finds "Alex Tan", "+6591" finds numbers starting +6591, and "alice@ex" finds alice@example.com.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedQuery =
  | { kind: 'empty' }
  | { kind: 'none' } // text was typed but holds nothing searchable (only symbols): matches nothing, rather than listing everything
  | { kind: 'id'; id: string }
  | { kind: 'email'; prefix: string }
  | { kind: 'phone'; prefixes: string[] }
  | { kind: 'words'; tsquery: string };

/** Escapes LIKE wildcards in user text so it can only ever be a literal prefix. */
export const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function parseQuery(q: Queryable, raw: string | undefined | null): Promise<ParsedQuery> {
  const t = (raw ?? '').trim().slice(0, 100);
  if (!t) return { kind: 'empty' };
  if (UUID.test(t)) return { kind: 'id', id: t.toLowerCase() };
  if (t.includes('@')) return { kind: 'email', prefix: t.toLowerCase() };
  const digits = t.replace(/[\s()-]/g, '');
  if (/^\+?\d{3,}$/.test(digits)) {
    // "91234567" may be typed without the country code: also try the deployment's own dial code.
    const dial = (await getRegional(q)).dialCode;
    const plain = digits.replace(/^\+/, '');
    const set = new Set<string>(digits.startsWith('+') ? [digits] : [`+${plain}`, `${dial}${plain}`]);
    return { kind: 'phone', prefixes: [...set] };
  }
  const words = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 5);
  if (!words.length) return { kind: 'none' };
  return { kind: 'words', tsquery: words.map((w) => `${w}:*`).join(' & ') };
}

/**
 * SQL (boolean expression) selecting customer ids that match a parsed query. Always bounded by LIMIT so it is safe to use in `IN (...)`
 * from orders, invoices and cases. `p` pushes a parameter and returns its placeholder.
 */
export function customerIdsMatching(pq: ParsedQuery, p: (v: unknown) => string, limit = 200): string | null {
  switch (pq.kind) {
    case 'empty': return null;
    case 'none': return 'SELECT id FROM customers WHERE false';
    case 'id': return `SELECT ${p(pq.id)}::uuid`;
    case 'email': return `SELECT id FROM customers WHERE lower(email) LIKE ${p(likePrefix(pq.prefix))} LIMIT ${limit}`;
    case 'phone': {
      const ors = pq.prefixes.map((x) => { const ph = p(likePrefix(x)); return `(SELECT id FROM customers WHERE phone LIKE ${ph} LIMIT ${limit}) UNION (SELECT customer_id FROM services WHERE identifier LIKE ${ph} LIMIT ${limit})`; });
      return `SELECT id FROM (${ors.join(' UNION ')}) m LIMIT ${limit}`;
    }
    case 'words': return `SELECT id FROM customers WHERE to_tsvector('simple', display_name) @@ to_tsquery('simple', ${p(pq.tsquery)}) LIMIT ${limit}`;
  }
}
