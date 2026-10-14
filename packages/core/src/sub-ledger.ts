import { createHash } from 'node:crypto';
import { audit } from './audit.js';
import { GL } from './config.js';
import type { Db, Queryable, Row } from './db.js';
import { invalid, rejected } from './errors.js';
import { postJournal, REVENUE_STREAMS, type JournalLine, type RevenueStream } from './ledger.js';
import { runJournalBatch } from './journal-batches.js';
import { getSapSettings } from './sap-exporter.js';
import { getRegional } from './settings.js';

/**
 * The financial sub-ledger. Business modules (billing, payments, rating, orders) announce what happened as events; each event becomes one balanced, immutable journal in
 * `gl_entries`. The same event delivered twice posts once; an event that cannot be posted goes to the dead-letter list instead of being lost.
 */
export const LEDGER_EVENT_TYPES = ['PAYMENT_SUCCESS', 'INVOICE_GENERATED', 'ADJUSTMENT_POSTED', 'ETC_CHARGED'] as const;
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

export interface EventLine { stream: RevenueStream; netMinor: number; description?: string }
export interface LedgerEvent {
  eventId: string;
  eventType: LedgerEventType;
  /** ISO timestamp of when it happened; the posting date is that moment in the company's time zone. */
  occurredAt: string;
  currency: string;
  /** The invoice number, payment reference or credit note number it concerns. */
  reference?: string;
  /** PAYMENT_SUCCESS: the amount received. */
  amountMinor?: number;
  /** INVOICE_GENERATED and ADJUSTMENT_POSTED: the revenue, by stream (before tax). */
  lines?: EventLine[];
  /** ETC_CHARGED: the charge before tax. */
  netMinor?: number;
  taxMinor?: number;
  /** ADJUSTMENT_POSTED: CREDIT reduces what the customer owes (a credit note), DEBIT increases it. */
  direction?: 'CREDIT' | 'DEBIT';
}
export interface BuiltJournal { date: string; sourceType: string; sourceId: string; eventType: LedgerEventType; lines: JournalLine[] }
export interface PostResult { eventId: string; duplicate: boolean; journalId: string | null }

const GOODS_STREAMS: readonly string[] = ['DEVICE_INSTALMENT', 'GOODS'];
const revenueAccount = (s: RevenueStream) => (GOODS_STREAMS.includes(s) ? GL.GOODS_REVENUE : GL.SERVICE_REVENUE);
const whole = (n: unknown, what: string, min = 0): number => {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min) throw invalid(`${what} must be a whole number of minor units${min === 0 ? ' (zero or more)' : ''}`);
  return n;
};

/** The posting date: the moment the event happened, on the calendar of the company's time zone. */
export function postingDate(occurredAt: string, timezone: string): string {
  const t = new Date(occurredAt);
  if (Number.isNaN(t.getTime())) throw invalid('occurredAt must be an ISO date and time');
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}

export class SubLedgerEngine {
  constructor(private readonly db: Db) {}

  /** Pure: the double-entry journal an event stands for. Throws if the event is malformed. */
  static build(e: LedgerEvent, timezone = 'UTC'): BuiltJournal {
    if (!e || typeof e !== 'object') throw invalid('The event is empty');
    if (!e.eventId || typeof e.eventId !== 'string' || e.eventId.length > 200) throw invalid('eventId is required');
    if (!(LEDGER_EVENT_TYPES as readonly string[]).includes(e.eventType)) throw invalid(`Unknown event type ${String(e.eventType)}. Expected ${LEDGER_EVENT_TYPES.join(', ')}.`);
    const date = postingDate(e.occurredAt, timezone);
    const ref = e.reference?.trim() || e.eventId;
    const tax = whole(e.taxMinor ?? 0, 'taxMinor');
    const streamLines = (): EventLine[] => {
      if (!Array.isArray(e.lines) || !e.lines.length) throw invalid('lines are required');
      return e.lines.map((l) => {
        if (!(REVENUE_STREAMS as readonly string[]).includes(l.stream)) throw invalid(`Unknown revenue stream ${String(l.stream)}`);
        return { stream: l.stream, netMinor: whole(l.netMinor, 'netMinor'), description: l.description };
      });
    };
    const revenue = (ls: EventLine[], side: 'credit' | 'debit', label: string): JournalLine[] => ls.map((l) => ({ account: revenueAccount(l.stream), stream: l.stream, [side]: l.netMinor, description: `${label} ${ref}${l.description ? ` ${l.description}` : ` ${l.stream}`}` }));
    switch (e.eventType) {
      case 'PAYMENT_SUCCESS': {
        const amount = whole(e.amountMinor, 'amountMinor', 1);
        return { date, sourceType: 'PAYMENT', sourceId: ref, eventType: e.eventType, lines: [
          { account: GL.CASH, debit: amount, description: `Payment ${ref}` },
          { account: GL.AR, credit: amount, description: `Payment ${ref}` },
        ] };
      }
      case 'INVOICE_GENERATED': {
        const ls = streamLines();
        const net = ls.reduce((s, l) => s + l.netMinor, 0);
        return { date, sourceType: 'INVOICE', sourceId: ref, eventType: e.eventType, lines: [
          { account: GL.AR, debit: net + tax, description: `Invoice ${ref}` },
          ...revenue(ls, 'credit', 'Invoice'),
          { account: GL.TAX_PAYABLE, credit: tax, description: `Invoice ${ref} tax` },
        ] };
      }
      case 'ADJUSTMENT_POSTED': {
        if (e.direction !== 'CREDIT' && e.direction !== 'DEBIT') throw invalid('direction must be CREDIT or DEBIT');
        const ls = streamLines();
        const net = ls.reduce((s, l) => s + l.netMinor, 0);
        if (e.direction === 'CREDIT') {
          return { date, sourceType: 'CREDIT_NOTE', sourceId: ref, eventType: e.eventType, lines: [
            ...ls.map((l): JournalLine => ({ account: GL.CREDIT_NOTES, stream: l.stream, debit: l.netMinor, description: `Credit note ${ref} ${l.description ?? l.stream}` })),
            { account: GL.TAX_PAYABLE, debit: tax, description: `Credit note ${ref} tax` },
            { account: GL.AR, credit: net + tax, description: `Credit note ${ref}` },
          ] };
        }
        return { date, sourceType: 'INVOICE', sourceId: ref, eventType: e.eventType, lines: [
          { account: GL.AR, debit: net + tax, description: `Debit adjustment ${ref}` },
          ...revenue(ls, 'credit', 'Debit adjustment'),
          { account: GL.TAX_PAYABLE, credit: tax, description: `Debit adjustment ${ref} tax` },
        ] };
      }
      case 'ETC_CHARGED': {
        const net = whole(e.netMinor, 'netMinor', 1);
        return { date, sourceType: 'INVOICE', sourceId: ref, eventType: e.eventType, lines: [
          { account: GL.AR, debit: net + tax, description: `Early termination charge ${ref}` },
          { account: GL.SERVICE_REVENUE, stream: 'ETC', credit: net, description: `Early termination charge ${ref}` },
          { account: GL.TAX_PAYABLE, credit: tax, description: `Early termination charge ${ref} tax` },
        ] };
      }
    }
  }

  /** Posts one event. Idempotent on eventId: a repeat returns the first result; the same id with different content is rejected. */
  async post(e: LedgerEvent, source = 'API', actor = 'ledger'): Promise<PostResult> {
    const regional = await getRegional(this.db);
    if (typeof e?.currency !== 'string' || e.currency !== regional.currency) throw invalid(`currency must be ${regional.currency}; the ledger is kept in one currency`);
    const built = SubLedgerEngine.build(e, regional.timezone);
    const hash = createHash('sha256').update(JSON.stringify(e, Object.keys(e).sort())).digest('hex');
    const res = await this.db.tx(async (q): Promise<PostResult> => {
      const claimed = (await q.query(`INSERT INTO ledger_events (event_id, event_type, payload_hash, source) VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [e.eventId, e.eventType, hash, source])).rows[0];
      if (!claimed) {
        const prev = (await q.query('SELECT payload_hash, journal_id FROM ledger_events WHERE event_id=$1 FOR UPDATE', [e.eventId])).rows[0]!;
        if (prev.payloadHash !== hash) throw rejected(`Event ${e.eventId} was already received with different content. Use a new eventId for a different event.`);
        return { eventId: e.eventId, duplicate: true, journalId: prev.journalId };
      }
      const journalId = await postJournal(q, { date: built.date, sourceType: built.sourceType, sourceId: built.sourceId, currency: e.currency, lines: built.lines, eventType: built.eventType, eventId: e.eventId });
      await q.query('UPDATE ledger_events SET journal_id=$2 WHERE event_id=$1', [e.eventId, journalId]);
      await audit(q, actor, 'ledger_event', e.eventId, 'POSTED', { type: e.eventType, journalId, source });
      return { eventId: e.eventId, duplicate: false, journalId };
    });
    if (!res.duplicate && res.journalId) await this.exportRealtime(res.journalId, actor);
    return res;
  }

  /** Real-time export: when the SAP settings ask for it, the journal goes to SAP now instead of waiting for the daily close. A failure here never undoes the posting. */
  private async exportRealtime(journalId: string, actor: string): Promise<void> {
    const s = await getSapSettings(this.db);
    if (!s.realtime) return;
    try { await runJournalBatch(this.db, { runType: 'REALTIME', actor, journalIds: [journalId] }); } catch { /* recorded as a FAILED run and a reconciliation exception; the journal stays unexported for the next run */ }
  }

  /**
   * The message-bus entry point. `value` is the raw message (JSON text or an object). A message that cannot be posted is kept in the dead-letter list with the reason,
   * and `ok: false` is returned so the consumer can commit its offset and carry on.
   */
  async ingest(msg: { topic?: string; key?: string; value: unknown }, actor = 'ledger'): Promise<{ ok: boolean; result?: PostResult; error?: string }> {
    try {
      const event = (typeof msg.value === 'string' ? JSON.parse(msg.value) : msg.value) as LedgerEvent;
      return { ok: true, result: await this.post(event, 'KAFKA', actor) };
    } catch (err) {
      const error = String((err as Error).message ?? err).slice(0, 500);
      const payload = typeof msg.value === 'string' ? msg.value : JSON.stringify(msg.value ?? null);
      await this.db.query('INSERT INTO ledger_dead_letters (topic, message_key, payload, error) VALUES ($1,$2,$3,$4)', [msg.topic ?? null, msg.key ?? null, payload.slice(0, 20000), error]);
      return { ok: false, error };
    }
  }

  async deadLetters(open = true): Promise<Row[]> {
    return (await this.db.query(`SELECT * FROM ledger_dead_letters ${open ? 'WHERE resolved_at IS NULL' : ''} ORDER BY id DESC LIMIT 100`)).rows;
  }

  /** Tries a dead-lettered message again (after fixing the cause, for example the regional currency). Resolved when it posts. */
  async retryDeadLetter(id: number, actor = 'ledger'): Promise<{ ok: boolean; result?: PostResult; error?: string }> {
    const d = (await this.db.query('SELECT * FROM ledger_dead_letters WHERE id=$1 AND resolved_at IS NULL', [id])).rows[0];
    if (!d) throw invalid('That message is not waiting in the dead-letter list');
    try {
      const result = await this.post(JSON.parse(d.payload) as LedgerEvent, 'KAFKA', actor);
      await this.db.query('UPDATE ledger_dead_letters SET resolved_at=now() WHERE id=$1', [id]);
      return { ok: true, result };
    } catch (err) {
      const error = String((err as Error).message ?? err).slice(0, 500);
      await this.db.query('UPDATE ledger_dead_letters SET error=$2 WHERE id=$1', [id, error]);
      return { ok: false, error };
    }
  }

  /** Makes sure monthly partitions of `gl_entries` exist from this month for `monthsAhead` months. Returns how many it created. */
  async ensurePartitions(monthsAhead = 12): Promise<number> {
    const now = new Date();
    let created = 0;
    for (let i = 0; i <= monthsAhead; i++) {
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i + 1, 1));
      const name = `gl_entries_p${from.getUTCFullYear()}${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
      const f = from.toISOString().slice(0, 10), t = to.toISOString().slice(0, 10);
      if ((await this.db.query('SELECT to_regclass($1) AS r', [name])).rows[0]!.r) continue;
      // Rows that already landed in the default partition for that month would block the new partition; leave that month to the default.
      const stray = (await this.db.query('SELECT 1 FROM gl_entries_default WHERE entry_date >= $1::date AND entry_date < $2::date LIMIT 1', [f, t])).rows.length;
      if (stray) continue;
      await this.db.query(`CREATE TABLE ${name} PARTITION OF gl_entries FOR VALUES FROM ('${f}') TO ('${t}')`);
      created++;
    }
    return created;
  }
}

export type { Queryable };
