import type { Queryable, Row } from '../db.js';
import { invalid, notFound } from '../errors.js';
import { decodeCursor, pageSize, sqlBuilder, tsPage, type Page } from '../paging.js';

/** Jobs, newest first. Anyone who may export or import may see them: who ran what, and how it went, is not a secret from the people who run migrations. */
export async function listMigrationJobs(q: Queryable, f: { kind?: string; status?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  if (f.kind && !['EXPORT', 'IMPORT'].includes(f.kind)) throw invalid('unknown kind');
  const limit = pageSize(f.limit, 20, 100);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.kind) where.push(`kind = ${p(f.kind)}`);
  if (f.status) where.push(`status = ${p(f.status)}`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(created_at, id) < (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT id, kind, entity, entities, format, status, masked, file_name, file_bytes, rows_total, rows_done, rows_ok, rows_error, rows_skipped, percent, stage, summary, created_by, created_at::text AS cursor_ts, created_at, started_at, finished_at, updated_at
       FROM migration_jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  return tsPage(rows as Array<Row & { id: string; cursorTs: string }>, limit);
}

export async function getMigrationJob(q: Queryable, id: string, o: { items?: number } = {}): Promise<Row & { items: Row[] }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('job', id);
  const j = (await q.query('SELECT * FROM migration_jobs WHERE id=$1', [id])).rows[0];
  if (!j) throw notFound('job', id);
  const items = (await q.query(`SELECT line, severity, field, code, message, pass FROM migration_job_items WHERE job_id=$1 ORDER BY id LIMIT $2`, [id, Math.min(o.items ?? 200, 1000)])).rows;
  return { ...j, items };
}
