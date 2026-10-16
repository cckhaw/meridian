import { createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { audit } from './audit.js';
import type { Queryable, Row } from './db.js';
import { DomainError, invalid, notFound, unauthenticated } from './errors.js';
import { sha256Hex } from './field-crypto.js';

/**
 * OAuth 2.0 client-credentials for the northbound APIs. A client gets a secret once; only its hash is kept. A rotated secret keeps working for a grace period so
 * the client can switch over without an outage. Access tokens are signed JWTs (HS256, key derived from MERIDIAN_DATA_KEY) carrying the scopes, the channel and an
 * expiry; every call also checks that the client is still active, so revoking a client cuts it off before its tokens expire.
 */
export const NORTHBOUND_SCOPES = [
  'subscriber:read', 'subscriber:write', 'sim:swap', 'msisdn:change', 'ownership:transfer', 'subscriber:status', 'subscription:change', 'vas:manage',
  'order:create', 'order:read', 'order:cancel', 'billing:read', 'payment:create', 'event:subscribe', 'document:read',
] as const;
export type NorthboundScope = (typeof NORTHBOUND_SCOPES)[number];
export const SCOPE_LABEL: Record<NorthboundScope, string> = {
  'subscriber:read': 'Read subscribers, services and balances', 'subscriber:write': 'Change subscriber details', 'sim:swap': 'Swap a SIM or eSIM', 'msisdn:change': 'Change a mobile number',
  'ownership:transfer': 'Transfer ownership of a service', 'subscriber:status': 'Suspend, resume, bar or terminate a service', 'subscription:change': 'Change a subscription or plan',
  'vas:manage': 'Add or remove value-added services and passes', 'order:create': 'Create sales orders', 'order:read': 'Read and track orders', 'order:cancel': 'Cancel orders',
  'billing:read': 'Read accounts, invoices and usage', 'payment:create': 'Submit payments and top-ups', 'event:subscribe': 'Subscribe to event notifications (TMF 688)', 'document:read': 'Read a customer\'s signed agreements',
};

const ISSUER = 'meridian';
const AUDIENCE = 'meridian-api';
/** A signing key derived from the deployment's data key, one per purpose. */
export const derivedKey = (label: string): Buffer => Buffer.from(hkdfSync('sha256', process.env.MERIDIAN_DATA_KEY ?? process.env.MERIDIAN_ID_PEPPER ?? 'dev-only-pepper', label, 'hs256', 32));
const jwtKey = (): Buffer => derivedKey('meridian-oauth-jwt');
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export interface OAuthClientView { id: string; clientId: string; name: string; channel: string; scopes: string[]; tokenTtlSeconds: number; status: string; rotatedAt: string | null; previousSecretValidUntil: string | null; createdBy: string; createdAt: string; lastUsedAt: string | null }
const view = (r: Row): OAuthClientView => ({ id: r.id, clientId: r.clientId, name: r.name, channel: r.channel, scopes: r.scopes, tokenTtlSeconds: r.tokenTtlSeconds, status: r.status, rotatedAt: r.rotatedAt ? String(r.rotatedAt) : null,
  previousSecretValidUntil: r.prevExpiresAt && new Date(r.prevExpiresAt).getTime() > Date.now() ? String(r.prevExpiresAt) : null, createdBy: r.createdBy, createdAt: String(r.createdAt), lastUsedAt: r.lastUsedAt ? String(r.lastUsedAt) : null });

function checkScopes(scopes: string[]) {
  if (!scopes.length) throw invalid('Choose at least one scope.');
  for (const s of scopes) if (!(NORTHBOUND_SCOPES as readonly string[]).includes(s)) throw invalid(`Unknown scope ${s}.`);
}
const checkChannel = (c: string) => { if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(c)) throw invalid('A channel is capital letters, digits and underscores, for example SELF_CARE.'); };
const checkTtl = (t: number) => { if (!Number.isInteger(t) || t < 60 || t > 86400) throw invalid('A token lives from 60 seconds to 24 hours.'); };

export async function createOAuthClient(q: Queryable, actor: string, i: { name: string; channel?: string; scopes: string[]; tokenTtlSeconds?: number }): Promise<{ client: OAuthClientView; clientSecret: string }> {
  const name = (i.name ?? '').trim();
  if (!name || name.length > 80) throw invalid('Give the client a name of up to 80 characters.');
  checkScopes(i.scopes); const channel = i.channel ?? 'DEFAULT'; checkChannel(channel); const ttl = i.tokenTtlSeconds ?? 900; checkTtl(ttl);
  const clientId = `mc_${randomBytes(9).toString('hex')}`;
  const secret = randomBytes(32).toString('base64url');
  const r = (await q.query(`INSERT INTO oauth_clients (client_id, name, channel, scopes, token_ttl_seconds, secret_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [clientId, name, channel, i.scopes, ttl, sha256Hex(secret), actor])).rows[0]!;
  await audit(q, actor, 'oauth_client', r.id, 'CREATE', { clientId, name, channel, scopes: i.scopes });
  return { client: view(r), clientSecret: secret };
}
export const listOAuthClients = async (q: Queryable) => (await q.query('SELECT * FROM oauth_clients ORDER BY created_at DESC')).rows.map(view);

export async function updateOAuthClient(q: Queryable, actor: string, id: string, i: { name?: string; channel?: string; scopes?: string[]; tokenTtlSeconds?: number }): Promise<OAuthClientView> {
  if (i.scopes) checkScopes(i.scopes); if (i.channel) checkChannel(i.channel); if (i.tokenTtlSeconds !== undefined) checkTtl(i.tokenTtlSeconds);
  const r = (await q.query(`UPDATE oauth_clients SET name=COALESCE($2,name), channel=COALESCE($3,channel), scopes=COALESCE($4,scopes), token_ttl_seconds=COALESCE($5,token_ttl_seconds) WHERE id=$1 AND status='ACTIVE' RETURNING *`,
    [id, i.name?.trim() || null, i.channel ?? null, i.scopes ?? null, i.tokenTtlSeconds ?? null])).rows[0];
  if (!r) throw notFound('client', id);
  await audit(q, actor, 'oauth_client', id, 'UPDATE', { channel: i.channel, scopes: i.scopes, ttl: i.tokenTtlSeconds });
  return view(r);
}
/** A new secret, shown once. The old one keeps working for `graceMinutes` so the client can switch over. */
export async function rotateOAuthSecret(q: Queryable, actor: string, id: string, graceMinutes = 60): Promise<{ client: OAuthClientView; clientSecret: string }> {
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 7 * 1440) throw invalid('The old secret can stay valid for 0 minutes to 7 days.');
  const secret = randomBytes(32).toString('base64url');
  const r = (await q.query(`UPDATE oauth_clients SET prev_secret_hash=secret_hash, prev_expires_at=now() + ($3 || ' minutes')::interval, secret_hash=$2, rotated_at=now() WHERE id=$1 AND status='ACTIVE' RETURNING *`, [id, sha256Hex(secret), String(graceMinutes)])).rows[0];
  if (!r) throw notFound('client', id);
  await audit(q, actor, 'oauth_client', id, 'ROTATE', { graceMinutes });
  return { client: view(r), clientSecret: secret };
}
export async function revokeOAuthClient(q: Queryable, actor: string, id: string) {
  const r = await q.query(`UPDATE oauth_clients SET status='REVOKED', revoked_at=now() WHERE id=$1 AND status='ACTIVE'`, [id]);
  if (!r.rowCount) throw notFound('client', id);
  await audit(q, actor, 'oauth_client', id, 'REVOKE');
  return { ok: true };
}

const same = (a: string, b: string) => { const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex'); return x.length === y.length && timingSafeEqual(x, y); };
const oauthError = (error: string, description: string) => new DomainError(error === 'invalid_client' ? 'UNAUTHENTICATED' : 'INVALID', description, { error });

/** The token endpoint (RFC 6749 §4.4). Scopes asked for must be a subset of the client's. */
export async function issueToken(q: Queryable, i: { grantType?: string; clientId?: string; clientSecret?: string; scope?: string }, nowMs = Date.now()): Promise<{ access_token: string; token_type: 'Bearer'; expires_in: number; scope: string }> {
  if (i.grantType !== 'client_credentials') throw oauthError('unsupported_grant_type', 'Only grant_type=client_credentials is supported.');
  const row = i.clientId ? (await q.query('SELECT * FROM oauth_clients WHERE client_id=$1', [i.clientId])).rows[0] : undefined;
  const h = sha256Hex(i.clientSecret ?? '');
  const ok = row && row.status === 'ACTIVE' && (same(row.secretHash, h) || (row.prevSecretHash && row.prevExpiresAt && new Date(row.prevExpiresAt).getTime() > nowMs && same(row.prevSecretHash, h)));
  if (!ok) throw oauthError('invalid_client', 'Client authentication failed.');
  const asked = (i.scope ?? '').split(/[\s,]+/).filter(Boolean);
  const bad = asked.filter((s) => !(row.scopes as string[]).includes(s));
  if (bad.length) throw oauthError('invalid_scope', `The client may not use ${bad.join(', ')}.`);
  const scopes = asked.length ? asked : (row.scopes as string[]);
  const iat = Math.floor(nowMs / 1000), exp = iat + row.tokenTtlSeconds;
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ iss: ISSUER, aud: AUDIENCE, sub: row.clientId, scope: scopes.join(' '), ch: row.channel, iat, exp, jti: randomUUID() });
  const sig = createHmac('sha256', jwtKey()).update(`${head}.${body}`).digest('base64url');
  void q.query('UPDATE oauth_clients SET last_used_at=now() WHERE id=$1', [row.id]).catch(() => {});
  return { access_token: `${head}.${body}.${sig}`, token_type: 'Bearer', expires_in: row.tokenTtlSeconds, scope: scopes.join(' ') };
}

export interface TokenClaims { clientId: string; channel: string; scopes: string[]; expiresAt: number }
/** Checks the signature, expiry, issuer and audience, and that the client is still active. */
export async function verifyAccessToken(q: Queryable, token: string, nowMs = Date.now()): Promise<TokenClaims> {
  const parts = token.split('.');
  const fail = () => unauthenticated('The access token is not valid.');
  if (parts.length !== 3) throw fail();
  const want = createHmac('sha256', jwtKey()).update(`${parts[0]}.${parts[1]}`).digest();
  const got = Buffer.from(parts[2]!, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw fail();
  let c: Record<string, any>;
  try { c = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()); } catch { throw fail(); }
  if (c.iss !== ISSUER || c.aud !== AUDIENCE || typeof c.exp !== 'number') throw fail();
  if (c.exp * 1000 <= nowMs) throw unauthenticated('The access token has expired.');
  const row = (await q.query('SELECT status, scopes FROM oauth_clients WHERE client_id=$1', [c.sub])).rows[0];
  if (!row || row.status !== 'ACTIVE') throw fail();
  const scopes = String(c.scope ?? '').split(' ').filter((s) => (row.scopes as string[]).includes(s));   // a scope taken away since the token was issued stops working at once
  return { clientId: c.sub, channel: c.ch ?? 'DEFAULT', scopes, expiresAt: c.exp };
}
