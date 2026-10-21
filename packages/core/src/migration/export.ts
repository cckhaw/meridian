import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createDeflateRaw } from 'node:zlib';
import { audit } from '../audit.js';
import type { Db, Queryable, Row } from '../db.js';
import { invalid, notFound, rejected } from '../errors.js';
import { ENTITIES, entityById } from './entities.js';
import { csvHeader, csvRow, jsonRecord, valueOf } from './format.js';
import { maskRecord } from './mask.js';
import { templateVersion } from './templates.js';
import { DOMAINS, type EntityDef, type Rec } from './types.js';
import { Tally, zipArchive } from './zip.js';

/**
 * Exports. An export is a job (so who exported what, and whether it was masked, is on record), and its archive is built while it is downloaded: tables are
 * read a page at a time with keyset paging, rows are written as they come, and the archive is deflated and sent as it grows, so memory does not depend
 * on the size of the data. The download can be made once; a new export is a new job.
 *
 * Sensitive fields are masked unless the super user asks for them unmasked and gives a reason; either way that is audited.
 */
export interface ExportRequest {
  entities?: string[]; domains?: string[]; format: 'CSV' | 'JSON';
  unmasked?: boolean; reason?: string;
  /** Rows per entity in this file, so a very large table can be taken in parts. */
  maxRowsPerEntity?: number;
  /** Where each entity left off in an earlier part (the `resume` of that job's summary). */
  resume?: Record<string, string>;
  /** JSON only: nest children under their parents (customer → accounts → services). Default true. */
  nest?: boolean;
}
export const EXPORT_PAGE = 1000;
export const REASON_MIN = 10;

/** Entities in the order they must be loaded: by phase, and within a phase by dependency. */
export function loadOrder(ids: string[]): EntityDef[] {
  const want = new Set(ids);
  const out: EntityDef[] = [];
  const seen = new Set<string>();
  const visit = (d: EntityDef) => { if (seen.has(d.id)) return; seen.add(d.id); for (const p of d.dependsOn) { const x = entityById(p); if (x && want.has(x.id)) visit(x); } out.push(d); };
  for (const d of [...ENTITIES].sort((a, b) => a.phase - b.phase)) if (want.has(d.id)) visit(d);
  return out;
}

export function resolveEntities(r: Pick<ExportRequest, 'entities' | 'domains'>): EntityDef[] {
  const ids = new Set<string>();
  for (const e of r.entities ?? []) { if (!entityById(e)) throw invalid(`Unknown data set “${e}”.`); ids.add(e); }
  for (const d of r.domains ?? []) { if (!DOMAINS.some((x) => x.id === d)) throw invalid(`Unknown domain “${d}”.`); for (const e of ENTITIES) if (e.domain === d) ids.add(e.id); }
  if (!ids.size) throw invalid('Choose what to export: a domain, or one or more data sets.');
  return loadOrder([...ids]);
}

export async function createExportJob(db: Queryable, actor: string, r: ExportRequest, o: { canUnmask: boolean }): Promise<Row> {
  const entities = resolveEntities(r);
  if (!['CSV', 'JSON'].includes(r.format)) throw invalid('The format is CSV or JSON.');
  const unmasked = !!r.unmasked;
  if (unmasked) {
    if (!o.canUnmask) throw rejected('Only someone with the Settings permission can export sensitive fields unmasked.');
    if ((r.reason ?? '').trim().length < REASON_MIN) throw invalid(`Say why the sensitive fields are needed unmasked (at least ${REASON_MIN} characters). It is recorded in the audit log.`);
  }
  if (r.maxRowsPerEntity !== undefined && (!Number.isInteger(r.maxRowsPerEntity) || r.maxRowsPerEntity < 1)) throw invalid('Rows per data set must be a whole number from 1.');
  const job = (await db.query(
    `INSERT INTO migration_jobs (kind, entities, format, status, options, masked, reason, created_by) VALUES ('EXPORT',$1,$2,'PENDING',$3,$4,$5,$6) RETURNING *`,
    [entities.map((e) => e.id), r.format, JSON.stringify({ maxRowsPerEntity: r.maxRowsPerEntity ?? null, resume: r.resume ?? {}, nest: r.nest !== false }), !unmasked, unmasked ? r.reason!.trim() : null, actor])).rows[0]!;
  await audit(db, actor, 'migration', job.id, unmasked ? 'EXPORT_UNMASKED_REQUESTED' : 'EXPORT_REQUESTED', { entities: entities.map((e) => e.id), format: r.format, reason: unmasked ? r.reason!.trim() : undefined });
  return job;
}

/** Rows (estimated) in the tables behind these entities, to show progress. Exact when small, the planner's estimate when large. */
export async function estimateRows(q: Queryable, def: EntityDef): Promise<number> {
  if (!/^[a-z_]+$/.test(def.table)) return 0;
  const est = Number((await q.query(`SELECT COALESCE(sum(GREATEST(c.reltuples, 0)), 0)::bigint AS n FROM pg_class c WHERE c.oid = $1::regclass OR c.oid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = $1::regclass)`, [def.table])).rows[0]!.n);
  if (est >= 100_000) return est;
  return Number((await q.query(`SELECT count(*)::bigint AS n FROM (SELECT 1 FROM ${def.table} LIMIT 100001) x`)).rows[0]!.n);
}

const enc = new TextEncoder();
interface EntityOutcome { id: string; file: string; rows: number; bytes: number; sha256: string; complete: boolean; resume: string | null }

async function* entityText(db: Db, def: EntityDef, job: Row, progress: (n: number) => void, outcome: EntityOutcome, nestedIn: Set<string>): AsyncGenerator<string> {
  const unmasked = !job.masked;
  const csv = job.format === 'CSV';
  const maxRows: number | null = job.options.maxRowsPerEntity ?? null;
  let after: string | null = job.options.resume?.[def.id] ?? null;
  let rows = 0;
  // Children shown inside their parents in a JSON file are left out of the top level.
  const nestUnder = job.format === 'JSON' && job.options.nest !== false ? (def.nest ?? []).filter((n) => nestedIn.has(n.entity)) : [];
  const attach = async (page: Rec[]): Promise<Rec[]> => {
    const out = page.map((r) => jsonRecord(def, maskRecord(def, r, unmasked)));
    for (const n of nestUnder) {
      const child = entityById(n.entity)!;
      const keys = [...new Set(page.map((r) => valueOf(r, n.parentField)).filter((v) => v != null).map(String))];
      const kids = keys.length && child.byParent ? await child.byParent(db, n.childField, keys) : [];
      const by = new Map<string, Rec[]>();
      for (const k of kids) { const pk = String(valueOf(k, n.childField)); (by.get(pk) ?? by.set(pk, []).get(pk)!).push(await nestChild(db, child, k, unmasked, nestedIn)); }
      page.forEach((r, i) => { out[i]![n.as] = by.get(String(valueOf(r, n.parentField))) ?? []; });
    }
    return out;
  };
  yield csv ? csvHeader(def) : `{"entity":${JSON.stringify(def.id)},"label":${JSON.stringify(def.label)},"templateVersion":${JSON.stringify(templateVersion(def))},"masked":${!unmasked},"records":[`;
  let first = true;
  for (;;) {
    const room = maxRows === null ? EXPORT_PAGE : Math.min(EXPORT_PAGE, maxRows - rows);
    if (room <= 0) { outcome.complete = false; outcome.resume = after; break; }
    const page = await def.read(db, after, room);
    if (csv) { for (const r of page.rows) yield csvRow(def, maskRecord(def, r, unmasked)); }
    else { for (const r of await attach(page.rows)) { yield (first ? '\n' : ',\n') + JSON.stringify(r); first = false; } }
    rows += page.rows.length;
    progress(page.rows.length);
    after = page.next;
    if (!after) { outcome.complete = true; outcome.resume = null; break; }
  }
  if (!csv) yield '\n]}\n';
  outcome.rows = rows;
}
/** A nested child, itself with its own nested children (accounts carry services). */
async function nestChild(db: Db, def: EntityDef, r: Rec, unmasked: boolean, nestedIn: Set<string>): Promise<Rec> {
  const o = jsonRecord(def, maskRecord(def, r, unmasked));
  for (const n of (def.nest ?? []).filter((x) => nestedIn.has(x.entity))) {
    const child = entityById(n.entity)!;
    const key = valueOf(r, n.parentField);
    const kids = key != null && child.byParent ? await child.byParent(db, n.childField, [String(key)]) : [];
    o[n.as] = await Promise.all(kids.map((k) => nestChild(db, child, k, unmasked, nestedIn)));
  }
  return o;
}

/** Deflates the text of one entity while counting and hashing the uncompressed bytes. */
function deflated(text: AsyncIterable<string>, tally: Tally, hash: ReturnType<typeof createHash>): AsyncIterable<Uint8Array> {
  const bytes = (async function* () { for await (const t of text) { const b = enc.encode(t); tally.add(b); hash.update(b); yield b; } })();
  const input = Readable.from(bytes, { objectMode: false });
  const z = createDeflateRaw({ level: 6 });
  input.on('error', (e) => z.destroy(e));
  input.pipe(z);
  return z;
}

const README = (job: Row, entities: EntityDef[]) => [
  'Meridian data export', `Job ${job.id}`, `Format ${job.format}; sensitive fields ${job.masked ? 'masked' : 'NOT masked (super user, with a reason on record)'}.`, '',
  'Files are named by the phase they must be loaded in (p1 first), so loading them in name order respects what points at what.',
  'manifest.json lists every file with its row count and SHA-256, and says whether a data set was exported completely or in a part (and where the next part starts).', '',
  ...entities.map((e) => `p${e.phase}  ${e.id} — ${e.label}`), '',
].join('\r\n');

/**
 * Starts the download of a pending export: marks it exporting and returns the archive as a stream. When the stream ends the job is completed, and if it
 * fails or the client goes away the job is marked failed with the reason. The job can be downloaded only once.
 */
export async function startExport(db: Db, jobId: string, actor: string): Promise<{ stream: ReadableStream<Uint8Array>; fileName: string }> {
  const claimed = (await db.query(`UPDATE migration_jobs SET status='EXPORTING', started_at=now(), updated_at=now() WHERE id=$1 AND kind='EXPORT' AND status='PENDING' AND created_by=$2 RETURNING *`, [jobId, actor])).rows[0];
  if (!claimed) {
    const j = (await db.query('SELECT status, created_by FROM migration_jobs WHERE id=$1 AND kind=$2', [jobId, 'EXPORT'])).rows[0];
    if (!j || j.createdBy !== actor) throw notFound('export', jobId);
    throw rejected(`This export is ${String(j.status).toLowerCase()}. An export can be downloaded once: start a new one.`);
  }
  const job = claimed as Row;
  const entities = job.entities.map((id: string) => entityById(id)!).filter(Boolean) as EntityDef[];
  const nestedIn = new Set(job.format === 'JSON' && job.options.nest !== false ? entities.map((e) => e.id) : []);
  const skipTop = new Set<string>();
  if (job.format === 'JSON' && job.options.nest !== false) for (const e of entities) for (const n of e.nest ?? []) if (nestedIn.has(n.entity)) skipTop.add(n.entity);
  const files = entities.filter((e) => !skipTop.has(e.id));
  const estimates = new Map<string, number>();
  let total = 0;
  for (const e of entities) { const n = await estimateRows(db, e); estimates.set(e.id, n); total += n; }
  await db.query('UPDATE migration_jobs SET rows_total=$2 WHERE id=$1', [jobId, total]);

  let done = 0, lastTick = 0, stage = '';
  const tick = async (force = false) => {
    if (!force && Date.now() - lastTick < 1000) return;
    lastTick = Date.now();
    await db.query('UPDATE migration_jobs SET rows_done=$2, percent=$3, stage=$4, updated_at=now() WHERE id=$1', [jobId, done, total ? Math.min(99, Math.floor((done / total) * 100)) : 0, stage]).catch(() => undefined);
  };
  const outcomes: EntityOutcome[] = [];
  const ext = job.format === 'CSV' ? 'csv' : 'json';

  const archive = (async function* () {
    try {
      yield* zipArchive((async function* () {
        const readme = new Tally();
        const text = enc.encode(README(job, files));
        yield { name: 'README.txt', data: () => deflated((async function* () { yield new TextDecoder().decode(text); })(), readme, createHash('sha256')), done: () => readme };
        for (const def of files) {
          stage = def.id;
          const tally = new Tally(), hash = createHash('sha256');
          const outcome: EntityOutcome = { id: def.id, file: `p${def.phase}-${def.id}.${ext}`, rows: 0, bytes: 0, sha256: '', complete: true, resume: null };
          yield {
            name: outcome.file,
            data: () => deflated(entityText(db, def, job, (n) => { done += n; void tick(); }, outcome, nestedIn), tally, hash),
            done: () => { outcome.bytes = tally.size; outcome.sha256 = hash.digest('hex'); outcomes.push(outcome); return tally; },
          };
        }
        const manifest = new Tally();
        const body = JSON.stringify({
          job: job.id, exportedAt: new Date().toISOString(), exportedBy: actor, format: job.format, masked: !!job.masked, nested: job.format === 'JSON' && job.options.nest !== false,
          files: outcomes.map((o) => ({ ...o, templateVersion: templateVersion(entityById(o.id)!) })),
        }, null, 2);
        yield { name: 'manifest.json', data: () => deflated((async function* () { yield body; })(), manifest, createHash('sha256')), done: () => manifest };
      })());
      const resume = Object.fromEntries(outcomes.filter((o) => !o.complete && o.resume).map((o) => [o.id, o.resume!]));
      done = outcomes.reduce((n, o) => n + o.rows, 0);
      await db.query(`UPDATE migration_jobs SET status='COMPLETED', rows_done=$2, rows_ok=$2, percent=100, stage=NULL, finished_at=now(), updated_at=now(), summary=$3 WHERE id=$1`,
        [jobId, done, JSON.stringify({ files: outcomes, resume, partial: Object.keys(resume).length > 0 })]);
      await audit(db, actor, 'migration', jobId, 'EXPORT_COMPLETED', { rows: done, masked: !!job.masked, entities: job.entities });
    } catch (e) {
      await db.query(`UPDATE migration_jobs SET status='FAILED', finished_at=now(), updated_at=now(), summary=$2 WHERE id=$1`, [jobId, JSON.stringify({ error: (e as Error).message, stage })]).catch(() => undefined);
      throw e;
    }
  })();
  const it = archive[Symbol.asyncIterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) { const n = await it.next(); if (n.done) c.close(); else c.enqueue(n.value); },
    async cancel(reason) {
      await it.return?.(undefined);
      await db.query(`UPDATE migration_jobs SET status='FAILED', finished_at=now(), updated_at=now(), summary=$2 WHERE id=$1 AND status='EXPORTING'`, [jobId, JSON.stringify({ error: 'The download was stopped before it finished.', reason: String(reason ?? '') })]).catch(() => undefined);
    },
  });
  return { stream, fileName: `meridian-export-${new Date().toISOString().slice(0, 10)}-${String(jobId).slice(0, 8)}.zip` };
}
