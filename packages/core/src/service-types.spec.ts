import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateNode } from './catalog.js';
import type { Db } from './db.js';
import { terminateService } from './lifecycle.js';
import { dispatchOcs, listOcsJobs, setOcsSettings } from './ocs.js';
import { placeOrder } from './orders.js';
import { getServiceKind, updateServiceKind } from './service-kinds.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };
const sell = async () => { const { customer } = await newCustomer(db); const o = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] }); return (await db.query('SELECT * FROM services WHERE order_id=$1', [o.id])).rows[0]!; };
const outbox = async (instruction: string, serviceId: string) => (await db.query(`SELECT kind, payload FROM lifecycle_outbox WHERE instruction=$1 AND service_id=$2`, [instruction, serviceId])).rows;

describe('the super user adapts the built-in service types', () => {
  it('can rename and describe them, but not change what the platform issues or ends', async () => {
    const m = await updateServiceKind(db, 'admin', 'MOBILE', { name: 'Mobile line', description: 'Voice, SMS and data.' });
    expect(m).toMatchObject({ name: 'Mobile line', identifierPrefix: '+', isBuiltin: true, status: 'ACTIVE', expires: false });
    await expect(updateServiceKind(db, 'admin', 'FIBER', { identifierPrefix: 'FIB-' })).rejects.toThrow(/issued by the platform/);
    await expect(updateServiceKind(db, 'admin', 'IOT', { expires: true, validityDays: 5 })).rejects.toThrow(/do not end by themselves/);
    await expect(updateServiceKind(db, 'admin', 'SUBSCRIPTION', { status: 'INACTIVE' })).rejects.toThrow(/cannot be switched off/);
    await expect(updateServiceKind(db, 'admin', 'FIBER', { name: 'mobile line' })).rejects.toThrow(/already a service type/);
  });

  it('by default nothing changes: no start instruction, and the end goes to HLR, HSS and PCRF', async () => {
    const svc = await sell();
    expect(await outbox('PROVISION', svc.id)).toHaveLength(0);
    await terminateService(db, svc.id, { reason: 'CUSTOMER_REQUEST' }, 'ops');
    const end = await outbox('DEPROVISION', svc.id);
    expect(end).toHaveLength(1);
    expect(end[0]!.payload.systems).toEqual(['HLR', 'HSS', 'PCRF']);
    expect(end[0]!.payload.serviceKind).toBeUndefined(); // the message is what it always was
  });

  it('tells the network its own way once adapted: start and end instructions and the systems named', async () => {
    await updateServiceKind(db, 'admin', 'MOBILE', { announceStart: true, provisionInstruction: 'ACTIVATE_LINE', deprovisionInstruction: 'CLOSE_LINE', provisionSystems: ['HLR', 'HSS', 'AAA'] });
    const svc = await sell();
    const start = await outbox('ACTIVATE_LINE', svc.id);
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ kind: 'NETWORK', payload: { identifier: svc.identifier, systems: ['HLR', 'HSS', 'AAA'], offerId: 'plan-sim-5g' } });
    await terminateService(db, svc.id, { reason: 'CUSTOMER_REQUEST' }, 'ops');
    expect((await outbox('CLOSE_LINE', svc.id))[0]!.payload.systems).toEqual(['HLR', 'HSS', 'AAA']);
    expect(await outbox('DEPROVISION', svc.id)).toHaveLength(0);
    await updateServiceKind(db, 'admin', 'MOBILE', { announceStart: false, provisionInstruction: 'PROVISION', deprovisionInstruction: 'DEPROVISION', provisionSystems: [] }); // back to the defaults
    expect(await getServiceKind(db, 'MOBILE')).toMatchObject({ announceStart: false, provisionSystems: [] });
  });

  it('decides whether services of the type go to the charging system, and refuses a plan code where they do not', async () => {
    await updateNode(db, 'plan-sim-5g', { ocs: { planCode: 'PLAN_5G_100' } });
    await setOcsSettings(db, 'root', { vendor: 'simulator', enabled: true });
    await updateServiceKind(db, 'admin', 'MOBILE', { ocsEnabled: false });
    const off = await sell();
    expect(await listOcsJobs(db, { serviceId: off.id })).toHaveLength(0);
    await expect(updateNode(db, 'plan-sim-5g', { description: 'x', ocs: { planCode: 'PLAN_5G_200' } })).rejects.toThrow(/not provisioned into the charging system/);
    await updateServiceKind(db, 'admin', 'MOBILE', { ocsEnabled: true });
    const on = await sell();
    expect((await listOcsJobs(db, { serviceId: on.id }))[0]).toMatchObject({ command: 'PROVISION', planCode: 'PLAN_5G_100' });
    expect(await dispatchOcs(db)).toMatchObject({ sent: 1 });
  });
});
