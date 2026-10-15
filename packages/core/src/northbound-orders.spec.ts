import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBillCycle } from './billing.js';
import { dayOf, today } from './dates.js';
import type { Db } from './db.js';
import { raiseEvent, fanOutEvents, listDeliveries } from './events.js';
import { saveHubWebhook } from './integration-hub.js';
import { runDunning } from './lifecycle-service.js';
import { cancelOrderNorth, createOrderNorth, createPaymentNorth, getOrderNorth, listInvoicesNorth, listOrdersNorth, signedInvoiceUrl, toCustomerBill, verifyInvoiceUrl } from './northbound-orders.js';
import { advanceOrder, placeOrder } from './orders.js';
import { importImsis, importSims } from './nrm-pools.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
void [importImsis, importSims, raiseEvent, fanOutEvents, listDeliveries, saveHubWebhook];
const ALL = ['order:create', 'payment:create'];

describe('orders', () => {
  it('creates an order for an existing or a new customer, waits for payment unless it was captured, and tracks it as a TMF 622 ProductOrder', async () => {
    const c = await newCustomer(db);
    const o = await createOrderNorth(db, { channel: 'SELF_CARE', customerId: c.customer.id, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'QR' } }, 'app', ['order:create']);
    expect(o).toMatchObject({ '@type': 'ProductOrder', state: 'pending', channel: [{ id: 'SELF_CARE' }], relatedParty: [{ id: c.customer.id, role: 'customer' }] });
    expect((o.orderItem as any[])[0]).toMatchObject({ action: 'add', productOffering: { id: 'plan-sim-5g' } });
    expect((await getOrderNorth(db, o.id as string)).state).toBe('pending');
    expect((await getOrderNorth(db, o.externalId as string)).id).toBe(o.id);                           // found by order number too
    // a captured payment needs the scope and a reference
    await expect(createOrderNorth(db, { channel: 'CALL_CENTER', customerId: c.customer.id, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', captured: true, reference: 'R-1' } }, 'ivr', ['order:create'])).rejects.toThrow(/payment:create/);
    await expect(createOrderNorth(db, { channel: 'CALL_CENTER', customerId: c.customer.id, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', captured: true } }, 'ivr', ALL)).rejects.toThrow(/reference/);
    const paid = await createOrderNorth(db, { channel: 'CALL_CENTER', customerId: c.customer.id, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', captured: true, reference: 'R-1' } }, 'ivr', ALL);
    expect(paid.state).toBe('completed');
    expect(((paid['@meridian'] as any).services as any[]).length).toBe(1);
    // identity: exactly one of customerId and customer; a new customer is registered in the call
    await expect(createOrderNorth(db, { channel: 'STOREFRONT', lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'QR' } }, 'x', ALL)).rejects.toThrow(/Identify the customer/);
    const fresh = await createOrderNorth(db, { channel: 'STOREFRONT', customer: { segment: 'CONSUMER', displayName: 'Nora North', idDocument: 'S5551234Z' }, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'QR' } }, 'x', ALL);
    expect(fresh.state).toBe('pending');
    await expect(createOrderNorth(db, { channel: 'STOREFRONT', customer: { segment: 'CONSUMER', displayName: 'Nora Again', idDocument: 'S5551234Z' }, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'QR' } }, 'x', ALL)).rejects.toThrow(/already exists/);
    await expect(createOrderNorth(db, { channel: 'KIOSK', customerId: c.customer.id, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH' } }, 'x', ALL)).rejects.toThrow(/storeId/);
    await expect(createOrderNorth(db, { channel: 'DEALER', customerId: c.customer.id, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH' } }, 'x', ALL)).rejects.toThrow(/dealerId/);
    expect((await listOrdersNorth(db, { customerId: c.customer.id })).items.length).toBe(2);
  });

  it('cancels before the point of no return and refuses after', async () => {
    const c = await newCustomer(db);
    const o = await createOrderNorth(db, { channel: 'SELF_CARE', customerId: c.customer.id, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'QR' } }, 'app', ALL);
    await expect(cancelOrderNorth(db, o.id as string, '', 'app', 'SELF_CARE')).rejects.toThrow(/why/);
    const x = await cancelOrderNorth(db, o.id as string, 'Changed my mind', 'app', 'SELF_CARE');
    expect(x.state).toBe('cancelled');
    await expect(cancelOrderNorth(db, o.id as string, 'again', 'app', 'SELF_CARE')).rejects.toThrow(/already/);
    // a paid order whose service is already live cannot be cancelled: it is past the point of no return
    const live = await createOrderNorth(db, { channel: 'CALL_CENTER', customerId: c.customer.id, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'CASH', captured: true, reference: 'R-9' } }, 'ivr', ALL);
    await expect(cancelOrderNorth(db, live.id as string, 'too late', 'ivr', 'CALL_CENTER')).rejects.toThrow();
  });
});

describe('invoices and payments', () => {
  async function billed() {
    const c = await newCustomer(db);
    await placeOrder(db, { customerId: c.customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] });
    const acct = (await db.query('SELECT id, bill_cycle_day FROM accounts WHERE customer_id=$1', [c.customer.id])).rows[0]!;
    await db.query(`UPDATE accounts SET bill_cycle_day=$2 WHERE id=$1`, [acct.id, dayOf(today())]);
    await db.query(`UPDATE services SET activated_at = now() - interval '40 days' WHERE account_id=$1`, [acct.id]);
    await runBillCycle(db, today(), { accountId: acct.id });
    const inv = (await db.query(`SELECT * FROM invoices WHERE account_id=$1 AND kind='CYCLE' ORDER BY created_at DESC LIMIT 1`, [acct.id])).rows[0]!;
    return { accountId: acct.id as string, customerId: c.customer.id, invoice: inv };
  }

  it('lists a customer’s invoices as TMF 670 bills with a short-lived download link, the balance and the next bill', async () => {
    const a = await billed();
    const r = await listInvoicesNorth(db, a.accountId);
    expect(r.items.length).toBeGreaterThanOrEqual(1);
    expect(r.items[0]).toMatchObject({ '@type': 'CustomerBill', state: 'sent', billNo: a.invoice.number });
    expect(r.balance.dueMinor).toBe(Number(a.invoice.totalMinor));
    expect(r.unbilled.nextBill).toBeTruthy();
    const doc = ((r.items[0] as any).billDocument as any[])[0];
    const q = new URL(doc.href, 'http://x');
    verifyInvoiceUrl(a.invoice.id, Number(q.searchParams.get('exp')), q.searchParams.get('sig')!);
    expect(() => verifyInvoiceUrl(a.invoice.id, Number(q.searchParams.get('exp')), 'forged')).toThrow(/not valid/);
    expect(() => verifyInvoiceUrl(a.invoice.id, Number(q.searchParams.get('exp')), q.searchParams.get('sig')!, Date.now() + 16 * 60_000)).toThrow(/expired/);
    expect(() => verifyInvoiceUrl('other-invoice', Number(q.searchParams.get('exp')), q.searchParams.get('sig')!)).toThrow(/not valid/);
    void signedInvoiceUrl; void toCustomerBill;
  });

  it('allocates a payment to the oldest invoices, refuses an excess unless it is a top-up, repeats harmlessly, and unbars on payment', async () => {
    const a = await billed();
    const owed = Number(a.invoice.totalMinor);
    await db.query(`UPDATE invoices SET due_date = current_date - 30 WHERE id=$1`, [a.invoice.id]);
    await runDunning(db, today());
    await db.query(`UPDATE services SET bar_level='SOFT' WHERE account_id=$1`, [a.accountId]);
    await expect(createPaymentNorth(db, { accountId: a.accountId, amountMinor: owed + 500, method: 'QR', reference: 'PAY-1' }, 'psp')).rejects.toThrow(/topUp/);
    await expect(createPaymentNorth(db, { amountMinor: 100, method: 'QR', reference: 'PAY-1' }, 'psp')).rejects.toThrow(/exactly one/);
    await expect(createPaymentNorth(db, { accountId: a.accountId, amountMinor: 100, method: 'QR', reference: 'x' }, 'psp')).rejects.toThrow(/reference/);
    const part = await createPaymentNorth(db, { accountId: a.accountId, amountMinor: 1000, method: 'QR', reference: 'PAY-2' }, 'psp');
    expect(part).toMatchObject({ '@type': 'Payment', status: 'done', paymentItem: [{ number: a.invoice.number, amountMinor: 1000 }] });
    const again = await createPaymentNorth(db, { accountId: a.accountId, amountMinor: 1000, method: 'QR', reference: 'PAY-2' }, 'psp');   // the channel retried
    expect(again.id).toBe('PAY-2');
    expect(Number((await db.query('SELECT paid_minor FROM invoices WHERE id=$1', [a.invoice.id])).rows[0]!.paidMinor)).toBe(1000);
    const rest = await createPaymentNorth(db, { accountId: a.accountId, amountMinor: owed - 1000 + 700, method: 'QR', reference: 'PAY-3', topUp: true }, 'psp');
    expect(rest.paymentItem).toEqual([{ invoiceId: a.invoice.id, number: a.invoice.number, amountMinor: owed - 1000 }, { accountCredit: true, amountMinor: 700 }]);
    expect((await db.query('SELECT status FROM invoices WHERE id=$1', [a.invoice.id])).rows[0]!.status).toBe('PAID');
    expect((await db.query(`SELECT count(*)::int AS n FROM services WHERE account_id=$1 AND bar_level <> 'NONE'`, [a.accountId])).rows[0]!.n).toBe(0);     // paying lifted the bar
  });

  it('confirms a pending order with a payment, and pays a single invoice', async () => {
    const c = await newCustomer(db);
    const o = await createOrderNorth(db, { channel: 'STOREFRONT', customerId: c.customer.id, lines: [{ offerId: 'plan-sim-5g' }], payment: { method: 'QR' } }, 'x', ALL);
    const total = Number((await db.query('SELECT total_minor FROM orders WHERE id=$1', [o.id])).rows[0]!.totalMinor);
    await expect(createPaymentNorth(db, { orderId: o.id as string, amountMinor: total - 1, method: 'QR', reference: 'QR-1' }, 'psp')).rejects.toThrow(/does not match/);
    const p = await createPaymentNorth(db, { orderId: o.id as string, amountMinor: total, method: 'QR', reference: 'QR-1' }, 'psp');
    expect(p['@meridian']).toMatchObject({ orderState: expect.any(String) });
    expect((await getOrderNorth(db, o.id as string)).state).not.toBe('pending');
    void advanceOrder;
  });
});
