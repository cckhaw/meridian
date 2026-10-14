import type { Db, Queryable, Row } from './db.js';
import { invalid, notFound } from './errors.js';
import { listCoaRules, unmappedLines } from './coa.js';
import { decodeCursor, pageSize, sqlBuilder, toPage, type Page } from './paging.js';
import { reconcile } from './reports.js';
import { getRegional } from './settings.js';
import { SapExporter, type FileTotals, type SapFormat } from './sap-exporter.js';

/**
 * Reconciliation: proves that what the sub-ledger holds, what was written to the journal file and what SAP reports it posted all agree, and records every
 * difference as an exception (`RECONCILIATION_MISMATCH` and friends) so the audit trail shows what was checked, when, and what did not tie.
 *
 * A batch is checked three ways. The LEDGER side is read from the immutable sub-ledger (the lines stamped with the batch). The FILE side is read back out of the
 * stored file, not from the batch's own totals. The SAP side is what SAP reported when the batch was acknowledged. A period is checked for what was never
 * exported, what has no posting rule, and the sub-ledger's own control accounts.
 */
export type ExceptionCode = 'RECONCILIATION_MISMATCH' | 'UNMAPPED_ACCOUNT' | 'UNEXPORTED_ENTRIES' | 'NOT_ACKNOWLEDGED' | 'DELIVERY_FAILED' | 'UNBALANCED_JOURNAL';
export interface ReconException { code: ExceptionCode; severity: 'ERROR' | 'WARNING'; subject?: string; expectedMinor?: number | null; actualMinor?: number | null; detail: string }

/** How long a delivered batch may wait for SAP's acknowledgement before it is flagged. */
export const ACK_WARN_HOURS = 48;

interface ReportInput {
  scope: 'BATCH' | 'PERIOD'; batchId?: string; from?: string | null; to?: string | null;
  ledger: { debit: number; credit: number }; file?: { debit: number; credit: number } | null; sap?: { debit: number; credit: number } | null;
  exceptions: ReconException[]; actor: string;
}

async function saveReport(q: Queryable, r: ReportInput): Promise<Row> {
  const errors = r.exceptions.filter((e) => e.severity === 'ERROR').length;
  const rep = (await q.query(
    `INSERT INTO reconciliation_reports (scope, batch_id, period_from, period_to, status, ledger_debit_minor, ledger_credit_minor, file_debit_minor, file_credit_minor, sap_debit_minor, sap_credit_minor, exception_count, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [r.scope, r.batchId ?? null, r.from ?? null, r.to ?? null, errors ? 'MISMATCH' : 'OK', r.ledger.debit, r.ledger.credit, r.file?.debit ?? null, r.file?.credit ?? null, r.sap?.debit ?? null, r.sap?.credit ?? null, r.exceptions.length, r.actor])).rows[0]!;
  for (const e of r.exceptions) {
    await q.query(`INSERT INTO reconciliation_exceptions (report_id, code, severity, subject, expected_minor, actual_minor, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [rep.id, e.code, e.severity, e.subject ?? null, e.expectedMinor ?? null, e.actualMinor ?? null, e.detail]);
  }
  if (errors) { // finance and audit hear about it through the same outbox as the rest of the platform's events
    await q.query(`INSERT INTO lifecycle_outbox (kind, instruction, payload) VALUES ('EVENT', 'RECONCILIATION_MISMATCH', $1)`,
      [JSON.stringify({ topic: 'meridian.finance.events', reportId: rep.id, scope: r.scope, batchId: r.batchId ?? null, errors, codes: [...new Set(r.exceptions.filter((e) => e.severity === 'ERROR').map((e) => e.code))] })]);
  }
  return { ...rep, exceptions: r.exceptions };
}

const money = (n: number) => (n / 100).toFixed(2);
const diff = (code: ExceptionCode, subject: string, expected: number, actual: number, what: string): ReconException => ({ code, severity: 'ERROR', subject, expectedMinor: expected, actualMinor: actual, detail: `${what}: expected ${money(expected)}, found ${money(actual)} (difference ${money(actual - expected)}).` });

/** Checks one batch: ledger vs file vs SAP. Every run is recorded as a report, clean or not. */
export async function reconcileBatch(db: Db, batchId: string, actor = 'system'): Promise<Row> {
  return db.tx(async (q) => {
    const b = (await q.query('SELECT * FROM gl_batches WHERE id=$1', [batchId])).rows[0];
    if (!b) throw notFound('batch', batchId);
    const ex: ReconException[] = [];
    const ledger = (await q.query(`SELECT COALESCE(sum(debit_minor),0) AS d, COALESCE(sum(credit_minor),0) AS c, count(*) AS n FROM gl_entries WHERE exported_batch_id=$1`, [batchId])).rows[0]!;
    const L = { debit: Number(ledger.d), credit: Number(ledger.c) };
    if (b.status === 'FAILED') {
      ex.push({ code: 'UNMAPPED_ACCOUNT', severity: 'ERROR', subject: b.batchNo, detail: b.error ?? 'The run failed.' });
      return saveReport(q, { scope: 'BATCH', batchId, ledger: L, exceptions: ex, actor });
    }
    if (L.debit !== L.credit) ex.push(diff('UNBALANCED_JOURNAL', b.batchNo, L.debit, L.credit, 'The ledger lines of this batch do not balance'));
    if (Number(ledger.n) !== b.entryCount) ex.push(diff('RECONCILIATION_MISMATCH', 'entries', b.entryCount, Number(ledger.n), 'Number of ledger lines in the batch'));
    if (L.debit !== Number(b.debitMinor)) ex.push(diff('RECONCILIATION_MISMATCH', 'debit', Number(b.debitMinor), L.debit, 'Debits in the ledger against the batch record'));
    if (L.credit !== Number(b.creditMinor)) ex.push(diff('RECONCILIATION_MISMATCH', 'credit', Number(b.creditMinor), L.credit, 'Credits in the ledger against the batch record'));

    // The file as stored, read back the way SAP would read it.
    let F: { debit: number; credit: number } | null = null;
    const f = (await q.query('SELECT content, totals, ack FROM journal_batch_files WHERE batch_id=$1', [batchId])).rows[0];
    if (!f) ex.push({ code: 'RECONCILIATION_MISMATCH', severity: 'ERROR', subject: 'file', detail: 'The journal file for this batch is missing.' });
    else {
      const exponent = (await getRegional(q)).exponent;
      const t = SapExporter.parse(f.content as string, b.format as SapFormat, exponent);
      F = { debit: t.debitMinor, credit: t.creditMinor };
      if (t.debitMinor !== L.debit) ex.push(diff('RECONCILIATION_MISMATCH', 'debit', L.debit, t.debitMinor, 'Debits in the journal file against the ledger'));
      if (t.creditMinor !== L.credit) ex.push(diff('RECONCILIATION_MISMATCH', 'credit', L.credit, t.creditMinor, 'Credits in the journal file against the ledger'));
      if (t.debitMinor !== t.creditMinor) ex.push(diff('UNBALANCED_JOURNAL', 'file', t.debitMinor, t.creditMinor, 'The journal file does not balance'));
      if (t.documents !== b.documentCount) ex.push(diff('RECONCILIATION_MISMATCH', 'documents', b.documentCount, t.documents, 'Number of documents in the file'));
      const written = (f.totals ?? {}) as FileTotals['byAccount'];
      for (const acct of new Set([...Object.keys(written), ...Object.keys(t.byAccount)])) {
        const w = written[acct] ?? { debitMinor: 0, creditMinor: 0 }, g = t.byAccount[acct] ?? { debitMinor: 0, creditMinor: 0 };
        if (w.debitMinor !== g.debitMinor) ex.push(diff('RECONCILIATION_MISMATCH', `SAP ${acct} debit`, w.debitMinor, g.debitMinor, `Debits to SAP account ${acct} in the file against what was exported`));
        if (w.creditMinor !== g.creditMinor) ex.push(diff('RECONCILIATION_MISMATCH', `SAP ${acct} credit`, w.creditMinor, g.creditMinor, `Credits to SAP account ${acct} in the file against what was exported`));
      }
      if (b.fileSha256) {
        const { createHash } = await import('node:crypto');
        const h = createHash('sha256').update(f.content as string).digest('hex');
        if (h !== b.fileSha256) ex.push({ code: 'RECONCILIATION_MISMATCH', severity: 'ERROR', subject: 'file checksum', detail: 'The stored journal file no longer matches the checksum taken when it was written.' });
      }
    }

    // What SAP says it posted.
    let S: { debit: number; credit: number } | null = null;
    if (b.acknowledgedAt) {
      S = { debit: Number(b.sapDebitMinor), credit: Number(b.sapCreditMinor) };
      const base = F ?? L;
      if (S.debit !== base.debit) ex.push(diff('RECONCILIATION_MISMATCH', 'SAP debit', base.debit, S.debit, 'Debits SAP reports posting against the file'));
      if (S.credit !== base.credit) ex.push(diff('RECONCILIATION_MISMATCH', 'SAP credit', base.credit, S.credit, 'Credits SAP reports posting against the file'));
      const ack = (f?.ack ?? null) as { byAccount?: FileTotals['byAccount'] } | null;
      if (ack?.byAccount) {
        const written = (f!.totals ?? {}) as FileTotals['byAccount'];
        for (const acct of new Set([...Object.keys(written), ...Object.keys(ack.byAccount)])) {
          const w = written[acct] ?? { debitMinor: 0, creditMinor: 0 }, g = ack.byAccount[acct] ?? { debitMinor: 0, creditMinor: 0 };
          if (w.debitMinor !== g.debitMinor) ex.push(diff('RECONCILIATION_MISMATCH', `SAP ${acct} debit`, w.debitMinor, g.debitMinor, `Debits SAP reports on account ${acct} against what was sent`));
          if (w.creditMinor !== g.creditMinor) ex.push(diff('RECONCILIATION_MISMATCH', `SAP ${acct} credit`, w.creditMinor, g.creditMinor, `Credits SAP reports on account ${acct} against what was sent`));
        }
      }
    } else {
      const hours = (Date.now() - new Date(b.createdAt).getTime()) / 3_600_000;
      if (hours > ACK_WARN_HOURS) ex.push({ code: 'NOT_ACKNOWLEDGED', severity: 'WARNING', subject: b.batchNo, detail: `SAP has not acknowledged this batch ${Math.floor(hours)} hours after it was produced.` });
    }
    if (b.deliveryStatus === 'FAILED') ex.push({ code: 'DELIVERY_FAILED', severity: 'WARNING', subject: b.batchNo, detail: b.deliveryDetail ?? 'Delivery to SAP failed.' });
    return saveReport(q, { scope: 'BATCH', batchId, ledger: L, file: F, sap: S, exceptions: ex, actor });
  });
}

/** Checks a posting period: nothing left unexported, every line has a posting rule, each batch ties to its ledger lines, and the control accounts agree with the sub-ledgers. */
export async function reconcilePeriod(db: Db, o: { from: string; to: string; actor?: string }): Promise<Row> {
  if (o.to < o.from) throw invalid('The period ends before it starts.');
  return db.tx(async (q) => {
    const ex: ReconException[] = [];
    const tot = (await q.query(`SELECT COALESCE(sum(debit_minor),0) AS d, COALESCE(sum(credit_minor),0) AS c FROM gl_entries WHERE entry_date BETWEEN $1 AND $2`, [o.from, o.to])).rows[0]!;
    const L = { debit: Number(tot.d), credit: Number(tot.c) };
    if (L.debit !== L.credit) ex.push(diff('UNBALANCED_JOURNAL', `${o.from} to ${o.to}`, L.debit, L.credit, 'The ledger for the period does not balance'));
    const un = (await q.query(`SELECT count(*)::int AS n, COALESCE(sum(debit_minor),0) AS d, min(entry_date)::text AS first FROM gl_entries WHERE exported_batch_id IS NULL AND entry_date BETWEEN $1 AND $2`, [o.from, o.to])).rows[0]!;
    if (un.n > 0) ex.push({ code: 'UNEXPORTED_ENTRIES', severity: 'ERROR', subject: `${o.from} to ${o.to}`, expectedMinor: 0, actualMinor: Number(un.d), detail: `${un.n} ledger lines (debits ${money(Number(un.d))}, from ${un.first}) are still not in any SAP journal batch.` });
    for (const k of await unmappedLines(q, await listCoaRules(q))) {
      ex.push({ code: 'UNMAPPED_ACCOUNT', severity: 'ERROR', subject: `${k.accountCode}${k.stream ? ` / ${k.stream}` : ''}`, detail: `${k.lines} waiting ledger lines (account ${k.accountCode}${k.stream ? `, stream ${k.stream}` : ''}, ${k.eventType ?? k.sourceType}) have no posting rule, so they cannot be exported.` });
    }
    const batches = (await q.query(
      `SELECT b.id, b.batch_no, b.debit_minor, b.credit_minor, COALESCE(sum(e.debit_minor),0) AS d, COALESCE(sum(e.credit_minor),0) AS c
         FROM gl_batches b JOIN gl_entries e ON e.exported_batch_id = b.id AND e.entry_date BETWEEN $1 AND $2 WHERE b.status='COMPLETED' GROUP BY b.id, b.batch_no, b.debit_minor, b.credit_minor`, [o.from, o.to])).rows;
    for (const b of batches) {
      // A batch may also hold lines from outside the period; only flag it when it holds less than it claims.
      if (Number(b.d) > Number(b.debitMinor)) ex.push(diff('RECONCILIATION_MISMATCH', b.batchNo, Number(b.debitMinor), Number(b.d), 'Debits the ledger holds for this batch against what the batch recorded'));
      if (Number(b.c) > Number(b.creditMinor)) ex.push(diff('RECONCILIATION_MISMATCH', b.batchNo, Number(b.creditMinor), Number(b.c), 'Credits the ledger holds for this batch against what the batch recorded'));
    }
    const control = await reconcile(q);
    for (const c of control.checks.filter((x) => !x.ok)) ex.push(diff('RECONCILIATION_MISMATCH', c.name, c.expected, c.actual, `${c.name} (${c.note})`));
    return saveReport(q, { scope: 'PERIOD', from: o.from, to: o.to, ledger: L, exceptions: ex, actor: o.actor ?? 'system' });
  });
}

export async function listReports(q: Queryable, f: { status?: string; batchId?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit, 25, 100);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.status) where.push(`r.status = ${p(f.status)}`);
  if (f.batchId) where.push(`r.batch_id = ${p(f.batchId)}::uuid`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(r.created_at::text, r.id) < (${p(cur[0])}::text, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT r.*, r.created_at::text AS cursor_ts, b.batch_no FROM reconciliation_reports r LEFT JOIN gl_batches b ON b.id = r.batch_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at::text DESC, r.id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  return toPage(rows, limit, (r) => [r.cursorTs as string, r.id as string]) as Page<Row>;
}
export async function getReport(q: Queryable, id: string): Promise<Row> {
  const r = (await q.query('SELECT r.*, b.batch_no FROM reconciliation_reports r LEFT JOIN gl_batches b ON b.id = r.batch_id WHERE r.id=$1', [id])).rows[0];
  if (!r) throw notFound('reconciliation report', id);
  const exceptions = (await q.query('SELECT * FROM reconciliation_exceptions WHERE report_id=$1 ORDER BY id', [id])).rows;
  return { ...r, exceptions };
}
