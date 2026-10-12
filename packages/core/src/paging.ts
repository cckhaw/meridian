import { invalid } from './errors.js';

/**
 * Lists in Meridian are built for tables of millions of rows: every list is bounded, ordered by an indexed key, and continued with a
 * cursor ("keyset" paging) instead of OFFSET, so page 1 and page 10,000 cost the same. Nothing returns a total row count (counting a
 * huge table on every page view is what makes screens slow); callers say "load more" while `nextCursor` is present.
 */
export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 100;

export interface Page<T> { items: T[]; nextCursor: string | null }

export const pageSize = (n: number | undefined | null, fallback = DEFAULT_PAGE, max = MAX_PAGE): number =>
  Number.isFinite(n) && (n as number) > 0 ? Math.min(Math.floor(n as number), max) : fallback;

type CursorValue = string | number;
export const encodeCursor = (values: CursorValue[]): string => Buffer.from(JSON.stringify(values)).toString('base64url');

/** Cursors come from the client, so they are validated: a wrong shape is a 400, never part of a query string. */
export function decodeCursor(cursor: string | undefined | null, arity: number): CursorValue[] | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === arity && v.every((x) => (typeof x === 'string' && x.length <= 200) || (typeof x === 'number' && Number.isFinite(x)))) return v as CursorValue[];
  } catch { /* fall through */ }
  throw invalid('that page link is not valid; reload the list');
}

/** Rows fetched with `LIMIT n+1`: the extra row only tells us whether there is another page. */
export function toPage<T>(rows: T[], limit: number, key: (r: T) => CursorValue[]): Page<T> {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  return { items, nextCursor: more ? encodeCursor(key(items[items.length - 1]!)) : null };
}

/**
 * Timestamps have microsecond precision in PostgreSQL but only milliseconds in JavaScript, so a cursor built from a JS date can skip rows.
 * Queries therefore also select `created_at::text AS cursor_ts` (exact), the cursor carries that, and `cursorTs` is removed before rows leave the API.
 */
export function tsPage<T extends { cursorTs?: string; id: string | number }>(rows: T[], limit: number): Page<Omit<T, "cursorTs">> {
  const page = toPage(rows, limit, (r) => [r.cursorTs as string, r.id]);
  return { items: page.items.map(({ cursorTs: _drop, ...rest }) => rest) as Array<Omit<T, "cursorTs">>, nextCursor: page.nextCursor };
}

/** A tiny helper for building parameterised SQL. */
export function sqlBuilder() {
  const params: unknown[] = [];
  return { params, p: (v: unknown) => `$${params.push(v)}` };
}
