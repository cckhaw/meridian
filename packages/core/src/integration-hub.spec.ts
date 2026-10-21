import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticateApiKey, createApiClient } from './apikeys.js';
import type { Db } from './db.js';
import { authenticateNorthbound, requireScope, verifyRequestSignature } from './gateway.js';
import { checkRateLimit, deleteHubEndpoint, HUB_ENDPOINT_KINDS, HUB_UNUSED_KINDS, GatewayRateLimited, hubEndpointWithSecret, inboundWebhookKey, listHubEndpoints, listHubWebhooks, listRateRules, listTopicMappings, registerTmfListener, requestHash, saveHubEndpoint, saveHubWebhook, saveRateRule, saveTopicMapping, unregisterTmfListener, withIdempotency } from './integration-hub.js';
import { createOAuthClient, issueToken, revokeOAuthClient, rotateOAuthSecret, updateOAuthClient, verifyAccessToken } from './oauth.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

describe('endpoints', () => {
  it('no longer offers the dispatch system and slot sync, but keeps what is already stored', async () => {
    expect(HUB_ENDPOINT_KINDS.wfm).toEqual([]);
    expect(HUB_UNUSED_KINDS.map((k) => k.kind)).toEqual(['WFM_GATEWAY', 'SLOT_SYNC']);
    await expect(saveHubEndpoint(db, 'root', { group: 'wfm', kind: 'WFM_GATEWAY', name: 'New dispatch' })).rejects.toThrow(/not used/);
    await db.query(`INSERT INTO integration_endpoints (id, group_key, kind, name, url, config) VALUES (gen_random_uuid(), 'wfm', 'WFM_GATEWAY', 'Old dispatch', 'https://fsl.example.com', '{"poolSize":10}'), (gen_random_uuid(), 'wfm', 'SLOT_SYNC', 'Old slots', NULL, '{}')`);
    const rows = await listHubEndpoints(db, 'wfm');
    expect(rows.map((r) => r.kind).sort()).toEqual(['SLOT_SYNC', 'WFM_GATEWAY']);
    expect(rows.find((r) => r.kind === 'WFM_GATEWAY')).toMatchObject({ name: 'Old dispatch', url: 'https://fsl.example.com', config: { poolSize: 10 } });
    await expect(saveHubEndpoint(db, 'root', { group: 'wfm', kind: 'SLOT_SYNC', name: 'Renamed' }, rows[0]!.id)).rejects.toThrow(/not used/);
    for (const r of rows) await deleteHubEndpoint(db, 'root', r.id);
    expect(await listHubEndpoints(db, 'wfm')).toEqual([]);
  });

  it('keeps a secret encrypted and never returns it, and validates addresses by kind', async () => {
    const e = await saveHubEndpoint(db, 'root', { group: 'network', kind: 'HLR_HSS', name: 'HLR primary', url: 'diameter://hss1.example.net:3868', fallbackUrl: 'diameter://hss2.example.net:3868', timeoutMs: 3000, config: { realm: 'epc.example.net' }, secret: 'hunter2-hunter2' });
    expect(e).toMatchObject({ hasSecret: true, url: 'diameter://hss1.example.net:3868', timeoutMs: 3000 });
    expect(JSON.stringify(e)).not.toContain('hunter2');
    expect((await db.query('SELECT secret_enc FROM integration_endpoints WHERE id=$1', [e.id])).rows[0]!.secretEnc).not.toContain('hunter2');
    expect((await hubEndpointWithSecret(db, 'network', 'HLR_HSS'))!.secret).toBe('hunter2-hunter2');
    const kept = await saveHubEndpoint(db, 'root', { group: 'network', kind: 'HLR_HSS', name: 'HLR primary', url: e.url, timeoutMs: 4000 }, e.id);
    expect([kept.hasSecret, kept.timeoutMs]).toEqual([true, 4000]);                                       // no secret sent: kept
    expect((await saveHubEndpoint(db, 'root', { group: 'network', kind: 'HLR_HSS', name: 'HLR primary', secret: '' }, e.id)).hasSecret).toBe(false);   // empty: cleared
    await expect(saveHubEndpoint(db, 'root', { group: 'network', kind: 'HLR_HSS', name: 'x', url: 'ftp://x' })).rejects.toThrow(/must start with/);
    await expect(saveHubEndpoint(db, 'root', { group: 'wfm', kind: 'HLR_HSS', name: 'x' })).rejects.toThrow(/kind of endpoint/);
    await expect(saveHubEndpoint(db, 'root', { group: 'network', kind: 'HLR_HSS', name: 'HLR primary' })).rejects.toThrow(/already exists/);
    await expect(saveHubEndpoint(db, 'root', { group: 'finance', kind: 'SAP_FICO', name: 's', url: 'http://sap.example.com' })).rejects.toThrow(/https/);
    expect((await listHubEndpoints(db, 'network')).length).toBe(1);
    await deleteHubEndpoint(db, 'root', e.id);
    expect(await listHubEndpoints(db)).toEqual([]);
  });
});

describe('OAuth 2.0 clients', () => {
  it('issues scoped tokens, rotates with a grace period, and stops a revoked client at once', async () => {
    const { client, clientSecret } = await createOAuthClient(db, 'root', { name: 'Self-care app', channel: 'SELF_CARE', scopes: ['subscriber:read', 'sim:swap'], tokenTtlSeconds: 600 });
    expect(JSON.stringify(client)).not.toContain(clientSecret);
    const now = Date.now();
    const t = await issueToken(db, { grantType: 'client_credentials', clientId: client.clientId, clientSecret }, now);
    expect([t.token_type, t.expires_in, t.scope]).toEqual(['Bearer', 600, 'subscriber:read sim:swap']);
    expect(await verifyAccessToken(db, t.access_token, now + 1000)).toMatchObject({ clientId: client.clientId, channel: 'SELF_CARE', scopes: ['subscriber:read', 'sim:swap'] });
    await expect(verifyAccessToken(db, t.access_token, now + 601_000)).rejects.toThrow(/expired/);
    await expect(verifyAccessToken(db, t.access_token.slice(0, -2) + 'xx')).rejects.toThrow(/not valid/);
    await expect(issueToken(db, { grantType: 'client_credentials', clientId: client.clientId, clientSecret: 'wrong' })).rejects.toThrow(/authentication failed/);
    await expect(issueToken(db, { grantType: 'password', clientId: client.clientId, clientSecret })).rejects.toThrow(/client_credentials/);
    await expect(issueToken(db, { grantType: 'client_credentials', clientId: client.clientId, clientSecret, scope: 'order:create' })).rejects.toThrow(/may not use order:create/);
    expect((await issueToken(db, { grantType: 'client_credentials', clientId: client.clientId, clientSecret, scope: 'sim:swap' })).scope).toBe('sim:swap');
    // taking a scope away stops it on tokens already out
    await updateOAuthClient(db, 'root', client.id, { scopes: ['subscriber:read'] });
    expect((await verifyAccessToken(db, t.access_token)).scopes).toEqual(['subscriber:read']);
    // rotation: the old secret works for the grace period, then not
    const rot = await rotateOAuthSecret(db, 'root', client.id, 30);
    await expect(issueToken(db, { grantType: 'client_credentials', clientId: client.clientId, clientSecret: rot.clientSecret })).resolves.toBeTruthy();
    await expect(issueToken(db, { grantType: 'client_credentials', clientId: client.clientId, clientSecret }, now)).resolves.toBeTruthy();
    await expect(issueToken(db, { grantType: 'client_credentials', clientId: client.clientId, clientSecret }, now + 31 * 60_000 + 1000)).rejects.toThrow(/authentication failed/);
    await revokeOAuthClient(db, 'root', client.id);
    await expect(verifyAccessToken(db, t.access_token)).rejects.toThrow(/not valid/);
    await expect(createOAuthClient(db, 'root', { name: 'x', scopes: ['everything'] })).rejects.toThrow(/Unknown scope/);
  });
});

describe('the gateway', () => {
  it('accepts a token or an API key, requires the signature when a key has a signing secret, and enforces scopes', async () => {
    const { client, clientSecret } = await createOAuthClient(db, 'root', { name: 'IVR', channel: 'CALL_CENTER', scopes: ['subscriber:read'] });
    const tok = await issueToken(db, { grantType: 'client_credentials', clientId: client.clientId, clientSecret });
    const p = await authenticateNorthbound(db, { authorization: `Bearer ${tok.access_token}`, signature: null, raw: '' });
    expect([p.kind, p.channel]).toEqual(['OAUTH', 'CALL_CENTER']);
    expect(() => requireScope(p, 'sim:swap')).toThrow(/sim:swap/);
    expect(() => requireScope(p, 'subscriber:read')).not.toThrow();
    await expect(authenticateNorthbound(db, { authorization: null, signature: null, raw: '' })).rejects.toThrow(/Bearer/);

    const plain = await createApiClient(db, 'root', { name: 'Dealer portal', scopes: ['order:create'], channel: 'DEALER' });
    const k = await authenticateNorthbound(db, { authorization: `Bearer ${plain.key}`, signature: null, raw: '{}' });
    expect([k.kind, k.channel, k.scopes]).toEqual(['API_KEY', 'DEALER', ['order:create']]);
    await expect(authenticateApiKey(db, `Bearer ${plain.key}`, 'store')).rejects.toThrow();     // not a store-front key

    const signed = await createApiClient(db, 'root', { name: 'Partner', scopes: ['order:read'], channel: 'PARTNER_PORTAL', signRequests: true });
    const raw = '{"a":1}', t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac('sha256', signed.hmacSecret!).update(`${t}.${raw}`).digest('hex')}`;
    await expect(authenticateNorthbound(db, { authorization: `Bearer ${signed.key}`, signature: null, raw })).rejects.toThrow(/X-Meridian-Signature/);
    await expect(authenticateNorthbound(db, { authorization: `Bearer ${signed.key}`, signature: sig, raw: '{"a":2}' })).rejects.toThrow(/does not match/);
    expect((await authenticateNorthbound(db, { authorization: `Bearer ${signed.key}`, signature: sig, raw })).ref).toMatch(/^key:/);
    expect(() => verifyRequestSignature(raw, sig, signed.hmacSecret!, Date.now() + 10 * 60_000)).toThrow(/too old/);

    await expect(createApiClient(db, 'root', { name: 'old', expiresAt: '2001-01-01' })).rejects.toThrow(/future/);
    const soon = await createApiClient(db, 'root', { name: 'short', scopes: ['order:read'], expiresAt: new Date(Date.now() + 3000).toISOString() });
    await db.query(`UPDATE api_clients SET expires_at = now() - interval '1 second' WHERE id=$1`, [soon.client.id]);
    await expect(authenticateNorthbound(db, { authorization: `Bearer ${soon.key}`, signature: null, raw: '' })).rejects.toThrow(/valid API key/);
  });
});

describe('rate limits', () => {
  it('limits per channel over a sliding window, from rules an administrator sets', async () => {
    const rules = await listRateRules(db);
    expect(rules.find((r) => r.channel === 'SELF_CARE')).toMatchObject({ perMinute: 100, isDefault: true });
    await saveRateRule(db, 'root', 'PARTNER_PORTAL', 3);
    const t0 = Math.floor(Date.now() / 60_000) * 60_000;                      // the start of a minute
    for (let i = 0; i < 3; i++) await checkRateLimit(db, 'key:a', 'PARTNER_PORTAL', t0 + 1000 + i);
    await expect(checkRateLimit(db, 'key:a', 'PARTNER_PORTAL', t0 + 2000)).rejects.toBeInstanceOf(GatewayRateLimited);
    await expect(checkRateLimit(db, 'key:b', 'PARTNER_PORTAL', t0 + 2000)).resolves.toMatchObject({ limit: 3 });   // another client has its own count
    // 30 seconds into the next minute, half of the previous minute's 4 hits still count (4 * 0.5 + 1 = 3), so one more is allowed, the next is not
    await expect(checkRateLimit(db, 'key:a', 'PARTNER_PORTAL', t0 + 60_000 + 30_000)).resolves.toBeTruthy();
    await expect(checkRateLimit(db, 'key:a', 'PARTNER_PORTAL', t0 + 60_000 + 30_001)).rejects.toThrow(/Retry in/);
    await saveRateRule(db, 'root', 'PARTNER_PORTAL', 3, false);                // switched off: no limit
    await expect(checkRateLimit(db, 'key:a', 'PARTNER_PORTAL', t0 + 120_000)).resolves.toBeTruthy();
    await expect(saveRateRule(db, 'root', 'lower', 5)).rejects.toThrow(/capital letters/);
    await expect(saveRateRule(db, 'root', 'X_Y', 0)).rejects.toThrow(/1 to 100,000/);
  });
});

describe('idempotency', () => {
  it('runs a request once per key, replays its result, refuses a different request, and frees the key after a failure', async () => {
    let runs = 0;
    const key = 'b6e2f1a0-1111-4222-8333-944455556666';
    const h = requestHash('POST', '/v1/x', '{"a":1}');
    const first = await withIdempotency(db, 'oauth:c1', key, h, async () => ({ status: 201, body: { n: ++runs } }));
    const again = await withIdempotency(db, 'oauth:c1', key, h, async () => ({ status: 201, body: { n: ++runs } }));
    expect([runs, first.replayed, again.replayed, again.status, again.body]).toEqual([1, false, true, 201, { n: 1 }]);
    await expect(withIdempotency(db, 'oauth:c1', key, requestHash('POST', '/v1/x', '{"a":2}'), async () => ({ status: 200, body: {} }))).rejects.toThrow(/different request/);
    expect((await withIdempotency(db, 'oauth:c2', key, h, async () => ({ status: 200, body: { other: true } }))).replayed).toBe(false);   // keys are per client
    await expect(withIdempotency(db, 'oauth:c1', 'fail-key-12345', h, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect((await withIdempotency(db, 'oauth:c1', 'fail-key-12345', h, async () => ({ status: 200, body: { ok: 1 } }))).replayed).toBe(false);
    await db.query(`INSERT INTO gateway_idempotency_keys (client_ref, key, request_hash) VALUES ('oauth:c1','busy-key-12345',$1)`, [h]);
    await expect(withIdempotency(db, 'oauth:c1', 'busy-key-12345', h, async () => ({ status: 200, body: {} }))).rejects.toThrow(/still being processed/);
    await expect(withIdempotency(db, 'oauth:c1', 'short', h, async () => ({ status: 200, body: {} }))).rejects.toThrow(/8 to 120/);
  });
});

describe('webhooks, TM Forum 688 and topics', () => {
  it('registers outbound and inbound webhooks with encrypted keys, and TMF 688 listeners per client', async () => {
    await expect(saveHubWebhook(db, 'root', { kind: 'OUTBOUND', name: 'Dealer CRM', targetUrl: 'https://dealer.example.com/hook', authKind: 'HMAC' })).rejects.toThrow(/HMAC key/);
    const o = await saveHubWebhook(db, 'root', { kind: 'OUTBOUND', name: 'Dealer CRM', targetUrl: 'https://dealer.example.com/hook', authKind: 'HMAC', secret: 'a-long-signing-key-123', events: ['ORDER_CREATED', 'SIM_SWAPPED'], retryMax: 3 });
    expect(o).toMatchObject({ hasSecret: true, events: ['ORDER_CREATED', 'SIM_SWAPPED'], retryMax: 3, status: 'ACTIVE' });
    await expect(saveHubWebhook(db, 'root', { kind: 'OUTBOUND', name: 'x', targetUrl: 'https://x.example.com', events: ['NOPE'] })).rejects.toThrow(/Unknown event/);
    await expect(saveHubWebhook(db, 'root', { kind: 'INBOUND', name: 'PSP callback', secret: 'a-long-signing-key-123' })).rejects.toThrow(/Say which outside system/);
    await saveHubWebhook(db, 'root', { kind: 'INBOUND', name: 'DuitNow callback', provider: 'DuitNow', secret: 'inbound-secret-abcdef' });
    expect(await inboundWebhookKey(db, 'duitnow')).toBe('inbound-secret-abcdef');
    expect(await inboundWebhookKey(db, 'other')).toBeNull();
    expect((await listHubWebhooks(db, 'INBOUND'))).toHaveLength(1);

    const hub = await registerTmfListener(db, 'oauth:c1', { callback: 'https://listener.example.com/cb', query: 'eventType=ServiceOrderStateChangeEvent' });
    expect(hub).toMatchObject({ callback: 'https://listener.example.com/cb', query: 'eventType=ServiceOrderStateChangeEvent' });
    expect((await listHubWebhooks(db, 'TMF688'))[0]).toMatchObject({ events: ['ServiceOrderStateChangeEvent'], clientId: 'oauth:c1' });
    await expect(unregisterTmfListener(db, 'oauth:other', hub.id)).rejects.toThrow(/not found/);        // a client removes only its own
    await unregisterTmfListener(db, 'oauth:c1', hub.id);
    await expect(registerTmfListener(db, 'oauth:c1', { callback: 'not a url' })).rejects.toThrow(/valid address/);
  });
  it('maps internal events to external topics', async () => {
    await saveTopicMapping(db, 'root', { eventType: 'SIM_SWAPPED', topic: 'bss.subscriber.sim-swapped' });
    await saveTopicMapping(db, 'root', { eventType: 'SIM_SWAPPED', topic: 'fraud.signals' });
    await saveTopicMapping(db, 'root', { eventType: 'SIM_SWAPPED', topic: 'fraud.signals', enabled: false });
    expect((await listTopicMappings(db)).map((m) => [m.topic, m.enabled])).toEqual([['bss.subscriber.sim-swapped', true], ['fraud.signals', false]]);
    await expect(saveTopicMapping(db, 'root', { eventType: 'NOPE', topic: 'x' })).rejects.toThrow(/Unknown event/);
    await expect(saveTopicMapping(db, 'root', { eventType: 'ORDER_CREATED', topic: 'bad topic!' })).rejects.toThrow(/topic name/);
  });
});
