import { creditCheckForBasket } from './financing-check.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { currencyInfo, type OrderChannel, type PaymentMethod } from '@meridian/types';
import { audit } from './audit.js';
import { invoiceBalance, listInvoices, payInvoice } from './billing.js';
import { projectAccount } from './billing-simulation.js';
import { createCustomer, type NewCustomer } from './customers.js';
import { receiveDeposit } from './deposits.js';
import type { Db, Queryable, Row } from './db.js';
import { DomainError, invalid, notFound, rejected } from './errors.js';
import { advanceOrder, cancelOrder, getOrder, listOrders, placeOrder, type OrderInput } from './orders.js';
import { derivedKey } from './oauth.js';
import { assertStoreUsable } from './stores.js';

/**
 * Northbound ordering, billing and payments, in TM Forum shapes: ProductOrder (622), CustomerBill (670) and Payment (676). The ordering engine is the one the CRM and
 * the store-front use; this module only translates, checks what a channel may do, and keeps the money rules (nothing is captured without a reference).
 */

// ───────────────────────── orders (TMF 622) ─────────────────────────
/** The channel names an integration uses, and the order channel each becomes. */
export const NORTH_ORDER_CHANNELS = { SELF_CARE: 'SELF_SERVE', STOREFRONT: 'SELF_SERVE', CALL_CENTER: 'CALL_CENTER', IVR: 'CALL_CENTER', KIOSK: 'RETAIL_ASSISTED', DEALER: 'DEALER', PARTNER: 'DEALER' } as const satisfies Record<string, OrderChannel>;
export type NorthOrderChannel = keyof typeof NORTH_ORDER_CHANNELS;

const TMF_ORDER_STATE: Record<string, string> = {
  DRAFT: 'acknowledged', SUBMITTED: 'acknowledged', VALIDATED: 'acknowledged', PAYMENT_PENDING: 'pending', PAID: 'inProgress', FULFILMENT: 'inProgress', AWAITING_INSTALLATION: 'inProgress',
  SHIPPED: 'inProgress', DELIVERED: 'inProgress', ACTIVATED: 'inProgress', COMPLETED: 'completed', CANCELLED: 'cancelled', FAILED: 'failed',
};
const major = (minor: number, currency: string) => minor / 10 ** (currencyInfo(currency)?.exponent ?? 2);

export function toProductOrder(o: Row, channel?: string): Record<string, unknown> {
  const cur = o.currency as string;
  return {
    id: o.id, '@type': 'ProductOrder', href: `/api/v1/orders/${o.id}`, externalId: o.number, state: TMF_ORDER_STATE[o.state as string] ?? String(o.state).toLowerCase(),
    orderDate: o.createdAt ? new Date(o.createdAt).toISOString() : null, completionDate: o.completedAt ? new Date(o.completedAt).toISOString() : null,
    ...(o.failureReason ? { note: [{ text: o.failureReason }] } : {}),
    channel: [{ id: channel ?? o.channel, name: channel ?? o.channel }],
    relatedParty: [{ id: o.customerId, role: 'customer', name: o.customerName, '@referredType': 'Customer' }],
    orderTotalPrice: [{ priceType: 'total', price: { taxIncludedAmount: { unit: cur, value: major(Number(o.totalMinor), cur) } } }],
    orderItem: (o.lines as Row[] | undefined ?? []).map((l) => ({ id: l.id, action: 'add', quantity: l.quantity, state: String(l.status ?? '').toLowerCase(), productOffering: { id: l.offerId, name: l.description }, ...(l.serviceId ? { product: { id: l.serviceId } } : {}) })),
    payment: (o.payments as Row[] | undefined ?? []).map((p) => ({ id: p.id, method: p.method, status: p.status, amount: { unit: cur, value: major(Number(p.amountMinor), cur) }, reference: p.reference })),
    '@meridian': { number: o.number, internalState: o.state, cancellable: o.cancellable ?? null, nextActions: o.nextActions ?? [], services: (o.services as Row[] | undefined ?? []).map((s) => ({ id: s.id, identifier: s.identifier, status: s.status })) },
  };
}

export interface NorthOrderInput {
  channel: NorthOrderChannel;
  customerId?: string;
  /** Register the customer in the same call. Duplicate identity documents are refused: use customerId. */
  customer?: Pick<NewCustomer, 'segment' | 'displayName' | 'idDocument' | 'email' | 'phone' | 'dateOfBirth' | 'gender' | 'address' | 'marketCode'>;
  accountId?: string;
  lines: OrderInput['lines'];
  payment: { method: PaymentMethod; installmentMonths?: number; reference?: string; /** The payment was already captured by the channel (needs the payment:create scope and a reference). */ captured?: boolean };
  delivery?: { method: 'SHIP' | 'COLLECT'; address?: string; pickupStoreId?: string };
  installationSlot?: string;
  storeId?: string; dealerId?: string; dealerAgentId?: string;
  /** Device financing. `creditCheck` runs the credit check inline (the customer's ID number, with their consent); `creditCheckId` uses one already run; `payInFull` pays a device on a contract outright. */
  creditCheck?: { idNumber: string; consent: boolean };
  creditCheckId?: string; payInFull?: boolean;
}

export async function createOrderNorth(db: Db, i: NorthOrderInput, actor: string, scopes: string[]) {
  const channel = NORTH_ORDER_CHANNELS[i.channel];
  if (!channel) throw invalid(`The channel is one of ${Object.keys(NORTH_ORDER_CHANNELS).join(', ')}.`);
  if (!!i.customerId === !!i.customer) throw invalid('Identify the customer: either customerId or a customer to register, not both.');
  if (!i.lines?.length) throw invalid('An order needs at least one item.');
  const captured = !!i.payment.captured;
  if (captured && !scopes.includes('payment:create')) throw new DomainError('FORBIDDEN', 'Recording a captured payment needs the payment:create scope.');
  if (captured && !i.payment.reference?.trim()) throw invalid('A captured payment needs its reference (the gateway or terminal approval number).');
  if (channel === 'RETAIL_ASSISTED') { if (!i.storeId) throw invalid('A kiosk order needs the storeId it is sold at.'); await assertStoreUsable(db, i.storeId); }
  if (channel === 'DEALER' && (!i.dealerId || !i.dealerAgentId)) throw invalid('A dealer or partner order needs dealerId and dealerAgentId.');
  let customerId = i.customerId;
  if (i.customer) {
    const made = await db.tx((q) => createCustomer(q, i.customer as NewCustomer));
    customerId = made.customer.id as string;
  }
  let creditCheckId = i.creditCheckId;
  if (i.creditCheck && !i.payInFull && !creditCheckId) {
    creditCheckId = (await creditCheckForBasket(db, { customerId: customerId!, idNumber: i.creditCheck.idNumber, consent: { given: !!i.creditCheck.consent, by: actor, how: `northbound ${i.channel}` }, channel, lines: i.lines, actor })).id;
  }
  const order = await placeOrder(db, {
    customerId, accountId: i.accountId, channel, lines: i.lines, financing: { creditCheckId, payInFull: i.payInFull },
    payment: { method: i.payment.method, installmentMonths: i.payment.installmentMonths, reference: i.payment.reference, confirmed: captured },
    attribution: channel === 'SELF_SERVE' ? {} : { storeId: i.storeId, dealerId: i.dealerId, dealerAgentId: i.dealerAgentId, salespersonId: actor },
    deliveryAddress: i.delivery?.address, delivery: i.delivery?.method ? { method: i.delivery.method, pickupStoreId: i.delivery.pickupStoreId } : undefined, installationSlot: i.installationSlot, actor,
  });
  return toProductOrder(order, i.channel);
}
export async function getOrderNorth(db: Db, ref: string) { return toProductOrder(await getOrder(db, ref, { initiatedBy: 'CUSTOMER', canOverride: false })); }
export async function listOrdersNorth(db: Db, f: { customerId?: string; state?: string; limit?: number; cursor?: string }) {
  const page = await listOrders(db, { customerId: f.customerId, limit: f.limit, cursor: f.cursor });
  return { items: page.items.map((o) => toProductOrder(o)), nextCursor: page.nextCursor ?? null };
}
/** Cancels an order if it is before the point of no return (goods shipped, technician dispatched); the order's money is refunded by the cancellation itself. */
export async function cancelOrderNorth(db: Db, ref: string, reason: string, actor: string, channel: NorthOrderChannel | 'STAFF') {
  const o = await getOrder(db, ref);
  if (!reason?.trim()) throw invalid('Say why the order is being cancelled.');
  try { await cancelOrder(db, o.id, reason, actor, { initiatedBy: channel === 'SELF_CARE' || channel === 'STOREFRONT' ? 'CUSTOMER' : 'STAFF' }); }
  catch (e) { if (e instanceof DomainError && e.code === 'REJECTED') throw new DomainError('REJECTED', `${e.message}`, { reason: 'POINT_OF_NO_RETURN' }); throw e; }
  await audit(db, actor, 'order', o.id, 'NORTHBOUND_CANCEL', { reason });
  return toProductOrder(await getOrder(db, o.id, { initiatedBy: 'CUSTOMER', canOverride: false }));
}

// ───────────────────────── invoices (TMF 670) ─────────────────────────
const INVOICE_URL_TTL_SECONDS = 15 * 60;
const urlSig = (id: string, exp: number) => createHmac('sha256', derivedKey('meridian-invoice-url')).update(`${id}.${exp}`).digest('base64url');
/** A link to an invoice PDF that works for 15 minutes without a login. */
export function signedInvoiceUrl(invoiceId: string, nowMs = Date.now()): { href: string; expiresAt: string } {
  const exp = Math.floor(nowMs / 1000) + INVOICE_URL_TTL_SECONDS;
  return { href: `/api/v1/invoices/${invoiceId}/pdf?exp=${exp}&sig=${urlSig(invoiceId, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
}
export function verifyInvoiceUrl(invoiceId: string, exp: number, sig: string, nowMs = Date.now()): void {
  const want = Buffer.from(urlSig(invoiceId, exp)), got = Buffer.from(sig ?? '');
  if (!Number.isInteger(exp) || exp * 1000 < nowMs || want.length !== got.length || !timingSafeEqual(want, got)) throw new DomainError('UNAUTHENTICATED', 'This download link is not valid or has expired.');
}

const BILL_STATE: Record<string, string> = { ISSUED: 'sent', OVERDUE: 'onHold', PAID: 'settled', VOID: 'cancelled', WRITTEN_OFF: 'cancelled' };
export function toCustomerBill(r: Row, now = Date.now()): Record<string, unknown> {
  const cur = r.currency as string, due = invoiceBalance(r);
  const partly = Number(r.paidMinor) > 0 && due > 0;
  return {
    id: r.id, '@type': 'CustomerBill', href: `/api/v1/invoices/${r.id}`, billNo: r.number, category: String(r.kind).toLowerCase(),
    billDate: String(r.issueDate).slice(0, 10), paymentDueDate: String(r.dueDate).slice(0, 10), state: partly ? 'partiallyPaid' : BILL_STATE[r.status as string] ?? String(r.status).toLowerCase(),
    amountDue: { unit: cur, value: major(due, cur) }, taxIncludedAmount: { unit: cur, value: major(Number(r.totalMinor), cur) }, taxExcludedAmount: { unit: cur, value: major(Number(r.netMinor), cur) },
    remainingAmount: { unit: cur, value: major(due, cur) }, billingPeriod: { startDateTime: String(r.periodStart).slice(0, 10), endDateTime: String(r.periodEnd).slice(0, 10) },
    billDocument: [{ id: `${r.id}-pdf`, mimeType: 'application/pdf', ...signedInvoiceUrl(r.id as string, now) }],
  };
}

export async function listInvoicesNorth(q: Queryable, accountId: string, f: { status?: string; limit?: number; cursor?: string } = {}) {
  const acct = (await q.query('SELECT * FROM accounts WHERE id=$1', [accountId])).rows[0];
  if (!acct) throw notFound('account', accountId);
  const page = await listInvoices(q, { accountId, status: f.status, limit: f.limit ?? 24, cursor: f.cursor });
  // what the next bill would be, from the plans and instalments running now
  let nextBill: Record<string, unknown> | null = null;
  try {
    const p = await projectAccount(q, accountId, { months: 1 });
    const m = (p.months as Row[])[0];
    if (m) nextBill = { billDate: m.billDate, periodStart: m.periodStart, periodEnd: m.periodEnd, totalMinor: m.totalMinor, currency: acct.currency };
  } catch { nextBill = null; }
  const totals = (await q.query(`SELECT COALESCE(sum(total_minor - paid_minor - credited_minor) FILTER (WHERE status IN ('ISSUED','OVERDUE')),0) AS due, COALESCE(sum(total_minor - paid_minor - credited_minor) FILTER (WHERE status='OVERDUE'),0) AS overdue FROM invoices WHERE account_id=$1`, [accountId])).rows[0]!;
  return {
    account: { id: acct.id, currency: acct.currency, status: acct.status, billCycleDay: acct.billCycleDay },
    balance: { dueMinor: Number(totals.due), overdueMinor: Number(totals.overdue), currency: acct.currency },
    unbilled: { nextBill, usage: null, note: 'Usage not yet billed comes from the charging system; it is not connected in this deployment.' },
    ocsBuckets: null,
    items: page.items.map((r) => toCustomerBill(r)), nextCursor: page.nextCursor ?? null,
  };
}

// ───────────────────────── payments (TMF 676) ─────────────────────────
export interface NorthPaymentInput { accountId?: string; invoiceId?: string; orderId?: string; amountMinor: number; method: 'CASH' | 'CREDIT_CARD' | 'QR'; reference: string; topUp?: boolean }

/**
 * Takes a payment a channel has already captured. Against an order it confirms the order (the amount must match its total); against an invoice it pays that invoice;
 * against an account it pays the oldest invoices first. Any excess is refused unless `topUp` says to keep it as credit on the account. Paying what was overdue lifts the
 * dunning bars (and ends the ladder) in the same step. Repeats with the same reference change nothing.
 */
export async function createPaymentNorth(db: Db, i: NorthPaymentInput, actor: string) {
  if (!Number.isInteger(i.amountMinor) || i.amountMinor <= 0) throw invalid('amountMinor is a positive whole amount (minor units).');
  if (!i.reference || i.reference.trim().length < 3) throw invalid('A payment reference of at least 3 characters is required.');
  if ([i.accountId, i.invoiceId, i.orderId].filter(Boolean).length !== 1) throw invalid('Say what the payment is for: exactly one of orderId, invoiceId or accountId.');
  const ref = i.reference.trim();
  if (i.orderId) {
    const o = await getOrder(db, i.orderId);
    if (Number(o.totalMinor) !== i.amountMinor) throw rejected(`The amount ${i.amountMinor} does not match the order total ${o.totalMinor}.`);
    if (o.state !== 'PAYMENT_PENDING') return payment(ref, o.currency, i.amountMinor, [{ orderId: o.id, amountMinor: i.amountMinor }], { note: `The order is already ${String(o.state).toLowerCase()}.` });
    const r = await advanceOrder(db, o.id, { type: 'confirm_payment', reference: ref }, actor);
    return payment(ref, o.currency, i.amountMinor, [{ orderId: o.id, amountMinor: i.amountMinor }], { orderState: r.state });
  }
  if (i.invoiceId) {
    const inv = await payInvoice(db, i.invoiceId, { amountMinor: i.amountMinor, method: i.method, reference: ref, idempotencyKey: `north-${ref}-${i.invoiceId}` }, actor);
    return payment(ref, inv.currency, i.amountMinor, [{ invoiceId: inv.id, number: inv.number, amountMinor: i.amountMinor }], { invoiceStatus: inv.status, ...(await barState(db, inv.accountId)) });
  }
  const acct = (await db.query('SELECT * FROM accounts WHERE id=$1', [i.accountId])).rows[0];
  if (!acct) throw notFound('account', i.accountId);
  const open = (await db.query(`SELECT * FROM invoices WHERE account_id=$1 AND status IN ('ISSUED','OVERDUE') AND total_minor - paid_minor - credited_minor > 0 ORDER BY due_date, number`, [acct.id])).rows;
  const outstanding = open.reduce((s, r) => s + invoiceBalance(r), 0);
  if (i.amountMinor > outstanding && !i.topUp) throw rejected(`The account owes ${outstanding}; the payment is ${i.amountMinor}. Send topUp: true to keep the excess as credit.`);
  let left = i.amountMinor;
  const items: Array<Record<string, unknown>> = [];
  for (const inv of open) {
    if (left <= 0) break;
    const part = Math.min(left, invoiceBalance(inv));
    await payInvoice(db, inv.id, { amountMinor: part, method: i.method, reference: ref, idempotencyKey: `north-${ref}-${inv.id}` }, actor);
    items.push({ invoiceId: inv.id, number: inv.number, amountMinor: part }); left -= part;
  }
  if (left > 0) { await receiveDeposit(db, acct.id, { amountMinor: left, method: i.method, reference: ref }, actor); items.push({ accountCredit: true, amountMinor: left }); }
  return payment(ref, acct.currency, i.amountMinor, items, await barState(db, acct.id));
}
async function barState(q: Queryable, accountId: string) {
  const n = Number((await q.query(`SELECT count(*) AS n FROM services WHERE account_id=$1 AND bar_level <> 'NONE' AND status <> 'TERMINATED'`, [accountId])).rows[0]!.n);
  return { servicesStillBarred: n };
}
function payment(ref: string, currency: string, amountMinor: number, items: Array<Record<string, unknown>>, extra: Record<string, unknown>) {
  return { id: ref, '@type': 'Payment', status: 'done', paymentDate: new Date().toISOString(), amount: { unit: currency, value: major(amountMinor, currency) }, paymentItem: items, '@meridian': extra };
}
