import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NORTHBOUND_SCOPES } from './oauth.js';
import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { invalid, notFound, unauthenticated } from './errors.js';
import { decryptText, encryptText, sha256Hex } from './field-crypto.js';

/**
 * Credentials for an externally hosted store-front. A key looks like `mk_live_<prefix>_<secret>`: the prefix finds the row, only a hash of
 * the secret is stored, and the full key is shown once at creation. Keys are for server-to-server calls and must never reach a browser.
 */
export const API_SCOPES = ['store', ...NORTHBOUND_SCOPES] as const;
export type ApiScope = (typeof API_SCOPES)[number];
export interface ApiClient { id: string; name: string; scopes: ApiScope[]; status: string; channel: string; /** Set when the key must also sign each request (partner channels). */ hmacSecretEnc: string | null }

const KEY_RE = /^mk_(?:live|test)_([a-z0-9]{10})_([A-Za-z0-9_-]{32,})$/;

export async function createApiClient(q: Queryable, actor: string, o: { name: string; scopes?: ApiScope[]; channel?: string; expiresAt?: string | null; signRequests?: boolean }): Promise<{ client: Row; key: string; hmacSecret?: string }> {
  const name = o.name.trim();
  if (!name || name.length > 60) throw invalid('Give the client a name (up to 60 characters).');
  const scopes = o.scopes?.length ? o.scopes : ['store'];
  for (const s of scopes) if (!(API_SCOPES as readonly string[]).includes(s)) throw invalid(`unknown scope ${s}`);
  const prefix = randomBytes(8).toString('hex').slice(0, 10);
  const secret = randomBytes(32).toString('base64url');
  const key = `mk_${process.env.NODE_ENV === 'production' ? 'live' : 'test'}_${prefix}_${secret}`;
  const channel = o.channel ?? 'DEFAULT';
  if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(channel)) throw invalid('A channel is capital letters, digits and underscores, for example PARTNER_PORTAL.');
  if (o.expiresAt && (Number.isNaN(Date.parse(o.expiresAt)) || Date.parse(o.expiresAt) < Date.now())) throw invalid('The expiry must be a date in the future.');
  const hmacSecret = o.signRequests ? randomBytes(32).toString('base64url') : undefined;
  const row = (await q.query(`INSERT INTO api_clients (name, key_prefix, key_hash, scopes, created_by, channel, expires_at, hmac_secret_enc) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, key_prefix, scopes, status, channel, expires_at, created_by, created_at`,
    [name, prefix, sha256Hex(secret), scopes, actor, channel, o.expiresAt ?? null, hmacSecret ? encryptText(hmacSecret) : null])).rows[0]!;
  await audit(q, actor, 'api_client', row.id, 'CREATE', { name, scopes, channel, signed: !!hmacSecret });
  return { client: row, key, ...(hmacSecret ? { hmacSecret } : {}) };
}

export async function listApiClients(q: Queryable): Promise<Row[]> {
  return (await q.query(`SELECT id, name, key_prefix, scopes, status, channel, expires_at, (hmac_secret_enc IS NOT NULL) AS signed, created_by, created_at, last_used_at, revoked_at FROM api_clients ORDER BY created_at DESC`)).rows;
}

export async function revokeApiClient(q: Queryable, actor: string, id: string): Promise<void> {
  const r = await q.query(`UPDATE api_clients SET status='REVOKED', revoked_at=now() WHERE id=$1 AND status='ACTIVE'`, [id]);
  if (!r.rowCount) throw notFound('api client', id);
  await audit(q, actor, 'api_client', id, 'REVOKE');
}

/** Resolves `Authorization: Bearer mk_...` to an active, unexpired key. Every failure is the same generic 401 so a key's existence is not revealed. */
export async function authenticateApiKeyAny(q: Queryable, header: string | null): Promise<ApiClient> {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
  const m = token ? KEY_RE.exec(token) : null;
  if (!m) throw unauthenticated('A valid API key is required.');
  const row = (await q.query(`SELECT id, name, scopes, status, key_hash, channel, expires_at, hmac_secret_enc FROM api_clients WHERE key_prefix=$1`, [m[1]])).rows[0];
  const want = Buffer.from(row?.keyHash ?? '0'.repeat(64), 'hex');
  const got = Buffer.from(sha256Hex(m[2]!), 'hex');
  const same = want.length === got.length && timingSafeEqual(want, got);
  if (!row || !same || row.status !== 'ACTIVE' || (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now())) throw unauthenticated('A valid API key is required.');
  void q.query(`UPDATE api_clients SET last_used_at=now() WHERE id=$1`, [row.id]).catch(() => {});
  return { id: row.id, name: row.name, scopes: row.scopes, status: row.status, channel: row.channel, hmacSecretEnc: row.hmacSecretEnc };
}
/** As above, and the key must hold `scope` (the store-front routes ask for `store`). */
export async function authenticateApiKey(q: Queryable, header: string | null, scope: ApiScope = 'store'): Promise<ApiClient> {
  const c = await authenticateApiKeyAny(q, header);
  if (!(c.scopes as string[]).includes(scope)) throw unauthenticated('A valid API key is required.');
  return c;
}

export const apiClientHmacSecret = (c: ApiClient): string | null => (c.hmacSecretEnc ? decryptText(c.hmacSecretEnc) : null);
