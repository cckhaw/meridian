import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.js';
import { invalid } from './errors.js';

/**
 * The revenue streams Finance can book to different SAP accounts, cost centres and profit centres (Finance → Posting rules).
 *  SUBSCRIPTION recurring plan fees · USAGE voice, data and SMS beyond the plan · DEVICE_INSTALMENT device instalments on the bill · THIRD_PARTY partner content (for example a
 *  streaming service) · ETC early termination charges · GOODS devices and goods sold · ONE_TIME connection, activation and installation fees.
 */
export const REVENUE_STREAMS = ['SUBSCRIPTION', 'USAGE', 'DEVICE_INSTALMENT', 'THIRD_PARTY', 'ETC', 'GOODS', 'ONE_TIME'] as const;
export type RevenueStream = (typeof REVENUE_STREAMS)[number];

export interface JournalLine { account: string; debit?: number; credit?: number; description: string; stream?: RevenueStream | null }

/** The event a posting records, derived from where it came from when the caller does not say. */
export const EVENT_OF_SOURCE: Record<string, string> = {
  INVOICE: 'INVOICE_GENERATED', PAYMENT: 'PAYMENT_SUCCESS', CREDIT_NOTE: 'ADJUSTMENT_POSTED', REFUND: 'REFUND_POSTED', ORDER: 'ORDER_PAID', DEPOSIT: 'DEPOSIT_RECEIVED', WRITE_OFF: 'WRITE_OFF',
};

/** Posts one balanced journal. Zero-value lines are dropped; unbalanced journals are rejected before touching the DB. */
export async function postJournal(
  q: Queryable,
  j: { date: string; sourceType: string; sourceId: string; currency: string; lines: JournalLine[]; eventType?: string; eventId?: string },
): Promise<string | null> {
  const lines = j.lines.filter((l) => (l.debit ?? 0) !== 0 || (l.credit ?? 0) !== 0);
  const dr = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const cr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (dr !== cr) throw invalid(`unbalanced journal for ${j.sourceType} ${j.sourceId}: debit ${dr} != credit ${cr}`);
  if (lines.length === 0) return null;
  const id = randomUUID();
  const eventType = j.eventType ?? EVENT_OF_SOURCE[j.sourceType] ?? j.sourceType;
  for (const l of lines) {
    await q.query(
      `INSERT INTO gl_entries (journal_id, entry_date, source_type, source_id, account_code, description, debit_minor, credit_minor, currency, stream, event_type, event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, j.date, j.sourceType, j.sourceId, l.account, l.description, l.debit ?? 0, l.credit ?? 0, j.currency, l.stream ?? null, eventType, j.eventId ?? null],
    );
  }
  return id;
}
