import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateNode } from './catalog.js';
import type { Db } from './db.js';
import { resumeService, suspendService, terminateService } from './lifecycle.js';
import { GENERIC_REST_EXAMPLE, OCS_VENDORS, createGenericRestConnector, render, validateGenericRest, type OcsConnector, type OcsRequest, type OcsResult } from './ocs-vendors/index.js';
import { OCS_MAX_ATTEMPTS, cleanOcsMapping, dispatchOcs, enqueueOcs, getOcsSettings, listOcsJobs, ocsOverview, retryOcsJob, setOcsSettings } from './ocs.js';
import { placeOrder } from './orders.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };

const cfg = (over: Record<string, unknown> = {}) => ({ baseUrl: 'https://ocs.example.com/api', auth: 'BEARER', tokenEnv: 'MERIDIAN_OCS_TOKEN', referencePath: '/subscriber/id', commands: GENERIC_REST_EXAMPLE, ...over });
const req = (over: Partial<OcsRequest> = {}): OcsRequest => ({
  command: 'PROVISION', idempotencyKey: 'ocs:PROVISION:svc-1', at: '2026-10-15T00:00:00Z',
  subscriber: { serviceId: 'svc-1', identifier: '+6591234567', serviceType: 'MOBILE', serviceKind: null, iccid: '8960123456789012345', imsi: '525010000000001', customerId: 'c1', accountId: 'a1', segment: 'CONSUMER', marketCode: 'SG', creditLimitMinor: 50000 },
  plan: { offerId: 'plan-sim-5g', offerName: '5G SIM-only', planCode: 'PLAN_5G_100', params: { dataGb: 100, roaming: false } }, ...over,
});

describe('generic REST connector', () => {
  it('checks what the operator entered, in plain words', () => {
    expect(() => validateGenericRest(cfg({ baseUrl: 'ftp://x' }))).toThrow(/https/);
    expect(() => validateGenericRest(cfg({ baseUrl: 'https://user:pw@ocs.example.com' }))).toThrow(/user name or password/);
    expect(() => validateGenericRest(cfg({ tokenEnv: 'DATABASE_URL' }))).toThrow(/MERIDIAN_OCS_/); // a secret setting can never point at the database password
    expect(() => validateGenericRest(cfg({ auth: 'HEADER', headerName: '' }))).toThrow(/header/);
    expect(() => validateGenericRest(cfg({ commands: {} }))).toThrow(/PROVISION/);
    expect(() => validateGenericRest(cfg({ commands: { PROVISION: { method: 'POST', path: '/s', body: '{ "a": "{{nope}}" }' } } }))).toThrow(/unknown placeholder \{\{nope\}\}/);
    expect(() => validateGenericRest(cfg({ commands: { PROVISION: { method: 'POST', path: '/s', body: '{ not json' } } }))).toThrow(/valid JSON/);
    expect(() => validateGenericRest(cfg({ commands: { PROVISION: { method: 'POST', path: '/s', body: '{}' }, TERMINATE: { method: 'DELETE', path: '/s/{{serviceId}}', body: '{}' } } }))).toThrow(/no body/);
    expect(validateGenericRest(cfg()).commands.PROVISION?.path).toBe('/subscribers');
  });

  it('fills the template without ever letting a value change the shape of the JSON', () => {
    const out = render({ n: '{{creditLimitMinor}}', p: '{{planParams}}', t: 'tel {{msisdn}}!', nul: '{{expiresAt}}' }, { creditLimitMinor: 50000, planParams: { a: 1 }, msisdn: '+65"}],"x":["', expiresAt: null }) as any;
    expect(out).toEqual({ n: 50000, p: { a: 1 }, t: 'tel +65"}],"x":["!', nul: null });
  });

  it('sends the call, the token and the idempotency key; reads the vendor’s reference', async () => {
    const seen: any[] = [];
    const f = (async (url: string, init: any) => { seen.push({ url, init }); return new Response(JSON.stringify({ subscriber: { id: 'OCS-77' } }), { status: 201 }); }) as unknown as typeof fetch;
    const c = createGenericRestConnector(validateGenericRest(cfg()), { MERIDIAN_OCS_TOKEN: 'secret-token' } as NodeJS.ProcessEnv, f);
    expect(c.problem()).toBeNull();
    const r = await c.handle(req());
    expect(r).toMatchObject({ ok: true, reference: 'OCS-77' });
    expect(seen[0].url).toBe('https://ocs.example.com/api/subscribers');
    expect(seen[0].init.headers).toMatchObject({ authorization: 'Bearer secret-token', 'idempotency-key': 'ocs:PROVISION:svc-1', 'content-type': 'application/json' });
    expect(JSON.parse(seen[0].init.body)).toMatchObject({ msisdn: '+6591234567', imsi: '525010000000001', plan: 'PLAN_5G_100', planParams: { dataGb: 100, roaming: false }, creditLimit: 50000, expiresAt: null });
    expect(createGenericRestConnector(validateGenericRest(cfg()), {} as NodeJS.ProcessEnv, f).problem()).toMatch(/MERIDIAN_OCS_TOKEN is not set/);
  });

  it('tells an outage (try again) from a refusal (do not), treats “already exists” as done, and skips what the vendor lacks', async () => {
    const answer = (status: number, text = '') => createGenericRestConnector(validateGenericRest(cfg()), { MERIDIAN_OCS_TOKEN: 't' } as NodeJS.ProcessEnv, (async () => new Response(text, { status })) as unknown as typeof fetch);
    expect(await answer(503, 'down').handle(req())).toMatchObject({ ok: false, retryable: true });
    expect(await answer(429).handle(req())).toMatchObject({ ok: false, retryable: true });
    expect(await answer(400, 'bad plan').handle(req())).toMatchObject({ ok: false, retryable: false, detail: expect.stringContaining('bad plan') });
    expect(await answer(409).handle(req())).toMatchObject({ ok: true });
    const boom = createGenericRestConnector(validateGenericRest(cfg()), { MERIDIAN_OCS_TOKEN: 't' } as NodeJS.ProcessEnv, (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    expect(await boom.handle(req())).toMatchObject({ ok: false, retryable: true, detail: expect.stringContaining('ECONNREFUSED') });
    const only = createGenericRestConnector(validateGenericRest(cfg({ commands: { PROVISION: GENERIC_REST_EXAMPLE.PROVISION } })), { MERIDIAN_OCS_TOKEN: 't' } as NodeJS.ProcessEnv, (async () => new Response('', { status: 200 })) as unknown as typeof fetch);
    expect(await only.handle(req({ command: 'SET_BARRING', barring: { level: 'HARD', reason: 'DUNNING' } }))).toMatchObject({ ok: true, skipped: true });
  });

  it('ships a simulator and the generic connector, and a vendor file is all a new one takes', () => {
    expect(Object.keys(OCS_VENDORS).sort()).toEqual(['generic-rest', 'simulator']);
    expect(OCS_VENDORS.simulator!.real).toBe(false);
  });
});

describe('provisioning into the OCS, from order to termination', () => {
  const sent: OcsRequest[] = [];
  let behave: (r: OcsRequest) => OcsResult = () => ({ ok: true, reference: 'REF' });
  const conn: OcsConnector = { vendor: 'test', problem: () => null, handle: async (r) => { sent.push(r); return behave(r); } };
  const order = async (offerId = 'plan-sim-5g') => { const { customer } = await newCustomer(db); const o = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId }] }); return { customer, o, svc: (await db.query('SELECT * FROM services WHERE order_id=$1', [o.id])).rows[0]! }; };

  it('maps only plans that start a service, and cleans the mapping', async () => {
    expect(cleanOcsMapping({ planCode: '' })).toBeUndefined();
    expect(() => cleanOcsMapping({ planCode: 'bad code!' })).toThrow(/plan code/);
    expect(() => cleanOcsMapping({ planCode: 'P1', params: { 'bad key': 1 } })).toThrow(/parameter name/);
    expect(() => cleanOcsMapping({ planCode: 'P1', params: { x: { nested: 1 } as any } })).toThrow(/text, a number or yes\/no/);
    await expect(updateNode(db, 'good-phone-outright', { ocs: { planCode: 'X' } })).rejects.toThrow(/starts a service/); // goods have no subscriber
    const n = await updateNode(db, 'plan-sim-5g', { ocs: { planCode: 'PLAN_5G_100', params: { dataGb: 100 } } });
    expect((n as any).ocs).toEqual({ planCode: 'PLAN_5G_100', params: { dataGb: 100 } });
    expect(((await updateNode(db, 'plan-sim-5g', { ocs: null })) as any).ocs).toBeUndefined();
    await updateNode(db, 'plan-sim-5g', { ocs: { planCode: 'PLAN_5G_100', params: { dataGb: 100 } } });
  });

  it('queues nothing while the OCS is off, and nothing for a service that started before it was on', async () => {
    const before = await order();
    expect((await listOcsJobs(db)).length).toBe(0);
    await setOcsSettings(db, 'root', { vendor: 'simulator', enabled: true });
    await terminateService(db, before.svc.id, { reason: 'CUSTOMER_REQUEST' }, 'root');
    expect((await listOcsJobs(db)).length).toBe(0); // it was never in the OCS, so there is nothing to close there
  });

  it('queues the plan with the subscriber’s identity, and delivers it', async () => {
    const { svc } = await order();
    const jobs = await listOcsJobs(db, { serviceId: svc.id });
    expect(jobs.map((j) => [j.command, j.status, j.planCode])).toEqual([['PROVISION', 'PENDING', 'PLAN_5G_100']]);
    const stored = (await db.query(`SELECT payload FROM ocs_jobs WHERE service_id=$1`, [svc.id])).rows[0]!.payload as OcsRequest;
    expect(stored.subscriber).toMatchObject({ serviceId: svc.id, identifier: svc.identifier, serviceType: 'MOBILE', segment: 'CONSUMER' });
    expect(stored.plan).toMatchObject({ offerId: 'plan-sim-5g', planCode: 'PLAN_5G_100', params: { dataGb: 100 } });
    expect(await enqueueOcs(db, 'PROVISION', svc.id)).toBeNull(); // never twice
    const r = await dispatchOcs(db, { connector: conn });
    expect(r).toMatchObject({ sent: 1, dead: 0 });
    expect((await listOcsJobs(db, { serviceId: svc.id }))[0]).toMatchObject({ status: 'SENT', reference: 'REF', attempts: 1 });
  });

  it('follows the subscriber: barring, restoring and termination go in order after the start', async () => {
    sent.length = 0;
    const { svc } = await order();
    await suspendService(db, svc.id, 'FRAUD', 'ops');
    await resumeService(db, svc.id, 'ops');
    await terminateService(db, svc.id, { reason: 'CUSTOMER_REQUEST' }, 'ops');
    const cmds = (await listOcsJobs(db, { serviceId: svc.id })).reverse().map((j) => j.command);
    expect(cmds).toEqual(['PROVISION', 'SET_BARRING', 'SET_BARRING', 'TERMINATE']);
    await dispatchOcs(db, { connector: conn, limit: 50 });
    const mine = sent.filter((r) => r.subscriber.serviceId === svc.id);
    expect(mine.map((r) => r.command)).toEqual(['PROVISION', 'SET_BARRING', 'SET_BARRING', 'TERMINATE']);
    expect(mine[1]!.barring).toMatchObject({ level: 'HARD' });
    expect(mine[2]!.barring).toMatchObject({ level: 'NONE' });
    expect(mine[3]!.termination).toMatchObject({ reason: 'CUSTOMER_REQUEST', ported: false });
  });

  it('retries an outage with a back-off, keeps later jobs of that subscriber waiting, and keeps what finally fails', async () => {
    sent.length = 0;
    const { svc } = await order();
    await suspendService(db, svc.id, 'FRAUD', 'ops');
    let down = true;
    behave = () => (down ? { ok: false, retryable: true, detail: 'OCS down' } : { ok: true });
    const t0 = new Date();
    let r = await dispatchOcs(db, { connector: conn, now: t0 });
    expect(r).toMatchObject({ attempted: 1, retrying: 1, sent: 0 }); // the barring did not overtake the failed start
    let jobs = (await listOcsJobs(db, { serviceId: svc.id })).reverse();
    expect(jobs.map((j) => [j.command, j.status, j.attempts])).toEqual([['PROVISION', 'PENDING', 1], ['SET_BARRING', 'PENDING', 0]]);
    expect(jobs[0]!.lastError).toBe('OCS down');
    r = await dispatchOcs(db, { connector: conn, now: new Date(t0.getTime() + 30_000) });
    expect(r.attempted).toBe(0); // not due yet
    down = false;
    r = await dispatchOcs(db, { connector: conn, now: new Date(t0.getTime() + 61_000) });
    expect(r).toMatchObject({ sent: 2, retrying: 0 }); // the start, then the barring
    // a job that never gets through is kept
    const again = await order();
    await suspendService(db, again.svc.id, 'FRAUD', 'ops');
    down = true;
    let at = t0.getTime() + 120_000;
    for (let i = 0; i < OCS_MAX_ATTEMPTS; i++) { await dispatchOcs(db, { connector: conn, now: new Date(at) }); at += 13 * 3600_000; }
    jobs = (await listOcsJobs(db, { serviceId: again.svc.id })).reverse();
    expect(jobs.map((j) => [j.command, j.status])).toEqual([['PROVISION', 'DEAD'], ['SET_BARRING', 'PENDING']]);
    expect((await db.query(`SELECT 1 FROM lifecycle_outbox WHERE instruction='OCS_JOB_FAILED' AND service_id=$1`, [again.svc.id])).rows).toHaveLength(1);
    const ov = await ocsOverview(db);
    expect(ov.stats.dead).toBe(1);
    expect(ov.jobs[0]).toMatchObject({ status: 'DEAD', lastError: 'OCS down' });
    down = false;
    await expect(retryOcsJob(db, jobs[1]!.id, 'ops')).rejects.toThrow(/failed for good/);
    await retryOcsJob(db, jobs[0]!.id, 'ops');
    r = await dispatchOcs(db, { connector: conn, now: new Date(at) });
    expect(r.sent).toBe(2);
    behave = () => ({ ok: true, reference: 'REF' });
  });

  it('a refusal is not retried, and a switched-off or unready connector leaves jobs waiting', async () => {
    const { svc } = await order();
    behave = () => ({ ok: false, retryable: false, detail: 'unknown plan' });
    expect(await dispatchOcs(db, { connector: conn })).toMatchObject({ dead: 1, retrying: 0 });
    behave = () => ({ ok: true });
    const waiting = await order();
    expect((await dispatchOcs(db, { connector: { ...conn, problem: () => 'MERIDIAN_OCS_TOKEN is not set on the server.' } })).notReady).toMatch(/not set/);
    expect((await listOcsJobs(db, { serviceId: waiting.svc.id }))[0]!.status).toBe('PENDING');
    const dead = (await listOcsJobs(db, { serviceId: svc.id }))[0]!;
    await retryOcsJob(db, dead.id, 'ops');
    await dispatchOcs(db, { connector: conn, limit: 50 });
    await setOcsSettings(db, 'root', { vendor: 'simulator', enabled: false });
    expect((await dispatchOcs(db)).notReady).toMatch(/off/);
    await setOcsSettings(db, 'root', { vendor: 'simulator', enabled: true });
  });

  it('keeps each vendor’s settings when you switch, validates them, and lists the plans that have no code', async () => {
    await expect(setOcsSettings(db, 'root', { vendor: null, enabled: true })).rejects.toThrow(/Choose/);
    await expect(setOcsSettings(db, 'root', { vendor: 'generic-rest', enabled: true, config: cfg({ baseUrl: 'nope' }) })).rejects.toThrow(/address/);
    await setOcsSettings(db, 'root', { vendor: 'generic-rest', enabled: false, config: cfg() });
    await setOcsSettings(db, 'root', { vendor: 'simulator', enabled: true });
    const s = await getOcsSettings(db);
    expect(Object.keys(s.configs).sort()).toEqual(['generic-rest', 'simulator']);
    expect(JSON.stringify(s)).not.toMatch(/secret-token/);
    const ov = await ocsOverview(db, { MERIDIAN_OCS_TOKEN: 'x' } as NodeJS.ProcessEnv);
    expect(ov.vendors.find((v) => v.id === 'generic-rest')!.envSet).toEqual({ MERIDIAN_OCS_TOKEN: true });
    expect(ov.stats.unmappedOffers).toBeGreaterThan(0);
    expect(ov.stats.unmappedNames).not.toContain('5G SIM-only 100GB');
  });
});
