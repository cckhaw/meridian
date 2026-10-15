import { createHmac, timingSafeEqual } from 'node:crypto';
import { apiClientHmacSecret, authenticateApiKeyAny } from './apikeys.js';
import type { Queryable } from './db.js';
import { forbidden, unauthenticated } from './errors.js';
import { verifyAccessToken } from './oauth.js';

/**
 * Who is calling a northbound API. Three ways in, all reduced to the same principal:
 *  - `Authorization: Bearer <JWT>` from the OAuth token endpoint,
 *  - `Authorization: Bearer mk_…` an API key (partners, dealer portals), which may also require every request to be signed,
 *  - the signature itself: `X-Meridian-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` made with the key's signing secret.
 */
export interface GatewayPrincipal { kind: 'OAUTH' | 'API_KEY'; ref: string; channel: string; scopes: string[] }
const TOLERANCE_SECONDS = 300;

export function verifyRequestSignature(raw: string, header: string | null, secret: string, nowMs = Date.now()) {
  const m = /^t=(\d{9,12}),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) throw unauthenticated('A valid X-Meridian-Signature is required for this key.');
  if (Math.abs(nowMs / 1000 - Number(m[1])) > TOLERANCE_SECONDS) throw unauthenticated('The request signature is too old.');
  const want = createHmac('sha256', secret).update(`${m[1]}.${raw}`).digest();
  const got = Buffer.from(m[2]!, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw unauthenticated('The request signature does not match.');
}

export async function authenticateNorthbound(q: Queryable, h: { authorization: string | null; signature: string | null; raw: string }, nowMs = Date.now()): Promise<GatewayPrincipal> {
  const token = /^Bearer\s+(\S+)$/i.exec(h.authorization ?? '')?.[1];
  if (!token) throw unauthenticated('Send an access token or API key as Authorization: Bearer …');
  if (token.startsWith('mk_')) {
    // an API key may carry any scope it was issued with; the route decides which it needs
    const probe = await authenticateApiKeyAny(q, h.authorization);
    const secret = apiClientHmacSecret(probe);
    if (secret) verifyRequestSignature(h.raw, h.signature, secret, nowMs);
    return { kind: 'API_KEY', ref: `key:${probe.id}`, channel: probe.channel, scopes: probe.scopes as string[] };
  }
  const t = await verifyAccessToken(q, token, nowMs);
  return { kind: 'OAUTH', ref: `oauth:${t.clientId}`, channel: t.channel, scopes: t.scopes };
}
export function requireScope(p: GatewayPrincipal, scope: string) {
  if (!p.scopes.includes(scope)) throw forbidden(`This credential does not have the ${scope} scope.`);
}
