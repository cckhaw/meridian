import type { OfferNode } from '@meridian/types';
import { createNode } from './catalog.js';
import { runBillCycle, payInvoice, runDunning } from './billing.js';
import { createCustomer } from './customers.js';
import { createGroup } from './groups.js';
import type { Db } from './db.js';
import { addDays, dayOf, today } from './dates.js';
import { adjustStock } from './inventory.js';
import { placeOrder } from './orders.js';
import { createCase } from './cases.js';
import { createAgent, createDealer } from './dealers.js';

const sgd = (amountMinor: number) => ({ amountMinor, currency: 'SGD' as const });
const base = { status: 'ACTIVE' as const, markets: ['SG'], parentId: null };

type OfferSeed = Pick<OfferNode, 'id' | 'name' | 'kind' | 'prices' | 'fulfilment'> & Partial<Pick<OfferNode, 'contract' | 'partnerCode' | 'requires' | 'excludes' | 'description'>> & { group: string };
const ful = (o: Partial<OfferNode['fulfilment']> = {}) => ({ requiresShipping: false, requiresInstallation: false, requiresSimActivation: false, inventorySkus: [], ...o });
const rec = (amt: number) => ({ type: 'RECURRING' as const, amount: sgd(amt), periodMonths: 1, taxInclusive: true });
const PHONE_VARIANTS = [
  { id: 'black-128', colour: 'Black', storage: '128GB', sku: 'PHONE-X1-128' },
  { id: 'silver-128', colour: 'Silver', storage: '128GB', sku: 'PHONE-X1-128-SLV' },
  { id: 'black-256', colour: 'Black', storage: '256GB', sku: 'PHONE-X1-256', priceDeltaMinor: 10000 },
];
const once = (amt: number) => ({ type: 'ONE_TIME' as const, amount: sgd(amt), taxInclusive: true });

const OFFERS: OfferSeed[] = [
  { id: 'plan-sim-5g', group: 'sim-only', name: '5G SIM-only 100GB', kind: 'SIM_ONLY', prices: [rec(3500), once(1000)], contract: { termMonths: 0 }, fulfilment: ful({ requiresSimActivation: true }), description: 'No contract. Includes 100GB 5G data and unlimited calls.' },
  { id: 'plan-phone-12', group: 'device', name: '5G Plan + Phone (12 mo)', kind: 'SIM_DEVICE', prices: [rec(8800), once(49900)],
    contract: { termMonths: 12, etc: { method: 'SUBSIDY_AMORTISED', waiveInLastMonths: 1 }, subsidy: { deviceRetailPrice: sgd(120000), subsidyAmount: sgd(70100) } }, fulfilment: ful({ requiresShipping: true, requiresSimActivation: true, inventorySkus: ['PHONE-X1-128'] }) },
  { id: 'plan-phone-24', group: 'device', name: '5G Plan + Phone (24 mo)', kind: 'SIM_DEVICE', prices: [rec(6800), once(29900)],
    contract: { termMonths: 24, etc: { method: 'SUBSIDY_AMORTISED', waiveInLastMonths: 1 }, subsidy: { deviceRetailPrice: sgd(120000), subsidyAmount: sgd(90100) } }, fulfilment: ful({ requiresShipping: true, requiresSimActivation: true, inventorySkus: ['PHONE-X1-128'] }) },
  { id: 'plan-phone-36', group: 'device', name: '5G Plan + Phone (36 mo)', kind: 'SIM_DEVICE', prices: [rec(5800), once(0)],
    contract: { termMonths: 36, etc: { method: 'SUBSIDY_AMORTISED', capSubsidyFraction: 1 }, subsidy: { deviceRetailPrice: sgd(120000), subsidyAmount: sgd(120000) } }, fulfilment: ful({ requiresShipping: true, requiresSimActivation: true, inventorySkus: ['PHONE-X1-128'] }) },
  { id: 'watch-lte', group: 'wearable', name: 'Smart Watch LTE (12 mo)', kind: 'WEARABLE', prices: [rec(1200), once(15900)],
    contract: { termMonths: 12, etc: { method: 'SUBSIDY_AMORTISED' }, subsidy: { deviceRetailPrice: sgd(45900), subsidyAmount: sgd(30000) } }, fulfilment: ful({ requiresShipping: true, requiresSimActivation: true, inventorySkus: ['WATCH-L1'] }) },
  { id: 'fiber-1g', group: 'home', name: 'Home Fibre 1 Gbps (24 mo)', kind: 'FIBER', prices: [rec(4900), once(5000)],
    contract: { termMonths: 24, etc: { method: 'REMAINING_RECURRING_PERCENT', percentOfRemaining: 50 } }, fulfilment: ful({ requiresInstallation: true, inventorySkus: ['ONT-ROUTER'] }) },
  { id: 'device-care', group: 'insurance', name: 'Device Care (insurance)', kind: 'VAS', prices: [rec(900)], contract: { termMonths: 0 }, fulfilment: ful(), requires: ['grp-device'], description: 'Accidental damage cover. Needs a phone plan with a device, bought together or already owned.' },
  { id: 'vas-roaming', group: 'vas', name: 'Roaming Pass Asia', kind: 'VAS', prices: [rec(1500)], contract: { termMonths: 0 }, fulfilment: ful() },
  { id: 'netflix-premium', group: 'video', name: 'Netflix Premium', kind: 'NON_TELCO_SUBSCRIPTION', partnerCode: 'netflix', prices: [rec(1999)], contract: { termMonths: 0 }, fulfilment: ful() },
  { id: 'youtube-premium', group: 'video', name: 'YouTube Premium', kind: 'NON_TELCO_SUBSCRIPTION', partnerCode: 'youtube', prices: [rec(1399)], contract: { termMonths: 0 }, fulfilment: ful() },
  { id: 'good-phone-outright', group: 'electronics', name: 'Phone X1 128GB (outright)', kind: 'PHYSICAL_GOOD', prices: [once(99900)], fulfilment: ful({ requiresShipping: true, inventorySkus: ['PHONE-X1-128'] }) },
  { id: 'good-toaster', group: 'appliances', name: 'Smart Toaster T1', kind: 'PHYSICAL_GOOD', prices: [once(5900)], fulfilment: ful({ requiresShipping: true, inventorySkus: ['TOASTER-T1'] }) },
  { id: 'good-fridge', group: 'appliances', name: 'Smart Refrigerator F1', kind: 'PHYSICAL_GOOD', prices: [once(129900)], fulfilment: ful({ requiresShipping: true, inventorySkus: ['FRIDGE-F1'] }) },
  { id: 'iot-m2m', group: 'enterprise', name: 'IoT Connectivity (per device)', kind: 'IOT_CONNECTIVITY', prices: [rec(150)], contract: { termMonths: 0 }, fulfilment: ful() },
];

const TREE = [
  { id: 'mobile', level: 'NETWORK_TYPE', name: 'Mobile', networkType: 'mobile', children: [
    { id: 'postpaid', name: 'Postpaid', groups: ['sim-only', 'device', 'insurance', 'vas'] }, { id: 'wearables', name: 'Wearables', groups: ['wearable'] }] },
  { id: 'fiber', level: 'NETWORK_TYPE', name: 'Fibre', networkType: 'fiber', children: [{ id: 'residential', name: 'Residential', groups: ['home'] }] },
  { id: 'iot', level: 'NETWORK_TYPE', name: 'IoT', networkType: 'iot', children: [{ id: 'iot-enterprise', name: 'Enterprise IoT', groups: ['enterprise'] }] },
  { id: 'none', level: 'NETWORK_TYPE', name: 'Non-telco', networkType: 'none', children: [
    { id: 'entertainment', name: 'Entertainment', groups: ['video'] }, { id: 'goods', name: 'Physical goods', groups: ['electronics', 'appliances'] }] },
] as const;

type ItemSeed = { name: string; itemType: string; quantity?: number; unit?: string; unlimited?: boolean; description?: string };
const PLAN: ItemSeed[] = [
  { name: '5G SIM card', itemType: 'SIM', quantity: 1, unit: 'SIM' },
  { name: '5G data', itemType: 'DATA', quantity: 100, unit: 'GB', description: 'Full speed, then 1 Mbps' },
  { name: 'Local calls', itemType: 'VOICE', unlimited: true },
  { name: 'Local SMS', itemType: 'SMS', unlimited: true },
];
/** What each starter offer includes. Descriptive only (no SKUs), so stock behaviour stays with the offers' own fulfilment lists. */
const LINE_ITEMS: Record<string, ItemSeed[]> = {
  'plan-sim-5g': PLAN,
  'plan-phone-12': [...PLAN, { name: 'Phone X1 128GB', itemType: 'DEVICE', quantity: 1, unit: 'unit' }],
  'plan-phone-24': [...PLAN, { name: 'Phone X1 128GB', itemType: 'DEVICE', quantity: 1, unit: 'unit' }],
  'plan-phone-36': [...PLAN, { name: 'Phone X1 128GB', itemType: 'DEVICE', quantity: 1, unit: 'unit' }],
  'watch-lte': [{ name: 'Smart Watch LTE', itemType: 'DEVICE', quantity: 1, unit: 'unit' }, { name: 'Shared mobile number', itemType: 'SERVICE' }],
  'fiber-1g': [{ name: 'Home Fibre 1 Gbps line', itemType: 'SERVICE' }, { name: 'ONT + Wi-Fi router', itemType: 'DEVICE', quantity: 1, unit: 'unit' }, { name: 'Professional installation', itemType: 'SERVICE' }],
  'device-care': [{ name: 'Accidental damage cover', itemType: 'SERVICE', description: 'Repair or replacement of the covered device' }],
  'vas-roaming': [{ name: 'Roaming data in Asia', itemType: 'DATA', quantity: 5, unit: 'GB' }],
  'netflix-premium': [{ name: 'Netflix Premium', itemType: 'CONTENT', description: '4 screens, Ultra HD' }],
};

/** Catalog + stock. Idempotent: does nothing if the catalog already has nodes. */
export async function seedReference(db: Db): Promise<void> {
  if ((await db.query('SELECT 1 FROM catalog_nodes LIMIT 1')).rows.length) return;
  await db.tx(async (q) => {
    const groupParent = new Map<string, string>();
    for (const n of TREE) {
      await createNode(q, { ...base, id: n.id, level: 'NETWORK_TYPE', code: n.id, name: n.name, path: n.id, networkType: n.networkType } as never);
      for (const c of n.children) {
        const cid = `${n.id}-${c.id}`;
        await createNode(q, { ...base, id: cid, level: 'CATEGORY', code: c.id, name: c.name, path: `${n.id}/${c.id}`, parentId: n.id } as never);
        for (const g of c.groups) {
          await createNode(q, { ...base, id: `grp-${g}`, level: 'GROUP', code: g, name: g.replace(/-/g, ' ').replace(/^./, (x) => x.toUpperCase()), path: `${n.id}/${c.id}/${g}`, parentId: cid } as never);
          groupParent.set(g, `${n.id}/${c.id}/${g}`);
        }
      }
    }
    for (const o of OFFERS) {
      const gp = groupParent.get(o.group)!;
      await createNode(q, { ...base, id: o.id, level: 'OFFER', code: o.id, name: o.name, path: `${gp}/${o.id}`, parentId: `grp-${o.group}`, kind: o.kind, prices: o.prices,
        contract: o.contract, fulfilment: o.fulfilment, partnerCode: o.partnerCode, description: o.description, characteristics: {}, requires: o.requires ?? [], excludes: o.excludes ?? [],
        variants: o.fulfilment.inventorySkus.includes('PHONE-X1-128') ? PHONE_VARIANTS : [] } as never);
    }
    for (const [offerId, items] of Object.entries(LINE_ITEMS)) {
      for (const [i, it] of items.entries()) {
        await createNode(q, { ...base, id: `${offerId}-i${i + 1}`, level: 'LINE_ITEM', code: `${offerId}-i${i + 1}`, name: it.name, path: '', parentId: offerId, itemType: it.itemType, description: it.description,
          quantity: it.quantity, unit: it.unit, unlimited: it.unlimited, markets: [] } as never);
      }
    }
    const stock: Array<[string, string, number]> = [
      ['WH-MAIN', 'PHONE-X1-128', 200], ['WH-MAIN', 'WATCH-L1', 100], ['WH-MAIN', 'ONT-ROUTER', 500], ['WH-MAIN', 'TOASTER-T1', 50], ['WH-MAIN', 'FRIDGE-F1', 20],
      ['WH-MAIN', 'PHONE-X1-128-SLV', 100], ['WH-MAIN', 'PHONE-X1-256', 100], ['STORE-SG-001', 'PHONE-X1-128-SLV', 6], ['STORE-SG-001', 'PHONE-X1-256', 6],
      ['STORE-SG-001', 'PHONE-X1-128', 15], ['STORE-SG-001', 'WATCH-L1', 10], ['STORE-SG-001', 'TOASTER-T1', 5], ['STORE-SG-002', 'PHONE-X1-128', 8],
    ];
    for (const [l, s, n] of stock) await adjustStock(q, l, s, n);
    await q.query(`INSERT INTO bundle_rules (id, name, data) VALUES ('fibre-plus-phone', 'Fibre + phone plan: 10% off the phone', $1) ON CONFLICT DO NOTHING`,
      [JSON.stringify({ when: ['kind:FIBER', 'kind:SIM_DEVICE'], target: 'kind:SIM_DEVICE', percentBps: 1000 })]);
  });
}

/** Demo tenants created through the real order/billing code paths, with history backdated so bills, an overdue account and a suspension exist. */
export async function seedDemo(db: Db): Promise<void> {
  if ((await db.query(`SELECT 1 FROM customers WHERE display_name='Tan Wei Ming' LIMIT 1`)).rows.length) return;
  const orbitDealer = await createDealer(db, 'seed', { name: 'Orbit Mobile Partners', contactName: 'Priya Nair', email: 'partners@orbit.example.com' });
  const orbitAgent = await createAgent(db, 'seed', orbitDealer.id as string, { name: 'Marcus Teo', phone: '+6591110000' });
  await createAgent(db, 'seed', orbitDealer.id as string, { name: 'Aisha Rahman', phone: '+6592220000' });
  const retail = { storeId: 'STORE-SG-001', salespersonId: 'agent-lee' };
  const mk = async (name: string, doc: string, extra: Partial<Parameters<typeof createCustomer>[1]> = {}) =>
    (await createCustomer(db, { segment: 'CONSUMER', displayName: name, idDocument: doc, email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`, phone: '+6590000000', ...extra }));

  const wei = await mk('Tan Wei Ming', 'S1234567A');
  await placeOrder(db, { customerId: wei.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CREDIT_CARD' },
    lines: [{ offerId: 'plan-phone-24' }, { offerId: 'netflix-premium' }] });

  // A household as a Group of services on one account: Hui Ling's line is the principal, the family's lines are supplementary and share a data pool and a discount.
  const lim = await mk('Lim Hui Ling', 'S1111111C');
  const limLines: string[] = [];
  for (let n = 0; n < 4; n++) {
    const o = await placeOrder(db, { customerId: lim.customer.id, accountId: lim.account!.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-sim-5g' }] });
    limLines.push((await db.query(`SELECT id FROM services WHERE order_id=$1 LIMIT 1`, [o.id])).rows[0]!.id as string);
  }
  await createGroup(db, 'seed', { accountId: lim.account!.id as string, name: 'Lim household', principalServiceId: limLines[0]!, supplementaryServiceIds: limLines.slice(1),
    benefits: { allowances: { dataGb: 200, voiceMinutes: 3000, smsCount: 1000 }, discountBps: 1000 } });
  await placeOrder(db, { customerId: lim.customer.id, channel: 'TELESALES', attribution: { salespersonId: 'agent-nur' }, payment: { method: 'QR' }, lines: [{ offerId: 'fiber-1g' }] });

  const acme = await mk('Acme Holdings Pte Ltd', 'UEN201912345K', { segment: 'ENTERPRISE' });
  for (const dept of ['Finance', 'Engineering', 'Operations']) {
    const d = await mk(`Acme ${dept}`, 'UEN201912345K', { segment: 'ENTERPRISE', parentCustomerId: acme.customer.id });
    await placeOrder(db, { customerId: d.customer.id, channel: 'DEALER', attribution: { dealerId: orbitDealer.id as string, dealerAgentId: orbitAgent.id as string }, payment: { method: 'INSTALLMENT', installmentMonths: 12 }, lines: [{ offerId: 'plan-phone-12', quantity: 3 }] });
  }
  const orbit = await mk('Orbit Logistics IoT', 'UEN201898765Z', { segment: 'IOT' });
  await placeOrder(db, { customerId: orbit.customer.id, channel: 'CALL_CENTER', payment: { method: 'CASH' }, lines: [{ offerId: 'iot-m2m', quantity: 5000 }] });

  const olivia = await mk('Olivia Ng', 'S4444444F');
  await placeOrder(db, { customerId: olivia.customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-sim-5g' }, { offerId: 'vas-roaming' }] });

  // Quick-sale at the counter (anonymous walk-in)
  await placeOrder(db, { channel: 'QUICK_SALE', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'good-toaster' }] });

  // ── history: pretend the services went live 3 months ago, then run bill cycles ──
  await db.query(`UPDATE services SET activated_at = now() - interval '100 days', contract_start = now() - interval '100 days' WHERE customer_id <> $1`, [wei.customer.id]);
  await db.query(`UPDATE services SET activated_at = now() - interval '40 days', contract_start = now() - interval '40 days' WHERE customer_id = $1`, [wei.customer.id]);
  // Bill cycle days run 1-28, so the demo bills on the nearest earlier day that is one.
  const cycleDay = (d: string) => { while (dayOf(d) > 28) d = addDays(d, -1); return d; };
  const t = today();
  const billDate = cycleDay(t);
  await db.query(`UPDATE accounts SET bill_cycle_day = $1 WHERE customer_id <> $2`, [dayOf(billDate), olivia.customer.id]);
  await runBillCycle(db, billDate); // this month's invoices for everyone (Olivia excluded)
  const oldDate = cycleDay(addDays(t, -45));
  await db.query(`UPDATE accounts SET bill_cycle_day = $1 WHERE customer_id = $2`, [dayOf(oldDate), olivia.customer.id]);
  await runBillCycle(db, oldDate); // Olivia's invoice, issued 45 days ago and never paid
  await runDunning(db, t); // -> overdue, services suspended

  const invs = (await db.query(`SELECT id FROM invoices WHERE status='ISSUED' ORDER BY number LIMIT 4`)).rows;
  for (const i of invs.slice(0, 2)) await payInvoice(db, i.id, { method: 'CREDIT_CARD', reference: 'seed' }, 'seed');
  await createCase(db, { customerId: lim.customer.id, type: 'FIBER_ASSURANCE', subject: 'Intermittent fibre drops in the evening', priority: 'HIGH', note: 'Customer reports 3 drops this week.' }, 'seed');
  await createCase(db, { customerId: wei.customer.id, type: 'BILLING_REFUND', subject: 'Double charge for Netflix', note: 'Customer says Netflix was billed twice.' }, 'seed');
}
