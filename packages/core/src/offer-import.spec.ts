import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNode, getOffer, pageOffers } from './catalog.js';
import type { Db } from './db.js';
import { importOffers, offersTemplate } from './offer-import.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const H = 'group_id,offer_id,name,type,description,monthly_fee,upfront_price,prices_include_tax,contract_months,contract_free_months,etc_percent,subsidy,device_retail_price,fulfilment,stock_skus,colours_storage,device_contracts,channels,requires,excludes,partner_code,market,status,go_live_date';
const csv = (...rows: string[]) => [H, ...rows].join('\r\n');
const check = (t: string) => importOffers(db, t, { apply: false, actor: 'admin' });
const load = (t: string) => importOffers(db, t, { apply: true, actor: 'admin' });
const offerExists = async (id: string) => (await db.query('SELECT 1 FROM catalog_nodes WHERE id=$1', [id])).rows.length > 0;

describe('the template', () => {
  it('lists the valid ids to use, and can include every current offer so they can be edited in bulk', async () => {
    const t = await offersTemplate(db);
    expect(t).toContain('grp-sim-only = ');
    expect(t).toContain('SIM_ONLY = ');
    expect(t).toContain('SHIP = ');
    expect(t.split('\r\n').at(-2)).toBe(H);
    const full = await offersTemplate(db, { withOffers: true });
    expect(full).toContain('plan-sim-5g');
    // exported, unchanged, it loads back as updates and changes nothing that matters
    const r = await check(full);
    expect(r.rows.filter((x) => x.status === 'ERROR').map((x) => `${x.id}: ${x.message}`)).toEqual([]);
    expect(r.summary.created).toBe(0);
    expect(r.summary.updated).toBeGreaterThan(10);
  });
});

describe('creating and updating by offer id', () => {
  it('creates new offers like the wizard does (type defaults, draft), and checking changes nothing', async () => {
    const text = csv('grp-sim-only,csv-sim-20,CSV SIM 20,SIM_ONLY,Imported,20,,yes,0,,,,,,,,,,,,,,,', 'grp-sim-only,,CSV Fibre Lite,SIM_ONLY,,15.5,5,no,12,,40,,,,,,,,,,,,,,');
    const r = await check(text);
    expect(r.summary).toMatchObject({ created: 2, updated: 0, errors: 0 });
    expect(r.rows[1]).toMatchObject({ id: 'csv-fibre-lite', action: 'CREATE', status: 'OK' }); // id made from the name
    expect(await offerExists('csv-sim-20')).toBe(false);
    const out = await load(text);
    expect(out.applied).toBe(true);
    const sim = await getOffer(db, 'csv-sim-20');
    expect(sim).toMatchObject({ status: 'DRAFT', kind: 'SIM_ONLY', description: 'Imported' });
    expect(sim.prices[0]).toMatchObject({ type: 'RECURRING', amount: { amountMinor: 2000 }, taxInclusive: true });
    expect(sim.fulfilment.options).toEqual(['SIM']);
    const lite = await getOffer(db, 'csv-fibre-lite');
    expect(lite.contract).toMatchObject({ termMonths: 12, etc: { method: 'REMAINING_RECURRING_PERCENT', percentOfRemaining: 40 } });
    expect(lite.prices.map((p) => [p.type, p.amount.amountMinor, p.taxInclusive])).toEqual([['RECURRING', 1550, false], ['ONE_TIME', 500, false]]);
  });

  it('loading the same file again updates the same offers: no duplicates', async () => {
    const before = (await db.query(`SELECT count(*)::int AS n FROM catalog_nodes WHERE level='OFFER'`)).rows[0]!.n;
    const text = csv('grp-sim-only,csv-sim-20,CSV SIM 20 (renamed),SIM_ONLY,,25,,,,,,,,,,,,,,,,,,');
    const r = await check(text);
    expect(r.rows[0]).toMatchObject({ action: 'UPDATE', status: 'OK' });
    await load(text);
    await load(text);
    expect((await db.query(`SELECT count(*)::int AS n FROM catalog_nodes WHERE level='OFFER'`)).rows[0]!.n).toBe(before);
    const o = await getOffer(db, 'csv-sim-20');
    expect(o.name).toBe('CSV SIM 20 (renamed)');
    expect(o.prices[0]!.amount.amountMinor).toBe(2500);
    expect(o.description).toBe('Imported'); // blank cells leave a field as it was
  });

  it('applies status: active, scheduled with a date, and moves an offer to another group', async () => {
    const day = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await load(csv(`grp-sim-only,csv-sim-20,,SIM_ONLY,,,,,,,,,,,,,,,,,,,ACTIVE,`, `grp-sim-only,csv-later,Later plan,SIM_ONLY,,9,,,,,,,,,,,,,,,,,SCHEDULED,${day}`));
    expect((await getNode(db, 'csv-sim-20')).status).toBe('ACTIVE');
    expect(await getNode(db, 'csv-later')).toMatchObject({ status: 'SCHEDULED' });
    await load(csv('grp-device,csv-later,,SIM_ONLY,,,,,,,,,,,,,,,,,,,,'));
    expect((await getNode(db, 'csv-later')).parentId).toBe('grp-device');
  });

  it('creates an outright device with colours, storage prices and contracts', async () => {
    await load(csv('grp-electronics,csv-iphone,iPhone 18 Pro Max,PHYSICAL_GOOD,,,1599,yes,,,,,,SHIP,,Black:256GB:IP18-256/BLK:|Black:512GB:IP18-512-BLK:300|Silver/1TB/IP18-1TB-SLV/-50.5,24:400|12:200:2,,,,,,,'));
    const o = await getOffer(db, 'csv-iphone');
    expect(o.variants!.map((v) => [v.id, v.sku, v.priceDeltaMinor])).toEqual([['black-256gb', 'IP18-256/BLK', undefined], ['black-512gb', 'IP18-512-BLK', 30000], ['silver-1tb', 'IP18-1TB-SLV', -5050]]);
    expect(o.deals).toEqual([{ termMonths: 24, subsidyMinor: 40000 }, { termMonths: 12, subsidyMinor: 20000, waiveInLastMonths: 2 }]);
    expect(o.fulfilment.options).toEqual(['SHIP']);
  });
});

describe('problems', () => {
  it('names each one with its line, and loads nothing when any row has one', async () => {
    const text = csv(
      'grp-sim-only,csv-ok-1,Fine,SIM_ONLY,,10,,,,,,,,,,,,,,,,,,',
      'nope,csv-bad-1,Bad group,SIM_ONLY,,10,,,,,,,,,,,,,,,,,,',
      'grp-sim-only,csv-bad-2,Bad type,WIDGET,,10,,,,,,,,,,,,,,,,,,',
      'grp-sim-only,csv-bad-3,Bad price,SIM_ONLY,,ten,,,,,,,,,,,,,,,,,,',
      'grp-sim-only,csv-bad-4,No price,SIM_ONLY,,,,,,,,,,,,,,,,,,,,',
      'grp-sim-only,csv-bad-5,Bad contract,SIM_ONLY,,10,,,18,,,,,,,,,,,,,,,',
      'grp-sim-only,csv-bad-6,Bad option,SIM_ONLY,,10,,,,,,,,JUGGLE,,,,,,,,,,',
      'grp-sim-only,csv-ok-1,Same twice,SIM_ONLY,,10,,,,,,,,,,,,,,,,,,',
      'grp-sim-only,csv-bad-8,Bad channel,SIM_ONLY,,10,,,,,,,,,,,,TELEPATHY,,,,,,',
      'grp-sim-only,csv-bad-9,Past,SIM_ONLY,,10,,,,,,,,,,,,,,,,,SCHEDULED,2001-01-01',
      'grp-sim-only,Bad Id!,x,SIM_ONLY,,10,,,,,,,,,,,,,,,,,,',
      'grp-sim-only,,Goods as plan,PHYSICAL_GOOD,,,,,,,,,,SHIP,,,,,,,,,,',
      'grp-sim-only,csv-bad-10,Subsidy cut too deep,PHYSICAL_GOOD,,,100,,,,,,,SHIP,,,24:100,,,,,,,',
    );
    const r = await check(text);
    const msg = r.rows.map((x) => x.message ?? '');
    expect(r.rows.map((x) => x.status)).toEqual(['OK', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR']);
    expect(msg[1]).toMatch(/Unknown group/);
    expect(msg[2]).toMatch(/Unknown offer type/);
    expect(msg[3]).toMatch(/not an amount/);
    expect(msg[4]).toMatch(/at least one price/);
    expect(msg[5]).toMatch(/0, 12, 24 or 36/);
    expect(msg[6]).toMatch(/Unknown fulfilment option/);
    expect(msg[7]).toMatch(/already on line 2/);
    expect(msg[8]).toMatch(/Unknown channel/);
    expect(msg[9]).toMatch(/future/);
    expect(msg[10]).toMatch(/lowercase letters, digits and dashes/);
    expect(msg[11]).toMatch(/at least one price/);
    expect(msg[12]).toMatch(/less than the device price/);
    expect(r.rows[7]!.line).toBe(9);
    expect(r.canApply).toBe(false);
    await expect(load(text)).rejects.toThrow(/nothing was loaded/);
    expect(await offerExists('csv-ok-1')).toBe(false); // even the good row stayed out
  });

  it('cannot reprice an offer that has been sold, and says why; and an id used by a group is refused', async () => {
    const sold = (await db.query(`SELECT offer_id FROM services LIMIT 1`)).rows[0]?.offerId ?? 'plan-sim-5g';
    const o = await getOffer(db, sold);
    const r = await check(csv(`grp-sim-only,${sold},,${o.kind},,99.99,,,,,,,,,,,,,,,,,,`, 'grp-sim-only,grp-sim-only,Same id as a group,SIM_ONLY,,5,,,,,,,,,,,,,,,,,,'));
    const used = (await db.query(`SELECT 1 FROM services WHERE offer_id=$1 LIMIT 1`, [sold])).rows.length > 0 || (await db.query(`SELECT 1 FROM order_lines WHERE offer_id=$1 LIMIT 1`, [sold])).rows.length > 0;
    if (used) expect(r.rows[0]!.message).toMatch(/already sold/);
    expect(r.rows[1]!.message).toMatch(/already used by a group/);
  });

  it('asks for the right columns and refuses oversized or empty files', async () => {
    await expect(check('name,type\r\nA,B')).rejects.toThrow(/Missing: group_id/);
    await expect(check('')).rejects.toThrow(/empty/);
    await expect(check(csv(...Array.from({ length: 1001 }, (_, i) => `grp-sim-only,x-${i},X${i},SIM_ONLY,,1`)))).rejects.toThrow(/at most 1000/);
    expect((await pageOffers(db, { limit: 5 })).items.length).toBeGreaterThan(0);
  });
});
