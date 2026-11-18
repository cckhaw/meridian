import type { OfferNode } from '@meridian/types';
import type { Db } from './db.js';
import { createNode } from './catalog.js';
import { getRegional, marketMode } from './settings.js';
import { adjustStock } from './inventory.js';
import { audit } from './audit.js';
import { rejected } from './errors.js';

type Money = { amountMinor: number; currency: string };
type OfferSeed = Pick<OfferNode, 'id' | 'name' | 'kind' | 'prices' | 'fulfilment'> & Partial<Pick<OfferNode, 'contract' | 'partnerCode' | 'requires' | 'description'>> & { terms?: OfferNode['group']; group: string; skuVariants?: boolean };

const TREE = [
  { id: 'mobile', name: 'Mobile', networkType: 'mobile', children: [
    { id: 'postpaid', name: 'Postpaid', groups: ['sim-only', 'family', 'device', 'tablet', 'addons', 'insurance'] }, { id: 'wearables', name: 'Wearables', groups: ['wearable'] }] },
  { id: 'fiber', name: 'Fibre', networkType: 'fiber', children: [{ id: 'residential', name: 'Residential', groups: ['home'] }] },
  { id: 'iot', name: 'IoT', networkType: 'iot', children: [{ id: 'iot-enterprise', name: 'Enterprise IoT', groups: ['enterprise'] }] },
  { id: 'none', name: 'Non-telco', networkType: 'none', children: [
    { id: 'entertainment', name: 'Entertainment', groups: ['video'] }, { id: 'goods', name: 'Physical goods', groups: ['electronics', 'appliances', 'smart-home'] }] },
] as const;

/** Every SKU the demo catalog sells, with the stock a warehouse and a store start the demo with. */
export const DEMO_SKUS: Array<{ sku: string; warehouse: number; store: number }> = [
  { sku: 'PHONE-X1-128', warehouse: 600, store: 40 }, { sku: 'PHONE-X1-128-SLV', warehouse: 300, store: 20 }, { sku: 'PHONE-X1-256', warehouse: 300, store: 20 },
  { sku: 'PHONE-PRO-256', warehouse: 400, store: 25 }, { sku: 'TABLET-T1', warehouse: 300, store: 15 }, { sku: 'WATCH-L1', warehouse: 300, store: 20 },
  { sku: 'ONT-ROUTER', warehouse: 800, store: 0 }, { sku: 'MESH-WIFI', warehouse: 300, store: 15 }, { sku: 'SPEAKER-S1', warehouse: 300, store: 15 },
  { sku: 'TOASTER-T1', warehouse: 150, store: 8 }, { sku: 'FRIDGE-F1', warehouse: 60, store: 3 },
];
const PHONE_VARIANTS = [
  { id: 'black-128', colour: 'Black', storage: '128GB', sku: 'PHONE-X1-128' },
  { id: 'silver-128', colour: 'Silver', storage: '128GB', sku: 'PHONE-X1-128-SLV' },
  { id: 'black-256', colour: 'Black', storage: '256GB', sku: 'PHONE-X1-256', priceDeltaMinor: 10000 },
];

/**
 * Builds the demo catalog (about 30 offers across mobile plans, family plans, devices, tablets, fibre, add-ons, entertainment, goods and IoT) and tops up the
 * stock of the goods it sells at every warehouse and active store. Refuses when the catalog already has nodes: empty it first.
 */
export async function seedDemoCatalog(db: Db, actor: string): Promise<{ nodes: number; offers: number; stockRows: number }> {
  if ((await db.query('SELECT 1 FROM catalog_nodes LIMIT 1')).rows.length) throw rejected('The catalog is not empty. Empty it first.');
  const regional = await getRegional(db);
  const market = (await marketMode(db)).default;
  const cur = (regional as { currency?: string }).currency ?? 'SGD';
  const m = (amountMinor: number): Money => ({ amountMinor, currency: cur });
  const rec = (a: number) => ({ type: 'RECURRING' as const, amount: m(a), periodMonths: 1, taxInclusive: true });
  const once = (a: number) => ({ type: 'ONE_TIME' as const, amount: m(a), taxInclusive: true });
  const ful = (o: Partial<OfferNode['fulfilment']> = {}) => ({ requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [] as string[], ...o });
  const subsidy = (retail: number, sub: number) => ({ deviceRetailPrice: m(retail), subsidyAmount: m(sub) });
  const sim = { requiresSimActivation: true };
  const base = { status: 'ACTIVE' as const, markets: [market], parentId: null };

  const OFFERS: OfferSeed[] = [
    // SIM only
    { id: 'dm-lite-20', group: 'sim-only', name: 'Lite 20GB SIM-only', kind: 'SIM_ONLY', prices: [rec(1800), once(500)], contract: { termMonths: 0 }, fulfilment: ful(sim), description: 'No contract. 20GB of 5G data, unlimited local calls and SMS.' },
    { id: 'dm-plus-60', group: 'sim-only', name: 'Plus 60GB SIM-only', kind: 'SIM_ONLY', prices: [rec(2800), once(500)], contract: { termMonths: 0 }, fulfilment: ful(sim), description: 'No contract. 60GB of 5G data.' },
    { id: 'dm-max-150', group: 'sim-only', name: 'Max 150GB SIM-only (12 mo)', kind: 'SIM_ONLY', prices: [rec(3800), once(0)], contract: { termMonths: 12, etc: { method: 'REMAINING_RECURRING_PERCENT', percentOfRemaining: 30 } }, fulfilment: ful(sim), description: '12-month contract with no SIM fee.' },
    { id: 'dm-unlimited', group: 'sim-only', name: 'Unlimited 5G SIM-only (24 mo)', kind: 'SIM_ONLY', prices: [rec(5500), once(0)], contract: { termMonths: 24, etc: { method: 'REMAINING_RECURRING_PERCENT', percentOfRemaining: 40 } }, fulfilment: ful(sim), description: 'Unlimited data, 24-month contract.' },
    // family
    { id: 'dm-family-member', group: 'family', name: 'Family Member line', kind: 'SIM_ONLY', prices: [rec(1500), once(0)], contract: { termMonths: 0 }, fulfilment: ful(sim), description: 'A line that joins a Family Plan and shares its data.' },
    { id: 'dm-family-150', group: 'family', name: 'Family Plan 150GB (shared)', kind: 'SIM_ONLY', prices: [rec(9900), once(1000)], contract: { termMonths: 0 }, fulfilment: ful(sim),
      terms: { isGroupOffer: true, maxGroupMembers: 4, allowedMemberOfferIds: ['dm-family-member'], sharedPoolQuotaGb: 150 }, description: 'The family head plus up to 4 member lines sharing 150GB.' },
    // phone plans
    { id: 'dm-phone-12', group: 'device', name: '5G Plan + Phone X1 (12 mo)', kind: 'SIM_DEVICE', prices: [rec(8800), once(49900)], skuVariants: true,
      contract: { termMonths: 12, etc: { method: 'SUBSIDY_AMORTISED', waiveInLastMonths: 1 }, subsidy: subsidy(120000, 70100) }, fulfilment: ful({ requiresShipping: true, ...sim, inventorySkus: ['PHONE-X1-128'] }) },
    { id: 'dm-phone-24', group: 'device', name: '5G Plan + Phone X1 (24 mo)', kind: 'SIM_DEVICE', prices: [rec(6800), once(29900)], skuVariants: true,
      contract: { termMonths: 24, etc: { method: 'SUBSIDY_AMORTISED', waiveInLastMonths: 1 }, subsidy: subsidy(120000, 90100) }, fulfilment: ful({ requiresShipping: true, ...sim, inventorySkus: ['PHONE-X1-128'] }) },
    { id: 'dm-phone-36', group: 'device', name: '5G Plan + Phone X1 (36 mo)', kind: 'SIM_DEVICE', prices: [rec(5800), once(0)], skuVariants: true,
      contract: { termMonths: 36, etc: { method: 'SUBSIDY_AMORTISED', capSubsidyFraction: 1 }, subsidy: subsidy(120000, 120000) }, fulfilment: ful({ requiresShipping: true, ...sim, inventorySkus: ['PHONE-X1-128'] }) },
    { id: 'dm-pro-24', group: 'device', name: '5G Plan + Phone Pro 256GB (24 mo)', kind: 'SIM_DEVICE', prices: [rec(9800), once(59900)],
      contract: { termMonths: 24, etc: { method: 'SUBSIDY_AMORTISED', waiveInLastMonths: 1 }, subsidy: subsidy(189900, 110000) }, fulfilment: ful({ requiresShipping: true, ...sim, inventorySkus: ['PHONE-PRO-256'] }) },
    { id: 'dm-pro-36', group: 'device', name: '5G Plan + Phone Pro 256GB (36 mo)', kind: 'SIM_DEVICE', prices: [rec(8800), once(29900)],
      contract: { termMonths: 36, etc: { method: 'SUBSIDY_AMORTISED', capSubsidyFraction: 1 }, subsidy: subsidy(189900, 140000) }, fulfilment: ful({ requiresShipping: true, ...sim, inventorySkus: ['PHONE-PRO-256'] }) },
    // tablet and wearable
    { id: 'dm-tablet-24', group: 'tablet', name: '5G Tablet T1 + Data (24 mo)', kind: 'SIM_DEVICE', prices: [rec(4500), once(19900)],
      contract: { termMonths: 24, etc: { method: 'SUBSIDY_AMORTISED', waiveInLastMonths: 1 }, subsidy: subsidy(69900, 50000) }, fulfilment: ful({ requiresShipping: true, ...sim, inventorySkus: ['TABLET-T1'] }) },
    { id: 'dm-watch-lte', group: 'wearable', name: 'Smart Watch LTE (12 mo)', kind: 'WEARABLE', prices: [rec(1200), once(15900)],
      contract: { termMonths: 12, etc: { method: 'SUBSIDY_AMORTISED' }, subsidy: subsidy(45900, 30000) }, fulfilment: ful({ requiresShipping: true, ...sim, inventorySkus: ['WATCH-L1'] }) },
    // fibre
    { id: 'dm-fibre-300', group: 'home', name: 'Home Fibre 300 Mbps (12 mo)', kind: 'FIBER', prices: [rec(2900), once(5000)],
      contract: { termMonths: 12, etc: { method: 'REMAINING_RECURRING_PERCENT', percentOfRemaining: 50 } }, fulfilment: ful({ requiresInstallation: true, inventorySkus: ['ONT-ROUTER'] }) },
    { id: 'dm-fibre-1g', group: 'home', name: 'Home Fibre 1 Gbps (24 mo)', kind: 'FIBER', prices: [rec(4900), once(5000)],
      contract: { termMonths: 24, etc: { method: 'REMAINING_RECURRING_PERCENT', percentOfRemaining: 50 } }, fulfilment: ful({ requiresInstallation: true, inventorySkus: ['ONT-ROUTER'] }) },
    { id: 'dm-fibre-2g', group: 'home', name: 'Home Fibre 2 Gbps (24 mo)', kind: 'FIBER', prices: [rec(8900), once(0)],
      contract: { termMonths: 24, etc: { method: 'REMAINING_RECURRING_PERCENT', percentOfRemaining: 50 } }, fulfilment: ful({ requiresInstallation: true, inventorySkus: ['ONT-ROUTER'] }) },
    // add-ons
    { id: 'dm-roaming', group: 'addons', name: 'Roaming Pass Asia', kind: 'VAS', prices: [rec(1500)], contract: { termMonths: 0 }, fulfilment: ful() },
    { id: 'dm-extra-data', group: 'addons', name: 'Extra Data 20GB', kind: 'VAS', prices: [rec(800)], contract: { termMonths: 0 }, fulfilment: ful() },
    { id: 'dm-intl-calls', group: 'addons', name: 'International Calls Pack', kind: 'VAS', prices: [rec(1000)], contract: { termMonths: 0 }, fulfilment: ful() },
    { id: 'dm-device-care', group: 'insurance', name: 'Device Care (insurance)', kind: 'VAS', prices: [rec(900)], contract: { termMonths: 0 }, fulfilment: ful(), requires: ['grp-device'], description: 'Accidental damage cover. Needs a phone plan with a device.' },
    // entertainment
    { id: 'dm-netflix', group: 'video', name: 'Netflix Premium', kind: 'NON_TELCO_SUBSCRIPTION', partnerCode: 'netflix', prices: [rec(1999)], contract: { termMonths: 0 }, fulfilment: ful() },
    { id: 'dm-youtube', group: 'video', name: 'YouTube Premium', kind: 'NON_TELCO_SUBSCRIPTION', partnerCode: 'youtube', prices: [rec(1399)], contract: { termMonths: 0 }, fulfilment: ful() },
    // goods
    { id: 'dm-good-phone', group: 'electronics', name: 'Phone X1 128GB (outright)', kind: 'PHYSICAL_GOOD', prices: [once(99900)], skuVariants: true, fulfilment: ful({ requiresShipping: true, inventorySkus: ['PHONE-X1-128'] }) },
    { id: 'dm-good-pro', group: 'electronics', name: 'Phone Pro 256GB (outright)', kind: 'PHYSICAL_GOOD', prices: [once(189900)], fulfilment: ful({ requiresShipping: true, inventorySkus: ['PHONE-PRO-256'] }) },
    { id: 'dm-good-tablet', group: 'electronics', name: 'Tablet T1 (outright)', kind: 'PHYSICAL_GOOD', prices: [once(69900)], fulfilment: ful({ requiresShipping: true, inventorySkus: ['TABLET-T1'] }) },
    { id: 'dm-good-toaster', group: 'appliances', name: 'Smart Toaster T1', kind: 'PHYSICAL_GOOD', prices: [once(5900)], fulfilment: ful({ requiresShipping: true, inventorySkus: ['TOASTER-T1'] }) },
    { id: 'dm-good-fridge', group: 'appliances', name: 'Smart Refrigerator F1', kind: 'PHYSICAL_GOOD', prices: [once(129900)], fulfilment: ful({ requiresShipping: true, inventorySkus: ['FRIDGE-F1'] }) },
    { id: 'dm-good-speaker', group: 'smart-home', name: 'Smart Speaker S1', kind: 'PHYSICAL_GOOD', prices: [once(12900)], fulfilment: ful({ requiresShipping: true, inventorySkus: ['SPEAKER-S1'] }) },
    { id: 'dm-good-mesh', group: 'smart-home', name: 'Mesh Wi-Fi Kit (2 pack)', kind: 'PHYSICAL_GOOD', prices: [once(24900)], fulfilment: ful({ requiresShipping: true, inventorySkus: ['MESH-WIFI'] }) },
    // IoT
    { id: 'dm-iot', group: 'enterprise', name: 'IoT Connectivity (per device)', kind: 'IOT_CONNECTIVITY', prices: [rec(150)], contract: { termMonths: 0 }, fulfilment: ful() },
  ];
  const PLAN = (data: number) => [
    { name: '5G SIM card', itemType: 'SIM', quantity: 1, unit: 'SIM' }, { name: '5G data', itemType: 'DATA', quantity: data, unit: 'GB' },
    { name: 'Local calls', itemType: 'VOICE', unlimited: true }, { name: 'Local SMS', itemType: 'SMS', unlimited: true },
  ] as Array<{ name: string; itemType: string; quantity?: number; unit?: string; unlimited?: boolean; description?: string }>;
  const device = (name: string) => ({ name, itemType: 'DEVICE', quantity: 1, unit: 'unit' });
  const LINE_ITEMS: Record<string, ReturnType<typeof PLAN>> = {
    'dm-lite-20': PLAN(20), 'dm-plus-60': PLAN(60), 'dm-max-150': PLAN(150), 'dm-unlimited': PLAN(999),
    'dm-phone-12': [...PLAN(100), device('Phone X1')], 'dm-phone-24': [...PLAN(100), device('Phone X1')], 'dm-phone-36': [...PLAN(100), device('Phone X1')],
    'dm-pro-24': [...PLAN(200), device('Phone Pro 256GB')], 'dm-pro-36': [...PLAN(200), device('Phone Pro 256GB')], 'dm-tablet-24': [...PLAN(80).slice(0, 2), device('Tablet T1')],
    'dm-watch-lte': [device('Smart Watch LTE'), { name: 'Shared mobile number', itemType: 'SERVICE' }],
    'dm-fibre-300': [{ name: 'Home Fibre 300 Mbps line', itemType: 'SERVICE' }, device('ONT + Wi-Fi router'), { name: 'Professional installation', itemType: 'SERVICE' }],
    'dm-fibre-1g': [{ name: 'Home Fibre 1 Gbps line', itemType: 'SERVICE' }, device('ONT + Wi-Fi router'), { name: 'Professional installation', itemType: 'SERVICE' }],
    'dm-fibre-2g': [{ name: 'Home Fibre 2 Gbps line', itemType: 'SERVICE' }, device('ONT + Wi-Fi router'), { name: 'Professional installation', itemType: 'SERVICE' }],
    'dm-roaming': [{ name: 'Roaming data in Asia', itemType: 'DATA', quantity: 5, unit: 'GB' }], 'dm-extra-data': [{ name: 'Extra data', itemType: 'DATA', quantity: 20, unit: 'GB' }],
    'dm-device-care': [{ name: 'Accidental damage cover', itemType: 'SERVICE', description: 'Repair or replacement of the covered device' }],
    'dm-netflix': [{ name: 'Netflix Premium', itemType: 'CONTENT', description: '4 screens, Ultra HD' }],
  };

  let nodes = 0;
  await db.tx(async (q) => {
    const groupPath = new Map<string, string>();
    for (const n of TREE) {
      await createNode(q, { ...base, id: n.id, level: 'NETWORK_TYPE', code: n.id, name: n.name, path: n.id, networkType: n.networkType } as never, actor); nodes++;
      for (const c of n.children) {
        const cid = `${n.id}-${c.id}`;
        await createNode(q, { ...base, id: cid, level: 'CATEGORY', code: c.id, name: c.name, path: `${n.id}/${c.id}`, parentId: n.id } as never, actor); nodes++;
        for (const g of c.groups) {
          await createNode(q, { ...base, id: `grp-${g}`, level: 'GROUP', code: g, name: g.replace(/-/g, ' ').replace(/^./, (x) => x.toUpperCase()), path: `${n.id}/${c.id}/${g}`, parentId: cid } as never, actor); nodes++;
          groupPath.set(g, `${n.id}/${c.id}/${g}`);
        }
      }
    }
    for (const o of OFFERS) {
      await createNode(q, { ...base, id: o.id, level: 'OFFER', code: o.id, name: o.name, path: `${groupPath.get(o.group)!}/${o.id}`, parentId: `grp-${o.group}`, kind: o.kind, prices: o.prices,
        contract: o.contract, fulfilment: o.fulfilment, partnerCode: o.partnerCode, description: o.description, characteristics: {}, requires: o.requires ?? [], excludes: [],
        group: o.terms, variants: o.skuVariants ? PHONE_VARIANTS : [], deals: o.id === 'dm-good-phone' ? [{ termMonths: 12, subsidyMinor: 20000, waiveInLastMonths: 1 }, { termMonths: 24, subsidyMinor: 40000, waiveInLastMonths: 1 }] : [] } as never, actor); nodes++;
    }
    for (const [offerId, items] of Object.entries(LINE_ITEMS)) {
      for (const [i, it] of items.entries()) {
        await createNode(q, { ...base, id: `${offerId}-i${i + 1}`, level: 'LINE_ITEM', code: `${offerId}-i${i + 1}`, name: it.name, path: '', parentId: offerId, itemType: it.itemType, description: it.description,
          quantity: it.quantity, unit: it.unit, unlimited: it.unlimited, markets: [] } as never, actor); nodes++;
      }
    }
  });

  // stock: every warehouse and active store ends up with at least the starting quantity of every SKU the catalog sells
  let stockRows = 0;
  const places = [
    ...(await db.query(`SELECT id, 'W' AS k FROM warehouses WHERE status = 'ACTIVE'`)).rows,
    ...(await db.query(`SELECT id, 'S' AS k FROM stores WHERE status = 'ACTIVE'`)).rows,
  ];
  for (const p of places) {
    for (const s of DEMO_SKUS) {
      const want = p.k === 'W' ? s.warehouse : s.store;
      if (want <= 0) continue;
      const have = Number((await db.query('SELECT on_hand FROM inventory_stock WHERE location_id=$1 AND sku=$2', [p.id, s.sku])).rows[0]?.onHand ?? 0);
      if (have < want) { await adjustStock(db, p.id as string, s.sku, want - have); stockRows++; }
    }
  }
  await audit(db, actor, 'catalog', 'demo', 'SEED_DEMO_CATALOG', { nodes, offers: OFFERS.length, stockRows });
  return { nodes, offers: OFFERS.length, stockRows };
}
