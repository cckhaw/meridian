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
    expect(await getMarketSettings(db)).toMatchObject({ multiple: false, defaultMarket: 'SG' });
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

  it('adds a market with its own tax and dial code, and makes it the default', async () => {
    const cur = await getMarketSettings(db);
    const jp = { code: 'jp', name: 'Japan', dialCode: '+81', taxName: 'Consumption tax', taxBps: 1000, currency: '' };
    const next = await setMarketSettings(db, 'test', { multiple: true, defaultMarket: 'JP', markets: [...cur.markets, jp] });
    expect(next.defaultMarket).toBe('JP');
    expect(next.markets.map((m) => m.code)).toContain('JP');
    const m = await marketFor(db, 'JP');
    expect([m.taxName, m.taxBps, m.dialCode]).toEqual(['Consumption tax', 1000, '+81']);
    expect(await effectiveMarket(db)).toBe('JP'); // nobody picked one: the default
    expect((await newCustomer(db)).customer.marketCode.trim()).toBe('JP');
    await expect(effectiveMarket(db, 'ZZ')).rejects.toThrow(/unknown market/);
  });

  it('refuses bad input and removing a market that is still used or is the home country', async () => {
    const cur = await getMarketSettings(db);
    const without = (code: string) => cur.markets.filter((m) => m.code !== code);
    await expect(setMarketSettings(db, 'test', { multiple: true, markets: without('SG') })).rejects.toThrow(/own country/);
    await expect(setMarketSettings(db, 'test', { multiple: true, defaultMarket: 'ZZ' })).rejects.toThrow(/default market/);
    await expect(setMarketSettings(db, 'test', { multiple: true, markets: [...cur.markets, { ...cur.markets[0]! }] })).rejects.toThrow(/twice/);
    await expect(setMarketSettings(db, 'test', { multiple: true, markets: cur.markets.map((m) => (m.code === 'TH' ? { ...m, dialCode: '66' } : m)) })).rejects.toThrow(/dial code/);
    await expect(setMarketSettings(db, 'test', { multiple: true, defaultMarket: 'SG', markets: without('MY') })).rejects.toThrow(/cannot be removed: .*offer/); // plan-sim-5g is sold in MY
    await updateNode(db, 'plan-sim-5g', { markets: [] }, 'test');
    const ok = await setMarketSettings(db, 'test', { multiple: true, defaultMarket: 'SG', markets: without('VN') });
    expect(ok.markets.map((m) => m.code)).not.toContain('VN');
  });
});
