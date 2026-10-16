import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Where document bytes are kept, and how they are handed out.
 *
 *  - `DB`: in the database (the default; nothing to set up). Identity documents are encrypted (AES-256-GCM, see field-crypto.ts) before they get here.
 *  - `S3`: any S3-compatible object store (AWS S3, MinIO, Google Cloud Storage in interoperability mode, Cloudflare R2), switched on by environment
 *    variables. New documents then go to the bucket; older ones stay readable where they are. Requests are signed with AWS Signature Version 4 here,
 *    so no SDK is needed.
 *
 * Downloads are never public: a person gets a short-lived signed link (15 minutes), and every use of one is written to the audit log.
 */
export const LINK_TTL_SECONDS = 15 * 60;

export interface S3Config { endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string; pathStyle: boolean }
export function s3Config(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const endpoint = env.MERIDIAN_DOCS_S3_ENDPOINT?.trim(), bucket = env.MERIDIAN_DOCS_S3_BUCKET?.trim(), accessKey = env.MERIDIAN_DOCS_S3_ACCESS_KEY?.trim(), secretKey = env.MERIDIAN_DOCS_S3_SECRET_KEY?.trim();
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  if (!/^https:\/\//.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(endpoint)) throw new Error('MERIDIAN_DOCS_S3_ENDPOINT must be https (http only for localhost).');
  return { endpoint: endpoint.replace(/\/$/, ''), bucket, region: env.MERIDIAN_DOCS_S3_REGION?.trim() || 'us-east-1', accessKey, secretKey, pathStyle: (env.MERIDIAN_DOCS_S3_PATH_STYLE ?? 'true') !== 'false' };
}

const hmac = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest();
const hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const stamp = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

function target(c: S3Config, key: string): { url: URL; host: string; path: string } {
  const base = new URL(c.endpoint);
  const path = c.pathStyle ? `/${c.bucket}/${key.split('/').map(enc).join('/')}` : `/${key.split('/').map(enc).join('/')}`;
  const host = c.pathStyle ? base.host : `${c.bucket}.${base.host}`;
  return { url: new URL(`${base.protocol}//${host}${path}`), host, path };
}
const signingKey = (c: S3Config, date: string) => hmac(hmac(hmac(hmac(`AWS4${c.secretKey}`, date), c.region), 's3'), 'aws4_request');

/** A pre-signed GET link that stops working after `ttl` seconds (AWS Signature V4, query-string form). */
export function presignGet(c: S3Config, key: string, o: { ttl?: number; now?: Date; filename?: string } = {}): string {
  const now = o.now ?? new Date(), t = stamp(now), date = t.slice(0, 8), scope = `${date}/${c.region}/s3/aws4_request`;
  const { url, host, path } = target(c, key);
  const q: Record<string, string> = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${c.accessKey}/${scope}`, 'X-Amz-Date': t, 'X-Amz-Expires': String(o.ttl ?? LINK_TTL_SECONDS), 'X-Amz-SignedHeaders': 'host' };
  if (o.filename) q['response-content-disposition'] = `attachment; filename="${o.filename.replace(/[^\w.\- ]/g, '_')}"`;
  const canonicalQuery = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k]!)}`).join('&');
  const canonical = ['GET', path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const sig = createHmac('sha256', signingKey(c, date)).update(['AWS4-HMAC-SHA256', t, scope, hex(canonical)].join('\n')).digest('hex');
  url.search = `${canonicalQuery}&X-Amz-Signature=${sig}`;
  return url.toString();
}

async function s3Request(c: S3Config, method: 'PUT' | 'DELETE' | 'GET', key: string, body: Buffer | null, contentType: string | null, fetchImpl: typeof fetch): Promise<Response> {
  const now = new Date(), t = stamp(now), date = t.slice(0, 8), scope = `${date}/${c.region}/s3/aws4_request`;
  const { url, host, path } = target(c, key);
  const payload = hex(body ?? Buffer.alloc(0));
  const headers: Record<string, string> = { host, 'x-amz-content-sha256': payload, 'x-amz-date': t };
  if (contentType) headers['content-type'] = contentType;
  const names = Object.keys(headers).sort();
  const canonical = [method, path, '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payload].join('\n');
  const sig = createHmac('sha256', signingKey(c, date)).update(['AWS4-HMAC-SHA256', t, scope, hex(canonical)].join('\n')).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
  delete headers.host;
  return fetchImpl(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
}
export async function s3Put(c: S3Config, key: string, body: Buffer, contentType: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const r = await s3Request(c, 'PUT', key, body, contentType, fetchImpl);
  if (!r.ok) throw new Error(`The document store refused the upload (${r.status}).`);
}
export async function s3Get(c: S3Config, key: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const r = await s3Request(c, 'GET', key, null, null, fetchImpl);
  if (!r.ok) throw new Error(`The document store could not give the file (${r.status}).`);
  return Buffer.from(await r.arrayBuffer());
}
export async function s3Delete(c: S3Config, key: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const r = await s3Request(c, 'DELETE', key, null, null, fetchImpl);
  if (!r.ok && r.status !== 404) throw new Error(`The document store could not remove the file (${r.status}).`);
}

// ───────────────────────── our own short-lived links (documents kept in the database) ─────────────────────────
const linkKey = () => Buffer.from(hkdfSync('sha256', process.env.MERIDIAN_DATA_KEY ?? process.env.MERIDIAN_ID_PEPPER ?? 'dev-only-pepper', 'meridian-document-links', 'hmac', 32));
/** `<document id>.<expiry, seconds>.<signature>`: good for one document until it expires. */
export function signLink(documentId: string, o: { ttl?: number; now?: number; download?: boolean } = {}): string {
  const exp = Math.floor((o.now ?? Date.now()) / 1000) + (o.ttl ?? LINK_TTL_SECONDS), mode = o.download ? 'd' : 'v';
  return `${documentId}.${exp}.${mode}.${hmac(linkKey(), `${documentId}.${exp}.${mode}`).toString('base64url')}`;
}
export function verifyLink(token: string, now = Date.now()): { documentId: string; download: boolean } | null {
  const [id, exp, mode, sig] = token.split('.');
  if (!id || !exp || !mode || !sig || !/^\d+$/.test(exp) || (mode !== 'v' && mode !== 'd')) return null;
  const want = hmac(linkKey(), `${id}.${exp}.${mode}`), got = Buffer.from(sig, 'base64url');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  if (Number(exp) * 1000 < now) return null;
  return { documentId: id, download: mode === 'd' };
}
