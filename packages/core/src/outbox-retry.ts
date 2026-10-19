import type { Db, Row } from './db.js';

/**
 * Retry bookkeeping for the outbox rows that are sent to people through the messaging gateway (user alerts, signed agreement copies).
 * A row is claimed for a few minutes while it is being sent, a failed attempt waits longer each time, and after the last attempt the row is marked failed
 * with the reason. Rows that cannot be tried at all (no gateway) are left alone and do not use up attempts.
 */
export const BACKOFF_MINUTES = [1, 5, 15, 60, 240];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
const LEASE_MINUTES = 5;

export async function claimDue(db: Db, instruction: string, limit: number, where = ''): Promise<Row[]> {
  return db.tx(async (q) => {
    const rows = (await q.query(
      `SELECT * FROM lifecycle_outbox WHERE kind='NOTIFY' AND instruction=$1 AND delivered_at IS NULL AND failed_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ${where} ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`, [instruction, limit])).rows;
    if (rows.length) await q.query(`UPDATE lifecycle_outbox SET next_attempt_at = now() + make_interval(mins => $2) WHERE id = ANY($1::bigint[])`, [rows.map((r) => r.id), LEASE_MINUTES]);
    return rows;
  });
}
/** Gives a claimed row back untouched (nothing could be tried). */
export const releaseClaim = (db: Db, id: number | string) => db.query('UPDATE lifecycle_outbox SET next_attempt_at = NULL WHERE id=$1', [id]);
export const markDelivered = (db: Db, id: number | string, patch: Record<string, unknown>, strip: string[] = []) =>
  db.query(`UPDATE lifecycle_outbox SET delivered_at = now(), attempts = attempts + 1, last_error = NULL, next_attempt_at = NULL, payload = (payload ${strip.map((k) => `- '${k.replace(/'/g, '')}'`).join(' ')}) || $2::jsonb WHERE id=$1`, [id, JSON.stringify(patch)]);
/** Records a failed attempt: waits longer before the next one, or gives up. Returns true when it gave up. */
export async function markAttemptFailed(db: Db, id: number | string, error: string, patch: Record<string, unknown> = {}): Promise<boolean> {
  const r = (await db.query(
    `UPDATE lifecycle_outbox SET attempts = attempts + 1, last_error = $2, payload = payload || $4::jsonb,
       failed_at = CASE WHEN attempts + 1 >= $3 THEN now() END,
       next_attempt_at = CASE WHEN attempts + 1 >= $3 THEN NULL ELSE now() + make_interval(mins => ($5::int[])[LEAST(attempts + 1, $3 - 1)]) END
     WHERE id=$1 RETURNING failed_at`, [id, error.slice(0, 300), MAX_ATTEMPTS, JSON.stringify(patch), BACKOFF_MINUTES])).rows[0];
  return !!r?.failedAt;
}
/** Failed for a reason that another try cannot fix (for example no mobile number): no more attempts. */
export const markFailedFor = (db: Db, id: number | string, error: string) =>
  db.query('UPDATE lifecycle_outbox SET attempts = attempts + 1, last_error = $2, failed_at = now(), next_attempt_at = NULL WHERE id=$1', [id, error.slice(0, 300)]);
