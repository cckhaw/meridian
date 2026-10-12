import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { advanceOrder, cancelOrder, cancellationPreview, getOrder, placeOrder, returnGoods, sweepOrders } from './orders.js';
import { cancellationTerms, eligibleAddons, priceBasket } from './order-pricing.js';
import { reconcile } from './reports.js';
import { stockAt } from './inventory.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const DAY = 86_400_000;
const retail = { storeId: 'STORE-SG-001', salespersonId: 'agent-1' };
const group = (o: any, kind: string) => o.groups.find((g: any) => g.kind === kind);
const later = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const bundleOrder = async (extra: Record<string, unknown> = {}) => {
  const { customer } = await newCustomer(db);
  const o = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, deliveryAddress: '1 Test Road', lines: [{ offerId: 'plan-phone-24' }, { offerId: 'fiber-1g' }, { offerId: 'plan-sim-5g' }], ...extra });
  return { customer, o };
};

describe('an order is fulfilled in independent parts', () => {
  it('splits mobile + shipped device + fibre into activation, goods and installation, each with its own state', async () => {
    const { o } = await bundleOrder();
    expect(o.groups.map((g: any) => g.kind).sort()).toEqual(['ACTIVATION', 'GOODS', 'INSTALL']);
    expect(o.state).toBe('AWAITING_INSTALLATION'); // the long pole decides the headline
    expect(o.nextActions).toEqual(expect.arrayContaining(['schedule_installation', 'ship']));
    // the plain SIM waits for the device: nothing is active yet
    expect(group(o, 'ACTIVATION').status).toBe('PENDING');
    expect(o.serviceCount).toBe(0);
    expect(o.cancellable).toBe(true);
  });

  it('shipping the phone locks only the delivery; fibre and the SIM stay cancellable, and cancelling them leaves the phone', async () => {
    const { o: placed } = await bundleOrder();
    const paidUpfront = (g: string) => placed.lines.filter((l: any) => l.fulfilGroup === g).reduce((s: number, l: any) => s + l.paidNowMinor, 0);
    let o = await advanceOrder(db, placed.id, { type: 'ship' });
    expect(group(o, 'GOODS').status).toBe('LOCKED');
    expect(group(o, 'INSTALL').canCancel).toBe(true);
    expect(group(o, 'ACTIVATION').canCancel).toBe(true);
    expect(group(o, 'GOODS').canCancel).toBe(false);
    expect(group(o, 'GOODS').why).toMatch(/past the point of no return/);
    await expect(cancelOrder(db, placed.id, 'x', 'agent', { groups: ['GOODS'] })).rejects.toThrow(/point of no return/);

    o = await cancelOrder(db, placed.id, 'customer moved house');
    expect(group(o, 'INSTALL').status).toBe('CANCELLED');
    expect(group(o, 'ACTIVATION').status).toBe('CANCELLED');
    expect(group(o, 'GOODS').status).toBe('LOCKED'); // the shipped phone is untouched
    expect(o.state).toBe('SHIPPED');
    // the fibre part is refunded (less the phone's bundle discount, which no longer applies without the fibre)
    const claw = placed.lines.find((l: any) => l.fulfilGroup === 'GOODS').discountMinor;
    expect(claw).toBeGreaterThan(0);
    expect(group(o, 'INSTALL').refundedMinor).toBe(paidUpfront('INSTALL') - claw);
    expect(o.refundedMinor).toBe(paidUpfront('INSTALL') + paidUpfront('ACTIVATION') - claw);
    expect(o.payments[0].status).toBe('CAPTURED'); // only part of the payment came back

    o = await advanceOrder(db, placed.id, { type: 'deliver' });
    expect(o.state).toBe('COMPLETED'); // the phone's own contract line is live; the cancelled parts are not
    expect(o.services.map((s: any) => s.type)).toEqual(['MOBILE']);
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('cancelling before anything ships refunds everything, releases stock and the install slot, and the ledger still balances', async () => {
    const start = await stockAt(db, 'WH-MAIN', 'PHONE-X1-128');
    const { o: placed } = await bundleOrder({ installationSlot: later(5) });
    expect((await stockAt(db, 'WH-MAIN', 'PHONE-X1-128')).reserved).toBe(start.reserved + 1);
    expect(placed.appointments).toHaveLength(1);
    const o = await cancelOrder(db, placed.id, 'changed my mind');
    expect(o.state).toBe('CANCELLED');
    expect(o.payments[0].status).toBe('REFUNDED');
    expect(o.refundedMinor).toBe(placed.totalMinor);
    expect(o.appointments[0].status).toBe('CANCELLED');
    expect(await stockAt(db, 'WH-MAIN', 'PHONE-X1-128')).toEqual(start);
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('a late installation cancellation keeps the call-out fee; the technician being dispatched ends cancellation', async () => {
    const { customer } = await newCustomer(db);
    const placed = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'fiber-1g' }], installationSlot: new Date(Date.now() + 6 * 3_600_000).toISOString() });
    const pol = group(placed, 'INSTALL');
    expect(pol.feeMinor).toBe(5000);
    expect(pol.refundMinor).toBe(0); // the 50.00 installation fee paid upfront equals the call-out fee, so nothing comes back
    const early = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'fiber-1g' }], installationSlot: later(6) });
    expect(group(early, 'INSTALL').feeMinor).toBe(0);
    const cancelled = await cancelOrder(db, early.id, 'x');
    expect(cancelled.refundedMinor).toBe(early.totalMinor);

    let o = await cancelOrder(db, placed.id, 'too late to move it');
    expect(o.state).toBe('CANCELLED');
    expect(o.refundedMinor).toBe(0);
    expect(group(o, 'INSTALL').feeMinor).toBe(5000);

    const fresh = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'fiber-1g' }], installationSlot: later(3) });
    await advanceOrder(db, fresh.id, { type: 'dispatch_technician' });
    await expect(cancelOrder(db, fresh.id, 'x')).rejects.toThrow(/point of no return/);
    o = await advanceOrder(db, fresh.id, { type: 'complete_installation' });
    expect(o.state).toBe('COMPLETED');
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('services activate when the device is delivered, but a SIM bought alone (or with a plain accessory) is live at once', async () => {
    const { customer } = await newCustomer(db);
    const o = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, deliveryAddress: 'x', lines: [{ offerId: 'plan-sim-5g' }] });
    expect(o.state).toBe('COMPLETED');
    expect(o.serviceCount).toBe(1);
    const withToaster = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, deliveryAddress: 'x', lines: [{ offerId: 'netflix-premium' }, { offerId: 'good-phone-outright' }] });
    expect(group(withToaster, 'ACTIVATION').status).toBe('DONE'); // an outright accessory carries no contract, so the subscription does not wait
    expect(withToaster.services.map((s: any) => s.type)).toEqual(['SUBSCRIPTION']);
    expect(group(withToaster, 'ACTIVATION').canCancel).toBe(false);
    expect(group(withToaster, 'GOODS').canCancel).toBe(true);
    const half = await cancelOrder(db, withToaster.id, 'no phone after all');
    expect(group(half, 'GOODS').status).toBe('CANCELLED');
    expect(half.state).toBe('COMPLETED'); // the subscription stands
  });
});

describe('returns and the installation service level', () => {
  it('delivered goods can be returned in the cooling-off period (refund less a deduction, stock back, contract ends without a charge), not after', async () => {
    const { customer } = await newCustomer(db);
    const stock = await stockAt(db, 'WH-MAIN', 'PHONE-X1-128');
    const placed = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-phone-24' }] });
    await expect(returnGoods(db, placed.id, { reason: 'x' })).rejects.toThrow(/not been delivered/);
    await advanceOrder(db, placed.id, { type: 'ship' });
    let o = await advanceOrder(db, placed.id, { type: 'deliver' });
    expect(o.state).toBe('COMPLETED');
    expect(group(o, 'GOODS').returnable).toBe(true);
    expect((await stockAt(db, 'WH-MAIN', 'PHONE-X1-128')).onHand).toBe(stock.onHand - 1);
    o = await returnGoods(db, placed.id, { reason: 'does not fit my hand', deductionMinor: 2000 });
    expect(group(o, 'GOODS').status).toBe('RETURNED');
    expect(group(o, 'GOODS').refundedMinor).toBe(placed.totalMinor - 2000);
    expect(o.services[0].status).toBe('TERMINATED');
    expect((await stockAt(db, 'WH-MAIN', 'PHONE-X1-128')).onHand).toBe(stock.onHand);
    await expect(returnGoods(db, placed.id, { reason: 'again' })).rejects.toThrow(/already returned/);
    expect((await reconcile(db)).ok).toBe(true);

    const old = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-phone-24' }] });
    await advanceOrder(db, old.id, { type: 'ship' }); await advanceOrder(db, old.id, { type: 'deliver' });
    await db.query(`UPDATE order_groups SET done_at = now() - interval '15 days' WHERE order_id=$1 AND kind='GOODS'`, [old.id]);
    await expect(returnGoods(db, old.id, { reason: 'late' })).rejects.toThrow(/return period has ended/);
  });

  it('flags an installation at risk after 14 days and cancels it with a full refund after 21, even inside the late-cancel window', async () => {
    const { customer } = await newCustomer(db);
    const placed = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'fiber-1g' }] });
    expect(await sweepOrders(db, new Date(Date.now() + 10 * DAY))).toEqual({ atRisk: 0, cancelled: 0 });
    expect((await sweepOrders(db, new Date(Date.now() + 15 * DAY))).atRisk).toBeGreaterThanOrEqual(1);
    expect(group(await getOrder(db, placed.id), 'INSTALL').atRisk).toBe(true);
    await advanceOrder(db, placed.id, { type: 'schedule_installation', slot: later(1) }); // a visit tomorrow would normally cost a call-out fee to cancel
    const swept = await sweepOrders(db, new Date(Date.now() + 22 * DAY));
    expect(swept.cancelled).toBeGreaterThanOrEqual(1);
    const o = await getOrder(db, placed.id);
    expect(o.state).toBe('CANCELLED');
    expect(o.refundedMinor).toBe(placed.totalMinor);
    expect(o.history.some((h: any) => /cancel and refund after 21 days/.test(h.reason ?? ''))).toBe(true);
  });

  it('never auto-cancels an installation that has been dispatched', async () => {
    const { customer } = await newCustomer(db);
    const placed = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'fiber-1g' }], installationSlot: later(2) });
    await advanceOrder(db, placed.id, { type: 'dispatch_technician' });
    await sweepOrders(db, new Date(Date.now() + 30 * DAY));
    expect((await getOrder(db, placed.id)).state).toBe('AWAITING_INSTALLATION');
  });

  it('a retail counter sale is handed over at once: nothing to cancel, but returnable', async () => {
    const { customer } = await newCustomer(db);
    const o = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH', confirmed: true, reference: 'R1' }, lines: [{ offerId: 'plan-phone-24' }] });
    expect(o.state).toBe('COMPLETED');
    expect(o.cancellable).toBe(false);
    expect(group(o, 'GOODS').returnable).toBe(true);
    const r = await returnGoods(db, o.id, { reason: 'changed mind' }, 'agent-1');
    expect(r.refundedMinor).toBe(o.totalMinor);
  });
});

describe('payment structure, variants and bundles', () => {
  it('lets each line be paid upfront or by instalments with a down payment, and shows the same numbers it will charge', async () => {
    const { customer } = await newCustomer(db);
    const input = { customerId: customer.id, channel: 'SELF_SERVE' as const, payment: { method: 'CREDIT_CARD' as const }, lines: [{ offerId: 'plan-phone-24', payment: { mode: 'INSTALLMENT' as const, months: 12, downPaymentMinor: 5000 } }, { offerId: 'device-care' }] };
    const q = await priceBasket(db, input);
    expect(q.dueNow).toBe(5000);
    expect(q.lines[0]).toMatchObject({ payMode: 'INSTALLMENT', financed: 24900, instalmentMinor: 2075, monthlyFeeMinor: 6800 });
    expect(q.monthlyInstalmentMinor).toBe(2075);
    const o = await placeOrder(db, input);
    expect(o.totalMinor).toBe(5000);
    expect(o.payments[0].amountMinor).toBe(5000);
    await advanceOrder(db, o.id, { type: 'ship' });
    const done = await advanceOrder(db, o.id, { type: 'deliver' });
    expect(done.state).toBe('COMPLETED');
    const charges = (await db.query(`SELECT amount_minor, remaining_cycles FROM service_charges WHERE service_id = ANY($1)`, [done.services.map((s: any) => s.id)])).rows;
    expect(charges.reduce((s, c) => s + c.amountMinor * c.remainingCycles, 0)).toBe(24900);
    expect((await reconcile(db)).ok).toBe(true);
    // cancelling a financed line refunds only the down payment
    const again = await placeOrder(db, input);
    const c = await cancelOrder(db, again.id, 'x');
    expect(c.refundedMinor).toBe(5000);
  });

  it('rejects structures that make no sense', async () => {
    const { customer } = await newCustomer(db);
    const base = { customerId: customer.id, channel: 'SELF_SERVE' as const, payment: { method: 'CREDIT_CARD' as const } };
    const fin = (months: number, down = 0, offerId = 'plan-phone-24') => priceBasket(db, { ...base, lines: [{ offerId, payment: { mode: 'INSTALLMENT', months, downPaymentMinor: down } }] });
    await expect(fin(36)).rejects.toThrow(/longer than the 24-month contract/);
    await expect(fin(12, 29900)).rejects.toThrow(/down payment/);
    await expect(fin(5)).rejects.toThrow(/instalment months/);
    await expect(fin(12, 0, 'good-phone-outright')).rejects.toThrow(/no service to bill/);
  });

  it('finances several units at once: each carries its share, and the shares add up exactly', async () => {
    const { customer } = await newCustomer(db);
    const o = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'INSTALLMENT', installmentMonths: 12 }, lines: [{ offerId: 'plan-phone-12', quantity: 3 }] });
    expect(o.totalMinor).toBe(0);
    await advanceOrder(db, o.id, { type: 'ship' });
    const done = await advanceOrder(db, o.id, { type: 'deliver' });
    expect(done.serviceCount).toBe(3);
    const charges = (await db.query(`SELECT c.amount_minor, c.remaining_cycles FROM service_charges c JOIN services s ON s.id = c.service_id WHERE s.order_id=$1`, [o.id])).rows;
    expect(charges.reduce((s, c) => s + c.amountMinor * c.remainingCycles, 0)).toBe(o.lines[0].netMinor + o.lines[0].taxMinor);
  });

  it('prices and reserves the chosen colour and storage', async () => {
    const { customer } = await newCustomer(db);
    const silver = await stockAt(db, 'WH-MAIN', 'PHONE-X1-128-SLV');
    const big = await stockAt(db, 'WH-MAIN', 'PHONE-X1-256');
    const base = { customerId: customer.id, channel: 'SELF_SERVE' as const, payment: { method: 'CREDIT_CARD' as const } };
    const a = await placeOrder(db, { ...base, lines: [{ offerId: 'plan-phone-24', options: { variantId: 'silver-128' } }] });
    expect(a.lines[0].options).toMatchObject({ colour: 'Silver', storage: '128GB', sku: 'PHONE-X1-128-SLV' });
    expect((await stockAt(db, 'WH-MAIN', 'PHONE-X1-128-SLV')).reserved).toBe(silver.reserved + 1);
    const b = await priceBasket(db, { ...base, lines: [{ offerId: 'plan-phone-24', options: { variantId: 'black-256' } }] });
    expect(b.dueNow).toBe(29900 + 10000);
    const c = await placeOrder(db, { ...base, lines: [{ offerId: 'plan-phone-24', options: { variantId: 'black-256' } }] });
    expect((await stockAt(db, 'WH-MAIN', 'PHONE-X1-256')).reserved).toBe(big.reserved + 1);
    await cancelOrder(db, a.id, 'x'); await cancelOrder(db, c.id, 'x');
    expect(await stockAt(db, 'WH-MAIN', 'PHONE-X1-128-SLV')).toEqual(silver);
    await expect(priceBasket(db, { ...base, lines: [{ offerId: 'plan-phone-24', options: { variantId: 'gold-1tb' } }] })).rejects.toThrow(/choose one of/);
    await expect(priceBasket(db, { ...base, lines: [{ offerId: 'plan-sim-5g', options: { variantId: 'x' } }] })).rejects.toThrow(/no colour or storage options/);
  });

  it('applies the bundle discount when the bundle is complete and shows it as its own figure', async () => {
    const { customer } = await newCustomer(db);
    const base = { customerId: customer.id, channel: 'SELF_SERVE' as const, payment: { method: 'CREDIT_CARD' as const } };
    const alone = await priceBasket(db, { ...base, lines: [{ offerId: 'plan-phone-24' }] });
    const both = await priceBasket(db, { ...base, lines: [{ offerId: 'plan-phone-24' }, { offerId: 'fiber-1g' }] });
    expect(alone.discountMinor).toBe(0);
    expect(both.discountMinor).toBe(2990);
    expect(both.bundles).toEqual([expect.objectContaining({ ruleId: 'fibre-plus-phone', discountMinor: 2990 })]);
    expect(both.lines[0]!.gross).toBe(29900 - 2990);
    expect(both.dueNow).toBe(alone.dueNow - 2990 + 5000);
  });

  it('quotes with problems instead of failing, and offers only add-ons the customer can actually buy', async () => {
    const { customer } = await newCustomer(db);
    const q = await priceBasket(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'device-care' }] }, { soft: true });
    expect(q.problems.join(' ')).toMatch(/requires any Device offer/);
    const without = await eligibleAddons(db, { customerId: customer.id, offerIds: ['plan-sim-5g'], channel: 'SELF_SERVE', marketCode: 'SG' });
    expect(without.items.map((i) => i.offer.id)).not.toContain('device-care');
    const withPhone = await eligibleAddons(db, { customerId: customer.id, offerIds: ['plan-phone-24'], channel: 'SELF_SERVE', marketCode: 'SG' });
    expect(withPhone.items.map((i) => i.offer.id)).toContain('device-care');
    expect(withPhone.items.map((i) => i.offer.id)).not.toContain('plan-phone-24');
  });

  it('explains the cancellation terms per part in words', async () => {
    const t = await cancellationTerms(db, ['GOODS', 'INSTALL', 'ACTIVATION'], 'SGD');
    expect(t.find((x) => x.group === 'INSTALL')!.text).toMatch(/24 hours.*50\.00.*21 days/);
    expect(t.find((x) => x.group === 'GOODS')!.text).toMatch(/14 days of delivery/);
  });

  it('previews what each part would refund before anyone clicks cancel', async () => {
    const { o } = await bundleOrder();
    const prev = await cancellationPreview(db, o.id);
    expect(prev.every((p) => p.canCancel)).toBe(true);
    expect(o.cancelAll).toMatchObject({ refundMinor: o.totalMinor, clawbackMinor: 0 }); // cancelling the whole bundle returns everything: no discount is clawed back from parts that leave too
    const justFibre = prev.find((p) => p.kind === 'INSTALL')!;
    expect(justFibre.clawbackMinor).toBe(2990); // cancelling only the fibre breaks the bundle: the phone's discount is taken back
    expect(justFibre.refundMinor).toBe(5000 - 2990);
  });
});
