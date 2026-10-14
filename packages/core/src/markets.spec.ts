import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageOffers, updateNode } from './catalog.js';
import type { Db } from './db.js';
import { priceBasket } from './order-pricing.js';
import { effectiveMarket, getMarketSettings, marketFor, setMarketSettings } from './settings.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close?.(); });

describe('one market or several', () => {
  it('starts with one market, which is the deployment\'s own country', async () => {
    expect(await getMarketSettings(db)).toEqual({ multiple: false });
    expect(await effectiveMarket(db, 'MY')).toBe('SG');
    expect((await marketFor(db, 'MY')).code).toBe('SG');
  });

  it('ignores offer markets and customer markets while there is one market', async () => {
    await updateNode(db, 'plan-sim-5g', { markets: ['MY'] }, 'test');
    const c = await newCustomer(db, { marketCode: 'TH' });
    expect(c.customer.marketCode.trim()).toBe('SG'); // asked for Thailand; there is only one market
    expect((await pageOffers(db, { status: 'ACTIVE', market: 'SG', kind: 'SIM_ONLY' })).items.map((o) => o.id)).toContain('plan-sim-5g');
    const q = await priceBasket(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH' } } as never, { soft: true });
    expect(q.problems.join(' ')).not.toMatch(/not sold in/);
  });

  it('applies them once several markets are switched on', async () => {
    await setMarketSettings(db, 'test', { multiple: true });
    expect(await effectiveMarket(db, 'my')).toBe('MY');
    expect((await pageOffers(db, { status: 'ACTIVE', market: 'SG', kind: 'SIM_ONLY' })).items.map((o) => o.id)).not.toContain('plan-sim-5g');
    expect((await pageOffers(db, { status: 'ACTIVE', market: 'MY', kind: 'SIM_ONLY' })).items.map((o) => o.id)).toContain('plan-sim-5g');
    const my = await newCustomer(db, { marketCode: 'MY' });
    expect(my.customer.marketCode.trim()).toBe('MY');
    const th = await marketFor(db, 'TH');
    expect([th.code, th.taxName, th.dialCode, th.currency]).toEqual(['TH', 'VAT', '+66', 'SGD']); // its own tax and dial code, the deployment's one currency
  });
});
