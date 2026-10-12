import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.js';
import { invalid } from './errors.js';

export interface JournalLine { account: string; debit?: number; credit?: number; description: string }

/** Posts one balanced journal. Zero-value lines are dropped; unbalanced journals are rejected before touching the DB. */
export async function postJournal(
  q: Queryable,
  j: { date: string; sourceType: string; sourceId: string; currency: string; lines: JournalLine[] },
): Promise<string | null> {
  const lines = j.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  const dr = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const cr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (dr !== cr) throw invalid(`unbalanced journal for ${j.sourceType} ${j.sourceId}: debit ${dr} != credit ${cr}`);
  if (lines.length === 0) return null;
  const id = randomUUID();
  for (const l of lines) {
    await q.query(
      `INSERT INTO gl_entries (journal_id, entry_date, source_type, source_id, account_code, description, debit_minor, credit_minor, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, j.date, j.sourceType, j.sourceId, l.account, l.description, l.debit ?? 0, l.credit ?? 0, j.currency],
    );
  }
  return id;
}
