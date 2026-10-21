import { audit } from './audit.js';
import type { Db, Queryable, Row } from './db.js';
import { conflict, DomainError, invalid, notFound } from './errors.js';
import { decryptText, encryptText, sha256Hex } from './field-crypto.js';
import { resetEventGate } from './events.js';
import { authEndpointProblem } from './auth-provider-config.js';
import { identityEndpointProblem } from './kyc-provider-config.js';

/**
 * Integration hub: the settings behind the northbound API gateway and the outside systems Meridian talks to, in six groups. Secrets entered here are encrypted
 * (MERIDIAN_DATA_KEY) and never sent back to the browser: a view says only whether one is set. Credentials that *we* issue (OAuth clients, API keys) are kept as hashes.
 */
export const HUB_GROUPS = ['gateway', 'webhooks', 'wfm', 'network', 'finance', 'events', 'auth', 'identity'] as const;
export type HubGroup = (typeof HUB_GROUPS)[number];

/** The kinds of endpoint each group holds. */
export const HUB_ENDPOINT_KINDS: Record<HubGroup, Array<{ kind: string; label: string; hint: string }>> = {
  gateway: [],
  webhooks: [],
  wfm: [],
  network: [
    { kind: 'HLR_HSS', label: 'HLR / HSS', hint: 'Subscriber data for 2G/3G/4G provisioning' },
    { kind: 'UDM', label: 'UDM (5G core)', hint: 'Subscriber data for 5G provisioning' },
    { kind: 'PCRF', label: 'PCRF / PCF', hint: 'Policy and quota' },
    { kind: 'OCS', label: 'Charging system (OCS)', hint: 'Buckets and balances' },
    { kind: 'SMDP_PLUS', label: 'SM-DP+ (eSIM)', hint: 'GSMA SM-DP+ server, certificate bundle, matching ID parameters' },
  ],
  finance: [
    { kind: 'SAP_FICO', label: 'SAP FI-CO', hint: 'SFTP or RFC/REST host and the journal file destination' },
    { kind: 'CREDIT_BUREAU', label: 'Credit bureau', hint: 'Credit scoring for device financing: the address, a token, and how to read the answer. Settings in JSON: mode (REST or SIMULATOR), idField, scorePath, upfrontPath, upfrontUnit (MINOR or MAJOR), referencePath' },
    { kind: 'PAYMENT_GATEWAY', label: 'Payment provider', hint: 'DuitNow, PromptPay, QRIS, SGQR, card processors: credentials and the callback address' },
  ],
  events: [{ kind: 'EVENT_BUS', label: 'Event bus', hint: 'Kafka brokers or another event stream' }],
  identity: [
    { kind: 'KYC_OCR', label: 'ID check service (OCR, face match, liveness)', hint: 'A REST service that reads the ID photographs: address, token, how to read its answer, and when a clean answer approves on its own' },
    { kind: 'KYC_MYDIGITALID', label: 'MyDigital ID', hint: 'Prove identity with MyDigital ID instead of photographs: issuer, client id and secret, redirect addresses and which claims carry the name, ID number and date of birth' },
  ],
  auth: [
    { kind: 'IDP_OIDC', label: 'Single sign-on (OpenID Connect)', hint: 'Microsoft Entra ID, Okta, Ping Identity, Keycloak: issuer, client id and secret, which group gets which role' },
    { kind: 'IDP_SAML', label: 'Single sign-on (SAML 2.0)', hint: 'Provider address, entity id and signing certificate. Stored and checked; assertions are not accepted yet' },
    { kind: 'LDAP', label: 'Active Directory / LDAP', hint: 'Directory address, service account, search base, group-to-role mappings and how often to sync' },
    { kind: 'OTP_GATEWAY', label: 'SMS / WhatsApp gateway', hint: 'Carries one-time codes for the second factor and password recovery, text-message alerts for staff and signed agreement copies for customers: address, token, sender and template ids (MFA, RESET, ALERT, CONTRACT)' },
    { kind: 'EMAIL_GATEWAY', label: 'E-mail sender', hint: 'Carries e-mail codes (when Settings → Security policy allows them), e-mail alerts for staff and signed agreement copies for customers: sender name and address, and an HTTPS API (address, token, request body), SMTP (host, port, security, user, password) or the simulator' },
  ],
};

/** Kinds that earlier versions offered and nothing reads: the field-service connection is Integration → Field service and logistics. Stored rows of these kinds still load, can be viewed and removed, but not added or changed. */
export const HUB_UNUSED_KINDS: Array<{ group: HubGroup; kind: string; label: string }> = [
  { group: 'wfm', kind: 'WFM_GATEWAY', label: 'Dispatch system' },
  { group: 'wfm', kind: 'SLOT_SYNC', label: 'Appointment slot sync' },
];

const URL_SCHEMES = ['https', 'http', 'sftp', 'diameter', 'rfc', 'kafka', 'tls', 'tcp', 'ldap', 'ldaps'];
const prod = () => process.env.NODE_ENV === 'production';

/** An address as an administrator types it. Plain http is for a machine's own address outside production; the protocols network elements speak are accepted. */
export function hubUrlProblem(url: string, what = 'The address'): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return `${what} is not a valid address.`; }
  const scheme = u.protocol.replace(':', '');
  if (!URL_SCHEMES.includes(scheme)) return `${what} must start with one of ${URL_SCHEMES.map((s) => `${s}://`).join(', ')}.`;
  if (scheme === 'http' && (prod() || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) return `${what} must use https:// (plain http is only for a machine's own address outside production).`;
  return null;
}

// ───────────────────────── endpoints ─────────────────────────
export interface HubEndpoint { id: string; group: HubGroup; kind: string; name: string; url: string | null; fallbackUrl: string | null; timeoutMs: number; config: Record<string, unknown>; hasSecret: boolean; enabled: boolean; updatedBy: string | null; updatedAt: string }
export interface HubEndpointInput { group: HubGroup; kind: string; name: string; url?: string | null; fallbackUrl?: string | null; timeoutMs?: number; config?: Record<string, unknown>; enabled?: boolean;
  /** Write-only. Undefined keeps what is stored, an empty string clears it. */ secret?: string }

const endpointOf = (r: Row): HubEndpoint => ({ id: r.id, group: r.groupKey, kind: r.kind, name: r.name, url: r.url, fallbackUrl: r.fallbackUrl, timeoutMs: r.timeoutMs, config: r.config ?? {}, hasSecret: !!r.secretEnc, enabled: r.enabled, updatedBy: r.updatedBy, updatedAt: String(r.updatedAt) });

export async function listHubEndpoints(q: Queryable, group?: HubGroup): Promise<HubEndpoint[]> {
  return (await q.query(`SELECT * FROM integration_endpoints ${group ? 'WHERE group_key=$1' : ''} ORDER BY group_key, kind, name`, group ? [group] : [])).rows.map(endpointOf);
}
/** A stored endpoint with its secret in the clear, for the adapters that call out. Never sent to a browser. */
export async function hubEndpointWithSecret(q: Queryable, group: HubGroup, kind: string, name?: string): Promise<(HubEndpoint & { secret: string | null }) | null> {
  const r = (await q.query(`SELECT * FROM integration_endpoints WHERE group_key=$1 AND kind=$2 AND enabled ${name ? 'AND name=$3' : ''} ORDER BY created_at LIMIT 1`, name ? [group, kind, name] : [group, kind])).rows[0];
  return r ? { ...endpointOf(r), secret: r.secretEnc ? decryptText(r.secretEnc) : null } : null;
}

/** One endpoint by id, secret included, enabled or not: for sending a test through exactly what is stored. Never sent to a browser. */
export async function hubEndpointByIdWithSecret(q: Queryable, id: string): Promise<(HubEndpoint & { secret: string | null }) | null> {
  const r = (await q.query('SELECT * FROM integration_endpoints WHERE id=$1', [id])).rows[0];
  return r ? { ...endpointOf(r), secret: r.secretEnc ? decryptText(r.secretEnc) : null } : null;
}

export async function saveHubEndpoint(q: Queryable, actor: string, i: HubEndpointInput, id?: string): Promise<HubEndpoint> {
  if (!(HUB_GROUPS as readonly string[]).includes(i.group)) throw invalid('Unknown group.');
  if (HUB_UNUSED_KINDS.some((k) => k.kind === i.kind)) throw invalid('This kind of connection is not used. The field-service connection is set in Integration → Field service and logistics.');
  const kinds = HUB_ENDPOINT_KINDS[i.group].map((k) => k.kind);
  if (!kinds.includes(i.kind)) throw invalid(`Choose a kind of endpoint for this group (${kinds.join(', ') || 'none'}).`);
  const name = (i.name ?? '').trim();
  if (!name || name.length > 80) throw invalid('Give it a name of up to 80 characters.');
  for (const [v, what] of [[i.url, 'The address'], [i.fallbackUrl, 'The fallback address']] as const) if (v) { const p = hubUrlProblem(v, what); if (p) throw invalid(p); }
  const authProblem = i.group === 'auth' ? authEndpointProblem(i.kind, { url: i.url, config: i.config }) : i.group === 'identity' ? identityEndpointProblem(i.kind, { url: i.url, config: i.config }) : null;
  if (authProblem) throw invalid(authProblem);
  const timeout = i.timeoutMs ?? 10000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120000) throw invalid('The timeout is 100 to 120,000 milliseconds.');
  const config = i.config ?? {};
  if (JSON.stringify(config).length > 20000) throw invalid('The settings are too large.');
  const enc = i.secret === undefined ? undefined : i.secret === '' ? null : encryptText(i.secret);
  try {
    if (id) {
      const r = await q.query(`UPDATE integration_endpoints SET group_key=$2, kind=$3, name=$4, url=$5, fallback_url=$6, timeout_ms=$7, config=$8, enabled=$9, secret_enc = CASE WHEN $10::boolean THEN $11 ELSE secret_enc END, updated_by=$12, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, i.group, i.kind, name, i.url || null, i.fallbackUrl || null, timeout, JSON.stringify(config), i.enabled ?? true, enc !== undefined, enc ?? null, actor]);
      if (!r.rows[0]) throw notFound('endpoint', id);
      await audit(q, actor, 'integration_endpoint', id, 'UPDATE', { group: i.group, kind: i.kind, name, secret: i.secret === undefined ? 'kept' : i.secret === '' ? 'cleared' : 'replaced' });
      return endpointOf(r.rows[0]);
    }
    const r = await q.query(`INSERT INTO integration_endpoints (group_key, kind, name, url, fallback_url, timeout_ms, config, secret_enc, enabled, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [i.group, i.kind, name, i.url || null, i.fallbackUrl || null, timeout, JSON.stringify(config), enc ?? null, i.enabled ?? true, actor]);
    await audit(q, actor, 'integration_endpoint', r.rows[0]!.id, 'CREATE', { group: i.group, kind: i.kind, name });
    return endpointOf(r.rows[0]!);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict('An endpoint of that kind with that name already exists.');
    throw e;
  }
}
export async function deleteHubEndpoint(q: Queryable, actor: string, id: string) {
  const r = await q.query('DELETE FROM integration_endpoints WHERE id=$1', [id]);
  if (!r.rowCount) throw notFound('endpoint', id);
  await audit(q, actor, 'integration_endpoint', id, 'DELETE');
  return { ok: true };
}

// ───────────────────────── rate limits ─────────────────────────
export const HUB_CHANNELS = ['SELF_CARE', 'STOREFRONT', 'RETAIL_POS', 'CALL_CENTER', 'DEALER', 'PARTNER_PORTAL', 'DEFAULT'] as const;
/** Used until an administrator sets a rule for the channel. */
export const DEFAULT_RATE_LIMITS: Record<string, number> = { SELF_CARE: 100, STOREFRONT: 100, RETAIL_POS: 500, CALL_CENTER: 300, DEALER: 100, PARTNER_PORTAL: 50, DEFAULT: 60 };
export interface RateRule { channel: string; perMinute: number; enabled: boolean; isDefault: boolean }

export async function listRateRules(q: Queryable): Promise<RateRule[]> {
  const rows = new Map((await q.query('SELECT * FROM rate_limit_rules')).rows.map((r) => [r.channel as string, r]));
  const chans = [...new Set([...HUB_CHANNELS, ...rows.keys()])];
  return chans.map((c) => { const r = rows.get(c); return { channel: c, perMinute: r?.perMinute ?? DEFAULT_RATE_LIMITS[c] ?? 60, enabled: r ? r.enabled : true, isDefault: !r }; });
}
export async function saveRateRule(q: Queryable, actor: string, channel: string, perMinute: number, enabled = true): Promise<RateRule> {
  if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(channel)) throw invalid('A channel is capital letters, digits and underscores, for example SELF_CARE.');
  if (!Number.isInteger(perMinute) || perMinute < 1 || perMinute > 100000) throw invalid('The limit is 1 to 100,000 requests a minute.');
  await q.query(`INSERT INTO rate_limit_rules (channel, per_minute, enabled, updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (channel) DO UPDATE SET per_minute=EXCLUDED.per_minute, enabled=EXCLUDED.enabled, updated_by=EXCLUDED.updated_by, updated_at=now()`, [channel, perMinute, enabled, actor]);
  await audit(q, actor, 'rate_limit', channel, 'SET', { perMinute, enabled });
  return { channel, perMinute, enabled, isDefault: false };
}
export async function deleteRateRule(q: Queryable, actor: string, channel: string) {
  await q.query('DELETE FROM rate_limit_rules WHERE channel=$1', [channel]);
  await audit(q, actor, 'rate_limit', channel, 'RESET');
  return { ok: true };
}

export class GatewayRateLimited extends DomainError {
  constructor(public readonly retryAfterSeconds: number, public readonly limit: number) { super('RATE_LIMITED', `Rate limit of ${limit} requests a minute exceeded. Retry in ${retryAfterSeconds} seconds.`); this.name = 'GatewayRateLimited'; }
}
/**
 * Sliding-window limit per client, from the rule of its channel. The window is the last 60 seconds, estimated from this minute's count and the previous
 * minute's count weighted by how much of it is still inside the window. Counted in the database so every server instance agrees; a Redis-backed limiter can
 * replace this behind the same call.
 */
export async function checkRateLimit(q: Queryable, subject: string, channel: string, nowMs = Date.now()): Promise<{ limit: number; remaining: number }> {
  const rule = (await q.query('SELECT per_minute, enabled FROM rate_limit_rules WHERE channel=$1', [channel])).rows[0];
  if (rule && !rule.enabled) return { limit: 0, remaining: Infinity };
  const limit = rule?.perMinute ?? DEFAULT_RATE_LIMITS[channel] ?? DEFAULT_RATE_LIMITS.DEFAULT!;
  const minute = Math.floor(nowMs / 60_000);
  const frac = (nowMs % 60_000) / 60_000;
  const cur = Number((await q.query(`INSERT INTO rate_limit_buckets (subject, minute, hits) VALUES ($1,$2,1) ON CONFLICT (subject, minute) DO UPDATE SET hits = rate_limit_buckets.hits + 1 RETURNING hits`, [subject, minute])).rows[0]!.hits);
  const prev = Number((await q.query('SELECT hits FROM rate_limit_buckets WHERE subject=$1 AND minute=$2', [subject, minute - 1])).rows[0]?.hits ?? 0);
  const used = cur + prev * (1 - frac);
  if (used > limit) throw new GatewayRateLimited(Math.max(1, Math.ceil(60 * (1 - frac))), limit);
  if (Math.random() < 0.01) void q.query('DELETE FROM rate_limit_buckets WHERE minute < $1', [minute - 5]).catch(() => {});
  return { limit, remaining: Math.max(0, Math.floor(limit - used)) };
}

// ───────────────────────── idempotency ─────────────────────────
export const IDEMPOTENCY_HEADER = 'x-idempotency-key';
/**
 * Runs `fn` once per (client, key). The same key with the same request returns the first result again; the same key with a different request is refused; a repeat
 * while the first is still running is refused with a conflict so the caller retries. A failed first attempt frees the key so it can be retried.
 */
export async function withIdempotency<T>(db: Db, clientRef: string, key: string, requestHash: string, fn: () => Promise<{ status: number; body: T }>): Promise<{ status: number; body: T; replayed: boolean }> {
  if (!/^[\x21-\x7e]{8,120}$/.test(key)) throw invalid('X-Idempotency-Key is 8 to 120 visible characters (a UUID is ideal).');
  const ins = await db.query(`INSERT INTO gateway_idempotency_keys (client_ref, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [clientRef, key, requestHash]);
  if (!ins.rowCount) {
    const r = (await db.query('SELECT * FROM gateway_idempotency_keys WHERE client_ref=$1 AND key=$2', [clientRef, key])).rows[0];
    if (!r) return withIdempotency(db, clientRef, key, requestHash, fn);
    if (r.requestHash !== requestHash) throw new DomainError('REJECTED', 'This X-Idempotency-Key was already used for a different request.');
    if (r.status === 'IN_PROGRESS') throw conflict('The first request with this X-Idempotency-Key is still being processed. Retry shortly.');
    return { status: r.httpStatus, body: r.response as T, replayed: true };
  }
  try {
    const out = await fn();
    await db.query(`UPDATE gateway_idempotency_keys SET status='DONE', http_status=$3, response=$4 WHERE client_ref=$1 AND key=$2`, [clientRef, key, out.status, JSON.stringify(out.body ?? null)]);
    return { ...out, replayed: false };
  } catch (e) {
    await db.query('DELETE FROM gateway_idempotency_keys WHERE client_ref=$1 AND key=$2', [clientRef, key]).catch(() => {});
    throw e;
  }
}
export const requestHash = (method: string, path: string, raw: string) => sha256Hex(`${method} ${path}\n${raw}`);

// ───────────────────────── call log ─────────────────────────
export async function logGatewayCall(q: Queryable, c: { clientRef?: string | null; channel?: string | null; method: string; path: string; status: number; scope?: string | null; idempotencyKey?: string | null; ms?: number; detail?: Record<string, unknown> }) {
  await q.query(`INSERT INTO integration_audit_log (client_ref, channel, method, path, status, scope, idempotency_key, ms, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [c.clientRef ?? null, c.channel ?? null, c.method, c.path.slice(0, 300), c.status, c.scope ?? null, c.idempotencyKey ?? null, c.ms ?? null, JSON.stringify(c.detail ?? {})]);
}
export async function listGatewayCalls(q: Queryable, f: { clientRef?: string; limit?: number } = {}): Promise<Row[]> {
  return (await q.query(`SELECT * FROM integration_audit_log ${f.clientRef ? 'WHERE client_ref=$1' : ''} ORDER BY id DESC LIMIT ${Math.min(f.limit ?? 100, 500)}`, f.clientRef ? [f.clientRef] : [])).rows;
}

// ───────────────────────── webhooks and TM Forum 688 subscriptions ─────────────────────────
export const HUB_EVENT_TYPES = ['ORDER_CREATED', 'ORDER_CANCELLED', 'ORDER_COMPLETED', 'SIM_SWAPPED', 'MSISDN_CHANGED', 'OWNERSHIP_TRANSFERRED', 'SERVICE_SUSPENDED', 'SERVICE_RESUMED', 'SERVICE_BARRED', 'SERVICE_TERMINATED', 'PLAN_CHANGED', 'VAS_CHANGED', 'PAYMENT_RECEIVED', 'INVOICE_ISSUED', 'CONTRACT_GENERATED', 'KYC_SUBMITTED', 'KYC_DECIDED'] as const;
export type HubEventType = (typeof HUB_EVENT_TYPES)[number];

export interface HubWebhook { id: string; kind: 'OUTBOUND' | 'INBOUND' | 'TMF688'; name: string; targetUrl: string | null; authKind: 'NONE' | 'BEARER' | 'HMAC'; hasSecret: boolean; provider: string | null; events: string[]; query: string | null;
  retryMax: number; retryBackoffSeconds: number; status: 'ACTIVE' | 'PAUSED' | 'FAILED'; clientId: string | null; createdBy: string; createdAt: string }
export interface HubWebhookInput { kind: HubWebhook['kind']; name: string; targetUrl?: string | null; authKind?: HubWebhook['authKind']; secret?: string; provider?: string | null; events?: string[]; query?: string | null; retryMax?: number; retryBackoffSeconds?: number; status?: HubWebhook['status']; clientId?: string | null }
const webhookOf = (r: Row): HubWebhook => ({ id: r.id, kind: r.kind, name: r.name, targetUrl: r.targetUrl, authKind: r.authKind, hasSecret: !!r.secretEnc, provider: r.provider, events: r.events, query: r.query, retryMax: r.retryMax, retryBackoffSeconds: r.retryBackoffSeconds, status: r.status, clientId: r.clientId, createdBy: r.createdBy, createdAt: String(r.createdAt) });

export async function listHubWebhooks(q: Queryable, kind?: HubWebhook['kind']): Promise<HubWebhook[]> {
  return (await q.query(`SELECT * FROM webhook_subscriptions ${kind ? 'WHERE kind=$1' : ''} ORDER BY kind, created_at`, kind ? [kind] : [])).rows.map(webhookOf);
}
export async function saveHubWebhook(q: Queryable, actor: string, i: HubWebhookInput, id?: string): Promise<HubWebhook> {
  if (!['OUTBOUND', 'INBOUND', 'TMF688'].includes(i.kind)) throw invalid('Unknown kind of webhook.');
  const name = (i.name ?? '').trim();
  if (!name || name.length > 80) throw invalid('Give it a name of up to 80 characters.');
  const auth = i.authKind ?? (i.kind === 'INBOUND' ? 'HMAC' : 'NONE');
  if (i.kind !== 'INBOUND') {
    if (!i.targetUrl) throw invalid('Where should notifications be sent? Give the target address.');
    const p = hubUrlProblem(i.targetUrl, 'The target address'); if (p) throw invalid(p);
    if (prod() && !i.targetUrl.startsWith('https://')) throw invalid('The target address must use https://.');
  }
  if (i.kind === 'INBOUND' && !(i.provider ?? '').trim()) throw invalid('Say which outside system sends these callbacks (a payment gateway, a courier, a dealer channel).');
  if (auth !== 'NONE' && id === undefined && !i.secret) throw invalid(auth === 'HMAC' ? 'An HMAC key is needed (16 or more characters).' : 'A bearer token is needed.');
  if (auth === 'HMAC' && i.secret && i.secret.length < 16) throw invalid('The HMAC key is at least 16 characters.');
  const events = [...new Set(i.events ?? [])];
  for (const e of events) if (!(HUB_EVENT_TYPES as readonly string[]).includes(e) && !/^[A-Za-z]+Event$/.test(e)) throw invalid(`Unknown event ${e}.`);
  const retryMax = i.retryMax ?? 5, backoff = i.retryBackoffSeconds ?? 30;
  if (!Number.isInteger(retryMax) || retryMax < 0 || retryMax > 20) throw invalid('Retries: 0 to 20.');
  if (!Number.isInteger(backoff) || backoff < 1 || backoff > 86400) throw invalid('The wait between retries is 1 second to 1 day.');
  const enc = i.secret === undefined ? undefined : i.secret === '' ? null : encryptText(i.secret);
  const args = [i.kind, name, i.targetUrl || null, auth, i.provider?.trim() || null, events, i.query?.slice(0, 500) || null, retryMax, backoff, i.status ?? 'ACTIVE', i.clientId ?? null];
  if (id) {
    const r = await q.query(`UPDATE webhook_subscriptions SET kind=$2, name=$3, target_url=$4, auth_kind=$5, provider=$6, events=$7, query=$8, retry_max=$9, retry_backoff_seconds=$10, status=$11, client_id=$12,
      secret_enc = CASE WHEN $13::boolean THEN $14 ELSE secret_enc END, updated_at=now() WHERE id=$1 RETURNING *`, [id, ...args, enc !== undefined, enc ?? null]);
    if (!r.rows[0]) throw notFound('webhook', id);
    await audit(q, actor, 'webhook', id, 'UPDATE', { kind: i.kind, name });
    resetEventGate();
    return webhookOf(r.rows[0]);
  }
  const r = await q.query(`INSERT INTO webhook_subscriptions (kind, name, target_url, auth_kind, provider, events, query, retry_max, retry_backoff_seconds, status, client_id, secret_enc, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [...args, enc ?? null, actor]);
  await audit(q, actor, 'webhook', r.rows[0]!.id, 'CREATE', { kind: i.kind, name });
  resetEventGate();
  return webhookOf(r.rows[0]!);
}
export async function deleteHubWebhook(q: Queryable, actor: string, id: string) {
  resetEventGate();
  const r = await q.query('DELETE FROM webhook_subscriptions WHERE id=$1', [id]);
  if (!r.rowCount) throw notFound('webhook', id);
  await audit(q, actor, 'webhook', id, 'DELETE');
  return { ok: true };
}
/** The verification key of an inbound webhook, in the clear, for the code that checks incoming signatures. */
export async function inboundWebhookKey(q: Queryable, provider: string): Promise<string | null> {
  const r = (await q.query(`SELECT secret_enc FROM webhook_subscriptions WHERE kind='INBOUND' AND status='ACTIVE' AND lower(provider)=lower($1) AND secret_enc IS NOT NULL ORDER BY created_at LIMIT 1`, [provider])).rows[0];
  return r ? decryptText(r.secretEnc) : null;
}

// TM Forum 688 (Event Management): a client registers a listener with a callback and a query.
/** A callback a client supplied may not point at the deployment's own network. */
export function privateHostProblem(url: string): string | null {
  let u: URL; try { u = new URL(url); } catch { return null; }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const priv = h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || h === '::1' || /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:');
  return priv && prod() ? 'The callback cannot be an address inside a private network.' : null;
}
export interface TmfHub { id: string; callback: string; query?: string }
export async function registerTmfListener(q: Queryable, clientRef: string, i: { callback: string; query?: string }): Promise<TmfHub> {
  const p = hubUrlProblem(i.callback, 'The callback') ?? privateHostProblem(i.callback); if (p) throw invalid(p);
  if (prod() && !i.callback.startsWith('https://')) throw invalid('The callback must use https://.');
  const events = [...(i.query ?? '').matchAll(/eventType=([A-Za-z]+)/g)].map((m) => m[1]!);
  resetEventGate();
  const count = Number((await q.query(`SELECT count(*) AS n FROM webhook_subscriptions WHERE kind='TMF688' AND client_id=$1`, [clientRef])).rows[0]!.n);
  if (count >= 20) throw conflict('A client can hold 20 subscriptions. Remove one first.');
  const r = (await q.query(`INSERT INTO webhook_subscriptions (kind, name, target_url, auth_kind, events, query, client_id, created_by) VALUES ('TMF688',$1,$2,'NONE',$3,$4,$5,$5) RETURNING *`,
    [`TMF 688 listener of ${clientRef}`.slice(0, 80), i.callback, events, i.query?.slice(0, 500) ?? null, clientRef])).rows[0]!;
  return { id: r.id, callback: r.targetUrl, ...(r.query ? { query: r.query } : {}) };
}
export async function unregisterTmfListener(q: Queryable, clientRef: string, id: string) {
  const r = await q.query(`DELETE FROM webhook_subscriptions WHERE id=$1 AND kind='TMF688' AND client_id=$2`, [id, clientRef]);
  if (!r.rowCount) throw notFound('subscription', id);
  return { ok: true };
}

// ───────────────────────── event topics ─────────────────────────
export interface TopicMapping { id: string; eventType: string; topic: string; enabled: boolean }
export const listTopicMappings = async (q: Queryable): Promise<TopicMapping[]> => (await q.query('SELECT id, event_type, topic, enabled FROM event_topic_mappings ORDER BY event_type, topic')).rows as unknown as TopicMapping[];
export async function saveTopicMapping(q: Queryable, actor: string, i: { eventType: string; topic: string; enabled?: boolean }): Promise<TopicMapping> {
  if (!(HUB_EVENT_TYPES as readonly string[]).includes(i.eventType)) throw invalid(`Unknown event ${i.eventType}.`);
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(i.topic)) throw invalid('A topic name is letters, digits, dots, dashes and underscores (up to 120).');
  const r = (await q.query(`INSERT INTO event_topic_mappings (event_type, topic, enabled, updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (event_type, topic) DO UPDATE SET enabled=EXCLUDED.enabled, updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING id, event_type, topic, enabled`, [i.eventType, i.topic, i.enabled ?? true, actor])).rows[0]!;
  await audit(q, actor, 'event_topic', r.id, 'SET', { eventType: i.eventType, topic: i.topic, enabled: r.enabled });
  resetEventGate();
  return r as unknown as TopicMapping;
}
export async function deleteTopicMapping(q: Queryable, actor: string, id: string) {
  resetEventGate();
  const r = await q.query('DELETE FROM event_topic_mappings WHERE id=$1', [id]);
  if (!r.rowCount) throw notFound('mapping', id);
  await audit(q, actor, 'event_topic', id, 'DELETE');
  return { ok: true };
}
