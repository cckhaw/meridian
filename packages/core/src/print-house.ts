import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { audit } from './audit.js';
import { docContext, loadInvoiceDocs, publishedSchema } from './billing-templates.js';
import { DEFAULT_PRINT_PROFILE, PdfWriter, type PrintProfile } from './billing-docs/pdf.js';
import type { Db } from './db.js';
import { invalid, notFound } from './errors.js';
import { Tally, zipArchive } from './migration/zip.js';

/**
 * Print-house export. The bills of a run (or of a date range, or a list) are drawn with a published template version and a print profile (bleed, crop
 * marks, CMYK, optical-mark channels, a sheet barcode), merged into batch PDFs of N bills, and packaged with the files the printer's machines read:
 *   pdf/batch-0001.pdf …   the bills, in invoice order, each page carrying its barcode and optical marks
 *   control/<job>.csv      one line per bill: sequence, number, name, postcode, pages, batch file, first page in that file, insert flag
 *   control/<job>.dat      the same as pipe-separated H/D/T records with counts and page totals, to check a delivery against
 *   exceptions.csv         bills that cannot be mailed (no postal address); they are left out of the batches
 *   manifest.json          the PrintJobManifest: template version, profile, batches with sha256, totals, exceptions
 * The archive is built while it downloads, one batch in memory at a time.
 */
export interface PrintSelection { billRunId?: string; invoiceIds?: string[]; issuedFrom?: string; issuedTo?: string }
export interface PrintOptions {
  selection: PrintSelection; templateId?: string; templateVersion?: number;
  profile?: Partial<PrintProfile>; batchSize?: number;
  /** Mark every bill as carrying a paper insert (an optical-mark channel the inserter reads). */
  insertAll?: boolean;
  mailClass?: string;
}
export interface BatchEntry { file: string; invoices: number; pages: number; firstSequence: number; lastSequence: number; bytes: number; sha256: string }
export interface ExceptionEntry { invoiceNumber: string; customer: string; reason: string }
export interface PrintJobManifest {
  jobId: string; createdAt: string; createdBy: string;
  template: { id: string; name: string; version: number };
  profile: PrintProfile; selection: PrintSelection; mailClass: string;
  totals: { invoices: number; pages: number; batches: number; exceptions: number; warnings: number };
  batches: BatchEntry[]; exceptions: ExceptionEntry[]; warnings: string[];
  files: { csv: string; dat: string };
}

const DEFAULT_BATCH = 500, MAX_BATCH = 5000, PAGE = 200;
const enc = new TextEncoder();
const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csvLine = (cells: unknown[]) => cells.map(csvCell).join(',') + '\r\n';
const datCell = (v: unknown) => String(v ?? '').replace(/[|\r\n]+/g, ' ').trim();

function validateOptions(o: PrintOptions) {
  const s = o.selection ?? {};
  if (!s.billRunId && !s.invoiceIds?.length && !(s.issuedFrom && s.issuedTo)) throw invalid('Choose what to print: a bill run, a date range, or a list of invoices.');
  if (s.invoiceIds && s.invoiceIds.length > 100_000) throw invalid('A list of invoices is limited to 100,000; use a bill run or a date range for more.');
  const b = o.batchSize ?? DEFAULT_BATCH;
  if (!Number.isInteger(b) || b < 1 || b > MAX_BATCH) throw invalid(`A batch holds 1 to ${MAX_BATCH} bills.`);
  return b;
}
function mergeProfile(p?: Partial<PrintProfile>): PrintProfile {
  const m = { ...DEFAULT_PRINT_PROFILE, ...p };
  if (!(m.bleedMm >= 0 && m.bleedMm <= 10)) throw invalid('Bleed is 0 to 10 mm.');
  if (!(m.slugMm >= 0 && m.slugMm <= 20)) throw invalid('Slug is 0 to 20 mm.');
  if (m.cropMarks && m.bleedMm + m.slugMm < 5) throw invalid('Crop marks need at least 5 mm of bleed and slug together to sit in.');
  if (m.colorMode !== 'RGB' && m.colorMode !== 'CMYK') throw invalid('Colour mode is RGB or CMYK.');
  return m;
}
const where = (s: PrintSelection) => s.billRunId ? { sql: 'bill_run_id=$1', args: [s.billRunId] } : s.invoiceIds?.length ? { sql: 'id = ANY($1::uuid[])', args: [s.invoiceIds] } : { sql: 'issue_date BETWEEN $1 AND $2', args: [s.issuedFrom, s.issuedTo] };

/** Invoice ids in id order, a page at a time (keyset), so a run of millions never sits in memory. */
async function* invoiceIds(db: Db, s: PrintSelection): AsyncGenerator<string[]> {
  const w = where(s); let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const n = w.args.length;
    const ids = (await db.query(`SELECT id FROM invoices WHERE ${w.sql} AND id > $${n + 1}::uuid ORDER BY id LIMIT ${PAGE}`, [...w.args, after])).rows.map((r) => r.id as string);
    if (!ids.length) return;
    yield ids; after = ids[ids.length - 1]!;
  }
}

async function* deflated(bytes: Uint8Array, tally: Tally): AsyncGenerator<Uint8Array> { tally.add(bytes); yield deflateRawSync(bytes, { level: 6 }); }
const textEntry = (name: string, text: string) => { const t = new Tally(); return { name, data: () => deflated(enc.encode(text), t), done: () => t }; };

/** Creates the job and returns the archive stream. The job is completed (or failed) when the stream ends. */
export async function exportPrintPackage(db: Db, actor: string, opts: PrintOptions): Promise<{ jobId: string; filename: string; stream: ReadableStream<Uint8Array> }> {
  const batchSize = validateOptions(opts);
  const profile = mergeProfile(opts.profile);
  const t = await publishedSchema(db, opts.templateId, opts.templateVersion);
  if (!t.templateId) throw invalid('Publish a bill template first: print jobs record the template version they used.');
  const mailClass = (opts.mailClass ?? 'STANDARD').slice(0, 20);
  if (opts.selection.billRunId && !(await db.query(`SELECT 1 FROM bill_runs WHERE id=$1`, [opts.selection.billRunId])).rows[0]) throw notFound('Bill run', opts.selection.billRunId);
  const job = (await db.query(`INSERT INTO print_jobs (bill_run_id, template_id, template_version, profile, selection, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
    [opts.selection.billRunId ?? null, t.templateId, t.version, JSON.stringify(profile), JSON.stringify(opts.selection), actor])).rows[0]!;
  const jobId = job.id as string, short = jobId.slice(0, 8);
  await audit(db, actor, 'print_job', jobId, 'START', { selection: opts.selection, template: `${t.name} v${t.version}` });
  const ctx = await docContext(db);

  const batches: BatchEntry[] = [], exceptions: ExceptionEntry[] = [], warnings = new Set<string>();
  const csvRows: string[] = [], datRows: string[] = [];
  let sequence = 0, totalPages = 0;

  const archive = (async function* () {
    try {
      yield* zipArchive((async function* () {
        let writer: PdfWriter | null = null, cur: BatchEntry | null = null;
        const flush = async function* () {
          if (!writer || !cur) return;
          const w = writer, c = cur; writer = null; cur = null;
          const pdf = await w.save();
          for (const x of w.warnings) warnings.add(x);
          c.bytes = pdf.length; c.sha256 = createHash('sha256').update(pdf).digest('hex'); batches.push(c);
          const tally = new Tally();
          yield { name: `pdf/${c.file}`, data: () => deflated(pdf, tally), done: () => tally };
        };
        for await (const ids of invoiceIds(db, opts.selection)) {
          const docs = await loadInvoiceDocs(db, ids, ctx);
          for (const id of ids) {
            const doc = docs.get(id); if (!doc) continue;
            if (doc.customer.addressMissing) { exceptions.push({ invoiceNumber: doc.invoice.number, customer: doc.customer.name, reason: 'No postal address on the customer' }); continue; }
            if (!writer) {
              const file = `batch-${String(batches.length + 1).padStart(4, '0')}.pdf`;
              writer = await PdfWriter.create(profile, `${t.name} ${short} ${file}`, doc.invoice.issueDate);
              cur = { file, invoices: 0, pages: 0, firstSequence: sequence + 1, lastSequence: sequence, bytes: 0, sha256: '' };
            }
            sequence += 1;
            const firstPage = writer.pages + 1;
            const r = await writer.addInvoice(t.schema, doc, { sequence, barcodeValue: (p) => `${short.toUpperCase()}${String(sequence).padStart(8, '0')}${String(p).padStart(2, '0')}`, omrInsert: !!opts.insertAll });
            for (const x of r.warnings) warnings.add(x);
            cur!.invoices += 1; cur!.pages += r.pages; cur!.lastSequence = sequence; totalPages += r.pages;
            const row = [sequence, doc.invoice.number, doc.customer.name, doc.customer.lines[0] ?? '', doc.customer.lines[1] ?? '', doc.customer.city, doc.customer.postcode, doc.customer.country, r.pages, cur!.file, firstPage, opts.insertAll ? 'Y' : 'N', mailClass];
            csvRows.push(csvLine(row)); datRows.push(`D|${row.map(datCell).join('|')}`);
            if (cur!.invoices >= batchSize) yield* flush();
          }
        }
        yield* flush();
        const header = ['sequence', 'invoice_number', 'name', 'address1', 'address2', 'city', 'postcode', 'country', 'pages', 'batch_file', 'first_page_in_file', 'insert', 'mail_class'];
        const csvName = `control/${short}.csv`, datName = `control/${short}.dat`;
        yield textEntry(csvName, csvLine(header) + csvRows.join(''));
        yield textEntry(datName, [`H|${jobId}|${t.name}|v${t.version}|${new Date(job.createdAt).toISOString()}|${mailClass}`, ...datRows, `T|${sequence}|${totalPages}|${batches.length}`].join('\r\n') + '\r\n');
        yield textEntry('exceptions.csv', csvLine(['invoice_number', 'customer', 'reason']) + exceptions.map((e) => csvLine([e.invoiceNumber, e.customer, e.reason])).join(''));
        const manifest: PrintJobManifest = {
          jobId, createdAt: new Date(job.createdAt).toISOString(), createdBy: actor, template: { id: t.templateId, name: t.name, version: t.version }, profile, selection: opts.selection, mailClass,
          totals: { invoices: sequence, pages: totalPages, batches: batches.length, exceptions: exceptions.length, warnings: warnings.size }, batches, exceptions, warnings: [...warnings], files: { csv: csvName, dat: datName },
        };
        yield textEntry('manifest.json', JSON.stringify(manifest, null, 2));
        await db.query(`UPDATE print_jobs SET status='COMPLETED', invoice_count=$2, page_count=$3, summary=$4, finished_at=now() WHERE id=$1`, [jobId, sequence, totalPages, JSON.stringify({ batches: batches.length, exceptions: exceptions.length, warnings: [...warnings] })]);
        await audit(db, actor, 'print_job', jobId, 'COMPLETED', { invoices: sequence, pages: totalPages, batches: batches.length, exceptions: exceptions.length });
      })());
    } catch (e) {
      await db.query(`UPDATE print_jobs SET status='FAILED', finished_at=now(), summary=$2 WHERE id=$1`, [jobId, JSON.stringify({ error: (e as Error).message })]).catch(() => undefined);
      throw e;
    }
  })();
  const it = archive[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) { try { const n = await it.next(); if (n.done) c.close(); else c.enqueue(n.value); } catch (e) { c.error(e); } },
    async cancel() { await it.return?.(undefined); },
  });
  return { jobId, filename: `print-${short}.zip`, stream };
}

export async function listPrintJobs(db: Db, limit = 20) {
  return (await db.query(`SELECT p.id, p.bill_run_id, p.template_version, t.name AS template_name, p.status, p.invoice_count, p.page_count, p.summary, p.created_by, p.created_at, p.finished_at
    FROM print_jobs p JOIN bill_templates t ON t.id = p.template_id ORDER BY p.created_at DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 100)])).rows;
}
