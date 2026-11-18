import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { seedDemo } from './seed.js';
import { freshDb } from './test-helpers.js';
import { purgeSalesAndCatalog, purgeOrderDocuments, PURGE_CONFIRMATION } from './reset-demo-data.js';
import { seedDemoCatalog } from './demo-catalog.js';
import { createCustomer } from './customers.js';
import { placeOrder } from './orders.js';

let db: Db;
const n = async (sql: string) => Number((await db.query(sql)).rows[0]!.n);
beforeAll(async () => { db = await freshDb(); await seedDemo(db); }, 180_000);
afterAll(async () => { await db.close(); });

describe('resetting the sales data and the catalog', () => {
  it('refuses without the confirmation text, and a dry run changes nothing', async () => {
    await expect(purgeSalesAndCatalog(db, { actor: 't' })).rejects.toThrow(/confirmation/i);
    const orders = await n('SELECT count(*)::int AS n FROM orders');
    const dry = await purgeSalesAndCatalog(db, { actor: 't', dryRun: true });
    expect(dry.orders).toBe(orders);
    expect(await n('SELECT count(*)::int AS n FROM orders')).toBe(orders);
  });

  it('removes orders, subscriptions, bills and the catalog, keeps customers, and gives numbers, SIMs and goods back', async () => {
    const customers = await n('SELECT count(*)::int AS n FROM customers');
    const accounts = await n('SELECT count(*)::int AS n FROM accounts');
    const numbersAll = await n('SELECT count(*)::int AS n FROM msisdn_inventory');
    expect(await n('SELECT count(*)::int AS n FROM services')).toBeGreaterThan(0);
    expect(await n('SELECT count(*)::int AS n FROM invoices')).toBeGreaterThan(0);
    const r = await purgeSalesAndCatalog(db, { actor: 't', confirm: PURGE_CONFIRMATION });
    expect(r.orders).toBeGreaterThan(0);
    for (const t of ['orders', 'order_lines', 'services', 'invoices', 'invoice_lines', 'payments', 'gl_entries', 'catalog_nodes', 'inventory_reservations'])
      expect(await n(`SELECT count(*)::int AS n FROM ${t}`), t).toBe(0);
    expect(await n('SELECT count(*)::int AS n FROM customers')).toBe(customers);
    expect(await n('SELECT count(*)::int AS n FROM accounts')).toBe(accounts);
    expect(await n('SELECT count(*)::int AS n FROM msisdn_inventory')).toBe(numbersAll);
    expect(await n(`SELECT count(*)::int AS n FROM msisdn_inventory WHERE state IN ('ASSIGNED_ACTIVE','RESERVED_CHECKOUT','QUARANTINE_COOLING')`)).toBe(0);
    expect(await n(`SELECT count(*)::int AS n FROM iccid_inventory WHERE state IN ('RESERVED','ACTIVE','DECOMMISSIONED')`)).toBe(0);
    expect(await n(`SELECT count(*)::int AS n FROM inventory_stock WHERE reserved <> 0`)).toBe(0);
  }, 120_000);

  it('clears order documents in slices', async () => {
    expect(await purgeOrderDocuments(db, 10)).toEqual({ deleted: 0, remaining: 0 });
  });

  it('builds the demo catalog, and an order can be placed on it with a reused number and SIM', async () => {
    const r = await seedDemoCatalog(db, 't');
    expect(r.offers).toBeGreaterThan(25);
    await expect(seedDemoCatalog(db, 't')).rejects.toThrow(/not empty/i);
    const c = await createCustomer(db, { segment: 'CONSUMER', displayName: 'Reset Test', idDocument: 'S9990001Z', email: 'reset@example.com', phone: '+6590000001' } as never);
    const o = await placeOrder(db, { customerId: c.customer.id, accountId: c.account?.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'dm-lite-20' }] } as never);
    expect(['COMPLETED', 'FULFILLED', 'ACTIVE', 'FULFILLING', 'PAID']).toContain(o.state);
    expect(await n('SELECT count(*)::int AS n FROM services')).toBeGreaterThan(0);
  }, 120_000);
});
