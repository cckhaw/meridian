import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBillCycle } from './billing.js';
import { ancestorBlocks, isSellableNow, pageOffers, setStatus } from './catalog.js';
import { addDays, dayOf, today } from './dates.js';
import type { Db } from './db.js';
import { placeOrder } from './orders.js';
import { quoteOrder } from './order-pricing.js';
import { backdate, freshDb, newCustomer } from './test-helpers.js';
import { changePlanNorth } from './subscriber-ops.js';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  // a second plan in a group of its own, so a plan change can target something whose parent we retire
  const src = (await db.query(`SELECT * FROM catalog_nodes WHERE id='plan-sim-5g'`)).rows[0]!;
  const grp = (await db.query(`SELECT * FROM catalog_nodes WHERE id=$1`, [src.parentId])).rows[0]!;
  await db.query(`INSERT INTO catalog_nodes (id, level, code, name, path, parent_id, status, markets, data, sort_order) VALUES ('sale-test-group','GROUP','sale-test-group','Sale test group',$1,$2,'ACTIVE',$3,'{}',900)`, [`${grp.path.split('/').slice(0, -1).join('/')}/sale-test-group`, grp.parentId, grp.markets]);
  const data = { ...src.data, prices: src.data.prices.map((p: any) => (p.type === 'RECURRING' ? { ...p, amount: { ...p.amount, amountMinor: 5500 } } : p)), contract: { termMonths: 0 } };
  await db.query(`INSERT INTO catalog_nodes (id, level, code, name, path, parent_id, status, kind, markets, data, sort_order) VALUES ('sale-test-plan','OFFER','sale-test-plan','Sale test plan',$1,'sale-test-group','ACTIVE','SIM_ONLY',$2,$3,901)`,
    [`${grp.path.split('/').slice(0, -1).join('/')}/sale-test-group/sale-test-plan`, src.markets, JSON.stringify(data)]);
});
afterAll(async () => { await db.close(); });

const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };
const forSale = async (extra: object = {}) => (await pageOffers(db, { forSale: true, limit: 100, ...extra })).items.map((o) => o.id);
const admin = async (extra: object = {}) => (await pageOffers(db, { limit: 100, ...extra })).items.map((o) => o.id);
const basket = (customerId: string, offerId: string) => ({ customerId, channel: 'RETAIL_ASSISTED' as const, attribution: retail, payment: { method: 'CASH' as const }, lines: [{ offerId }] });
const parentOf = async (id: string) => (await db.query('SELECT parent_id FROM catalog_nodes WHERE id=$1', [id])).rows[0]!.parentId as string;

describe('offers under a node that is not live', () => {
  it('a live offer under a retired group is not for sale, refused by quote and order, still listed for staff; reactivating restores it', async () => {
    const { customer } = await newCustomer(db);
    const group = await parentOf('plan-sim-5g');
    expect(await forSale()).toContain('plan-sim-5g');
    expect(await forSale({ step: 'PLAN' })).toContain('plan-sim-5g');
    await setStatus(db, group, 'RETIRED');
    const name = (await db.query('SELECT name FROM catalog_nodes WHERE id=$1', [group])).rows[0]!.name;
    const msg = new RegExp(`5G SIM-only 100GB is not on sale: its group ${name} is retired`);

    expect(await forSale()).not.toContain('plan-sim-5g');
    expect(await forSale({ step: 'PLAN', channel: 'RETAIL_ASSISTED', market: 'SG' })).not.toContain('plan-sim-5g');
    expect(await forSale()).toContain('sale-test-plan');   // other groups are unaffected
    expect(await admin({ status: 'ACTIVE' })).toContain('plan-sim-5g');   // staff still see (and can manage) it
    expect(await admin()).toContain('plan-sim-5g');
    expect(await isSellableNow(db, 'plan-sim-5g')).toBe(false);
    expect((await ancestorBlocks(db, [{ id: 'plan-sim-5g', name: 'x' }, { id: 'sale-test-plan', name: 'y' }])).size).toBe(1);

    await expect(quoteOrder(db, basket(customer.id, 'plan-sim-5g'))).rejects.toThrow(msg);
    await expect(placeOrder(db, basket(customer.id, 'plan-sim-5g'))).rejects.toThrow(msg);
    expect((await db.query('SELECT 1 FROM orders WHERE customer_id=$1', [customer.id])).rows).toHaveLength(0);

    await setStatus(db, group, 'ACTIVE');
    expect(await forSale()).toContain('plan-sim-5g');
    expect(await isSellableNow(db, 'plan-sim-5g')).toBe(true);
    await expect(quoteOrder(db, basket(customer.id, 'plan-sim-5g'))).resolves.toBeTruthy();
    await expect(placeOrder(db, basket(customer.id, 'plan-sim-5g'))).resolves.toBeTruthy();
  });

  it('draft and scheduled parents, and a retired category or network type higher up, hide offers too', async () => {
    const { customer } = await newCustomer(db);
    const group = await parentOf('plan-sim-5g');
    const category = await parentOf(group);
    const network = await parentOf(category);
    const tomorrow = addDays(today(), 1);
    for (const [node, status, word, level] of [[group, 'DRAFT', 'still a draft', 'group'], [group, 'SCHEDULED', 'scheduled and not live yet', 'group'], [category, 'RETIRED', 'retired', 'category'], [network, 'RETIRED', 'retired', 'network type']] as const) {
      await setStatus(db, node, status, 'test', status === 'SCHEDULED' ? tomorrow : undefined);
      const nm = (await db.query('SELECT name FROM catalog_nodes WHERE id=$1', [node])).rows[0]!.name;
      expect(await forSale()).not.toContain('plan-sim-5g');
      await expect(quoteOrder(db, basket(customer.id, 'plan-sim-5g'))).rejects.toThrow(`its ${level} ${nm} is ${word}`);
      await setStatus(db, node, 'ACTIVE');
      expect(await forSale()).toContain('plan-sim-5g');
    }
  });

  it('refuses a plan change to an offer under a retired group, and allows it once the group is live again', async () => {
    const { customer } = await newCustomer(db);
    const o = await placeOrder(db, basket(customer.id, 'plan-sim-5g'));
    const serviceId = o.services[0].id as string;
    await setStatus(db, 'sale-test-group', 'RETIRED');
    await expect(changePlanNorth(db, serviceId, { targetOfferId: 'sale-test-plan', effective: 'IMMEDIATE' }, 'app')).rejects.toThrow(/Sale test plan is not on sale: its group Sale test group is retired/);
    expect((await db.query('SELECT offer_id FROM services WHERE id=$1', [serviceId])).rows[0]!.offerId).toBe('plan-sim-5g');
    await setStatus(db, 'sale-test-group', 'ACTIVE');
    await expect(changePlanNorth(db, serviceId, { targetOfferId: 'sale-test-plan', effective: 'IMMEDIATE' }, 'app')).resolves.toBeTruthy();
    expect((await db.query('SELECT offer_id FROM services WHERE id=$1', [serviceId])).rows[0]!.offerId).toBe('sale-test-plan');
  });

  it('an already-sold service keeps billing after its group is retired', async () => {
    const { customer, account } = await newCustomer(db);
    await db.query('UPDATE accounts SET bill_cycle_day=$2 WHERE id=$1', [account!.id, dayOf(today())]);
    await placeOrder(db, basket(customer.id, 'plan-sim-5g'));
    await backdate(db, customer.id, 100);
    await setStatus(db, await parentOf('plan-sim-5g'), 'RETIRED');
    const run = await runBillCycle(db, today(), { accountId: account!.id });
    expect(run).toMatchObject({ invoices: 1, errors: [] });
    const inv = (await db.query('SELECT total_minor FROM invoices WHERE account_id=$1', [account!.id])).rows[0]!;
    expect(Number(inv.totalMinor)).toBe(3500);
    expect((await db.query(`SELECT status FROM services WHERE account_id=$1`, [account!.id])).rows[0]!.status).toBe('ACTIVE');
  });
});
