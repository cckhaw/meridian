import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNode, setStatus } from './catalog.js';
import { catalogHealthPage, catalogHealthSummary, HEALTH_CAP, HEALTH_CHECKS, type HealthRow } from './catalog-health.js';
import type { Db } from './db.js';
import { placeOrder } from './orders.js';
import { freshDb, newCustomer } from './test-helpers.js';
import { tmfCreateOffering } from './tmf620.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); }, 60_000);
afterAll(async () => { await db.close(); });

const money = (type: string, value: number, extra: Record<string, unknown> = {}) => ({ priceType: type, price: { taxIncludedAmount: { unit: 'SGD', value } }, ...extra });
const monthly = (v: number) => money('recurring', v, { recurringChargePeriodType: 'month', recurringChargePeriodLength: 1 });
const offer = (id: string, group: string, over: Record<string, unknown> = {}) => tmfCreateOffering(db, {
  id, name: `HL ${id}`, category: [{ id: group }], lifecycleStatus: 'Active', productOfferingPrice: [monthly(10)], '@meridian': { kind: 'VAS' }, ...over,
}, 'test');
const group = (id: string, status = 'ACTIVE') => createNode(db, { level: 'GROUP', id, code: id, name: `Group ${id}`, path: '', parentId: 'mobile-postpaid', status, markets: [] } as never, 'test');
const sql = (text: string, args: unknown[] = []) => db.query(text, args);
const all = async (check: string, o: { minAgeDays?: number; nearPriceBps?: number } = {}): Promise<HealthRow[]> => {
  const out: HealthRow[] = [];
  let cursor: string | undefined;
  do { const p = await catalogHealthPage(db, check, { ...o, limit: 200, cursor }); out.push(...p.items); cursor = p.nextCursor ?? undefined; } while (cursor);
  return out;
};
const ids = (rows: HealthRow[]) => rows.map((r) => r.id);

describe('catalogue health: the checks', () => {
  it('lists offers that were never sold, by age, and leaves out the ones that were', async () => {
    await offer('hl-old', 'grp-vas'); await offer('hl-young', 'grp-vas');
    await sql(`UPDATE catalog_nodes SET created_at = now() - interval '90 days' WHERE id IN ('hl-old', 'plan-phone-12')`);
    const { customer } = await newCustomer(db);
    await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-phone-12' }] });
    const rows = await all('NEVER_SOLD');
    expect(ids(rows)).toContain('hl-old');
    expect(ids(rows)).not.toContain('hl-young');            // too new
    expect(ids(rows)).not.toContain('plan-phone-12');       // sold
    expect(ids(await all('NEVER_SOLD', { minAgeDays: 0 }))).toContain('hl-young');
  });

  it('finds active offers hidden by a parent that is not live, and says which one', async () => {
    await group('grp-hl-a'); await offer('hl-hidden', 'grp-hl-a'); await offer('hl-shown', 'grp-vas');
    await setStatus(db, 'grp-hl-a', 'RETIRED', 'test');
    const rows = await all('UNREACHABLE');
    const r = rows.find((x) => x.id === 'hl-hidden')!;
    expect(r.message).toBe('Not on sale: its group Group grp-hl-a is retired.');
    expect(r.related).toEqual([{ id: 'grp-hl-a', name: 'Group grp-hl-a' }]);
    expect(ids(rows)).not.toContain('hl-shown');
  });

  it('finds prerequisites and exclusions that are missing, cannot be met, or point at things no longer on sale', async () => {
    await group('grp-hl-empty');                                  // live, but nothing on sale in it
    await offer('hl-dep-live', 'grp-vas'); await offer('hl-dep-dead', 'grp-vas'); await setStatus(db, 'hl-dep-dead', 'RETIRED', 'test');
    for (const id of ['hl-needs-ghost', 'hl-needs-dead', 'hl-needs-empty', 'hl-needs-live', 'hl-excl-dead']) await offer(id, 'grp-vas');
    const set = (id: string, requires: string[], excludes: string[] = []) => sql(`UPDATE catalog_nodes SET data = jsonb_set(jsonb_set(data, '{requires}', $2::jsonb), '{excludes}', $3::jsonb) WHERE id = $1`, [id, JSON.stringify(requires), JSON.stringify(excludes)]);
    await set('hl-needs-ghost', ['no-such-thing']); await set('hl-needs-dead', ['hl-dep-dead']); await set('hl-needs-empty', ['grp-hl-empty']); await set('hl-needs-live', ['hl-dep-live']);
    await set('hl-excl-dead', [], ['hl-dep-dead']);
    expect(ids(await all('DEP_MISSING'))).toContain('hl-needs-ghost');
    const dead = await all('DEP_REQUIRES_DEAD');
    expect(ids(dead)).toEqual(expect.arrayContaining(['hl-needs-dead', 'hl-needs-empty']));
    expect(ids(dead)).not.toContain('hl-needs-live');
    expect(dead.find((r) => r.id === 'hl-needs-dead')!.message).toBe('Requires HL hl-dep-dead, which is retired.');
    expect(dead.find((r) => r.id === 'hl-needs-empty')!.message).toMatch(/has no offer on sale beneath it/);
    const excl = await all('DEP_EXCLUDES_DEAD');
    expect(ids(excl)).toContain('hl-excl-dead');
    expect(ids(excl)).not.toContain('hl-needs-dead');
  });

  it('finds circular prerequisites once per cycle, including through a group, and rules that contradict themselves', async () => {
    for (const id of ['hl-cyc-a', 'hl-cyc-b', 'hl-cyc-c', 'hl-grp-user']) await offer(id, 'grp-vas');
    await group('grp-hl-cyc'); await offer('hl-in-grp', 'grp-hl-cyc');
    const set = (id: string, requires: string[], excludes: string[] = []) => sql(`UPDATE catalog_nodes SET data = jsonb_set(jsonb_set(data, '{requires}', $2::jsonb), '{excludes}', $3::jsonb) WHERE id = $1`, [id, JSON.stringify(requires), JSON.stringify(excludes)]);
    await set('hl-cyc-a', ['hl-cyc-b']); await set('hl-cyc-b', ['hl-cyc-c']); await set('hl-cyc-c', ['hl-cyc-a']);
    await set('hl-grp-user', ['grp-hl-cyc']); await set('hl-in-grp', ['hl-grp-user']);          // needs the group that holds it
    const cyc = await all('DEP_CIRCULAR');
    const abc = cyc.filter((r) => ['hl-cyc-a', 'hl-cyc-b', 'hl-cyc-c'].includes(r.id));
    expect(abc.map((r) => r.id)).toEqual(['hl-cyc-a']);                                            // one finding for the cycle, at its first member
    expect(abc[0]!.message).toBe('Circular: HL hl-cyc-a → HL hl-cyc-b → HL hl-cyc-c → HL hl-cyc-a.');
    expect(cyc.some((r) => ['hl-grp-user', 'hl-in-grp'].includes(r.id))).toBe(true);
    await offer('hl-self-group', 'grp-hl-cyc'); await offer('hl-self-ex', 'grp-vas'); await offer('hl-clash', 'grp-vas'); await offer('hl-clash-x', 'grp-vas');
    await set('hl-self-group', ['grp-hl-cyc']); await set('hl-self-ex', [], ['hl-self-ex']); await set('hl-clash', ['hl-clash-x'], ['hl-clash-x']);
    const self = await all('DEP_SELF_CONFLICT');
    expect(self.find((r) => r.id === 'hl-self-group')!.message).toBe('Requires Group grp-hl-cyc, which contains this offer.');
    expect(self.find((r) => r.id === 'hl-self-ex')!.message).toBe('Excludes itself.');
    expect(self.find((r) => r.id === 'hl-clash')!.message).toMatch(/Requires HL hl-clash-x but excludes HL hl-clash-x/);
  });

  it('finds identical and nearly identical prices in one group, and ignores price ids', async () => {
    await group('grp-hl-price');
    await offer('hl-p1', 'grp-hl-price', { productOfferingPrice: [monthly(25), money('oneTime', 5)] });
    await offer('hl-p2', 'grp-hl-price', { productOfferingPrice: [monthly(25), money('oneTime', 5)] });      // identical to hl-p1 (their price ids differ)
    await offer('hl-p3', 'grp-hl-price', { productOfferingPrice: [monthly(25.1), money('oneTime', 9)] });    // 0.4% above, different one-time price
    await offer('hl-p4', 'grp-hl-price', { productOfferingPrice: [monthly(40)] });
    const dup = (await all('PRICE_DUPLICATE')).filter((r) => r.related.some((x) => x.id.startsWith('hl-p')));
    expect(dup).toHaveLength(1);
    expect(dup[0]!.related.map((x) => x.id)).toEqual(['hl-p1', 'hl-p2']);
    expect(dup[0]!.message).toBe('Same type, term and prices as 1 other offer in this group.');
    const near = (await all('PRICE_NEAR')).filter((r) => r.id.startsWith('hl-p'));
    expect(near.map((r) => r.id)).toContain('hl-p3');
    expect(near.map((r) => r.id)).not.toContain('hl-p4');           // 40 is not near 25.1
    expect((await all('PRICE_NEAR', { nearPriceBps: 10 })).filter((r) => r.id === 'hl-p3')).toHaveLength(0);   // 0.1% is stricter than the 0.4% gap
  });

  it('finds bundle discounts that stack and device deals that repeat a contract length', async () => {
    const rule = (id: string, when: string[], target: string) => sql(`INSERT INTO bundle_rules (id, name, status, data) VALUES ($1, $2, 'ACTIVE', $3)`, [id, `Rule ${id}`, JSON.stringify({ when, target, percentBps: 500 })]);
    await rule('hl-r1', ['kind:FIBER', 'kind:SIM_DEVICE'], 'kind:SIM_DEVICE'); await rule('hl-r2', ['kind:SIM_DEVICE'], 'kind:SIM_DEVICE'); await rule('hl-r3', ['kind:IOT'], 'kind:SIM_DEVICE');
    await offer('hl-deals', 'grp-vas');
    await sql(`UPDATE catalog_nodes SET data = jsonb_set(data, '{deals}', '[{"termMonths":12,"subsidyMinor":100},{"termMonths":12,"subsidyMinor":200},{"termMonths":24,"subsidyMinor":300}]') WHERE id = 'hl-deals'`);
    const rows = await all('PROMO_OVERLAP');
    const pair = rows.filter((r) => r.entity === 'bundle_rule' && r.id.startsWith('hl-r'));
    expect(pair).toHaveLength(1);
    expect([pair[0]!.id, pair[0]!.related[0]!.id]).toEqual(['hl-r1', 'hl-r2']);
    expect(pair[0]!.message).toBe('Both discount kind:SIM_DEVICE when kind:SIM_DEVICE is in the basket, so they stack.');
    expect(rows.find((r) => r.id === 'hl-deals')!.message).toBe('2 device deals for a 12-month contract.');
  });

  it('finds active offers with no line items and no channel chosen, and leaves out the market check while there is one market', async () => {
    await offer('hl-bare', 'grp-vas');
    expect(ids(await all('NO_LINE_ITEMS'))).toContain('hl-bare');
    await createNode(db, { level: 'LINE_ITEM', id: 'hl-bare-i1', code: 'hl-bare-i1', name: 'Data', path: '', parentId: 'hl-bare', status: 'ACTIVE', markets: [], itemType: 'DATA', quantity: 5, unit: 'GB' } as never, 'test');
    expect(ids(await all('NO_LINE_ITEMS'))).not.toContain('hl-bare');
    expect(ids(await all('NO_CHANNELS'))).toContain('hl-bare');
    await sql(`UPDATE catalog_nodes SET data = jsonb_set(data, '{salesChannels}', '["RETAIL_ASSISTED"]') WHERE id = 'hl-bare'`);
    expect(ids(await all('NO_CHANNELS'))).not.toContain('hl-bare');
    expect((await catalogHealthSummary(db)).map((c) => c.id)).not.toContain('NO_MARKETS');
    await expect(catalogHealthPage(db, 'NO_MARKETS')).rejects.toThrow(/unknown check/);
  });

  it('finds scheduled go-lives that did not happen and scheduled offers whose parent will not be live by then', async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await offer('hl-late', 'grp-vas', { lifecycleStatus: 'In design' });
    await sql(`UPDATE catalog_nodes SET status = 'SCHEDULED', active_from = now() - interval '10 minutes' WHERE id = 'hl-late'`);
    expect(ids(await all('SCHEDULE_OVERDUE'))).toContain('hl-late');
    await group('grp-hl-draft', 'DRAFT'); await group('grp-hl-sched', 'DRAFT');
    await offer('hl-sched-under-draft', 'grp-hl-draft', { lifecycleStatus: 'In design', validFor: { startDateTime: future } });
    await offer('hl-sched-ok', 'grp-hl-sched', { lifecycleStatus: 'In design', validFor: { startDateTime: future } });
    await setStatus(db, 'grp-hl-sched', 'SCHEDULED', 'test', new Date(Date.now() + 2 * 86_400_000).toISOString());    // live before its offer goes live
    const rows = await all('SCHEDULE_PARENT_NOT_LIVE');
    expect(ids(rows)).toContain('hl-sched-under-draft');
    expect(ids(rows)).not.toContain('hl-sched-ok');
    expect(rows.find((r) => r.id === 'hl-sched-under-draft')!.message).toMatch(/its group Group grp-hl-draft is still a draft/);
  });

  it('has a summary that counts every check, refuses an unknown check and a bad option', async () => {
    const summary = await catalogHealthSummary(db);
    expect(summary.map((c) => c.id)).toEqual(HEALTH_CHECKS.filter((c) => c.id !== 'NO_MARKETS').map((c) => c.id));
    expect(summary.every((c) => Number.isInteger(c.count) && c.count >= 0 && c.capped === false)).toBe(true);
    expect(summary.find((c) => c.id === 'DEP_CIRCULAR')!.count).toBeGreaterThan(0);
    await expect(catalogHealthPage(db, 'NOPE')).rejects.toThrow(/unknown check/);
    await expect(catalogHealthSummary(db, { minAgeDays: -1 })).rejects.toThrow(/minAgeDays/);
    await expect(catalogHealthPage(db, 'NEVER_SOLD', { nearPriceBps: 0 })).rejects.toThrow(/nearPriceBps/);
  });
});

describe('catalogue health: paging and the cap', () => {
  it('pages with a cursor, seeing every finding exactly once, and caps the count at a very large catalogue', async () => {
    const big = await freshDb();
    try {
      const parent = (await big.query(`SELECT path FROM catalog_nodes WHERE id = 'grp-vas'`)).rows[0]!.path as string;
      const n = HEALTH_CAP + 120;
      await big.query(
        `INSERT INTO catalog_nodes (id, level, code, name, path, parent_id, status, kind, markets, data, sort_order)
         SELECT 'bulk-' || lpad(g::text, 6, '0'), 'OFFER', 'bulk-' || g, 'Bulk ' || g, $1 || '/bulk-' || lpad(g::text, 6, '0'), 'grp-vas', 'ACTIVE', 'VAS', '{}',
                '{"prices":[{"type":"RECURRING","amount":{"amountMinor":1000,"currency":"SGD"},"periodMonths":1,"taxInclusive":true}],"requires":[],"excludes":[],"salesChannels":[]}'::jsonb, g
         FROM generate_series(1, $2) g`, [parent, n]);
      const summary = await catalogHealthSummary(big);
      const open = summary.find((c) => c.id === 'NO_CHANNELS')!;
      expect([open.count, open.capped]).toEqual([HEALTH_CAP, true]);
      // paging through a few hundred of them with a small page: no repeats, no gaps, in key order
      const seen: string[] = [];
      let cursor: string | undefined, pages = 0;
      do { const p = await catalogHealthPage(big, 'NO_CHANNELS', { limit: 100, cursor }); seen.push(...p.items.filter((r) => r.id.startsWith('bulk-')).map((r) => r.id)); cursor = p.nextCursor ?? undefined; pages++; if (seen.length >= 450) break; } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual([...seen].sort());
      expect(seen.length).toBeGreaterThanOrEqual(450);
      expect(pages).toBeGreaterThan(3);
      // a forged cursor is refused
      await expect(catalogHealthPage(big, 'NO_CHANNELS', { cursor: 'not-a-cursor' })).rejects.toThrow(/page link is not valid/);
    } finally { await big.close(); }
  }, 120_000);
});
