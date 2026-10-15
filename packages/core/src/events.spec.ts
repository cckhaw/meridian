import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { deliverEvents, dispatchEvents, eventWanted, fanOutEvents, listDeliveries, raiseEvent, resetEventGate, retryDelivery, setTopicPublisher, tmfEnvelope } from './events.js';
import { registerTmfListener, saveHubWebhook, saveTopicMapping } from './integration-hub.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const ok = (calls: Array<{ url: string; headers: Record<string, string>; body: string }>, status = 200) =>
  (async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) }); return new Response('', { status }); }) as unknown as typeof fetch;

describe('event delivery', () => {
  it('writes nothing to the outbox when nobody listens, and the TM Forum envelope when somebody does', async () => {
    resetEventGate();
    expect(await eventWanted(db, 'PAYMENT_RECEIVED')).toBe(false);
    await raiseEvent(db, 'PAYMENT_RECEIVED', { resourceId: 'x' }, { onlyIfWanted: true });
    expect((await db.query(`SELECT count(*)::int AS n FROM lifecycle_outbox WHERE instruction='PAYMENT_RECEIVED'`)).rows[0]!.n).toBe(0);
    await saveHubWebhook(db, 'root', { kind: 'OUTBOUND', name: 'Partner', targetUrl: 'https://partner.example.com/hook', authKind: 'HMAC', secret: 'a-signing-key-12345', events: ['PAYMENT_RECEIVED', 'SIM_SWAPPED'], retryMax: 2, retryBackoffSeconds: 10 });
    expect(await eventWanted(db, 'PAYMENT_RECEIVED')).toBe(true);
    expect(await eventWanted(db, 'ORDER_CREATED')).toBe(false);
    const env = tmfEnvelope('SIM_SWAPPED', 'e1', { eventType: 'SIM_SWAPPED', serviceId: 's1', resourceId: 's1', to: '8960', occurredAt: '2026-10-15T00:00:00.000Z' });
    expect(env).toMatchObject({ eventId: 'e1', eventType: 'ServiceAttributeValueChangeEvent', domain: 'serviceInventory', event: { service: { id: 's1', businessEvent: 'SIM_SWAPPED', to: '8960' } } });
  });

  it('fans an event out to the webhooks and listeners that asked for it, signs it, retries failures with a growing wait, and gives up', async () => {
    await registerTmfListener(db, 'oauth:c1', { callback: 'https://listener.example.com/cb', query: 'eventType=PaymentCreateEvent' });
    await saveTopicMapping(db, 'root', { eventType: 'PAYMENT_RECEIVED', topic: 'bss.payments' });
    await raiseEvent(db, 'PAYMENT_RECEIVED', { accountId: undefined, resourceId: 'inv-1', payload: { amountMinor: 500 } }, { onlyIfWanted: true });
    await raiseEvent(db, 'ORDER_CREATED', { resourceId: 'o-1' });                          // nobody wants it: it is fanned out to nothing
    const fan = await fanOutEvents(db);
    expect(fan).toMatchObject({ events: 2, deliveries: 3 });                              // the webhook, the listener, the topic
    const rows = await listDeliveries(db);
    expect(rows.map((r) => [r.eventType, r.topic ?? 'hook', r.status]).sort()).toEqual([['PAYMENT_RECEIVED', 'bss.payments', 'READY'], ['PAYMENT_RECEIVED', 'hook', 'PENDING'], ['PAYMENT_RECEIVED', 'hook', 'PENDING']]);
    // delivery 1: success, signed
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const t0 = Date.now();
    const r1 = await deliverEvents(db, { fetchImpl: ok(calls), nowMs: t0 });
    expect(r1.delivered).toBe(2);
    const hooked = calls.find((c) => c.url.includes('partner'))!;
    const t = /t=(\d+)/.exec(hooked.headers['x-meridian-signature']!)![1]!;
    expect(hooked.headers['x-meridian-signature']).toBe(`t=${t},v1=${createHmac('sha256', 'a-signing-key-12345').update(`${t}.${hooked.body}`).digest('hex')}`);
    expect(JSON.parse(hooked.body)).toMatchObject({ eventType: 'PaymentCreateEvent', event: { payment: { amountMinor: 500 } } });
    expect(hooked.headers['x-meridian-event-type']).toBe('PAYMENT_RECEIVED');
    // a failing endpoint: tried again after 10 s, then 20 s, then marked failed (retryMax 2 = 3 tries)
    await raiseEvent(db, 'SIM_SWAPPED', { serviceId: undefined, resourceId: 's1', payload: { to: 'x' } });
    await fanOutEvents(db);
    const bad: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const t1 = Date.now();
    const f1 = await deliverEvents(db, { fetchImpl: ok(bad, 500), nowMs: t1 });
    expect(f1).toMatchObject({ retrying: 1, failed: 0 });
    expect((await deliverEvents(db, { fetchImpl: ok(bad, 500), nowMs: t1 + 5_000 })).retrying).toBe(0);                  // not due yet
    expect((await deliverEvents(db, { fetchImpl: ok(bad, 500), nowMs: t1 + 11_000 })).retrying).toBe(1);                 // second try
    expect((await deliverEvents(db, { fetchImpl: ok(bad, 500), nowMs: t1 + 40_000 })).failed).toBe(1);                   // the third was the last
    const failed = (await listDeliveries(db, { status: 'FAILED' }))[0]!;
    expect(failed).toMatchObject({ attempts: 3, lastError: 'HTTP 500' });
    expect(await retryDelivery(db, Number(failed.id))).toEqual({ ok: true });
    expect((await deliverEvents(db, { fetchImpl: ok([]), nowMs: t1 + 50_000 })).delivered).toBe(1);
  });

  it('hands topic deliveries to a connected producer, and a paused webhook receives nothing', async () => {
    const sent: Array<[string, string]> = [];
    setTopicPublisher(async (topic, key) => { sent.push([topic, key]); });
    expect((await deliverEvents(db, { fetchImpl: ok([]) })).published).toBe(1);
    expect(sent[0]![0]).toBe('bss.payments');
    setTopicPublisher(null);
    const hooks = (await db.query(`SELECT id FROM webhook_subscriptions WHERE kind='OUTBOUND'`)).rows;
    await db.query(`UPDATE webhook_subscriptions SET status='PAUSED' WHERE id=$1`, [hooks[0]!.id]);
    resetEventGate();
    await raiseEvent(db, 'SIM_SWAPPED', { resourceId: 's2' });
    const out = await dispatchEvents(db, { fetchImpl: ok([]) });
    expect(out.events).toBe(1);
    expect((await listDeliveries(db)).filter((r) => r.eventType === 'SIM_SWAPPED' && r.subscriptionId === hooks[0]!.id).length).toBe(1);   // only the earlier one
  });
});
