import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { getTypeConflicts, setTypeConflicts } from './offer-conflicts.js';
import { priceBasket } from './order-pricing.js';
import { placeOrder } from './orders.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const basket = async (offerIds: string[]) => {
  const { customer } = await newCustomer(db);
  return { customerId: customer.id, channel: 'SELF_SERVE' as const, payment: { method: 'CREDIT_CARD' as const }, deliveryAddress: '1 Test Road', lines: offerIds.map((offerId) => ({ offerId })) };
};

describe('offer types that cannot share an order', () => {
  it('allows every combination until a rule says otherwise', async () => {
    expect(await getTypeConflicts(db)).toEqual([]);
    await expect(priceBasket(db, await basket(['plan-sim-5g', 'fiber-1g']))).resolves.toBeTruthy();
  });

  it('refuses the pair in both directions, in pricing and when placing the order, and names the offers', async () => {
    expect(await setTypeConflicts(db, 'root', [['SIM_ONLY', 'FIBER']])).toEqual([['FIBER', 'SIM_ONLY']]);   // stored once, in a fixed order
    const msg = /Home Fibre.*cannot be ordered together with .*SIM.*Place them as separate orders|SIM.*cannot be ordered together with .*Fibre/s;
    await expect(priceBasket(db, await basket(['plan-sim-5g', 'fiber-1g']))).rejects.toThrow(msg);
    await expect(priceBasket(db, await basket(['fiber-1g', 'plan-sim-5g']))).rejects.toThrow(msg);
    await expect(placeOrder(db, await basket(['plan-sim-5g', 'fiber-1g']))).rejects.toThrow(/cannot be ordered together/);
    await expect(priceBasket(db, await basket(['fiber-1g']))).resolves.toBeTruthy();                 // each alone is fine
    await expect(priceBasket(db, await basket(['plan-sim-5g']))).resolves.toBeTruthy();
  });

  it('can be switched off again, and rejects nonsense', async () => {
    await expect(setTypeConflicts(db, 'root', [['FIBER', 'FIBER']])).rejects.toThrow(/two different/);
    await expect(setTypeConflicts(db, 'root', [['FIBER', 'NOPE']])).rejects.toThrow(/no offer type/);
    await setTypeConflicts(db, 'root', []);
    await expect(priceBasket(db, await basket(['plan-sim-5g', 'fiber-1g']))).resolves.toBeTruthy();
  });
});
