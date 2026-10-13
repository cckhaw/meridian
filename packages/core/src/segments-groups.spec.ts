import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBillCycle } from './billing.js';
import { createCustomer } from './customers.js';
import type { Db } from './db.js';
import { addGroupMember, changePrincipal, createGroup, dissolveGroup, getGroup, groupOfService, listGroups, removeGroupMember, updateGroup } from './groups.js';
import { terminateService, transferOwnership } from './lifecycle.js';
import { placeOrder } from './orders.js';
import { createSegment, getCustomerSettings, listSegmentChanges, listSegments, moveCustomerSegment, setCustomerSettings, updateSegment } from './segments.js';
import { addDays, dayOf, today } from './dates.js';
import { backdate, freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

describe('customer segments', () => {
  it('starts with Consumer, Enterprise and IoT, and lets the operator add more', async () => {
    expect((await listSegments(db)).map((s) => s.id)).toEqual(['CONSUMER', 'ENTERPRISE', 'IOT']);
    const s = await createSegment(db, 'admin', { name: 'Small business', description: 'Sole traders' });
    expect(s).toMatchObject({ id: 'SMALL_BUSINESS', name: 'Small business', individual: false, status: 'ACTIVE' });
    await expect(createSegment(db, 'admin', { name: 'small BUSINESS' })).rejects.toThrow(/already a segment/);
    expect((await createSegment(db, 'admin', { name: 'Small-business' })).id).toBe('SMALL_BUSINESS_2'); // a different name, so a different code
    const { customer } = await newCustomer(db, { segment: 'SMALL_BUSINESS' });
    expect(customer.segment).toBe('SMALL_BUSINESS');
    expect((await listSegments(db, { withCounts: true })).find((x) => x.id === 'SMALL_BUSINESS')!.customers).toBe(1);
  });

  it('only individual segments insist on one customer per ID document, and switched-off segments cannot be used', async () => {
    await newCustomer(db, { idDocument: 'S9999999Z' });
    await expect(newCustomer(db, { idDocument: 'S9999999Z' })).rejects.toThrow(/already exists/);
    await newCustomer(db, { segment: 'ENTERPRISE', idDocument: 'UEN-SHARED' });
    await newCustomer(db, { segment: 'ENTERPRISE', idDocument: 'UEN-SHARED' });
    const s = await createSegment(db, 'admin', { name: 'Trial' });
    await updateSegment(db, 'admin', s.id, { status: 'INACTIVE' });
    await expect(newCustomer(db, { segment: s.id })).rejects.toThrow(/switched off/);
    await expect(newCustomer(db, { segment: 'NOPE' })).rejects.toThrow(/unknown customer segment/);
  });

  it('protects what customers depend on', async () => {
    const used = await createSegment(db, 'admin', { name: 'Public sector' });
    await newCustomer(db, { segment: used.id });
    await expect(updateSegment(db, 'admin', used.id, { individual: true })).rejects.toThrow(/cannot change/);
    expect((await updateSegment(db, 'admin', used.id, { name: 'Government', description: 'Agencies' })).name).toBe('Government');
    for (const s of await listSegments(db)) if (s.id !== 'CONSUMER') await updateSegment(db, 'admin', s.id, { status: 'INACTIVE' });
    await expect(updateSegment(db, 'admin', 'CONSUMER', { status: 'INACTIVE' })).rejects.toThrow(/at least one segment/);
    for (const s of await listSegments(db)) await updateSegment(db, 'admin', s.id, { status: 'ACTIVE' });
  });

  it('moves a customer between segments with a reason, and keeps the history', async () => {
    const { customer } = await newCustomer(db, { idDocument: 'S1000001A' });
    await expect(moveCustomerSegment(db, 'cs', customer.id, 'ENTERPRISE', ' ')).rejects.toThrow(/why/);
    await expect(moveCustomerSegment(db, 'cs', customer.id, 'CONSUMER', 'no change')).rejects.toThrow(/already/);
    await moveCustomerSegment(db, 'cs', customer.id, 'ENTERPRISE', 'Registered a business');
    expect((await db.query('SELECT segment FROM customers WHERE id=$1', [customer.id])).rows[0]!.segment).toBe('ENTERPRISE');
    const h = await listSegmentChanges(db, customer.id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ fromSegment: 'CONSUMER', toSegment: 'ENTERPRISE', reason: 'Registered a business', changedBy: 'cs', toName: 'Enterprise' });
    expect((await db.query(`SELECT 1 FROM audit_log WHERE entity='customer' AND entity_id=$1 AND action='segment_change'`, [customer.id])).rows).toHaveLength(1);
  });

  it('refuses a move that would break the identity rule', async () => {
    await newCustomer(db, { segment: 'CONSUMER', idDocument: 'UEN-DUP-1' });
    const a = await newCustomer(db, { segment: 'ENTERPRISE', idDocument: 'UEN-DUP-1' }); // companies may share a document with a person
    await expect(moveCustomerSegment(db, 'cs', a.customer.id, 'CONSUMER', 'Becoming a person')).rejects.toThrow(/already holds this ID/);
    const parent = await newCustomer(db, { segment: 'ENTERPRISE', idDocument: 'UEN-P-1' });
    await createCustomer(db, { segment: 'ENTERPRISE', displayName: 'Dept', idDocument: 'UEN-P-1', parentCustomerId: parent.customer.id });
    await expect(moveCustomerSegment(db, 'cs', parent.customer.id, 'CONSUMER', 'Reclassify')).rejects.toThrow(/departments/);
  });
});

describe('customer settings', () => {
  it('does not allow creating a customer without an order until the operator turns it on', async () => {
    expect(await getCustomerSettings(db)).toMatchObject({ allowCreateWithoutOrder: false });
    expect(await setCustomerSettings(db, 'root', { allowCreateWithoutOrder: true })).toMatchObject({ allowCreateWithoutOrder: true });
    expect((await getCustomerSettings(db)).allowCreateWithoutOrder).toBe(true);
    await setCustomerSettings(db, 'root', { allowCreateWithoutOrder: false });
  });
});

describe('service groups', () => {
  /** A customer with `n` mobile lines on one account. */
  async function lines(n: number) {
    const c = await newCustomer(db);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const o = await placeOrder(db, { customerId: c.customer.id, accountId: c.account!.id, channel: 'TELESALES', payment: { method: 'CASH', confirmed: true, reference: 'R' }, lines: [{ offerId: 'plan-sim-5g' }] });
      ids.push((await db.query('SELECT id FROM services WHERE order_id=$1', [o.id])).rows[0]!.id as string);
    }
    return { c, ids, accountId: c.account!.id as string };
  }

  it('has one principal and supplementary services, all on one account', async () => {
    const { c, ids, accountId } = await lines(3);
    const g = await createGroup(db, 'cs', { accountId, name: 'Household', principalServiceId: ids[0]!, supplementaryServiceIds: [ids[1]!], benefits: { allowances: { dataGb: 100, voiceMinutes: 2000 }, discountBps: 1500 } });
    expect(g.members.map((m: any) => m.role)).toEqual(['PRINCIPAL', 'SUPPLEMENTARY']);
    expect(g.benefits).toEqual({ allowances: { dataGb: 100, voiceMinutes: 2000 }, discountBps: 1500 });
    await expect(createGroup(db, 'cs', { accountId, name: 'Again', principalServiceId: ids[1]! })).rejects.toThrow(/already in a group/);
    const other = await lines(1);
    await expect(addGroupMember(db, 'cs', g.id, other.ids[0]!)).rejects.toThrow(/different account/);
    expect((await addGroupMember(db, 'cs', g.id, ids[2]!)).members).toHaveLength(3);
    expect(await groupOfService(db, ids[2]!)).toMatchObject({ name: 'Household', role: 'SUPPLEMENTARY' });
    expect((await listGroups(db, { customerId: c.customer.id })).items.map((x: any) => [x.name, Number(x.memberCount)])).toEqual([['Household', 3]]);
  });

  it('never leaves a supplementary service without its principal', async () => {
    const { ids, accountId } = await lines(3);
    const g = await createGroup(db, 'cs', { accountId, name: 'Team', principalServiceId: ids[0]!, supplementaryServiceIds: [ids[1]!, ids[2]!] });
    await expect(removeGroupMember(db, 'cs', g.id, ids[0]!)).rejects.toThrow(/principal service/);
    await expect(terminateService(db, ids[0]!, {}, 'cs')).rejects.toThrow(/principal service of the group/);
    await expect(transferOwnership(db, ids[0]!, (await newCustomer(db)).customer.id, undefined, 'cs')).rejects.toThrow(/principal service of the group/);
    // hand over the principal, then the old one may leave
    expect((await changePrincipal(db, 'cs', g.id, ids[1]!)).members.map((m: any) => [m.serviceId, m.role]).sort()).toEqual([[ids[0], 'SUPPLEMENTARY'], [ids[1], 'PRINCIPAL'], [ids[2], 'SUPPLEMENTARY']].sort());
    expect((await removeGroupMember(db, 'cs', g.id, ids[0]!))!.members).toHaveLength(2);
    // a supplementary service that ends simply leaves
    await terminateService(db, ids[2]!, {}, 'cs');
    expect(await groupOfService(db, ids[2]!)).toBeNull();
    expect((await getGroup(db, g.id)).members).toHaveLength(1);
    // the last one leaving closes the group
    expect(await removeGroupMember(db, 'cs', g.id, ids[1]!)).toBeNull();
    expect((await getGroup(db, g.id)).status).toBe('CLOSED');
    await expect(addGroupMember(db, 'cs', g.id, ids[0]!)).rejects.toThrow(/dissolved/);
  });

  it('can be dissolved, renamed and given new benefits', async () => {
    const { ids, accountId } = await lines(2);
    const g = await createGroup(db, 'cs', { accountId, name: 'Pair', principalServiceId: ids[0]!, supplementaryServiceIds: [ids[1]!] });
    const u = await updateGroup(db, 'cs', g.id, { name: 'Pair+', benefits: { allowances: { smsCount: 500 } } });
    expect(u).toMatchObject({ name: 'Pair+', benefits: { allowances: { smsCount: 500 } } });
    await expect(updateGroup(db, 'cs', g.id, { benefits: { discountBps: 20_000 } })).rejects.toThrow(/between 0% and 100%/);
    await expect(updateGroup(db, 'cs', g.id, { benefits: { allowances: { dataGb: -1 } } })).rejects.toThrow(/dataGb|shared data/);
    await dissolveGroup(db, 'cs', g.id);
    expect(await groupOfService(db, ids[0]!)).toBeNull();
    expect((await createGroup(db, 'cs', { accountId, name: 'Fresh', principalServiceId: ids[1]!, supplementaryServiceIds: [ids[0]!] })).members).toHaveLength(2);
  });

  it('gives the group discount on supplementary lines at billing', async () => {
    const { c, ids, accountId } = await lines(2);
    await backdate(db, c.customer.id, 100);
    await createGroup(db, 'cs', { accountId, name: 'Discounted', principalServiceId: ids[0]!, supplementaryServiceIds: [ids[1]!], benefits: { discountBps: 2000 } });
    const day = (await db.query('SELECT bill_cycle_day FROM accounts WHERE id=$1', [accountId])).rows[0]!.billCycleDay as number;
    let asOf = today(); while (dayOf(asOf) !== day) asOf = addDays(asOf, 1);
    const r = await runBillCycle(db, asOf, { accountId });
    expect(r.invoices).toBe(1);
    const lines_ = (await db.query(`SELECT l.kind, l.description, l.net_minor, l.service_id FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.account_id=$1`, [accountId])).rows;
    const fee = lines_.find((l) => l.kind === 'RECURRING')!;
    const off = lines_.find((l) => l.description.startsWith('Group discount Discounted'))!;
    expect(off.serviceId).toBe(ids[1]);
    expect(off.netMinor).toBeLessThan(0);
    expect(Math.abs(off.netMinor)).toBeCloseTo((fee.netMinor / 2) * 0.2, -1); // 20% of one of the two equal lines
  });
});
