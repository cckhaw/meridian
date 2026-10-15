import { createHash, randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import type { Db, Queryable, Row } from '../db.js';
import { invalid, notFound, rejected } from '../errors.js';
import { entityById, importFields } from './entities.js';
import { objectKey, presignUrl, s3ConfigFromEnv, s3Range, s3Size, type S3Config } from './s3.js';

/**
 * Uploaded files. By default a file is sent in pieces (a few MB each, base64 in JSON, so it fits a serverless request) and kept in the database until the job
 * has read it. When an S3-compatible bucket is configured, the browser sends the file straight to it with a pre-signed URL and nothing large passes through here.
 * A JSON document or a spreadsheet is turned into rows when the upload is completed, so the job only ever reads CSV or one-record-per-line JSON.
 */
export const CHUNK_BYTES = 2 * 1024 * 1024;
export const DB_MAX_BYTES = Number(process.env.MERIDIAN_MIGRATION_DB_MAX_MB ?? 256) * 1024 * 1024;
export const CONVERT_MAX_BYTES = 128 * 1024 * 1024;
const EXT = /\.(csv|txt|ndjson|jsonl|json|xlsx)$/i;

export interface FileSource { size: number; read(from: number, length: number): Promise<Uint8Array> }

export async function createUpload(q: Queryable, actor: string, i: { fileName: string; totalBytes: number }, env: NodeJS.ProcessEnv = process.env): Promise<Row & { mode: 'chunked' | 'presigned'; presigned?: { url: string; method: 'PUT' } }> {
  const fileName = i.fileName.trim().slice(-150);
  if (!EXT.test(fileName)) throw invalid('Upload a .csv, .json, .ndjson or .xlsx file.');
  if (!Number.isInteger(i.totalBytes) || i.totalBytes < 1) throw invalid('The file is empty.');
  const s3 = s3ConfigFromEnv(env);
  const id = randomUUID();
  if (s3) {
    if (!/\.(csv|txt|ndjson|jsonl)$/i.test(fileName)) throw invalid('Files that go to the object store must be CSV or NDJSON (convert a JSON document or a spreadsheet first, or turn the object store off).');
    if (i.totalBytes > 5 * 1024 ** 3) throw invalid('A single upload to the object store is at most 5 GB: split the file.');
    const key = objectKey(s3, id, fileName);
    const row = (await q.query(`INSERT INTO migration_uploads (id, created_by, file_name, total_bytes, chunk_bytes, chunks, storage, object_key) VALUES ($1,$2,$3,$4,$5,1,'S3',$6) RETURNING *`, [id, actor, fileName, i.totalBytes, CHUNK_BYTES, key])).rows[0]!;
    return { ...row, mode: 'presigned', presigned: { url: presignUrl(s3, 'PUT', key, { expires: 3600 }), method: 'PUT' } };
  }
  if (i.totalBytes > DB_MAX_BYTES) throw invalid(`A file up to ${Math.round(DB_MAX_BYTES / 1024 / 1024)} MB can be uploaded here. Split it into several files, or ask for an object store to be set up for larger ones.`);
  const chunks = Math.ceil(i.totalBytes / CHUNK_BYTES);
  const row = (await q.query(`INSERT INTO migration_uploads (id, created_by, file_name, total_bytes, chunk_bytes, chunks) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [id, actor, fileName, i.totalBytes, CHUNK_BYTES, chunks])).rows[0]!;
  return { ...row, mode: 'chunked' };
}

async function mine(q: Queryable, actor: string, id: string): Promise<Row> {
  const u = /^[0-9a-f-]{36}$/i.test(id) ? (await q.query('SELECT * FROM migration_uploads WHERE id=$1', [id])).rows[0] : null;
  if (!u || u.createdBy !== actor) throw notFound('upload', id);
  return u;
}

export async function putChunk(q: Queryable, actor: string, id: string, n: number, data: Buffer): Promise<{ received: number; of: number }> {
  const u = await mine(q, actor, id);
  if (u.status !== 'OPEN' || u.storage !== 'DB') throw rejected('This upload is closed.');
  if (!Number.isInteger(n) || n < 0 || n >= u.chunks) throw invalid(`There is no piece ${n}: this file has ${u.chunks}.`);
  const want = n === u.chunks - 1 ? Number(u.totalBytes) - n * u.chunkBytes : u.chunkBytes;
  if (data.length !== want) throw invalid(`Piece ${n} should be ${want} bytes, not ${data.length}.`);
  await q.query(`INSERT INTO migration_blobs (upload_id, seq, data) VALUES ($1,$2,$3) ON CONFLICT (upload_id, seq) DO UPDATE SET data=EXCLUDED.data`, [id, n, data]);
  const have = Number((await q.query('SELECT count(*) AS n FROM migration_blobs WHERE upload_id=$1', [id])).rows[0]!.n);
  return { received: have, of: u.chunks };
}

export async function openSource(q: Queryable, u: Row, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<FileSource> {
  if (u.storage === 'S3') {
    const s3 = s3ConfigFromEnv(env) as S3Config | null;
    if (!s3) throw rejected('The object store this file was sent to is not configured any more.');
    return { size: Number(u.totalBytes), read: (from, length) => s3Range(s3, u.objectKey, from, length, fetchImpl) };
  }
  return {
    size: Number(u.totalBytes),
    async read(from, length) {
      const cb = u.chunkBytes as number;
      const first = Math.floor(from / cb), last = Math.floor((Math.min(from + length, Number(u.totalBytes)) - 1) / cb);
      if (from >= Number(u.totalBytes)) return new Uint8Array(0);
      const rows = (await q.query('SELECT seq, data FROM migration_blobs WHERE upload_id=$1 AND seq BETWEEN $2 AND $3 ORDER BY seq', [u.id, first, last])).rows;
      const joined = Buffer.concat(rows.map((r) => r.data as Buffer));
      const offset = from - first * cb;
      return new Uint8Array(joined.subarray(offset, offset + length));
    },
  };
}

async function readAll(q: Queryable, u: Row): Promise<Buffer> {
  const rows = (await q.query('SELECT data FROM migration_blobs WHERE upload_id=$1 ORDER BY seq', [u.id])).rows;
  return Buffer.concat(rows.map((r) => r.data as Buffer));
}
async function replaceBlobs(q: Queryable, id: string, data: Buffer): Promise<void> {
  await q.query('DELETE FROM migration_blobs WHERE upload_id=$1', [id]);
  const chunks = Math.max(1, Math.ceil(data.length / CHUNK_BYTES));
  for (let n = 0; n < chunks; n++) await q.query('INSERT INTO migration_blobs (upload_id, seq, data) VALUES ($1,$2,$3)', [id, n, data.subarray(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES)]);
  await q.query('UPDATE migration_uploads SET total_bytes=$2, chunks=$3 WHERE id=$1', [id, data.length, chunks]);
}

// ───────────────────────── turning documents and spreadsheets into rows ─────────────────────────
type Rec = Record<string, unknown>;

/**
 * A JSON document's records, each as a flat record of its own data set. A file of nested records (customers with their accounts and services, as the JSON export
 * writes them) becomes several data sets: the parents, then the children with the parent's key filled in, in the order they must be loaded.
 */
export function explodeJson(doc: unknown, entityHint?: string): Array<{ entity: string; records: Rec[] }> {
  let entity = entityHint, records: unknown;
  if (Array.isArray(doc)) records = doc;
  else if (doc && typeof doc === 'object') { const d = doc as Rec; entity = (d.entity as string | undefined) ?? (d.template as Rec | undefined)?.entity as string | undefined ?? entity; records = d.records; }
  if (!Array.isArray(records)) throw invalid('A JSON file holds an array of records, or an object with them under "records".');
  if (!entity || !entityById(entity)) throw invalid('This JSON file does not say which data set it holds. Export or download the JSON template, which names it.');
  const out = new Map<string, Rec[]>();
  const walk = (ent: string, recs: Rec[]) => {
    const def = entityById(ent)!;
    const names = new Set(importFields(def).map((f) => f.name));
    for (const r of recs) {
      const flat: Rec = {};
      for (const [k, v] of Object.entries(r)) {
        const nest = def.nest?.find((n) => n.as === k);
        if (nest && Array.isArray(v)) {
          const kids = (v as Rec[]).map((c) => ({ ...c, [nest.childField]: c[nest.childField] ?? r[nest.parentField] }));
          walk(nest.entity, kids);
        } else flat[k] = v;
      }
      for (const k of Object.keys(flat)) if (!names.has(k) && flat[k] === undefined) delete flat[k];
      (out.get(ent) ?? out.set(ent, []).get(ent)!).push(flat);
    }
  };
  walk(entity, records as Rec[]);
  const order = [...out.keys()].sort((a, b) => entityById(a)!.phase - entityById(b)!.phase || (entityById(b)!.dependsOn.includes(a) ? -1 : 1));
  return order.map((e) => ({ entity: e, records: out.get(e)! }));
}

const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const colIndex = (ref: string) => { let n = 0; for (const ch of /^[A-Z]+/.exec(ref)![0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const csvq = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The first worksheet of an .xlsx file as CSV text. Dates are whatever the cells hold (numbers for real dates): write dates as text in the sheet. */
export function xlsxToCsv(buf: Uint8Array): string {
  const files = unzipSync(buf, { filter: (f) => /^xl\/(sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(f.name) });
  const sheetName = Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort()[0];
  if (!sheetName) throw invalid('That spreadsheet has no worksheet.');
  const shared: string[] = [];
  if (files['xl/sharedStrings.xml']) for (const m of strFromU8(files['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(decodeXml([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const lines: string[] = [];
  for (const rm of strFromU8(files[sheetName]!).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cm of rm[1]!.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!, body = cm[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      let v = '';
      if (type === 'inlineStr') v = decodeXml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
      else { const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''; v = type === 's' ? shared[Number(raw)] ?? '' : type === 'b' ? (raw === '1' ? 'true' : 'false') : decodeXml(raw); }
      const at = ref ? colIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = v;
    }
    lines.push(cells.map(csvq).join(','));
  }
  if (!lines.length) throw invalid('That spreadsheet is empty.');
  return lines.join('\r\n') + '\r\n';
}

export interface CompletedUpload { id: string; entity: string | null; format: 'CSV' | 'NDJSON'; rows: number | null; bytes: number; fileName: string }

/**
 * Closes an upload: checks that every piece (or the object) is there, reads the file's format, and turns a JSON document or a spreadsheet into rows.
 * Returns the upload, and, for a JSON file of nested records, one more per data set inside it (in the order to load them).
 */
export async function completeUpload(db: Db, actor: string, id: string, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Promise<{ uploads: CompletedUpload[] }> {
  const u = await mine(db, actor, id);
  if (u.status !== 'OPEN') throw rejected('This upload is already closed.');
  const name = String(u.fileName);
  if (u.storage === 'S3') {
    const s3 = s3ConfigFromEnv(env);
    if (!s3) throw rejected('The object store is not configured.');
    const size = await s3Size(s3, u.objectKey, fetchImpl);
    if (size === null) throw invalid('The file has not arrived in the object store yet. Upload it, then complete.');
    if (size !== Number(u.totalBytes)) throw invalid(`The file in the object store is ${size} bytes, not the ${u.totalBytes} that were announced.`);
    const format = /\.(ndjson|jsonl)$/i.test(name) ? 'NDJSON' : 'CSV';
    await db.query(`UPDATE migration_uploads SET status='COMPLETE', format=$2, completed_at=now() WHERE id=$1`, [id, format]);
    return { uploads: [{ id, entity: null, format, rows: null, bytes: size, fileName: name }] };
  }
  const have = Number((await db.query('SELECT count(*) AS n, COALESCE(sum(length(data)),0) AS bytes FROM migration_blobs WHERE upload_id=$1', [id])).rows[0]!.n);
  if (have !== u.chunks) throw invalid(`${u.chunks - have} piece${u.chunks - have === 1 ? ' is' : 's are'} still missing. Send them, then complete.`);
  const done: CompletedUpload[] = [];
  const finish = async (uid: string, format: 'CSV' | 'NDJSON', fileName: string, rows: number | null, bytes: number, entity: string | null, sha: string, note: Rec = {}) => {
    await db.query(`UPDATE migration_uploads SET status='COMPLETE', format=$2, rows_hint=$3, sha256=$4, note=$5, completed_at=now() WHERE id=$1`, [uid, format, rows, sha, JSON.stringify({ entity, ...note })]);
    done.push({ id: uid, entity, format, rows, bytes, fileName });
  };
  const ndjson = (recs: Rec[]) => Buffer.from(recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (/\.(csv|txt)$/i.test(name) || /\.(ndjson|jsonl)$/i.test(name)) {
    const hash = createHash('sha256');
    const rows = (await db.query('SELECT data FROM migration_blobs WHERE upload_id=$1 ORDER BY seq', [id])).rows;
    for (const r of rows) hash.update(r.data as Buffer);
    await finish(id, /\.(ndjson|jsonl)$/i.test(name) ? 'NDJSON' : 'CSV', name, null, Number(u.totalBytes), null, hash.digest('hex'));
  } else {
    if (Number(u.totalBytes) > CONVERT_MAX_BYTES) throw invalid(`A JSON document or spreadsheet can be up to ${CONVERT_MAX_BYTES / 1024 / 1024} MB. Use CSV, or NDJSON (one record per line), for larger files.`);
    const buf = await readAll(db, u);
    if (/\.xlsx$/i.test(name)) {
      let csv: string;
      try { csv = xlsxToCsv(buf); } catch (e) { throw invalid(e instanceof Error && (e as { code?: string }).code ? 'That does not look like a valid .xlsx file.' : (e as Error).message); }
      const out = Buffer.from(csv);
      await replaceBlobs(db, id, out);
      await finish(id, 'CSV', name, null, out.length, null, createHash('sha256').update(out).digest('hex'), { from: 'xlsx' });
    } else {
      let doc: unknown;
      try { doc = JSON.parse(buf.toString('utf8')); } catch { throw invalid('That file is not valid JSON.'); }
      const parts = explodeJson(doc);
      for (const [i, p] of parts.entries()) {
        const out = ndjson(p.records);
        const uid = i === 0 ? id : randomUUID();
        if (i === 0) await replaceBlobs(db, id, out);
        else {
          await db.query(`INSERT INTO migration_uploads (id, created_by, file_name, total_bytes, chunk_bytes, chunks) VALUES ($1,$2,$3,$4,$5,1)`, [uid, actor, `${name.replace(/\.json$/i, '')}.${p.entity}.ndjson`, out.length, CHUNK_BYTES]);
          await replaceBlobs(db, uid, out);
        }
        await finish(uid, 'NDJSON', i === 0 ? name : `${name.replace(/\.json$/i, '')}.${p.entity}.ndjson`, p.records.length, out.length, p.entity, createHash('sha256').update(out).digest('hex'), { from: 'json', fromUpload: id });
      }
    }
  }
  return { uploads: done };
}

export async function discardUpload(q: Queryable, actor: string, id: string): Promise<void> {
  await mine(q, actor, id);
  await q.query(`UPDATE migration_uploads SET status='DISCARDED' WHERE id=$1`, [id]);
  await q.query('DELETE FROM migration_blobs WHERE upload_id=$1', [id]);
}
