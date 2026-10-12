import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBillCycle, payInvoice } from './billing.js';
import { addToGroup, createCustomer, listChildren, searchCustomers } from './customers.js';
import { changeMsisdn, changeSim, completePortOut, requestPortOut, suspendService, resumeService, terminateService, transferOwnership } from './lifecycle.js';
import { createCase } from './cases.js';
import { customer360, reconcile } from './reports.js';
import { placeOrder } from './orders.js';
import { dayOf, today } from './dates.js';
import type { Db } from './db.js';
import { backdate, freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };

async function withService(offerId: string, ageDays = 0) {
  const c = await newCustomer(db);
  const o = await placeOrder(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId }] });
  if (ageDays) await backdate(db, c.customer.id, ageDays);
  return { ...c, serviceId: o.services[0].id as string };
}

describe('customer hierarchy', () => {
  it('rejects duplicate individuals but allows departments to share a company registration', async () => {
    const a = await createCustomer(db, { segment: 'CONSUMER', displayName: 'A', idDocument: 'S9999999Z' });
    await expect(createCustomer(db, { segment: 'CONSUMER', displayName: 'B', idDocument: 's9999999z' })).rejects.toThrow(/already exists/);
    expect(a.customer.idDocumentRef).not.toContain('9999999'); // masked, raw document never stored
    expect(a.customer).not.toHaveProperty('idDocumentHash'); // internal duplicate-detection hash is not exposed
    expect((await searchCustomers(db, { q: 'A' })).items[0]).not.toHaveProperty('idDocumentHash');
    const co = await createCustomer(db, { segment: 'ENTERPRISE', displayName: 'Co', idDocument: 'UEN1' });
    const d1 = await createCustomer(db, { segment: 'ENTERPRISE', displayName: 'Co HR', idDocument: 'UEN1', parentCustomerId: co.customer.id });
    const d2 = await createCustomer(db, { segment: 'ENTERPRISE', displayName: 'Co HR Payroll', idDocument: 'UEN1', parentCustomerId: d1.customer.id });
    expect((await listChildren(db, co.customer.id)).items.map((r) => r.displayName)).toEqual(['Co HR']);
    expect((await listChildren(db, co.customer.id, { deep: true })).items.map((r) => r.displayName).sort()).toEqual(['Co HR', 'Co HR Payroll']);
    expect(d2.customer.hierarchyPath.split('.')).toHaveLength(3);
  });

  it('searches by name, phone and MSISDN, and builds a Customer 360', async () => {
    const { customer, serviceId } = await withService('plan-sim-5g');
    const msisdn = (await db.query('SELECT identifier FROM services WHERE id=$1', [serviceId])).rows[0]!.identifier as string;
    expect((await searchCustomers(db, { q: msisdn })).items.map((c) => c.id)).toContain(customer.id);
    const owner = await newCustomer(db, { segment: 'FAMILY' });
    await addToGroup(db, owner.customer.id, customer.id);
    await createCase(db, { customerId: customer.id, type: 'FIBER_ASSURANCE', subject: 'Slow speeds' });
    const c360 = await customer360(db, customer.id);
    expect(c360.accounts).toHaveLength(1);
    expect(c360.serviceSummary[0]).toMatchObject({ type: 'MOBILE', status: 'ACTIVE', n: 1 });
    expect(c360.cases).toHaveLength(1);
    expect(c360.memberOf[0].displayName).toBe(owner.customer.displayName);
    expect(c360.recommendations.map((r: any) => r.id)).toEqual(expect.arrayContaining(['device', 'fiber', 'ott']));
  });
});

describe('subscription lifecycle', () => {
  it('suspends, resumes, swaps SIM and number', async () => {
    const { serviceId } = await withService('plan-sim-5g');
    await suspendService(db, serviceId);
    await expect(suspendService(db, serviceId)).rejects.toThrow(/ACTIVE/);
    expect((await resumeService(db, serviceId)).status).toBe('ACTIVE');
    expect((await changeSim(db, serviceId, '8965010000000000001')).iccid).toBe('8965010000000000001');
    await expect(changeSim(db, serviceId, '123')).rejects.toThrow(/ICCID/);
    const s = await changeMsisdn(db, serviceId);
    expect(s.identifier).toMatch(/^\+65\d{8}$/);
    await expect(changeMsisdn(db, serviceId, '+6591111111')).resolves.toBeTruthy();
    const other = await withService('plan-sim-5g');
    await expect(changeMsisdn(db, other.serviceId, '+6591111111')).rejects.toThrow(/already in service/);
  });

  it('transfers ownership, but not while the account is overdue', async () => {
    const a = await withService('plan-sim-5g');
    const b = await newCustomer(db);
    // same shard is required for in-place transfer; find a receiver on the same shard
    let target = b.customer;
    for (let i = 0; i < 400 && target.shardId !== a.customer.shardId; i++) target = (await newCustomer(db)).customer;
    expect(target.shardId).toBe(a.customer.shardId);
    const moved = await transferOwnership(db, a.serviceId, target.id);
    expect(moved.customerId).toBe(target.id);
    const x = await withService('plan-sim-5g', 100);
    await db.query('UPDATE accounts SET bill_cycle_day=$2 WHERE customer_id=$1', [x.customer.id, dayOf(today())]);
    await runBillCycle(db, today());
    await db.query(`UPDATE invoices SET status='OVERDUE' WHERE customer_id=$1`, [x.customer.id]);
    await expect(transferOwnership(db, x.serviceId, target.id)).rejects.toThrow(/overdue/);
  });

  it('terminating a contract early raises an ETC invoice; outside a contract it does not', async () => {
    const { serviceId, account, customer } = await withService('plan-phone-24', 180); // ~6 months into 24
    const r = await terminateService(db, serviceId, { reason: 'customer request' });
    expect(r.service.status).toBe('TERMINATED');
    expect(r.etcMinor).toBe(Math.round((90100 * (24 - 5)) / 24)); // 180 days = 5 whole calendar months elapsed
    expect(r.invoice!.totalMinor).toBeGreaterThan(r.etcMinor); // + tax
    await expect(terminateService(db, serviceId)).rejects.toThrow(/already/);
    const free = await withService('plan-sim-5g', 30);
    expect((await terminateService(db, free.serviceId)).etcMinor).toBe(0);
    expect(account).toBeTruthy(); expect(customer).toBeTruthy();
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('MNP port-out: requested -> completed terminates the number and resolves the case', async () => {
    const { serviceId, customer } = await withService('plan-sim-5g', 30);
    const c = await requestPortOut(db, serviceId, { recipientOperator: 'OtherTel', portingCode: 'PC123' });
    expect(c.type).toBe('MNP_PORT_OUT');
    expect((await db.query('SELECT status FROM services WHERE id=$1', [serviceId])).rows[0]!.status).toBe('PORTING_OUT');
    await completePortOut(db, serviceId);
    expect((await db.query('SELECT status FROM services WHERE id=$1', [serviceId])).rows[0]!.status).toBe('TERMINATED');
    expect((await db.query('SELECT status FROM cases WHERE id=$1', [c.id])).rows[0]!.status).toBe('RESOLVED');
    expect(customer.id).toBeTruthy();
  });
});

describe('invoice payment settles overdue correctly', () => {
  it('payInvoice is idempotent for a repeated key', async () => {
    const x = await withService('plan-sim-5g', 100);
    await db.query('UPDATE accounts SET bill_cycle_day=$2 WHERE customer_id=$1', [x.customer.id, dayOf(today())]);
    await runBillCycle(db, today(), { accountId: x.account!.id });
    const id = (await db.query('SELECT id FROM invoices WHERE customer_id=$1', [x.customer.id])).rows[0]!.id;
    await payInvoice(db, id, { amountMinor: 1000, method: 'CASH', idempotencyKey: 'k1' });
    const r = await payInvoice(db, id, { amountMinor: 1000, method: 'CASH', idempotencyKey: 'k1' });
    expect(r.paidMinor).toBe(1000);
  });
});
