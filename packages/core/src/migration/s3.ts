import { createHash, createHmac } from 'node:crypto';

/**
 * Object storage for very large uploads: the browser sends the file straight to an S3-compatible bucket (Amazon S3, Google Cloud Storage's S3 interface,
 * Cloudflare R2, MinIO) with a short-lived pre-signed URL, so a multi-gigabyte file never passes through the application. The job then reads it back in ranges.
 * Signing is AWS Signature Version 4 in the query string, written here so no SDK is needed.
 *
 * Environment: MERIDIAN_MIGRATION_S3_BUCKET, _REGION, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY, and optionally _ENDPOINT (for a non-Amazon service; path-style) and _PREFIX.
 */
export interface S3Config { bucket: string; region: string; accessKeyId: string; secretAccessKey: string; endpoint?: string; prefix: string }

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const bucket = env.MERIDIAN_MIGRATION_S3_BUCKET?.trim(), accessKeyId = env.MERIDIAN_MIGRATION_S3_ACCESS_KEY_ID?.trim(), secretAccessKey = env.MERIDIAN_MIGRATION_S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return { bucket, region: env.MERIDIAN_MIGRATION_S3_REGION?.trim() || 'us-east-1', accessKeyId, secretAccessKey, endpoint: env.MERIDIAN_MIGRATION_S3_ENDPOINT?.trim().replace(/\/$/, '') || undefined, prefix: (env.MERIDIAN_MIGRATION_S3_PREFIX ?? 'meridian-migration/').replace(/^\/+/, '') };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (key: string) => key.split('/').map(enc).join('/');

/** A pre-signed URL for one request on one object. The signature covers the method, the object, the time and the validity, nothing else. */
export function presignUrl(cfg: S3Config, method: 'GET' | 'PUT' | 'HEAD' | 'DELETE', key: string, o: { expires?: number; now?: Date } = {}): string {
  const now = o.now ?? new Date();
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z
  const date = stamp.slice(0, 8);
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  let origin: string, host: string, path: string;
  if (cfg.endpoint) { const u = new URL(cfg.endpoint); origin = cfg.endpoint; host = u.host; path = `/${enc(cfg.bucket)}/${encPath(key)}`; }
  else { host = cfg.region === 'us-east-1' ? `${cfg.bucket}.s3.amazonaws.com` : `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`; origin = `https://${host}`; path = `/${encPath(key)}`; }
  const q: Record<string, string> = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${cfg.accessKeyId}/${scope}`, 'X-Amz-Date': stamp, 'X-Amz-Expires': String(o.expires ?? 900), 'X-Amz-SignedHeaders': 'host' };
  const query = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k]!)}`).join('&');
  const canonical = [method, path, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, date), cfg.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  return `${origin}${path}?${query}&X-Amz-Signature=${signature}`;
}

export const objectKey = (cfg: S3Config, uploadId: string, fileName: string) => `${cfg.prefix}${uploadId}/${fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-100)}`;

/** The size of an object, or null if it is not there. */
export async function s3Size(cfg: S3Config, key: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const r = await fetchImpl(presignUrl(cfg, 'HEAD', key), { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`The object store answered ${r.status}.`);
  const n = Number(r.headers.get('content-length'));
  return Number.isFinite(n) ? n : null;
}

export async function s3Range(cfg: S3Config, key: string, from: number, length: number, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const r = await fetchImpl(presignUrl(cfg, 'GET', key), { headers: { range: `bytes=${from}-${from + length - 1}` }, signal: AbortSignal.timeout(60_000) });
  if (r.status === 416) return new Uint8Array(0);
  if (!r.ok && r.status !== 206) throw new Error(`The object store answered ${r.status}.`);
  return new Uint8Array(await r.arrayBuffer());
}
export const s3Delete = (cfg: S3Config, key: string, fetchImpl: typeof fetch = fetch) => fetchImpl(presignUrl(cfg, 'DELETE', key), { method: 'DELETE', signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
