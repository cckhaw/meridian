import type { Db, Queryable, Row } from '../db.js';
import { audit } from '../audit.js';
import { conflict, invalid, notFound, rejected } from '../errors.js';
import { coerceCells, coerceObject, mapHeader, type HeaderMap, type Issue } from './coerce.js';
import { parseCsvBytes } from './csvstream.js';
import { ENTITIES, entityById, importFields } from './entities.js';
import { canRollBack, importerFor, type BatchRow, type RowResult } from './importers.js';
import { openSource } from './uploads.js';
import { templateVersion } from './templates.js';
import type { EntityDef, Rec } from './types.js';

/**
 * Loading a file is a job that works in slices. Every slice is a short request (the platform ends a request after about a minute): it takes the job, processes
 * batches of rows until its time is up, and hands back. The job remembers where it is (a byte offset at a row boundary, saved in the same transaction as the batch's
 * writes), so the next slice, from any server, carries on exactly there and nothing is done twice. Two passes: check the whole file without changing anything, then,
 * when the person says so (or the job was set to start by itself), load it.
 */
export const SLICE_MS = 20_000;
export const WINDOW_BYTES = 1024 * 1024;
export const MAX_ITEMS = 5000;
const ACTIVE = ['PENDING', 'VALIDATING', 'IMPORTING', 'ROLLING_BACK'];
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK'];

export interface ImportOptions { onError: 'ABORT' | 'SKIP'; errorThresholdPercent: number; batchSize?: number; autoStart: boolean }

class Superseded extends Error {}

// ───────────────────────── reading rows ─────────────────────────
interface ParsedRow { line: number; end: number; cells?: string[]; obj?: Record<string, unknown>; problem?: string }
function parseNdjsonBytes(buf: Uint8Array, base: number, line: number, o: { final: boolean; maxRows: number }): { rows: ParsedRow[]; next: number; nextLine: number } {
  const rows: ParsedRow[] = [];
  const dec = new TextDecoder('utf-8');
  let i = base === 0 && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  let curLine = line, lastEnd = i, lastLine = line;
  while (i < buf.length && rows.length < o.maxRows) {
    let j = buf.indexOf(0x0a, i);
    if (j < 0) { if (!o.final) break; j = buf.length; }
    const text = dec.decode(buf.subarray(i, j)).trim();
    const end = Math.min(j + 1, buf.length);
    if (text) {
      try {
        const v = JSON.parse(text);
        if (v && typeof v === 'object' && !Array.isArray(v)) rows.push({ line: curLine, end: base + end, obj: v as Record<string, unknown> });
        else rows.push({ line: curLine, end: base + end, problem: 'This line is not a JSON object.' });
      } catch { rows.push({ line: curLine, end: base + end, problem: 'This line is not valid JSON.' }); }
    }
    i = end; curLine++; lastEnd = i; lastLine = curLine;
  }
  return { rows, next: base + lastEnd, nextLine: lastLine };
}

// ───────────────────────── creating and steering a job ─────────────────────────
/** The entities that must be finished before this one may be checked or loaded: everything in an earlier phase, and whatever it depends on. */
export function prerequisites(entity: string): string[] {
  const def = entityById(entity);
  if (!def) return [];
  const out = new Set<string>();
  const walk = (e: EntityDef) => { for (const d of e.dependsOn) { const x = entityById(d); if (x && !out.has(d)) { out.add(d); walk(x); } } };
  walk(def);
  for (const e of ENTITIES) if (e.id !== entity && e.phase < def.phase) out.add(e.id);
  return [...out];
}
async function blockers(q: Queryable, entity: string, jobId: string): Promise<Row[]> {
  const pre = prerequisites(entity);
  if (!pre.length) return [];
  return (await q.query(`SELECT id, entity, status FROM migration_jobs WHERE kind='IMPORT' AND entity = ANY($1::text[]) AND id <> $2 AND status IN ('PENDING','VALIDATING','VALIDATED','IMPORTING','ROLLING_BACK')`, [pre, jobId])).rows;
}
const blockerText = (b: Row[]) => [...new Set(b.map((x) => entityById(x.entity)?.label ?? x.entity))].join(', ');

export async function createImportJob(db: Db, actor: string, i: { uploadId: string; entity: string; onError?: string; errorThresholdPercent?: number; batchSize?: number; autoStart?: boolean }): Promise<Row> {
  const def = entityById(i.entity);
  if (!def) throw invalid(`There is no data set “${i.entity}”.`);
  const imp = importerFor(i.entity);
  if (!def.importable || !imp) throw invalid(`${def.label} can be exported but not loaded from a file (yet).`);
  const u = /^[0-9a-f-]{36}$/i.test(i.uploadId) ? (await db.query('SELECT * FROM migration_uploads WHERE id=$1', [i.uploadId])).rows[0] : null;
  if (!u || u.createdBy !== actor) throw notFound('upload', i.uploadId);
  if (u.status !== 'COMPLETE') throw rejected('Finish the upload first.');
  const note = u.note as { entity?: string | null };
  if (note.entity && note.entity !== i.entity) throw invalid(`That file holds ${entityById(note.entity)?.label ?? note.entity}, not ${def.label}.`);
  const onError = (i.onError ?? 'ABORT').toUpperCase();
  if (onError !== 'ABORT' && onError !== 'SKIP') throw invalid('onError is ABORT or SKIP.');
  const threshold = i.errorThresholdPercent ?? (onError === 'SKIP' ? 5 : 0);
  if (!(threshold >= 0 && threshold <= 100)) throw invalid('The error threshold is a percentage from 0 to 100.');
  const batchSize = Math.min(Math.max(Math.floor(i.batchSize ?? imp.batch), 10), imp.batch);
  const options: ImportOptions = { onError, errorThresholdPercent: onError === 'ABORT' ? 0 : threshold, batchSize, autoStart: !!i.autoStart };
  // Does the file say which template it was made from?
  let version: string | null = null;
  const warnings: string[] = [];
  if (u.format === 'CSV') {
    const head = Buffer.from(await (await openSource(db, u)).read(0, 4096)).toString('utf8');
    const m = /Meridian import template: .*?\((\w+)\) · version ([0-9a-f]{8})/.exec(head);
    if (m) {
      version = m[2]!;
      if (m[1] !== i.entity) throw invalid(`This file was made from the ${entityById(m[1]!)?.label ?? m[1]} template, not ${def.label}.`);
      if (m[2] !== templateVersion(def)) warnings.push(`This file was made from an older ${def.label} template (version ${m[2]}; now ${templateVersion(def)}). Columns may have changed: the check will tell.`);
    }
  }
  const job = (await db.query(
    `INSERT INTO migration_jobs (kind, entity, format, status, options, file_name, file_bytes, upload_id, template_version, created_by, summary, stage)
     VALUES ('IMPORT',$1,$2,'PENDING',$3,$4,$5,$6,$7,$8,$9,'Waiting to be checked') RETURNING *`,
    [i.entity, u.format, JSON.stringify(options), u.fileName, u.totalBytes, u.id, version ?? templateVersion(def), actor, JSON.stringify({ warnings })])).rows[0]!;
  await audit(db, actor, 'migration', job.id, 'IMPORT_CREATED', { entity: i.entity, file: u.fileName, onError });
  return job;
}

export async function startImport(db: Db, actor: string, jobId: string): Promise<Row> {
  const j = await load(db, jobId);
  if (j.status !== 'VALIDATED') throw rejected(j.status === 'IMPORTING' ? 'This job is already loading.' : 'The file has to be checked before it can be loaded.');
  const v = j.summary.validation as { canStart: boolean; reason?: string } | undefined;
  if (!v?.canStart) throw rejected(v?.reason ?? 'The check found too many problems to load this file. Fix the file and upload it again.');
  const b = await blockers(db, j.entity, jobId);
  if (b.length) throw rejected(`Finish loading ${blockerText(b)} first: this data points at it.`);
  const r = await db.query(`UPDATE migration_jobs SET status='IMPORTING', cursor_bytes=$2, stage='Loading', percent=0, updated_at=now(), summary = summary || $3::jsonb WHERE id=$1 AND status='VALIDATED' RETURNING *`, [jobId, restartAt(j).offset, JSON.stringify({ cursorLine: restartAt(j).line })]);
  if (!r.rowCount) throw conflict('This job changed while you were starting it.');
  await audit(db, actor, 'migration', jobId, 'IMPORT_STARTED', { entity: j.entity });
  return r.rows[0]!;
}

export async function cancelJob(db: Db, actor: string, jobId: string): Promise<Row> {
  const j = await load(db, jobId);
  if (TERMINAL.includes(j.status) || j.status === 'ROLLING_BACK') throw rejected('This job is already finished.');
  await db.query(`UPDATE migration_jobs SET status='CANCELLED', stage='Cancelled', finished_at=now(), updated_at=now() WHERE id=$1`, [jobId]);
  await db.query('DELETE FROM migration_keys WHERE job_id=$1', [jobId]);
  await audit(db, actor, 'migration', jobId, 'IMPORT_CANCELLED', { loaded: Number(j.rowsOk) });
  return load(db, jobId);
}

/** Takes out what a job created. Only for data sets where that is safe; stops with a message if something already depends on it. */
export async function rollbackJob(db: Db, actor: string, jobId: string, reason?: string): Promise<Row> {
  const j = await load(db, jobId);
  if (j.kind !== 'IMPORT') throw invalid('Only imports can be rolled back.');
  if (!canRollBack(j.entity)) throw rejected(`What ${entityById(j.entity)?.label ?? j.entity} loads cannot be taken out automatically, because the screens it feeds also change it. Correct it in the system, or restore the database from before the load.`);
  if (!['COMPLETED', 'FAILED', 'CANCELLED', 'IMPORTING'].includes(j.status)) throw rejected('There is nothing to roll back in this state.');
  const n = Number((await db.query(`SELECT count(*) AS n FROM migration_refs WHERE job_id=$1 AND created`, [jobId])).rows[0]!.n);
  if (!n) throw rejected('This job did not create anything.');
  await db.query(`UPDATE migration_jobs SET status='ROLLING_BACK', stage='Taking out what was loaded', percent=0, rows_total=$2, rows_done=0, finished_at=NULL, updated_at=now(), summary = summary || $3::jsonb WHERE id=$1`, [jobId, n, JSON.stringify({ rollbackReason: reason ?? 'Requested', problem: null })]);
  await audit(db, actor, 'migration', jobId, 'IMPORT_ROLLBACK', { records: n, reason: reason ?? null });
  return load(db, jobId);
}

/** Where a pass starts: the start of the file, or just after the header row. */
const restartAt = (j: Row): { offset: number; line: number } => (j.options as { dataStart?: { offset: number; line: number } }).dataStart ?? { offset: 0, line: 1 };

async function load(q: Queryable, id: string): Promise<Row> {
  const j = /^[0-9a-f-]{36}$/i.test(id) ? (await q.query('SELECT * FROM migration_jobs WHERE id=$1', [id])).rows[0] : null;
  if (!j) throw notFound('job', id);
  return j;
}

// ───────────────────────── the slice ─────────────────────────
export interface SliceResult { job: Row; /** another request is working on it */ busy?: boolean; /** it waits for another job to finish first */ waitingFor?: string }

/** Works on a job for about `budgetMs`, then returns where it is. Safe to call again at any time, from anywhere: only one caller works on a job at once. */
export async function runMigrationSlice(db: Db, jobId: string, o: { budgetMs?: number; actor?: string } = {}): Promise<SliceResult> {
  const deadline = Date.now() + (o.budgetMs ?? SLICE_MS);
  const got = await db.query(`UPDATE migration_jobs SET claimed_until = now() + interval '90 seconds' WHERE id=$1 AND kind='IMPORT' AND status = ANY($2::text[]) AND (claimed_until IS NULL OR claimed_until < now()) RETURNING *`, [jobId, ACTIVE]);
  if (!got.rowCount) {
    const j = await load(db, jobId);
    return { job: j, busy: ACTIVE.includes(j.status) };
  }
  let job: Row = got.rows[0]!;
  let waitingFor: string | undefined;
  try {
    for (let first = true; (first || Date.now() < deadline) && ACTIVE.includes(job.status); first = false) {
      const before = `${job.status}:${job.cursorBytes}`;
      try {
        const r = await step(db, job);
        job = r.job; waitingFor = r.waitingFor;
      } catch (e) {
        if (e instanceof Superseded) { job = await load(db, jobId); break; }
        job = await fail(db, job, e);
      }
      if (waitingFor) break;
      if (`${job.status}:${job.cursorBytes}` === before && job.status !== 'ROLLING_BACK') break;
    }
  } finally {
    await db.query('UPDATE migration_jobs SET claimed_until=NULL WHERE id=$1', [jobId]);
  }
  return { job: await load(db, jobId), waitingFor };
}

/** Runs the slice driver over every job that has work to do, until the time is up. This is what a scheduler calls. */
export async function runDueMigrationJobs(db: Db, o: { budgetMs?: number } = {}): Promise<{ ran: number }> {
  const deadline = Date.now() + (o.budgetMs ?? SLICE_MS);
  let ran = 0;
  const ids = (await db.query(`SELECT id FROM migration_jobs WHERE kind='IMPORT' AND status = ANY($1::text[]) AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY created_at LIMIT 20`, [ACTIVE])).rows.map((r) => r.id as string);
  for (const id of ids) {
    const left = deadline - Date.now();
    if (left < 500) break;
    await runMigrationSlice(db, id, { budgetMs: left }); ran++;
  }
  return { ran };
}

async function fail(db: Db, job: Row, e: unknown): Promise<Row> {
  const d = (e as { details?: unknown }).details;
  const message = e instanceof Error ? (Array.isArray(d) && d.length ? d.join('; ') : e.message) : String(e);
  const wasLoading = job.status === 'IMPORTING' || job.status === 'ROLLING_BACK';
  await db.query(`UPDATE migration_jobs SET status='FAILED', stage=$2, finished_at=now(), updated_at=now(), summary = summary || $3::jsonb WHERE id=$1`,
    [job.id, wasLoading ? 'Stopped: something went wrong while loading' : 'The file cannot be checked', JSON.stringify({ problem: message })]);
  await db.query('DELETE FROM migration_keys WHERE job_id=$1', [job.id]);
  return load(db, job.id);
}

async function step(db: Db, job: Row): Promise<{ job: Row; waitingFor?: string }> {
  if (job.status === 'PENDING') {
    const b = await blockers(db, job.entity, job.id);
    if (b.length) {
      const text = blockerText(b);
      await db.query(`UPDATE migration_jobs SET stage=$2, updated_at=now() WHERE id=$1`, [job.id, `Waiting for ${text} to finish`]);
      return { job: await load(db, job.id), waitingFor: text };
    }
    const r = await db.query(`UPDATE migration_jobs SET status='VALIDATING', started_at=COALESCE(started_at, now()), stage='Checking the file', cursor_bytes=0, summary = summary || '{"cursorLine":1}'::jsonb, updated_at=now() WHERE id=$1 AND status='PENDING' RETURNING *`, [job.id]);
    if (!r.rowCount) throw new Superseded();
    return { job: r.rows[0]! };
  }
  if (job.status === 'ROLLING_BACK') return { job: await rollbackStep(db, job) };
  return { job: await batch(db, job) };
}

async function batch(db: Db, job: Row): Promise<Row> {
  const write = job.status === 'IMPORTING';
  const def = entityById(job.entity)!;
  const imp = importerFor(job.entity)!;
  const opts = job.options as ImportOptions & { header?: string[] };
  const upload = (await db.query('SELECT * FROM migration_uploads WHERE id=$1', [job.uploadId])).rows[0];
  if (!upload || upload.status === 'DISCARDED') throw rejected('The uploaded file is no longer there. Upload it again.');
  const src = await openSource(db, upload);
  const size = src.size;
  let cursor = Number(job.cursorBytes);
  const line = Number((job.summary as { cursorLine?: number }).cursorLine ?? 1);
  const csv = job.format === 'CSV';
  const needHeader = csv && !opts.header;
  const maxRows = needHeader ? 1 : opts.batchSize ?? imp.batch;

  let rows: ParsedRow[] = [], next = cursor, nextLine = line, win = WINDOW_BYTES;
  for (;;) {
    const buf = await src.read(cursor, Math.min(win, size - cursor));
    const final = cursor + buf.length >= size;
    const p = csv ? parseCsvBytes(buf, cursor, line, { final, maxRows }) : parseNdjsonBytes(buf, cursor, line, { final, maxRows });
    if (p.rows.length || final) { rows = p.rows as ParsedRow[]; next = p.next; nextLine = p.nextLine; if (!p.rows.length) next = size; break; }
    if (win >= 64 * 1024 * 1024) throw invalid('A single row is larger than 64 MB.');
    win *= 2;
  }

  const finish = rows.length === 0 || next >= size;
  // The header row of a CSV file: remembered, and nothing else happens in this step.
  if (needHeader) {
    if (!rows.length) throw invalid('The file is empty.');
    const header = rows[0]!.cells!.map((c) => c.trim());
    if (!imp.cellsOnly) {
      const m = mapHeader(def, header);
      if (m.issues.length) throw invalid(m.issues.map((x) => x.message).join(' '));
    }
    const r = await db.query(`UPDATE migration_jobs SET cursor_bytes=$2, options = options || $3::jsonb, summary = summary || $4::jsonb, updated_at=now() WHERE id=$1 AND status=$5 RETURNING *`,
      [job.id, next, JSON.stringify({ header, dataStart: { offset: next, line: nextLine } }), JSON.stringify({ cursorLine: nextLine }), job.status]);
    if (!r.rowCount) throw new Superseded();
    return r.rows[0]!;
  }

  // Clean each row; those with problems never reach the importer.
  const header = csv ? opts.header! : importFields(def).filter((f) => !f.jsonOnly).map((f) => f.name);
  const map: HeaderMap | null = csv && !imp.cellsOnly ? mapHeader(def, header) : null;
  const results: Array<RowResult & { issues?: Issue[] }> = new Array(rows.length);
  const good: BatchRow[] = [], goodAt: number[] = [];
  rows.forEach((r, i) => {
    if (r.problem) { results[i] = { status: 'ERROR', message: r.problem, code: 'BAD_ROW' }; return; }
    if (csv && r.cells!.length > header.length && r.cells!.slice(header.length).some((c) => c.trim())) { results[i] = { status: 'ERROR', message: `This row has ${r.cells!.length} cells but the header has ${header.length}.`, code: 'TOO_MANY_CELLS' }; return; }
    let rec: Rec = {}, cells: string[] | undefined;
    if (imp.cellsOnly) {
      cells = csv ? r.cells : header.map((h) => { const v = r.obj![h]; return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); });
    } else {
      const c = csv ? coerceCells(def, map!, r.cells!) : coerceObject(def, r.obj!);
      if (c.issues.length) { results[i] = { status: 'ERROR', message: c.issues[0]!.message, field: c.issues[0]!.field, code: c.issues[0]!.code, issues: c.issues }; return; }
      rec = c.rec;
    }
    good.push({ line: r.line, rec, cells }); goodAt.push(i);
  });

  const progress = async (q: Queryable): Promise<Row> => {
    const cur = (await q.query('SELECT status FROM migration_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
    if (!cur || cur.status !== job.status) throw new Superseded();
    const ok = results.filter((r) => r.status === 'OK').length, errs = results.filter((r) => r.status === 'ERROR').length, skipped = results.filter((r) => r.status === 'SKIPPED').length;
    const have = Number((await q.query('SELECT count(*) AS n FROM migration_job_items WHERE job_id=$1', [job.id])).rows[0]!.n);
    const items: Array<{ line: number; severity: string; field: string | null; code: string; message: string }> = [];
    rows.forEach((r, i) => {
      const x = results[i]!;
      if (x.status === 'ERROR') for (const is of x.issues?.length ? x.issues : [{ field: x.field ?? null, code: x.code ?? 'INVALID', message: x.message ?? 'Not accepted.' }]) items.push({ line: r.line, severity: 'ERROR', field: is.field ?? null, code: is.code, message: is.message });
      else if (x.status === 'SKIPPED' && Number(job.rowsSkipped) + items.length < 100) items.push({ line: r.line, severity: 'WARNING', field: null, code: x.code ?? 'SKIPPED', message: x.message ?? 'Skipped.' });
    });
    const room = Math.max(0, MAX_ITEMS - have);
    const keep = items.slice(0, room);
    if (keep.length) await q.query(`INSERT INTO migration_job_items (job_id, line, severity, field, code, message, pass) SELECT $1, l, s, f, c, m, $7 FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[]) AS t(l, s, f, c, m)`,
      [job.id, keep.map((x) => x.line), keep.map((x) => x.severity), keep.map((x) => x.field), keep.map((x) => x.code), keep.map((x) => x.message.slice(0, 500)), write ? 'IMPORT' : 'VALIDATE']);
    const percent = size ? Math.min(100, Math.floor((next / size) * 100)) : 100;
    const r = await q.query(
      `UPDATE migration_jobs SET cursor_bytes=$2, rows_done = rows_done + $3, rows_ok = rows_ok + $4, rows_error = rows_error + $5, rows_skipped = rows_skipped + $6, percent=$7,
         summary = summary || $8::jsonb, updated_at=now(), claimed_until = now() + interval '90 seconds' WHERE id=$1 RETURNING *`,
      [job.id, next, rows.length, ok, errs, skipped, finish ? 100 : percent, JSON.stringify({ cursorLine: nextLine, itemsCapped: items.length > room || (job.summary as { itemsCapped?: boolean }).itemsCapped === true })]);
    return r.rows[0]!;
  };

  let updated: Row;
  if (imp.raw) {
    const res = good.length ? await imp.run({ db, q: db, jobId: job.id, actor: job.createdBy, write, header }, good) : [];
    res.forEach((r, k) => { results[goodAt[k]!] = r; });
    updated = await db.tx(progress);
  } else {
    updated = await db.tx(async (q) => {
      const res = good.length ? await imp.run({ db, q, jobId: job.id, actor: job.createdBy, write, header }, good) : [];
      res.forEach((r, k) => { results[goodAt[k]!] = r; });
      return progress(q);
    });
  }
  return finish ? endOfPass(db, updated) : write ? checkThreshold(db, updated) : updated;
}

/** During a load: too many rows failing means stop, and take out what was loaded when that is possible. */
async function checkThreshold(db: Db, job: Row): Promise<Row> {
  const o = job.options as ImportOptions;
  const errors = Number(job.rowsError);
  if (!errors) return job;
  const total = Number(job.rowsTotal) || Number(job.rowsDone);
  const pct = total ? (errors / total) * 100 : 100;
  if (o.onError === 'SKIP' && pct <= o.errorThresholdPercent) return job;
  const why = o.onError === 'ABORT' ? 'A row failed while loading, and this job stops at the first problem.' : `${errors} rows failed, which is more than the ${o.errorThresholdPercent}% this job allows.`;
  if (canRollBack(job.entity)) {
    await db.query(`UPDATE migration_jobs SET status='ROLLING_BACK', stage='Too many errors: taking out what was loaded', percent=0, rows_total=(SELECT count(*) FROM migration_refs WHERE job_id=$1 AND created), rows_done=0, updated_at=now(), summary = summary || $2::jsonb WHERE id=$1`, [job.id, JSON.stringify({ rollbackReason: why, auto: true })]);
  } else {
    await db.query(`UPDATE migration_jobs SET status='FAILED', stage='Stopped: too many errors', finished_at=now(), updated_at=now(), summary = summary || $2::jsonb WHERE id=$1`, [job.id, JSON.stringify({ problem: `${why} What was loaded stays in place, because ${entityById(job.entity)?.label ?? job.entity} cannot be taken out automatically. Fix the file and load it again: rows already loaded are skipped.` })]);
  }
  return load(db, job.id);
}

async function endOfPass(db: Db, job: Row): Promise<Row> {
  const done = Number(job.rowsDone), ok = Number(job.rowsOk), errors = Number(job.rowsError), skipped = Number(job.rowsSkipped);
  const o = job.options as ImportOptions;
  if (job.status === 'VALIDATING') {
    await db.query('DELETE FROM migration_keys WHERE job_id=$1', [job.id]);
    if (!done) throw invalid('The file has a header but no rows.');
    const pct = (errors / done) * 100;
    const canStart = o.onError === 'ABORT' ? errors === 0 : pct <= o.errorThresholdPercent;
    const reason = canStart ? undefined : o.onError === 'ABORT'
      ? `${errors} ${errors === 1 ? 'row has a problem' : 'rows have problems'}. This job stops at the first problem, so fix the file (see the report) and upload it again, or upload it again with “skip rows with problems” on.`
      : `${errors} of ${done} rows (${pct.toFixed(1)}%) have problems, which is more than the ${o.errorThresholdPercent}% this job allows. Fix the file, or raise the limit.`;
    const validation = { rows: done, ok, errors, skipped, canStart, reason };
    await db.query(`UPDATE migration_jobs SET status='VALIDATED', stage=$2, rows_total=$3, rows_done=0, rows_ok=0, rows_error=0, rows_skipped=0, cursor_bytes=$5, percent=0, updated_at=now(), summary = summary || $4::jsonb WHERE id=$1`,
      [job.id, canStart ? 'Checked: ready to load' : 'Checked: problems found', done, JSON.stringify({ validation, cursorLine: restartAt(job).line }), restartAt(job).offset]);
    if (canStart && o.autoStart && !(await blockers(db, job.entity, job.id)).length) await db.query(`UPDATE migration_jobs SET status='IMPORTING', stage='Loading', updated_at=now() WHERE id=$1`, [job.id]);
    return load(db, job.id);
  }
  // A load that reached the end.
  if (errors && (o.onError === 'ABORT' || (errors / Math.max(Number(job.rowsTotal), 1)) * 100 > o.errorThresholdPercent)) return checkThreshold(db, job);
  await db.query(`UPDATE migration_jobs SET status='COMPLETED', stage='Done', percent=100, finished_at=now(), updated_at=now(), summary = summary || $2::jsonb WHERE id=$1`, [job.id, JSON.stringify({ result: { loaded: ok, skipped, errors } })]);
  await audit(db, job.createdBy, 'migration', job.id, 'IMPORT_COMPLETED', { entity: job.entity, loaded: ok, skipped, errors });
  return load(db, job.id);
}

async function rollbackStep(db: Db, job: Row): Promise<Row> {
  const imp = importerFor(job.entity)!;
  const n = await db.tx(async (q) => {
    const cur = (await q.query('SELECT status FROM migration_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
    if (cur?.status !== 'ROLLING_BACK') throw new Superseded();
    const k = await imp.undo!(q, job.id, 1000);
    await q.query(`UPDATE migration_jobs SET rows_done = rows_done + $2, percent = CASE WHEN rows_total > 0 THEN LEAST(100, floor((rows_done + $2) * 100.0 / rows_total)) ELSE 100 END, updated_at=now(), claimed_until = now() + interval '90 seconds' WHERE id=$1`, [job.id, k]);
    return k;
  });
  if (n > 0) return load(db, job.id);
  const auto = (job.summary as { auto?: boolean }).auto;
  await db.query(`UPDATE migration_jobs SET status=$2, stage=$3, percent=100, finished_at=now(), updated_at=now() WHERE id=$1`, [job.id, auto ? 'FAILED' : 'ROLLED_BACK', auto ? 'Stopped, and what was loaded has been taken out' : 'Rolled back']);
  await audit(db, job.createdBy, 'migration', job.id, 'IMPORT_ROLLED_BACK', { entity: job.entity });
  return load(db, job.id);
}

// ───────────────────────── the row-level report ─────────────────────────
export async function jobReportCsv(db: Db, jobId: string): Promise<string> {
  const j = await load(db, jobId);
  const q = (v: unknown) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const items = (await db.query('SELECT line, severity, field, code, message, pass FROM migration_job_items WHERE job_id=$1 ORDER BY id', [jobId])).rows;
  const v = (j.summary as { validation?: Record<string, unknown> }).validation;
  const head = [`# Migration report for ${j.fileName} (${entityById(j.entity)?.label ?? j.entity}) · job ${j.id} · ${j.status}`,
    ...(v ? [`# Check: ${v.rows} rows, ${v.ok} ready, ${v.errors} with problems, ${v.skipped} already loaded`] : []),
    `# This pass: ${j.rowsDone} rows read, ${j.rowsOk} ok, ${j.rowsError} with problems, ${j.rowsSkipped} skipped`,
    ...((j.summary as { itemsCapped?: boolean }).itemsCapped ? [`# The list below is cut off at ${MAX_ITEMS} entries; the counts above are complete.`] : [])];
  return [...head, 'pass,line,severity,field,code,message', ...items.map((i) => [i.pass, i.line, i.severity, i.field, i.code, i.message].map(q).join(','))].join('\r\n') + '\r\n';
}
