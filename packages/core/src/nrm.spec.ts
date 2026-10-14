import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateNode } from './catalog.js';
import type { Db } from './db.js';
import { addDays, today } from './dates.js';
import { terminateService } from './lifecycle.js';
import { LifecycleService } from './lifecycle-service.js';
import { getOrder, listOrders, nextOrderNumber, placeOrder, cancelOrder } from './orders.js';
import { NumberReservationService, RedisLock, type RedisLike } from './number-reservation.js';
import { getMatcher, getNumberingSettings, identifierHistory, listTierRules, recycleExpired, setNumberingSettings, updateTierRule } from './nrm.js';
import { importImsis, importMsisdns, importSims, issueEsimProfile, listSims, transitionSim } from './nrm-pools.js';
import { backdate, freshDb, newCustomer } from './test-helpers.js';
import { VipPatternMatcher, type TierRule } from './vip-pattern-matcher.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const retail = { storeId: 'STORE-SG-001', salespersonId: 'a1' };
let seq = 0;
const iccid = () => `8960${String(1_000_000_000_000_000 + ++seq * 7).slice(1)}`; // 19 digits starting 89
const imsi = () => `525010${String(1_000_000_000 + ++seq * 13).slice(1)}`;

describe('order numbers', () => {
  it('are the order date and a counter for that day, and find the order', async () => {
    const a = await newCustomer(db);
    const o1 = await placeOrder(db, { customerId: a.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] });
    const o2 = await placeOrder(db, { customerId: a.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] });
    expect(o1.number).toMatch(/^\d{8}-\d{5}$/);
    const day = String(o1.number).slice(0, 8);
    expect(o2.number).toBe(`${day}-${String(Number(String(o1.number).slice(9)) + 1).padStart(5, '0')}`);
    expect((await getOrder(db, o2.number)).id).toBe(o2.id);        // by number
    expect((await getOrder(db, o2.id)).number).toBe(o2.number);    // by id
    expect((await listOrders(db, { q: o1.number })).items.map((o) => o.id)).toEqual([o1.id]);
    expect((await listOrders(db, { q: day })).items.length).toBeGreaterThanOrEqual(2);
    // another day starts again at 1
    expect(await nextOrderNumber(db, new Date('2031-03-05T04:00:00Z'))).toMatch(/^20310305-00001$/);
    expect(await nextOrderNumber(db, new Date('2031-03-05T04:00:00Z'))).toMatch(/^20310305-00002$/);
  });
});

describe('VipPatternMatcher', () => {
  it('puts numbers in Diamond, Gold, Silver, Standard and Auction by what they end with', async () => {
    const m = await getMatcher(db);
    const t = (n: string) => m.classify(n).tier;
    expect(t('+60128888888')).toBe('DIAMOND');     // AAAAA
    expect(t('+60123456789')).toBe('DIAMOND');     // ...456789
    expect(t('+60129876543')).toBe('DIAMOND');     // descending run
    expect(t('+60123334455')).toBe('GOLD');        // AABBCC
    expect(t('+60121212121')).toBe('GOLD');        // ABABAB
    expect(t('+60121237777')).toBe('GOLD');        // AAAA (7777)
    expect(t('+60123401122')).toBe('SILVER');      // AABB
    expect(t('+60123401212')).toBe('SILVER');      // ABAB
    expect(t('+60121212188')).toBe('SILVER');      // ABABCC
    expect(t('+60123461234')).toBe('SILVER');      // sequential four
    expect(t('+60123467591')).toBe('STANDARD');
    expect(t('+60188888888')).toBe('AUCTION');     // all eight the same
    expect(m.classify('+60121237777').patternCode).toBe('AAAA');
    const many = m.classifyMany(['+60128888888', '+60123467591', '+60123401122']);
    expect(many.counts).toMatchObject({ DIAMOND: 1, SILVER: 1, STANDARD: 1 });
  });

  it('follows the rules it is given, and ignores a disabled tier', () => {
    const rules: TierRule[] = [{ tier: 'GOLD', label: 'Gold', sortOrder: 1, patterns: [{ code: 'ends88', regex: '88$' }], oneTimeFeeMinor: 0, minMonthlyPlanMinor: 0, minContractMonths: 0, etcMultiplierBps: 10000, enabled: true }];
    expect(new VipPatternMatcher(rules).classify('+60123467588').tier).toBe('GOLD');
    expect(new VipPatternMatcher(rules.map((r) => ({ ...r, enabled: false }))).classify('+60123467588').tier).toBe('STANDARD');
  });

  it('refuses a pattern that is not safe or not valid when a rule is saved', async () => {
    await expect(updateTierRule(db, 'admin', 'GOLD', { patterns: [{ code: 'bad', regex: '(' }] })).rejects.toThrow(/not a valid regular expression/);
    await expect(updateTierRule(db, 'admin', 'GOLD', { patterns: [{ code: 'loop', regex: '(\\d+)+$' }] })).rejects.toThrow(/repeats a repeat/);
    await expect(updateTierRule(db, 'admin', 'STANDARD', { oneTimeFeeMinor: 100 })).rejects.toThrow(/Standard numbers carry no fee/);
    await expect(updateTierRule(db, 'admin', 'GOLD', { etcMultiplierBps: 500 })).rejects.toThrow(/1x to 10x/);
  });
});

describe('the number pool and reservations', () => {
  it('imports a range, classifies it, skips what is already there, and changes nothing on a check', async () => {
    const check = await importMsisdns(db, { range: { from: '+60121000000', to: '+60121000999' } }, { apply: false, actor: 'ops' });
    expect(check).toMatchObject({ applied: false, total: 1000, added: 1000 });
    expect((await db.query('SELECT count(*)::int AS n FROM msisdn_inventory')).rows[0]!.n).toBe(0);
    const done = await importMsisdns(db, { range: { from: '+60121000000', to: '+60121000999' } }, { apply: true, actor: 'ops' });
    expect(done.applied).toBe(true);
    expect(Object.values(done.byTier!).reduce((a, b) => a + (b ?? 0), 0)).toBe(1000);
    expect(done.byTier!.STANDARD).toBeGreaterThan(500);
    const mixed = await importMsisdns(db, { csv: 'msisdn\n+60121000001\n+60129990000\nnot-a-number\n' }, { apply: false, actor: 'ops' });
    expect(mixed).toMatchObject({ added: 1, duplicates: 1, errors: [{ line: 4 }] });
    await expect(importMsisdns(db, { csv: '+6012100\n' }, { apply: true, actor: 'ops' })).rejects.toThrow(/problem/);
    await expect(importMsisdns(db, { range: { from: '+60121000000', to: '+60131000000' } }, { apply: false, actor: 'ops' })).rejects.toThrow(/at most/);
    // a few memorable ones
    await importMsisdns(db, { csv: '+60128888888\n+60123334455\n+60188888888\n' }, { apply: true, actor: 'ops' });
    expect((await db.query(`SELECT tier FROM msisdn_inventory WHERE msisdn='+60188888888'`)).rows[0]!.tier).toBe('AUCTION');
  });

  it('gives a number to one of two customers choosing it at once, and lets it go when the hold runs out', async () => {
    const svc = new NumberReservationService(db);
    const n = '+60123334455';
    const results = await Promise.allSettled([svc.reserve(n, 'checkout:a'), svc.reserve(n, 'checkout:b')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(lost.reason.message)).toMatch(/being bought by someone else|just taken/);
    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<NumberReservationService['reserve']>>>;
    expect(winner.value.tier).toBe('GOLD');
    expect(winner.value.oneTimeFeeMinor).toBeGreaterThan(0);
    expect(new Date(winner.value.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect((await svc.search({ tier: 'GOLD' })).items.map((r) => r.msisdn)).not.toContain(n); // it is held
    await svc.reserve(n, winner.value.holder); // the holder choosing it again just extends the hold
    // nobody pays: the hold lapses
    await db.query(`UPDATE msisdn_inventory SET reserved_until = now() - interval '1 minute' WHERE msisdn=$1`, [n]);
    expect((await svc.search({ tier: 'GOLD' })).items.map((r) => r.msisdn)).toContain(n); // a lapsed hold is free even before the sweep
    expect(await svc.expireStale()).toBeGreaterThanOrEqual(1);
    expect((await db.query(`SELECT state, reserved_by FROM msisdn_inventory WHERE msisdn=$1`, [n])).rows[0]).toMatchObject({ state: 'AVAILABLE', reservedBy: null });
    const hist = (await identifierHistory(db, 'MSISDN', n)).map((h) => h.toState);
    expect(hist).toEqual(expect.arrayContaining(['RESERVED_CHECKOUT', 'AVAILABLE']));
    expect(await svc.release(n, 'checkout:a')).toBe(false); // nothing left to release
  });

  it('picks numbers without waiting on rows another checkout holds', async () => {
    const svc = new NumberReservationService(db);
    const [a, b] = await Promise.all([svc.pick('checkout:p1', { tier: 'STANDARD', prefix: '+601210' }), svc.pick('checkout:p2', { tier: 'STANDARD', prefix: '+601210' })]);
    expect(a).toHaveLength(1); expect(b).toHaveLength(1);
    expect(a[0]!.msisdn).not.toBe(b[0]!.msisdn);
  });

  it('puts the distributed lock (Redis) in front, and the database still decides', async () => {
    const held = new Map<string, string>();
    const redis: RedisLike = {
      async set(key, value, _m, _ttl, _nx) { if (held.has(key)) return null; held.set(key, value); return 'OK'; },
      async eval(_script, _n, key, token) { if (held.get(key as string) === token) held.delete(key as string); return 1; },
    };
    const svc = new NumberReservationService(db, { lock: new RedisLock(redis) });
    held.set('meridian:nrm:msisdn:+60121000500', 'someone-else'); // another server is mid-reservation
    await expect(svc.reserve('+60121000500', 'checkout:x')).rejects.toThrow(/just taken/);
    held.clear();
    const r = await svc.reserve('+60121000500', 'checkout:x');
    expect(r.msisdn).toBe('+60121000500');
    expect(held.size).toBe(0); // the lock is released after the transaction
    await svc.release('+60121000500', 'checkout:x');
  });

  it('holds numbers for auction, refuses direct sale, and announces the winner on the bus', async () => {
    const svc = new NumberReservationService(db);
    const held = await svc.holdForAuction(['+60188888888', '+60128888888', '+60120000000'], 'ops');
    expect(held.held).toBe(2);
    expect(held.skipped[0]!.why).toMatch(/not in the pool/);
    await expect(svc.reserve('+60188888888', 'checkout:z')).rejects.toThrow(/held for auction/);
    expect((await svc.search({ tier: 'AUCTION' })).items).toHaveLength(0);
    const winner = await newCustomer(db);
    const res = await svc.settleAuction({ msisdn: '+60188888888', auctionId: 'AUC-1', winnerCustomerId: winner.customer.id, winningBidMinor: 250000 }, 'auction-engine');
    expect(res.holder).toBe('auction:AUC-1');
    expect(new Date(res.expiresAt).getTime() - Date.now()).toBeGreaterThan(40 * 3_600_000); // the settlement window, not 15 minutes
    const ev = (await db.query(`SELECT payload FROM lifecycle_outbox WHERE kind='EVENT' AND instruction='VIP_NUMBER_AUCTION_WON'`)).rows[0]!.payload;
    expect(ev).toMatchObject({ topic: 'meridian.nrm.events', msisdn: '+60188888888', auctionId: 'AUC-1', customerId: winner.customer.id, winningBidMinor: 250000 });
    // an unwinnable auction goes back on the shelf, still a premium tier
    expect((await svc.releaseFromAuction(['+60128888888'], 'ops')).released).toBe(1);
    expect((await db.query(`SELECT state, tier FROM msisdn_inventory WHERE msisdn='+60128888888'`)).rows[0]).toMatchObject({ state: 'AVAILABLE', tier: 'DIAMOND' });
  });
});

describe('SIMs and IMSIs', () => {
  it('writes a free IMSI onto every SIM in a batch, and refuses a batch the pool cannot cover', async () => {
    const ims = Array.from({ length: 6 }, imsi);
    expect((await importImsis(db, { csv: ims.join('\n') }, { apply: true, actor: 'ops' })).added).toBe(6);
    const sims = Array.from({ length: 4 }, iccid);
    const check = await importSims(db, { csv: `iccid\n${sims.join('\n')}\n` }, { apply: false, actor: 'ops', locationId: 'WH-MAIN' });
    expect(check).toMatchObject({ applied: false, added: 4, errors: [] });
    expect((await listSims(db)).items).toHaveLength(0);
    const done = await importSims(db, { csv: `iccid\n${sims.join('\n')}\n` }, { apply: true, actor: 'ops', locationId: 'WH-MAIN', batch: 'B1' });
    expect([done.added, done.bound]).toEqual([4, 4]);
    expect((await db.query(`SELECT count(*)::int AS n FROM imsi_inventory WHERE state='BOUND_TO_SIM'`)).rows[0]!.n).toBe(4);
    const more = Array.from({ length: 3 }, iccid);
    await expect(importSims(db, { csv: more.join('\n') }, { apply: true, actor: 'ops', locationId: 'WH-MAIN' })).rejects.toThrow(/IMSI pool has 2 free/);
    expect((await importSims(db, { csv: `${sims[0]}\n8912\n` }, { apply: false, actor: 'ops' })).errors[0]).toMatchObject({ line: 2 });
    await expect(importSims(db, { csv: `${iccid()}\n` }, { apply: false, actor: 'ops', locationId: 'NOWHERE' })).rejects.toThrow(/Unknown location/);
  });

  it('moves SIMs along their states and never brings a scrapped one back', async () => {
    const [free] = (await listSims(db, { state: 'AVAILABLE' })).items;
    const id = free!.iccid as string;
    await expect(transitionSim(db, id, 'ACTIVE', { actor: 'ops' })).rejects.toThrow(/by an order/);
    expect((await transitionSim(db, id, 'DISTRIBUTED_DEALER', { actor: 'ops', locationId: 'STORE-SG-001' })).locationId).toBe('STORE-SG-001');
    await expect(transitionSim(db, id, 'DECOMMISSIONED', { actor: 'ops', reason: 'x' })).rejects.toThrow(/cannot go to DECOMMISSIONED/);
    await expect(transitionSim(db, id, 'DAMAGED_SCRAPPED', { actor: 'ops' })).rejects.toThrow(/Say why/);
    await transitionSim(db, id, 'DAMAGED_SCRAPPED', { actor: 'ops', reason: 'bent in the box' });
    expect((await db.query(`SELECT state FROM imsi_inventory WHERE iccid=$1`, [id])).rows).toHaveLength(0); // its IMSI went back to the pool, unused
    await transitionSim(db, id, 'DECOMMISSIONED', { actor: 'ops', reason: 'written off' });
    await expect(transitionSim(db, id, 'WAREHOUSE_INVENTORY', { actor: 'ops' })).rejects.toThrow(/final/);
  });
});

describe('selling a plan with a SIM and a number', () => {
  it('asks for a SIM when the deployment requires one, holds the SIM and number for the order, and activates them with the service', async () => {
    await setNumberingSettings(db, 'admin', { ...(await getNumberingSettings(db)), requireSim: true });
    await db.query(`UPDATE iccid_inventory SET location_id='STORE-SG-001', state='DISTRIBUTED_DEALER' WHERE state='WAREHOUSE_INVENTORY'`);
    await importImsis(db, { range: { from: '525010000000100', to: '525010000000140' } }, { apply: true, actor: 'ops' });
    await importSims(db, { csv: `iccid\n${Array.from({ length: 3 }, iccid).join('\n')}\n` }, { apply: true, actor: 'ops', locationId: 'STORE-SG-001' });
    const c = await newCustomer(db);
    const order = (lines: object[]) => placeOrder(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: lines as never });
    await expect(order([{ offerId: 'plan-sim-5g' }])).rejects.toThrow(/Choose the SIM/);

    const sim = (await listSims(db, { state: 'AVAILABLE', locationId: 'STORE-SG-001' })).items[0]!.iccid as string;
    // A SIM at another place is not yours to sell
    await db.query(`UPDATE iccid_inventory SET location_id='STORE-SG-002' WHERE iccid=$1`, [sim]);
    await expect(order([{ offerId: 'plan-sim-5g', iccid: sim }])).rejects.toThrow(/not at your store/);
    await db.query(`UPDATE iccid_inventory SET location_id='STORE-SG-001' WHERE iccid=$1`, [sim]);

    // Silver numbers cost a connection fee and ask for nothing else
    const silver = (await db.query(`SELECT msisdn FROM msisdn_inventory WHERE tier='SILVER' AND state='AVAILABLE' LIMIT 1`)).rows[0]!.msisdn as string;
    const o = await order([{ offerId: 'plan-sim-5g', iccid: sim, msisdn: silver }]);
    expect(o.totalMinor).toBe(1000 + 5000); // the plan's upfront price plus the Silver connection fee
    const line = (await db.query('SELECT * FROM order_lines WHERE order_id=$1', [o.id])).rows[0]!;
    expect([line.iccid, line.msisdn, line.vipTier, Number(line.vipFeeMinor)]).toEqual([sim, silver, 'SILVER', 5000]);
    const svc = (await db.query('SELECT * FROM services WHERE order_id=$1', [o.id])).rows[0]!;
    expect([svc.identifier, svc.iccid, svc.vipTier]).toEqual([silver, sim, 'SILVER']);
    expect(svc.imsi).toMatch(/^\d{15}$/);
    expect((await db.query('SELECT state, service_id FROM iccid_inventory WHERE iccid=$1', [sim])).rows[0]).toMatchObject({ state: 'ACTIVE', serviceId: svc.id });
    expect((await db.query('SELECT state FROM imsi_inventory WHERE imsi=$1', [svc.imsi])).rows[0]!.state).toBe('ACTIVE');
    expect((await db.query('SELECT state, service_id FROM msisdn_inventory WHERE msisdn=$1', [silver])).rows[0]).toMatchObject({ state: 'ASSIGNED_ACTIVE', serviceId: svc.id });
    await expect(order([{ offerId: 'plan-sim-5g', iccid: sim }])).rejects.toThrow(/cannot be sold/); // the SIM is in use now
    await expect(order([{ offerId: 'plan-sim-5g', iccid: (await listSims(db, { state: 'AVAILABLE' })).items[0]!.iccid, msisdn: silver }])).rejects.toThrow(/cannot be sold/);
  });

  it('refuses a VIP number on a plan that is too small, and takes the next free SIM and a standard number when none is named', async () => {
    const c = await newCustomer(db);
    const gold = (await db.query(`SELECT msisdn FROM msisdn_inventory WHERE tier='GOLD' AND state='AVAILABLE' LIMIT 1`)).rows[0]!.msisdn as string;
    await expect(placeOrder(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g', simType: 'PHYSICAL', msisdn: gold }] }))
      .rejects.toThrow(/Gold number: it needs a plan of at least .*50\.00 a month/);
    const diamond = (await db.query(`SELECT msisdn FROM msisdn_inventory WHERE tier='DIAMOND' AND state='AVAILABLE' LIMIT 1`)).rows[0]!.msisdn as string;
    await expect(placeOrder(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-phone-24', simType: 'PHYSICAL', msisdn: diamond }] }))
      .rejects.toThrow(/Diamond number/);
    const o = await placeOrder(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g', simType: 'PHYSICAL' }] });
    const svc = (await db.query('SELECT * FROM services WHERE order_id=$1', [o.id])).rows[0]!;
    expect((await db.query('SELECT tier FROM msisdn_inventory WHERE msisdn=$1', [svc.identifier])).rows[0]!.tier).toBe('STANDARD');
    expect(svc.iccid).toMatch(/^89/);
  });

  it('gives the SIM and the number back when the order never becomes a service', async () => {
    const c = await newCustomer(db);
    const sim = (await listSims(db, { state: 'AVAILABLE', locationId: 'STORE-SG-001' })).items[0]!.iccid as string;
    const num = (await db.query(`SELECT msisdn FROM msisdn_inventory WHERE tier='STANDARD' AND state='AVAILABLE' LIMIT 1`)).rows[0]!.msisdn as string;
    // Hold the order before it activates by leaving payment unconfirmed
    const o = await placeOrder(db, { customerId: c.customer.id, channel: 'CALL_CENTER', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-sim-5g', iccid: sim, msisdn: num }] }).catch((e) => e);
    if (o instanceof Error) throw o;
    const row = async () => ({ sim: (await db.query('SELECT state FROM iccid_inventory WHERE iccid=$1', [sim])).rows[0]!.state, num: (await db.query('SELECT state FROM msisdn_inventory WHERE msisdn=$1', [num])).rows[0]!.state });
    expect(['RESERVED', 'ACTIVE']).toContain((await row()).sim);
    if ((await row()).sim === 'RESERVED') {
      await cancelOrder(db, o.id, 'changed mind', 'agent');
      expect(await row()).toEqual({ sim: 'DISTRIBUTED_DEALER', num: 'AVAILABLE' });
    }
  });
});

describe('when the subscriber leaves', () => {
  it('scraps the plastic, decouples and quarantines the IMSI, rests the number, and recycles all of it later', async () => {
    const c = await newCustomer(db);
    const o = await placeOrder(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g', simType: 'PHYSICAL' }] });
    const s = (await db.query('SELECT * FROM services WHERE order_id=$1', [o.id])).rows[0]!;
    await backdate(db, c.customer.id, 40);
    await terminateService(db, s.id, { reason: 'customer request' }, 'agent');
    expect((await db.query('SELECT state, service_id FROM iccid_inventory WHERE iccid=$1', [s.iccid])).rows[0]).toMatchObject({ state: 'DECOMMISSIONED', serviceId: null });
    const im = (await db.query('SELECT * FROM imsi_inventory WHERE imsi=$1', [s.imsi])).rows[0]!;
    expect([im.state, im.iccid, im.serviceId, im.previousMsisdn]).toEqual(['QUARANTINED', null, null, s.identifier]);
    expect(String(im.quarantineUntil).slice(0, 10)).toBe(addDays(today(), 90));
    const n = (await db.query('SELECT state, quarantine_until::text AS until FROM msisdn_inventory WHERE msisdn=$1', [s.identifier])).rows[0]!;
    expect([n.state, n.until]).toEqual(['QUARANTINE_COOLING', addDays(today(), 90)]);

    expect(await recycleExpired(db, addDays(today(), 89))).toEqual({ imsis: 0, msisdns: 0 });
    const out = await recycleExpired(db, addDays(today(), 91));
    expect(out.imsis).toBeGreaterThanOrEqual(1);
    expect(out.msisdns).toBeGreaterThanOrEqual(1);
    expect((await db.query('SELECT state, iccid FROM imsi_inventory WHERE imsi=$1', [s.imsi])).rows[0]).toMatchObject({ state: 'POOL_UNASSIGNED', iccid: null });
    expect((await db.query('SELECT state FROM msisdn_inventory WHERE msisdn=$1', [s.identifier])).rows[0]!.state).toBe('AVAILABLE');
    expect((await db.query(`SELECT 1 FROM identifier_registry WHERE identifier=$1`, [s.identifier])).rows).toHaveLength(0); // the number can be sold again
    expect((await db.query('SELECT state FROM iccid_inventory WHERE iccid=$1', [s.iccid])).rows[0]!.state).toBe('DECOMMISSIONED'); // the plastic does not come back
    const trail = (await identifierHistory(db, 'IMSI', s.imsi)).map((h) => h.toState).reverse();
    expect(trail.slice(-5)).toEqual(['BOUND_TO_SIM', 'ACTIVE', 'QUARANTINED', 'RECYCLED', 'POOL_UNASSIGNED']);
    // The recycled IMSI goes onto the next SIM batch, or a fresh eSIM profile
    await importSims(db, { csv: `${iccid()},,ESIM\n` }, { apply: true, actor: 'ops', locationId: 'WH-MAIN', kind: 'ESIM' });
    const prof = await db.tx((q) => issueEsimProfile(q, { actor: 'ops' }));
    expect(prof.activationCode).toMatch(/^LPA:1\$/);
    expect((await db.query('SELECT state FROM imsi_inventory WHERE imsi=$1', [prof.imsi])).rows[0]!.state).toBe('BOUND_TO_SIM');
  });

  it('keeps an eSIM profile for reuse, never recycles a ported number, and charges a VIP number its higher early-termination charge', async () => {
    await updateTierRule(db, 'admin', 'GOLD', { minMonthlyPlanMinor: 0, minContractMonths: 0, etcMultiplierBps: 15000 });
    await importSims(db, { csv: `${iccid()},,ESIM\n` }, { apply: true, actor: 'ops', locationId: 'WH-MAIN', kind: 'ESIM' });
    const c = await newCustomer(db);
    const gold = (await db.query(`SELECT msisdn FROM msisdn_inventory WHERE tier='GOLD' AND state='AVAILABLE' LIMIT 1`)).rows[0]!.msisdn as string;
    const o = await placeOrder(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-phone-24', simType: 'ESIM', msisdn: gold }] });
    await backdate(db, c.customer.id, 180);
    const s = (await db.query('SELECT * FROM services WHERE order_id=$1', [o.id])).rows[0]!;
    expect(s.vipEtcBps).toBe(15000);
    const base = Math.round((90100 * (24 - 5)) / 24);
    const end = await terminateService(db, s.id, { reason: 'customer request', ported: true }, 'agent');
    expect(end.etc.quotedMinor).toBe(Math.round(base * 1.5));
    expect((await db.query('SELECT state, kind FROM iccid_inventory WHERE iccid=$1', [s.iccid])).rows[0]).toMatchObject({ state: 'WAREHOUSE_INVENTORY', kind: 'ESIM' }); // the profile template is reusable
    expect((await db.query('SELECT state, quarantine_until FROM msisdn_inventory WHERE msisdn=$1', [gold])).rows[0]).toMatchObject({ state: 'PORTED_OUT', quarantineUntil: null });
    expect(await recycleExpired(db, addDays(today(), 5000))).toMatchObject({ msisdns: 0 }); // it belongs to the other operator
    await updateTierRule(db, 'admin', 'GOLD', { minMonthlyPlanMinor: 5000, minContractMonths: 12, etcMultiplierBps: 12500 });
  });

  it('runs recycling and the hold sweep with the daily job', async () => {
    const out = await new LifecycleService(db).runDailyJobs(addDays(today(), 400));
    expect(out).toHaveProperty('recycled');
    expect(out).toHaveProperty('expiredHolds');
    expect((await listTierRules(db)).map((r) => r.tier)).toEqual(['AUCTION', 'DIAMOND', 'GOLD', 'SILVER', 'STANDARD']);
    void updateNode;
  });
});
