import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import pg from 'pg';
import { MIGRATIONS } from './migrations.generated.js';

export type Row = Record<string, any>;
export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}
export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  readonly kind: 'postgres' | 'pglite';
  close(): Promise<void>;
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** snake_case -> camelCase keys, Date -> ISO string, so domain code and JSON responses stay plain. */
function normalise<T>(rows: Row[]): T[] {
  return rows.map((r) => {
    const o: Row = {};
    for (const k of Object.keys(r)) {
      const v = r[k];
      o[camel(k)] = v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? Number(v) : v;
    }
    return o as T;
  });
}

// int8/numeric -> number (money is integer minor units; stays far below 2^53), date -> 'YYYY-MM-DD' string.
const parsers = { 20: (v: string) => Number(v), 1700: (v: string) => Number(v), 1082: (v: string) => v }; // 1700 = numeric (sum() of bigint)
pg.types.setTypeParser(20, parsers[20]);
pg.types.setTypeParser(1700, parsers[1700]);
pg.types.setTypeParser(1082, parsers[1082]);

async function migrate(q: Queryable, exec: (sql: string) => Promise<unknown>) {
  await q.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await q.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    await exec(m.sql);
    await q.query('INSERT INTO _migrations (name) VALUES ($1)', [m.name]);
  }
}

async function openPglite(dir?: string): Promise<Db> {
  const opts = { extensions: { ltree }, parsers };
  const lite = dir ? new PGlite(dir, opts) : new PGlite(opts);
  const wrap = (c: { query: PGlite['query'] }): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await c.query<Row>(sql, params);
      return { rows: normalise<T>(r.rows), rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  const base = wrap(lite);
  await migrate(base, (sql) => lite.exec(sql));
  return { kind: 'pglite', ...base, tx: (fn) => lite.transaction((t) => fn(wrap(t as unknown as PGlite))), close: () => lite.close() };
}

async function openPostgres(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL_MAX ?? 10) });
  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await c.query(sql, params as unknown[]);
      return { rows: normalise<T>(r.rows), rowCount: r.rowCount ?? 0 };
    },
  });
  const base = wrap(pool);
  // Serialise migrations across instances. The lock is transaction-scoped (pg_advisory_xact_lock) so it also works behind a
  // transaction-mode pooler such as PgBouncer/Neon's pooled endpoint, where a session-level lock could leak or never release.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(727001)');
    await migrate(wrap(c), (sql) => c.query(sql));
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  return {
    kind: 'postgres',
    ...base,
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(wrap(c));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

/** DATABASE_URL -> real Postgres/AlloyDB. Otherwise embedded Postgres (PGlite): in-memory, or persisted to MERIDIAN_DATA_DIR. */
export function openDb(opts: { url?: string; dataDir?: string } = {}): Promise<Db> {
  const url = opts.url !== undefined ? opts.url : process.env.DATABASE_URL;
  return url ? openPostgres(url) : openPglite(opts.dataDir ?? process.env.MERIDIAN_DATA_DIR);
}
