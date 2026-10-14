import { audit } from './audit.js';
import { listCoaRules, resolveWith, unmappedLines, type CoaRule } from './coa.js';
import { addDays, today } from './dates.js';
import type { Db, Queryable, Row } from './db.js';
import { invalid, notFound, rejected } from './errors.js';
import { reconcileBatch, reconcilePeriod } from './reconciliation.js';
import { getSapSettings, SapExporter, transportFor, type DeliveryResult, type ExportEntry, type RenderedFile, type SapFormat, type SapTransport } from './sap-exporter.js';
import { getRegional } from './settings.js';

/**
 * Journal batch runs. A run takes the sub-ledger lines that have not been exported yet, resolves each through the posting rules to a SAP account, cost centre and
 * profit centre, writes them as balanced SAP documents (flat file, IDoc, JSON or CSV), stamps the lines with the batch (the only change an entry ever allows), keeps the
 * exact file, sends it, and reconciles it. Three kinds of run: SCHEDULED (the daily close), MANUAL (Finance asks for one), REALTIME (one event, at once).
 */
export type RunType = 'SCHEDULED' | 'MANUAL' | 'REALTIME';
export interface RunOptions { runType: RunType; actor: string; format?: SapFormat; /** Export lines posted up to and including this date. */ asOf?: string; /** Export only these journals (a real-time run). */ journalIds?: string[]; transport?: SapTransport; now?: Date }
export interface RunResult { batch: Row | null; file?: RenderedFile; delivery?: DeliveryResult; reconciliation?: Row }

function row(e: Row, rules: CoaRule[]): ExportEntry | null {
  const sap = resolveWith(rules, { accountCode: e.accountCode, stream: e.stream, eventType: e.eventType, sourceType: e.sourceType, entryDate: e.entryDate });
  return sap ? { id: e.id, journalId: e.journalId, entryDate: e.entryDate, sourceType: e.sourceType, sourceId: e.sourceId, accountCode: e.accountCode, description: e.description, debitMinor: Number(e.debitMinor), creditMinor: Number(e.creditMinor), currency: e.currency, stream: e.stream, eventType: e.eventType, sap } : null;
}

export async function runJournalBatch(db: Db, o: RunOptions): Promise<RunResult> {
  const settings = await getSapSettings(db);
  const format = o.format ?? settings.format;
  const exponent = (await getRegional(db)).exponent;
  const created = o.now ?? new Date();
  type Outcome = { kind: 'NONE' } | { kind: 'UNMAPPED'; batchId: string; message: string } | { kind: 'DONE'; batch: Row; file: RenderedFile };
  const out: Outcome = await db.tx(async (q): Promise<Outcome> => {
    const params: unknown[] = [];
    const where = ['exported_batch_id IS NULL'];
    if (o.asOf) where.push(`entry_date <= $${params.push(o.asOf)}::date`);
    if (o.journalIds?.length) where.push(`journal_id = ANY($${params.push(o.journalIds)}::uuid[])`);
    const raw = (await q.query(`SELECT * FROM gl_entries WHERE ${where.join(' AND ')} ORDER BY id FOR UPDATE`, params)).rows;
    if (!raw.length) return { kind: 'NONE' };
    const rules = await listCoaRules(q);
    const entries: ExportEntry[] = [];
    const missing = new Map<string, number>();
    for (const e of raw) {
      const r = row(e, rules);
      if (r) entries.push(r); else { const k = `${e.accountCode}${e.stream ? ` / ${e.stream}` : ''}`; missing.set(k, (missing.get(k) ?? 0) + 1); }
    }
    const batchNo = `M${String((await q.query(`SELECT nextval('gl_batch_seq') AS n`)).rows[0]!.n).padStart(7, '0')}`;
    if (missing.size) {
      const message = `No posting rule for ${[...missing].map(([k, n]) => `${k} (${n} lines)`).join(', ')}. Add the rule in Finance → Posting rules and run again; nothing was exported.`;
      const b = (await q.query(`INSERT INTO gl_batches (batch_no, entry_count, debit_minor, credit_minor, run_type, format, status, error, created_by) VALUES ($1,0,0,0,$2,$3,'FAILED',$4,$5) RETURNING id`, [batchNo, o.runType, format, message, o.actor])).rows[0]!;
      return { kind: 'UNMAPPED', batchId: b.id as string, message };
    }
    const dr = entries.reduce((s, e) => s + e.debitMinor, 0), cr = entries.reduce((s, e) => s + e.creditMinor, 0);
    if (dr !== cr) throw new Error(`refusing to export an unbalanced ledger: debit ${dr} != credit ${cr}`);
    const exporter = new SapExporter(settings, exponent);
    const docs = exporter.documents(entries, batchNo);
    for (const d of docs) {
      const t = SapExporter.totals([d]);
      if (t.debitMinor !== t.creditMinor) throw new Error(`SAP document ${d.reference} would not balance (debit ${t.debitMinor}, credit ${t.creditMinor}); nothing was exported`);
    }
    const file = exporter.render(docs, format, { batchNo, createdAt: created });
    const totals = SapExporter.totals(docs);
    const dates = entries.map((e) => e.entryDate).sort();
    const batch = (await q.query(
      `INSERT INTO gl_batches (batch_no, entry_count, debit_minor, credit_minor, run_type, format, status, period_from, period_to, document_count, file_name, file_sha256, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'COMPLETED',$7,$8,$9,$10,$11,$12) RETURNING *`,
      [batchNo, entries.length, dr, cr, o.runType, format, dates[0], dates[dates.length - 1], docs.length, file.fileName, file.sha256, o.actor])).rows[0]!;
    await q.query('INSERT INTO journal_batch_files (batch_id, content, content_type, totals) VALUES ($1,$2,$3,$4)', [batch.id, file.content, file.contentType, JSON.stringify(totals.byAccount)]);
    // The one change a posted line allows: it is stamped with the batch that carried it to SAP.
    const ids = entries.map((e) => e.id);
    for (let i = 0; i < ids.length; i += 5000) {
      await q.query('UPDATE gl_entries SET exported_batch_id=$1 WHERE id = ANY($2::bigint[]) AND entry_date BETWEEN $3 AND $4 AND exported_batch_id IS NULL', [batch.id, ids.slice(i, i + 5000), dates[0], dates[dates.length - 1]]);
    }
    await audit(q, o.actor, 'gl', batch.id as string, o.runType === 'SCHEDULED' ? 'DAILY_CLOSE' : 'EXPORTED', { entries: entries.length, documents: docs.length, format, batchNo });
    return { kind: 'DONE', batch, file };
  });
  if (out.kind === 'NONE') return { batch: null };
  if (out.kind === 'UNMAPPED') {
    await reconcileBatch(db, out.batchId, o.actor); // the failed run still leaves its exception report
    throw rejected(out.message);
  }
  const delivery = await deliver(db, out.batch, { ...out.file, format }, o.transport ?? transportFor(settings));
  const reconciliation = await reconcileBatch(db, out.batch.id as string, o.actor);
  return { batch: await getBatch(db, out.batch.id as string), file: out.file, delivery, reconciliation };
}

async function deliver(db: Db, batch: Row, file: RenderedFile & { format: SapFormat }, transport: SapTransport): Promise<DeliveryResult> {
  let r: DeliveryResult;
  try { r = await transport.deliver(file, { batchId: batch.id as string, batchNo: batch.batchNo as string }); } catch (e) { r = { ok: false, detail: String((e as Error).message ?? e) }; }
  const status = transport.kind === 'MANUAL' ? 'NOT_SENT' : r.ok ? 'DELIVERED' : 'FAILED';
  await db.query('UPDATE gl_batches SET delivery_status=$2, delivery_detail=$3, sap_reference=COALESCE($4, sap_reference) WHERE id=$1', [batch.id, status, r.detail.slice(0, 500), r.reference ?? null]);
  return r;
}

/** Sends a batch's stored file again (for example after fixing the endpoint). The file is the one that was written, never a fresh one. */
export async function redeliverBatch(db: Db, batchId: string, actor: string, transport?: SapTransport): Promise<DeliveryResult> {
  const b = await getBatch(db, batchId);
  if (b.status !== 'COMPLETED') throw rejected('This run failed, so there is no file to send.');
  const f = (await db.query('SELECT content, content_type FROM journal_batch_files WHERE batch_id=$1', [batchId])).rows[0];
  if (!f) throw notFound('journal file', batchId);
  const settings = await getSapSettings(db);
  const r = await deliver(db, b, { fileName: b.fileName, contentType: f.contentType, content: f.content, sha256: b.fileSha256, format: b.format }, transport ?? transportFor(settings));
  await audit(db, actor, 'gl', batchId, 'REDELIVERED', { ok: r.ok });
  return r;
}

/** SAP's answer for a batch: what it says it posted. Recorded, then the batch is reconciled against it. */
export async function acknowledgeBatch(db: Db, batchId: string, ack: { reference?: string; debitMinor: number; creditMinor: number; byAccount?: Record<string, { debitMinor: number; creditMinor: number }> }, actor: string): Promise<Row> {
  if (!Number.isSafeInteger(ack.debitMinor) || !Number.isSafeInteger(ack.creditMinor) || ack.debitMinor < 0 || ack.creditMinor < 0) throw invalid('The amounts SAP posted are whole numbers of minor units, not negative.');
  const b = await getBatch(db, batchId);
  if (b.status !== 'COMPLETED') throw rejected('This run failed, so there is nothing for SAP to acknowledge.');
  await db.tx(async (q) => {
    await q.query('UPDATE gl_batches SET sap_debit_minor=$2, sap_credit_minor=$3, sap_reference=COALESCE($4, sap_reference), acknowledged_at=now() WHERE id=$1', [batchId, ack.debitMinor, ack.creditMinor, ack.reference ?? null]);
    await q.query('UPDATE journal_batch_files SET ack=$2 WHERE batch_id=$1', [batchId, JSON.stringify({ byAccount: ack.byAccount ?? null })]);
    await audit(q, actor, 'gl', batchId, 'ACKNOWLEDGED', { reference: ack.reference ?? null, debit: ack.debitMinor, credit: ack.creditMinor });
  });
  return reconcileBatch(db, batchId, actor);
}

export async function getBatch(q: Queryable, id: string): Promise<Row> {
  const b = (await q.query('SELECT * FROM gl_batches WHERE id=$1', [id])).rows[0];
  if (!b) throw notFound('batch', id);
  return b;
}
export async function getBatchFile(q: Queryable, id: string): Promise<{ fileName: string; contentType: string; content: string }> {
  const b = await getBatch(q, id);
  const f = (await q.query('SELECT content, content_type FROM journal_batch_files WHERE batch_id=$1', [id])).rows[0];
  if (!f) throw notFound('journal file', id);
  return { fileName: b.fileName, contentType: f.contentType, content: f.content };
}
export const listBatches = async (q: Queryable) => (await q.query('SELECT * FROM gl_batches ORDER BY created_at DESC, id DESC LIMIT 50')).rows;

/** Older name: exports everything waiting as one CSV and returns the file's text. */
export async function exportGl(db: Db, actor = 'system'): Promise<{ batch: Row | null; csv: string }> {
  const r = await runJournalBatch(db, { runType: 'MANUAL', actor, format: 'CSV' });
  return { batch: r.batch, csv: r.file?.content ?? 'CompanyCode,PostingDate,DocType,DocumentRef,Currency,LineNo,PostingKey,GLAccount,DC,Amount,CostCenter,ProfitCenter,TaxCode,Text,Reference\r\n' };
}
export async function getBatchCsv(q: Queryable, batchId: string): Promise<string> { return (await getBatchFile(q, batchId)).content; }

/**
 * The daily close (the scheduled "midnight" job): exports everything posted up to the end of yesterday in the company's time zone, then reconciles that day.
 * Does nothing unless the SAP settings switch the automatic close on (or `force` is given). Safe to run again: a second run finds nothing left to export.
 */
export async function runDailyClose(db: Db, o: { actor?: string; asOf?: string; force?: boolean; transport?: SapTransport } = {}): Promise<{ ran: boolean; asOf: string; batch: Row | null; reconciliation?: Row; delivery?: DeliveryResult; partitions?: number }> {
  const settings = await getSapSettings(db);
  const asOf = o.asOf ?? addDays(today(), -1);
  if (!settings.autoClose && !o.force) return { ran: false, asOf, batch: null };
  const { SubLedgerEngine } = await import('./sub-ledger.js');
  const partitions = await new SubLedgerEngine(db).ensurePartitions(12);
  const r = await runJournalBatch(db, { runType: 'SCHEDULED', actor: o.actor ?? 'daily-close', asOf, transport: o.transport });
  const rec = await reconcilePeriod(db, { from: asOf, to: asOf, actor: o.actor ?? 'daily-close' });
  return { ran: true, asOf, batch: r.batch, delivery: r.delivery, reconciliation: rec, partitions };
}
export { unmappedLines };
