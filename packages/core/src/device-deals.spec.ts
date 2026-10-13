import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateNode } from './catalog.js';
import type { Db } from './db.js';
import { terminateService } from './lifecycle.js';
import { priceBasket } from './order-pricing.js';
import { advanceOrder, cancelOrder, placeOrder, returnGoods } from './orders.js';
import { reconcile } from './reports.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await updateNode(db, 'good-phone-outright', { deals: [{ termMonths: 24, subsidyMinor: 40000 }, { termMonths: 12, subsidyMinor: 20000, waiveInLastMonths: 2 }] }, 'admin');
});
afterAll(async () => { await db.close(); });

const lines = (extra: Record<string, unknown> = {}) => [{ offerId: 'plan-sim-5g' }, { offerId: 'good-phone-outright', attachTo: 0, dealTermMonths: 24, ...extra }];
const order = async (l = lines(), channel: 'SELF_SERVE' | 'RETAIL_ASSISTED' = 'SELF_SERVE') => {
  const { customer } = await newCustomer(db);
  return placeOrder(db, { customerId: customer.id, channel, payment: { method: 'CREDIT_CARD' }, deliveryAddress: '1 Test Road', lines: l } as never);
};

describe('a device bought on a contract with a plan', () => {
  it('only works for a device that offers contracts, on the lengths it offers', async () => {
    await expect(order([{ offerId: 'plan-sim-5g' }, { offerId: 'good-phone-outright', attachTo: 0, dealTermMonths: 36 } as never])).rejects.toThrow(/not offered on a 36-month contract/);
    await expect(order([{ offerId: 'plan-sim-5g' }, { offerId: 'good-toaster', attachTo: 0, dealTermMonths: 24 } as never])).rejects.toThrow(/not offered on a 24-month contract/);
    await expect(order([{ offerId: 'good-phone-outright', attachTo: 0, dealTermMonths: 24 } as never])).rejects.toThrow(/choose a plan/);
    await expect(order([{ offerId: 'plan-phone-24' }, { offerId: 'good-phone-outright', attachTo: 0, dealTermMonths: 24 } as never])).rejects.toThrow(/plan that has no device/);
  });

  it('prices the device at retail less the subsidy and lets it be paid by instalments on the plan, no longer than the contract', async () => {
    const { customer } = await newCustomer(db);
    const base = { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' } } as never;
    const outright = await priceBasket(db, { ...(base as object), lines: [{ offerId: 'good-phone-outright' }] } as never);
    const onContract = await priceBasket(db, { ...(base as object), lines: lines({ payment: { mode: 'INSTALLMENT', months: 12, downPaymentMinor: 5900 } }) } as never);
    const phone = onContract.lines[1]!;
    expect(phone.listGross).toBe(outright.lines[0]!.gross - 40000);
    expect(phone.deal).toMatchObject({ termMonths: 24, subsidyMinor: 40000 });
    expect(phone.paidNow).toBe(5900);
    expect(phone.instalmentMinor).toBe(Math.floor((phone.gross - 5900) / 12));
    await expect(priceBasket(db, { ...(base as object), lines: lines({ dealTermMonths: 12, payment: { mode: 'INSTALLMENT', months: 24 } }) } as never)).rejects.toThrow(/cannot run longer than the 12-month contract/);
    await expect(priceBasket(db, { ...(base as object), lines: [{ offerId: 'plan-sim-5g' }, { offerId: 'good-toaster', payment: { mode: 'INSTALLMENT', months: 12 } }] } as never)).rejects.toThrow(/no service to bill/);
  });

  it('switches the plan on when the device arrives, with its contract and the device instalments on its bill, and charges the unamortised subsidy on early termination', async () => {
    const placed = await order(lines({ payment: { mode: 'INSTALLMENT', months: 12 } }));
    expect(placed.serviceCount).toBe(0); // the plan waits for the device
    await advanceOrder(db, placed.id, { type: 'ship' });
    const done = await advanceOrder(db, placed.id, { type: 'deliver' });
    const svc = done.services.find((s: any) => s.type === 'MOBILE');
    const row = (await db.query('SELECT * FROM services WHERE id=$1', [svc.id])).rows[0]!;
    expect(row.contractTermMonths).toBe(24);
    expect(row.deal).toMatchObject({ termMonths: 24, subsidyMinor: 40000 });
    const charges = (await db.query(`SELECT description, remaining_cycles FROM service_charges WHERE service_id=$1`, [svc.id])).rows;
    expect(charges.some((c: any) => /Phone X1 128GB \(outright\) instalment \(12 mo\)/.test(c.description) && c.remainingCycles === 12)).toBe(true);
    const end = await terminateService(db, svc.id, { reason: 'test' });
    expect(end.etcMinor).toBe(40000); // nothing of the 24 months has elapsed
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('cannot be cancelled plan-first: the plan and its device are cancelled together', async () => {
    const placed = await order();
    await expect(cancelOrder(db, placed.id, 'x', 'agent', { groups: ['ACTIVATION'] })).rejects.toThrow(/cancel the device with it/);
    const o = await cancelOrder(db, placed.id, 'changed mind');
    expect(o.groups.map((g: any) => g.status).sort()).toEqual(['CANCELLED', 'CANCELLED']);
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('keeps the plan but ends the contract and the device instalments when the device is returned', async () => {
    const placed = await order(lines({ payment: { mode: 'INSTALLMENT', months: 12 } }));
    await advanceOrder(db, placed.id, { type: 'ship' });
    const done = await advanceOrder(db, placed.id, { type: 'deliver' });
    const id = done.services.find((s: any) => s.type === 'MOBILE').id;
    await returnGoods(db, placed.id, { reason: 'faulty', condition: 'GOOD' }, 'agent', { canOverride: true });
    const row = (await db.query('SELECT * FROM services WHERE id=$1', [id])).rows[0]!;
    expect(row.status).toBe('ACTIVE');
    expect(row.deal).toBeNull();
    expect(row.contractTermMonths).toBeNull();
    expect((await db.query(`SELECT 1 FROM service_charges WHERE service_id=$1 AND remaining_cycles > 0`, [id])).rows).toHaveLength(0);
    expect((await terminateService(db, id, {})).etcMinor).toBe(0);
  });
});

describe('contracts on a device offer', () => {
  it('are only for devices sold outright, and the subsidy must be less than the price', async () => {
    await expect(updateNode(db, 'good-toaster', { deals: [{ termMonths: 24, subsidyMinor: 5900 }] }, 'admin')).rejects.toMatchObject({ details: expect.arrayContaining([expect.stringMatching(/less than the device price/)]) });
    await expect(updateNode(db, 'good-toaster', { deals: [{ termMonths: 18, subsidyMinor: 1000 }] }, 'admin')).rejects.toMatchObject({ details: expect.arrayContaining([expect.stringMatching(/12, 24 or 36/)]) });
    await expect(updateNode(db, 'plan-sim-5g', { deals: [{ termMonths: 24, subsidyMinor: 1000 }] }, 'admin')).rejects.toMatchObject({ details: expect.arrayContaining([expect.stringMatching(/sold outright/)]) });
  });
});
