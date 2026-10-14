import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { advanceOrder, cancelOrder, placeOrder } from './orders.js';
import { reconcile } from './reports.js';
import { stockAt } from './inventory.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const retail = { storeId: 'STORE-SG-001', salespersonId: 'agent-1' };

describe('order capture and fulfilment', () => {
  it('retail SIM + phone: pays, hands over, activates, accrues commission, ledger balances', async () => {
    const { customer } = await newCustomer(db);
    const before = await stockAt(db, 'STORE-SG-001', 'PHONE-X1-128');
    const o = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-phone-24' }, { offerId: 'netflix-premium' }] });
    expect(o.state).toBe('COMPLETED');
    expect(o.totalMinor).toBe(29900); // device upfront only; plan fees are billed later
    expect(o.services.map((s: any) => s.type).sort()).toEqual(['MOBILE', 'SUBSCRIPTION']);
    expect(o.services.find((s: any) => s.type === 'MOBILE').identifier).toMatch(/^\+65\d{8}$/);
    const after = await stockAt(db, 'STORE-SG-001', 'PHONE-X1-128');
    expect(after.onHand).toBe(before.onHand - 1);
    expect(after.reserved).toBe(before.reserved);
    expect((await db.query("SELECT amount_minor FROM agent_ledger_entries WHERE order_id=$1 AND entry_type='EARNING'", [o.id])).rows[0]!.amountMinor).toBeGreaterThan(0);
    expect(o.cancellable).toBe(false); // handed over = past the point of no return
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('self-serve device: ships, can be cancelled before shipping (refund + stock back) but not after', async () => {
    const { customer } = await newCustomer(db);
    const start = await stockAt(db, 'WH-MAIN', 'PHONE-X1-128');
    const a = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-phone-24' }] });
    expect(a.state).toBe('FULFILMENT');
    expect(a.nextActions).toEqual(['ship']);
    expect((await stockAt(db, 'WH-MAIN', 'PHONE-X1-128')).reserved).toBe(start.reserved + 1);
    const cancelled = await cancelOrder(db, a.id, 'changed my mind');
    expect(cancelled.state).toBe('CANCELLED');
    expect(await stockAt(db, 'WH-MAIN', 'PHONE-X1-128')).toEqual(start);
    expect(cancelled.payments[0].status).toBe('REFUNDED');

    const b = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'plan-phone-24' }] });
    const shipped = await advanceOrder(db, b.id, { type: 'ship' });
    expect(shipped.state).toBe('SHIPPED');
    await expect(cancelOrder(db, b.id, 'too late')).rejects.toThrow(/point of no return/);
    const done = await advanceOrder(db, b.id, { type: 'deliver' });
    expect(done.state).toBe('COMPLETED');
    expect(done.serviceCount).toBe(1);
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('fibre: installation scheduling, dispatch is the point of no return, completion activates', async () => {
    const { customer } = await newCustomer(db);
    let o = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD' }, lines: [{ offerId: 'fiber-1g' }] });
    expect(o.state).toBe('AWAITING_INSTALLATION');
    await expect(advanceOrder(db, o.id, { type: 'dispatch_technician' })).rejects.toThrow(/schedule/);
    o = await advanceOrder(db, o.id, { type: 'schedule_installation', slot: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    expect(o.cancellable).toBe(true);
    o = await advanceOrder(db, o.id, { type: 'dispatch_technician' });
    expect(o.cancellable).toBe(false);
    await expect(cancelOrder(db, o.id, 'x')).rejects.toThrow(/point of no return/);
    o = await advanceOrder(db, o.id, { type: 'complete_installation' });
    expect(o.state).toBe('COMPLETED');
    expect(o.services[0].identifier).toMatch(/^FBR-/);
  });

  it('QR payment waits for confirmation', async () => {
    const { customer } = await newCustomer(db);
    let o = await placeOrder(db, { customerId: customer.id, channel: 'TELESALES', attribution: { salespersonId: 't1' }, payment: { method: 'QR' }, lines: [{ offerId: 'plan-sim-5g' }] });
    expect(o.state).toBe('PAYMENT_PENDING');
    o = await advanceOrder(db, o.id, { type: 'confirm_payment' });
    expect(o.state).toBe('COMPLETED');
  });

  it('declined payment fails the order without reserving stock', async () => {
    const { customer } = await newCustomer(db);
    const before = await stockAt(db, 'WH-MAIN', 'TOASTER-T1');
    const o = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CREDIT_CARD', reference: 'DECLINE-4000' }, lines: [{ offerId: 'good-toaster' }] });
    expect(o.state).toBe('FAILED');
    expect(o.failureReason).toBe('payment declined');
    expect(await stockAt(db, 'WH-MAIN', 'TOASTER-T1')).toEqual(before);
  });

  it('insufficient stock fails the order and refunds the payment', async () => {
    const { customer } = await newCustomer(db);
    const o = await placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CASH' }, lines: [{ offerId: 'good-fridge', quantity: 21 }] });
    expect(o.state).toBe('FAILED');
    expect(o.failureReason).toMatch(/insufficient stock/);
    expect(o.payments[0].status).toBe('REFUNDED');
    expect((await reconcile(db)).ok).toBe(true);
  });

  it('quick-sale: anonymous walk-in, outright goods only', async () => {
    const o = await placeOrder(db, { channel: 'QUICK_SALE', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'good-toaster', quantity: 2 }] });
    expect(o.state).toBe('COMPLETED');
    expect(o.customerName).toBe('Walk-in customer');
    await expect(placeOrder(db, { channel: 'QUICK_SALE', payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] })).rejects.toThrow(/outright goods/);
    await expect(placeOrder(db, { channel: 'SELF_SERVE', payment: { method: 'CASH' }, lines: [{ offerId: 'good-toaster' }] })).rejects.toThrow(/customerId is required/);
  });

  it('port-in keeps the customer number and rejects a number already in service', async () => {
    const { customer } = await newCustomer(db);
    const o = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g', msisdn: '+6598765432' }] });
    expect(o.services[0].identifier).toBe('+6598765432');
    const other = await newCustomer(db);
    await expect(placeOrder(db, { customerId: other.customer.id, channel: 'RETAIL_ASSISTED', attribution: retail, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g', msisdn: '+6598765432' }] })).rejects.toThrow(/already in service/);
  });

  it('bulk-activates an IoT fleet', async () => {
    const { customer } = await newCustomer(db, { segment: 'IOT', idDocument: 'UEN-IOT-1' });
    const o = await placeOrder(db, { customerId: customer.id, channel: 'CALL_CENTER', payment: { method: 'CASH' }, lines: [{ offerId: 'iot-m2m', quantity: 10_000 }] });
    expect(o.state).toBe('COMPLETED');
    expect(o.serviceCount).toBe(10_000);
  });

  it('validates catalog rules and inputs', async () => {
    const { customer } = await newCustomer(db);
    await expect(placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CASH' }, lines: [{ offerId: 'nope' }] })).rejects.toThrow(/not found/);
    await expect(placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'CASH' }, lines: [] })).rejects.toThrow(/at least one line/);
    await expect(placeOrder(db, { customerId: customer.id, channel: 'SELF_SERVE', payment: { method: 'INSTALLMENT', installmentMonths: 12 }, lines: [{ offerId: 'good-toaster' }] })).rejects.toThrow(/instalments need a service/);
  });
});
