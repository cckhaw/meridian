import { enqueueOcs } from './ocs.js';
import { cancelOrderVisit, confirmOrderVisit, holdOrderVisit, orderBookingAvailable, type OrderSlot } from './workforce.js';
import { assertNotBlacklisted } from './fraud.js';
import { randomUUID } from 'node:crypto';
import { behaviourOf, type OfferNode, type OrderChannel, type OrderState, type PaymentMethod } from '@meridian/types';
import { ruleSatisfied, listBundleRules } from './bundles.js';
import { decide, deadlineDays, getCancellationSettings, listRules, type CancellationDecision, type Facts } from './cancellation.js';
import { GL, paymentMode } from './config.js';
import { recordOrderCommission } from './commission.js';
import { announceStart, getServiceKind, isBuiltinKind, type ServiceKind } from './service-kinds.js';
import { clawBack } from './commission-processor.js';
import { effectiveMarket, getRegional, marketFor } from './settings.js';
import type { Db, Queryable, Row } from './db.js';
import { monthlyFee } from './catalog.js';
import { DomainError, invalid, notFound, rejected } from './errors.js';
import { MAIN_WAREHOUSE, consumeReservations, releaseReservations, reserve, restockConsumed } from './inventory.js';
import { postJournal, type RevenueStream } from './ledger.js';
import { today } from './dates.js';
import { attachCheckToOrder } from './device-financing.js';
import { createsService, deliveryMethods, groupOf, priceBasket, RETAIL_CHANNELS, skusFor, type GroupKind, type LineInput } from './order-pricing.js';
import { assertStoreUsable } from './stores.js';
import { decodeCursor, pageSize, sqlBuilder, tsPage, type Page } from './paging.js';
import { customerIdsMatching, parseQuery } from './search.js';
import { audit } from './audit.js';
import { assertDealerSale } from './dealers.js';
import { consumeMsisdnTx, releaseMsisdnTx, reserveMsisdnTx } from './number-reservation.js';
import { activateResourcesTx, allocateSimTx, releaseOrderSimsTx } from './nrm-pools.js';
import { taxSplit } from './tax.js';
import { syncOrderGroups } from './group-orders.js';
import { createPortInTx } from './port-in.js';
import { conflict } from './errors.js';
import { raiseEvent } from './events.js';

export type { GroupKind, LineInput, LinePayment } from './order-pricing.js';

export interface OrderInput {
  customerId?: string;
  accountId?: string;
  channel: OrderChannel;
  marketCode?: string;
  lines: LineInput[];
  /**
   * How the money due now is taken. `confirmed`: a cashier with the payment permission states the money was received (terminal approval / receipt in `reference`).
   * Each line may choose to pay upfront or by instalments (see LineInput.payment); `installmentMonths` with method INSTALLMENT is the older whole-order shortcut.
   */
  payment: { method: PaymentMethod; installmentMonths?: number; reference?: string; confirmed?: boolean;
    /** Wait in PAYMENT_PENDING for a payment gateway to confirm (online checkout), whatever the payment mode. */
    deferred?: boolean };
  attribution?: { storeId?: string; salespersonId?: string; dealerId?: string; dealerAgentId?: string };
  deliveryAddress?: string;
  /** How goods reach the customer: shipped to the address, or collected at a store they choose. Default: shipped when the offers allow it. */
  delivery?: { method: 'SHIP' | 'COLLECT'; pickupStoreId?: string };
  /** Preferred installation visit, booked as soon as the order is paid. */
  installationSlot?: string;
  /** A window chosen from the field-service system's live availability (see `findOrderSlots`); it is held for the order and booked once the order is paid. Replaces `installationSlot`. */
  installationSlotRef?: OrderSlot;
  /** Device financing: the credit check to use, or pay a device on a contract in full. */
  financing?: { creditCheckId?: string; payInFull?: boolean };
  /** The fibre port the customer was holding at checkout (from the coverage service); kept with the order so Fibre Ops can see which port it is. */
  fiberReservationId?: string;
  actor?: string;
}

const TERMINAL: OrderState[] = ['COMPLETED', 'CANCELLED', 'FAILED'];
const OPEN_GROUP = ['PENDING', 'LOCKED'];
const DAY = 86_400_000;

const serviceType = (o: OfferNode) => behaviourOf(o).service ?? 'MOBILE';
const isGoods = (o: { kind?: string; template?: string }) => behaviourOf(o).goods;

async function setState(q: Queryable, o: Row, to: OrderState, actor: string, reason?: string) {
  await q.query(
    `UPDATE orders SET state=$3::order_state, failure_reason = CASE WHEN $3::order_state IN ('FAILED','CANCELLED') THEN $4 ELSE failure_reason END,
       completed_at = CASE WHEN $3::order_state = 'COMPLETED' THEN now() ELSE completed_at END, version = version + 1, updated_at = now()
     WHERE id=$1 AND shard_id=$2`,
    [o.id, o.shardId, to, reason ?? null],
  );
  await q.query('INSERT INTO order_state_history (shard_id, order_id, from_state, to_state, actor, reason) VALUES ($1,$2,$3,$4,$5,$6)', [o.shardId, o.id, o.state, to, actor, reason ?? null]);
  if ((to === 'CANCELLED' || to === 'FAILED') && o.fulfilment?.wfm) await cancelOrderVisit(q, o.id, reason ?? 'The order did not go ahead', actor);   // release the technician window held for it
  if (to === 'CANCELLED' || to === 'COMPLETED') await raiseEvent(q, to === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_COMPLETED', { accountId: o.accountId, resourceId: o.id, payload: { orderId: o.id, orderNumber: o.number, customerId: o.customerId, state: to, reason: reason ?? null } }, { onlyIfWanted: true });
  o.state = to;
}
/** A line in the timeline for something that happened to part of the order without changing its overall state. */
/** Amounts in timeline notes, written the way people read them (currency exponent respected). */
const fmt = (minor: number, currency: string) => { const f = new Intl.NumberFormat('en', { style: 'currency', currency }); return f.format(minor / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2)).replace(/\u00a0/g, ' '); };
const note = (q: Queryable, o: Row, actor: string, reason: string) =>
  q.query('INSERT INTO order_state_history (shard_id, order_id, from_state, to_state, actor, reason) VALUES ($1,$2,$3,$3,$4,$5)', [o.shardId, o.id, o.state, actor, reason]);

export async function walkInCustomer(q: Queryable, marketCode: string): Promise<string> {
  const ref = `WALKIN-${marketCode}`;
  const { createCustomer } = await import('./customers.js');
  const found = (await q.query('SELECT id FROM customers WHERE display_name=$1 AND market_code=$2 LIMIT 1', ['Walk-in customer', marketCode])).rows[0];
  if (found) return found.id;
  return (await createCustomer(q, { segment: 'ENTERPRISE', displayName: 'Walk-in customer', idDocument: ref, marketCode, account: false })).customer.id;
}

export async function placeOrder(db: Db, input: OrderInput): Promise<Row> {
  return db.tx((q) => placeOrderTx(q, input));
}

/** The next order number: the order date (in the deployment's time zone) and a counter for that day, e.g. 20261014-00042. Atomic, so two orders never share one. */
export async function nextOrderNumber(q: Queryable, now: Date = new Date()): Promise<string> {
  const tz = (await getRegional(q)).timezone;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); // YYYY-MM-DD
  // The day's starting point is written once (the first order of the day); every order then takes the next sequence value, which never waits on another order.
  await q.query(`INSERT INTO order_counters (day, last, base) SELECT $1::date, 0, nextval('order_number_seq') WHERE NOT EXISTS (SELECT 1 FROM order_counters WHERE day=$1::date) ON CONFLICT (day) DO NOTHING`, [day]);
  const n = (await q.query(`SELECT nextval('order_number_seq') - base AS n FROM order_counters WHERE day=$1::date`, [day])).rows[0]!.n as number;
  return `${day.replaceAll('-', '')}-${String(n).padStart(5, '0')}`;
}

/**
 * Takes the SIM and number an order line asked for, in the order's own transaction: a named SIM or the next free one at the seller's store (or an
 * eSIM profile), and the chosen number from the pool. A mobile plan with no number named takes the next Standard number when the deployment
 * keeps a number pool. Nothing is taken for lines that need neither.
 */
async function allocateLineTx(q: Queryable, p: Awaited<ReturnType<typeof priceBasket>>['lines'][number], orderId: string, storeId: string | null, actor: string): Promise<{ msisdn?: string; iccid?: string; simType?: string }> {
  const out: { msisdn?: string; iccid?: string; simType?: string } = {};
  const holder = `order:${orderId}`;
  const mobile = createsService(p.offer) && serviceType(p.offer) === 'MOBILE' && p.qty === 1;
  if (p.input.msisdn && p.numberInPool) {
    const token = (await q.query(`SELECT token FROM number_reservation_locks WHERE resource_type='MSISDN' AND resource_id=$1 AND state='ACTIVE'`, [p.input.msisdn])).rows[0]?.token;
    const row = (await q.query('SELECT state, reserved_by FROM msisdn_inventory WHERE msisdn=$1', [p.input.msisdn])).rows[0];
    if (row?.state === 'RESERVED_CHECKOUT' && p.input.numberToken && token === p.input.numberToken) {
      await q.query(`UPDATE msisdn_inventory SET reserved_by=$2, reserved_until=NULL, updated_at=now() WHERE msisdn=$1`, [p.input.msisdn, holder]); // the checkout hold becomes the order's
      await q.query(`UPDATE number_reservation_locks SET holder=$2, expires_at='infinity' WHERE resource_type='MSISDN' AND resource_id=$1 AND state='ACTIVE'`, [p.input.msisdn, holder]);
    } else {
      await reserveMsisdnTx(q, p.input.msisdn, holder, randomUUID(), 60_000, { actor });
      await q.query(`UPDATE msisdn_inventory SET reserved_until=NULL WHERE msisdn=$1`, [p.input.msisdn]);
      await q.query(`UPDATE number_reservation_locks SET expires_at='infinity' WHERE resource_type='MSISDN' AND resource_id=$1 AND state='ACTIVE'`, [p.input.msisdn]);
    }
    out.msisdn = p.input.msisdn;
  } else if (mobile && !p.input.msisdn && !(p.input.portIn && !p.input.portIn.temporaryNumber) && ((await q.query('SELECT 1 FROM msisdn_inventory LIMIT 1')).rows.length || p.input.portIn)) {
    const pick = (await q.query(`SELECT msisdn FROM msisdn_inventory WHERE tier='STANDARD' AND (state='AVAILABLE' OR (state='RESERVED_CHECKOUT' AND reserved_until < now())) ORDER BY msisdn LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
    if (!pick) throw rejected(p.input.portIn ? 'There is no temporary number to give while the port-in is processed (the pool has no standard numbers left). Load more numbers, or port in without a temporary number.' : 'There are no standard numbers left in the pool. Load more numbers, or choose a number.');
    await reserveMsisdnTx(q, pick.msisdn as string, holder, randomUUID(), 60_000, { actor });
    await q.query(`UPDATE msisdn_inventory SET reserved_until=NULL WHERE msisdn=$1`, [pick.msisdn]);
    await q.query(`UPDATE number_reservation_locks SET expires_at='infinity' WHERE resource_type='MSISDN' AND resource_id=$1 AND state='ACTIVE'`, [pick.msisdn]);
    out.msisdn = pick.msisdn as string;
  }
  if (p.input.iccid || p.input.simType) {
    if (!mobile) throw invalid(`${p.offer.name} does not take a SIM.`);
    const sim = await allocateSimTx(q, { iccid: p.input.iccid, simType: p.input.simType }, { orderId, storeId, actor });
    out.iccid = sim.iccid; out.simType = sim.kind;
  }
  return out;
}

/** An order that did not become a service gives its numbers and SIMs back. */
export async function releaseOrderNumbering(q: Queryable, orderId: string, actor = 'system'): Promise<void> {
  await releaseOrderSimsTx(q, orderId, actor);
  const holder = `order:${orderId}`;
  for (const r of (await q.query(`SELECT msisdn FROM msisdn_inventory WHERE state='RESERVED_CHECKOUT' AND reserved_by=$1`, [holder])).rows) await releaseMsisdnTx(q, r.msisdn as string, holder, actor);
}

/** The order transaction body, so callers (store checkout) can create a customer and its order atomically. */
export async function placeOrderTx(q: Queryable, input: OrderInput): Promise<Row> {
  const actor = input.actor ?? input.attribution?.salespersonId ?? 'system';
  let customerId = input.customerId;
  if (!customerId) {
    if (!input.lines.length) throw invalid('an order needs at least one line');
    if (input.channel !== 'QUICK_SALE') throw invalid('customerId is required (only QUICK_SALE may be anonymous)');
    customerId = await walkInCustomer(q, await effectiveMarket(q, input.marketCode));
  }
  // Everything about price, eligibility and payment structure is decided in one place, shared with the quote the order wizard shows.
  const priced = await priceBasket(q, { ...input, customerId });
  const customer = priced.customer!;
  { const c = (await q.query('SELECT id_document_hash, email, phone FROM customers WHERE id=$1', [customerId])).rows[0]; if (c) await assertNotBlacklisted(q, { idHash: c.idDocumentHash, email: c.email, msisdn: c.phone }); }
  if (input.installationSlotRef) {
    if (!priced.lines.some((l) => groupOf(l.offer) === 'INSTALL')) throw invalid('this order has no installation to book a time for');
    if (!(await orderBookingAvailable(q))) throw invalid('live installation times are not switched on');
    if (!input.deliveryAddress?.trim()) throw invalid('enter the installation address');
    input.installationSlot = input.installationSlotRef.start;
  }
  if (input.installationSlot) {
    const slot = new Date(input.installationSlot);
    if (Number.isNaN(slot.getTime()) || slot.getTime() < Date.now()) throw invalid('the installation date must be in the future');
  }

  // How the goods reach the customer. A counter sale hands them over at once, so there is nothing to choose.
  let delivery: { method: 'SHIP' | 'COLLECT'; pickupStoreId?: string } | undefined;
  const methods = RETAIL_CHANNELS.includes(input.channel) ? [] : deliveryMethods(priced.lines.map((l) => l.offer));
  if (methods.length) {
    const method = input.delivery?.method ?? (methods.includes('SHIP') ? 'SHIP' : 'COLLECT');
    if (!methods.includes(method)) throw invalid(method === 'COLLECT' ? 'these items cannot be collected in store' : 'these items cannot be shipped: they are collected in store');
    if (method === 'COLLECT') {
      if (!input.delivery?.pickupStoreId) throw invalid('choose the store where the customer will collect');
      await assertStoreUsable(q, input.delivery.pickupStoreId);
      delivery = { method, pickupStoreId: input.delivery.pickupStoreId };
    } else delivery = { method };
  }
  const orderId = randomUUID();
  const orderNumber = await nextOrderNumber(q);
  const att = input.attribution ?? {};
  if (input.channel === 'DEALER') {
    if (!att.dealerId || !att.dealerAgentId) throw invalid('a dealer order needs the dealer and the agent who sold it');
    await assertDealerSale(q, att.dealerId, att.dealerAgentId);
  }
  const eligible = !!(att.salespersonId || att.dealerId); // whether it earns, and how much, is decided by the commission plans
  const months = priced.lines.find((l) => l.payMode === 'INSTALLMENT')?.months ?? null;
  await q.query(
    `INSERT INTO orders (id, shard_id, customer_id, account_id, channel, state, total_minor, currency, market_code, store_id, salesperson_id, dealer_id, dealer_agent_id,
       commission_eligible, payment_method, installment_months, fulfilment, created_by, number)
     VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [orderId, customer.shardId, customerId, input.accountId ?? null, input.channel, priced.dueNow, priced.currency, priced.marketCode, att.storeId ?? null, att.salespersonId ?? null, att.dealerId ?? null, att.dealerAgentId ?? null,
     eligible, input.payment.method, months, JSON.stringify({ address: input.deliveryAddress ?? null, ...(delivery ? { delivery } : {}), ...(input.installationSlot ? { slot: new Date(input.installationSlot).toISOString() } : {}), ...(input.fiberReservationId ? { fiber: { reservationId: input.fiberReservationId } } : {}) }), actor, orderNumber],
  );
  for (const p of priced.lines) {
    const alloc = await allocateLineTx(q, p, orderId, att.storeId ?? null, actor);
    await q.query(
      `INSERT INTO order_lines (shard_id, order_id, offer_id, quantity, unit_price_minor, msisdn, serial_number, description, net_minor, tax_minor,
         fulfil_group, options, pay_mode, installment_months, down_payment_minor, paid_now_minor, discount_minor, discount_rules, position, attach_position, deal, iccid, sim_type, vip_tier, vip_fee_minor,
         group_head_position, join_group_id, port_in)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
      [customer.shardId, orderId, p.offer.id, p.qty, Math.round(p.gross / p.qty), alloc.msisdn ?? p.input.msisdn ?? null, p.input.serialNumber ?? null, p.offer.name, p.net, p.tax,
       p.group, JSON.stringify({ ...(p.variant ? { variantId: p.variant.id, colour: p.variant.colour, storage: p.variant.storage, sku: p.variant.sku } : {}), ...(alloc.msisdn ? { numberFromPool: true } : {}) }),
       p.payMode, p.months, p.downMinor, p.paidNow, p.discountMinor, p.discountRules, p.position, p.attachPosition ?? null,
       p.deal ? JSON.stringify({ termMonths: p.deal.termMonths, subsidyMinor: p.deal.subsidyMinor, waiveInLastMonths: p.deal.waiveInLastMonths ?? 1, retailMinor: p.deal.retailMinor, currency: priced.currency }) : null,
       alloc.iccid ?? null, alloc.simType ?? null, p.vipTier ?? null, p.vipFeeMinor,
       p.input.memberOf ?? null, p.input.joinGroupId ?? null, p.input.portIn ? JSON.stringify(p.input.portIn) : null],
    );
  }
  if (priced.financing?.checkId) await attachCheckToOrder(q, priced.financing.checkId, orderId, customerId);
  if (input.installationSlotRef) await holdOrderVisit(q, { orderId, number: orderNumber, customerId, slot: input.installationSlotRef }, actor);
  const o = (await q.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0]!;
  o.state = 'DRAFT';
  await setState(q, o, 'SUBMITTED', actor);
  await raiseEvent(q, 'ORDER_CREATED', { accountId: o.accountId, resourceId: o.id, payload: { orderId: o.id, orderNumber: o.number, customerId: o.customerId, channel: o.channel, totalMinor: Number(o.totalMinor) } }, { onlyIfWanted: true });
  await drive(q, o, { actor, paymentReference: input.payment.reference, paymentConfirmed: !!input.payment.confirmed, deferPayment: !!input.payment.deferred });
  return getOrder(q, orderId);
}

type Ctx = { actor: string; paymentReference?: string; paymentConfirmed?: boolean; deferPayment?: boolean; gatewayRef?: string };

// ───────────────────────── fulfilment groups ─────────────────────────
async function groupRows(q: Queryable, orderId: string): Promise<Row[]> {
  return (await q.query(`SELECT * FROM order_groups WHERE order_id=$1 ORDER BY CASE kind WHEN 'INSTALL' THEN 1 WHEN 'GOODS' THEN 2 ELSE 3 END`, [orderId])).rows;
}
const findGroup = (gs: Row[], kind: GroupKind) => gs.find((g) => g.kind === kind);
async function patchGroup(q: Queryable, id: string, set: string, params: unknown[] = []) {
  await q.query(`UPDATE order_groups SET ${set} WHERE id=$1`, [id, ...params]);
}
/** The first moment anything about the order became irreversible; kept for older screens and reports. */
const markPointOfNoReturn = (q: Queryable, o: Row) => q.query('UPDATE orders SET point_of_no_return_at = COALESCE(point_of_no_return_at, now()) WHERE id=$1', [o.id]);

/** Mirrors the open parts of the order into the older `pending_tasks` list. */
async function syncTasks(q: Queryable, o: Row) {
  const gs = await groupRows(q, o.id);
  const tasks = gs.filter((g) => OPEN_GROUP.includes(g.status) && g.kind !== 'ACTIVATION').map((g) => (g.kind === 'INSTALL' ? 'INSTALL' : 'SHIP'));
  await q.query('UPDATE orders SET pending_tasks=$2 WHERE id=$1', [o.id, tasks]);
  o.pendingTasks = tasks;
}

/**
 * The order's headline state, derived from its parts: open installation beats shipped beats "in fulfilment"; when every part is finished
 * the order completes (or is cancelled if nothing was delivered).
 */
async function syncOrder(q: Queryable, o: Row, ctx: Ctx) {
  await syncTasks(q, o);
  const gs = await groupRows(q, o.id);
  if (!gs.length || TERMINAL.includes(o.state)) return;
  const open = gs.filter((g) => OPEN_GROUP.includes(g.status));
  if (open.length) {
    const install = open.find((g) => g.kind === 'INSTALL');
    const goods = open.find((g) => g.kind === 'GOODS');
    const headline: OrderState = install ? 'AWAITING_INSTALLATION' : goods?.status === 'LOCKED' ? 'SHIPPED' : 'FULFILMENT';
    if (o.state !== headline) await setState(q, o, headline, ctx.actor);
    return;
  }
  if (gs.every((g) => g.status === 'CANCELLED' || g.status === 'RETURNED')) { await setState(q, o, 'CANCELLED', ctx.actor, 'every part of the order was cancelled'); return; }
  if (o.state !== 'ACTIVATED') await setState(q, o, 'ACTIVATED', ctx.actor);
  await complete(q, o);
}

/** Runs the order forward until it completes, fails, or needs an external event (payment confirmation, shipping, installation). */
async function drive(q: Queryable, o: Row, ctx: Ctx): Promise<void> {
  for (let guard = 0; guard < 20; guard++) {
    switch (o.state as OrderState) {
      case 'SUBMITTED': {
        await setState(q, o, 'VALIDATED', ctx.actor);
        const hasContract = (await q.query(
          `SELECT 1 FROM order_lines ol JOIN catalog_nodes c ON c.id = ol.offer_id WHERE ol.order_id=$1 AND ((c.data->'contract'->>'termMonths')::int > 0 OR ol.deal IS NOT NULL) LIMIT 1`, [o.id])).rows.length > 0;
        const overdue = (await q.query(`SELECT COALESCE(sum(total_minor - paid_minor - credited_minor),0) AS d FROM invoices WHERE customer_id=$1 AND status='OVERDUE'`, [o.customerId])).rows[0]!.d;
        if (hasContract && overdue > 0) return fail(q, o, ctx, `credit check declined: ${overdue} minor units overdue`);
        break;
      }
      case 'VALIDATED': {
        if (o.totalMinor === 0) { await setState(q, o, 'PAID', ctx.actor, 'nothing to pay upfront'); break; }
        await setState(q, o, 'PAYMENT_PENDING', ctx.actor);
        if (ctx.deferPayment) return; // the payment gateway confirms it later
        // Simulated mode auto-approves everything but QR. Manual mode waits for a person (or the payment webhook) to confirm.
        if (paymentMode() === 'simulated' ? o.paymentMethod === 'QR' : !ctx.paymentConfirmed) return;
        const ok = await capture(q, o, ctx.paymentReference);
        if (!ok) return fail(q, o, ctx, 'payment declined');
        await setState(q, o, 'PAID', ctx.actor);
        break;
      }
      case 'PAYMENT_PENDING': return;
      case 'PAID': {
        try {
          await reserveStock(q, o);
        } catch (e) {
          if (e instanceof DomainError) return fail(q, o, ctx, e.message);
          throw e;
        }
        await openGroups(q, o, ctx);
        await setState(q, o, 'FULFILMENT', ctx.actor);
        break;
      }
      case 'FULFILMENT': case 'AWAITING_INSTALLATION': case 'SHIPPED': case 'DELIVERED': case 'ACTIVATED':
        await progress(q, o, ctx);
        return;
      default: return;
    }
  }
  throw new Error('order did not settle'); // defensive: indicates a state-machine bug
}

/** Creates one group per kind of work in the order. Goods handed over at a retail counter are finished at once. */
async function openGroups(q: Queryable, o: Row, ctx: Ctx) {
  const lines = await orderLines(q, o.id);
  const kinds = [...new Set(lines.map((l) => l.fulfilGroup as GroupKind))];
  for (const kind of kinds) {
    await q.query('INSERT INTO order_groups (order_id, kind) VALUES ($1,$2)', [o.id, kind]);
  }
  if (kinds.includes('GOODS') && RETAIL_CHANNELS.includes(o.channel)) {
    await consumeReservations(q, o.id, 'GOODS'); // handed over at the counter
    await q.query(`UPDATE order_groups SET status='DONE', locked_at=now(), done_at=now() WHERE order_id=$1 AND kind='GOODS'`, [o.id]);
    await markPointOfNoReturn(q, o);
    o.pointOfNoReturnAt = new Date().toISOString();
    await activateLines(q, o, lines.filter((l) => l.fulfilGroup === 'GOODS' && createsService(l.offer)));
  }
  let slot = o.fulfilment?.slot as string | undefined;
  if (kinds.includes('INSTALL') && o.fulfilment?.wfm) {   // the window was held in the field-service system while the order was taken: now it becomes a job
    const r = await confirmOrderVisit(q, o, ctx.actor);
    if (!r.ok) slot = undefined;
    else { o.fulfilment = (await q.query('SELECT fulfilment FROM orders WHERE id=$1', [o.id])).rows[0]!.fulfilment; slot = o.fulfilment?.slot; }
  } else if (slot && kinds.includes('INSTALL')) await bookSlot(q, o, new Date(slot));
  await syncTasks(q, o);
}

async function bookSlot(q: Queryable, o: Row, slot: Date) {
  await q.query(`UPDATE orders SET fulfilment = fulfilment || $2::jsonb WHERE id=$1`, [o.id, JSON.stringify({ slot: slot.toISOString() })]);
  await q.query(`UPDATE installation_appointments SET status='CANCELLED' WHERE order_id=$1 AND status='BOOKED'`, [o.id]);
  await q.query(`INSERT INTO installation_appointments (shard_id, order_id, slot_start, slot_end) VALUES ($1,$2,$3,$4)`, [o.shardId, o.id, slot.toISOString(), new Date(slot.getTime() + 4 * 3_600_000).toISOString()]);
  await q.query(`UPDATE order_groups SET details = details || $2::jsonb WHERE order_id=$1 AND kind='INSTALL'`, [o.id, JSON.stringify({ slot: slot.toISOString() })]);
}

/**
 * Moves what can move: plain services switch on once any device they depend on has been delivered (immediately if there is none),
 * then the order's headline state follows. Called after every event.
 */
async function progress(q: Queryable, o: Row, ctx: Ctx) {
  const gs = await groupRows(q, o.id);
  const act = findGroup(gs, 'ACTIVATION');
  if (act?.status === 'PENDING') {
    const lines = await orderLines(q, o.id);
    const goods = findGroup(gs, 'GOODS');
    const waitsForDevice = goods && OPEN_GROUP.includes(goods.status) && lines.some((l) => l.fulfilGroup === 'GOODS' && l.status === 'ACTIVE' && (createsService(l.offer) || l.attachPosition != null)); // a plan bought with a device on a contract switches on when the device arrives
    if (!waitsForDevice) {
      await consumeReservations(q, o.id, 'ACTIVATION');
      await activateLines(q, o, lines.filter((l) => l.fulfilGroup === 'ACTIVATION' && l.status === 'ACTIVE' && createsService(l.offer)));
      await patchGroup(q, act.id, `status='DONE', done_at=now()`);
    }
  }
  await syncOrder(q, o, ctx);
}

async function orderLines(q: Queryable, orderId: string): Promise<Array<Row & { offer: OfferNode }>> {
  const rows = (await q.query('SELECT ol.*, c.kind, c.data FROM order_lines ol JOIN catalog_nodes c ON c.id = ol.offer_id WHERE ol.order_id=$1 ORDER BY ol.position, ol.id', [orderId])).rows;
  return rows.map((r) => ({ ...r, offer: { kind: r.kind, ...r.data, prices: r.data.prices ?? [] } as OfferNode }));
}

async function reserveStock(q: Queryable, o: Row) {
  const loc = o.storeId ?? MAIN_WAREHOUSE;
  const pickup = o.fulfilment?.delivery?.method === 'COLLECT' ? (o.fulfilment.delivery.pickupStoreId as string) : null;
  for (const l of await orderLines(q, o.id)) {
    const at = pickup && l.fulfilGroup === 'GOODS' ? pickup : loc; // goods collected in store come out of that store's stock
    const variant = l.options?.sku ? (l.offer.variants ?? []).find((v) => v.id === l.options.variantId) : undefined;
    for (const sku of skusFor(l.offer, variant)) await reserve(q, o.id, at, sku, l.quantity, l.fulfilGroup);
    // Line items that carry a SKU (e.g. the phone inside a bundle) reserve their own stock: item quantity x units ordered.
    const items = (await q.query(`SELECT data->>'sku' AS sku, COALESCE((data->>'quantity')::int, 1) AS qty FROM catalog_nodes WHERE parent_id=$1 AND level='LINE_ITEM' AND status='ACTIVE' AND data->>'sku' IS NOT NULL ORDER BY sort_order`, [l.offerId])).rows;
    for (const it of items) await reserve(q, o.id, at, it.sku as string, l.quantity * (it.qty as number), l.fulfilGroup);
  }
}

function paymentGateway(method: PaymentMethod, reference?: string) {
  if (method === 'ETC_CHARGE') return false;
  if (paymentMode() === 'manual') return true; // the caller already established that money was received
  return !(reference ?? '').toUpperCase().startsWith('DECLINE'); // simulated PSP
}

/** Splits an amount paid for a line into the revenue and tax it contains. */
const shareOf = (paid: number, l: Row) => {
  const gross = l.netMinor + l.taxMinor;
  const net = gross > 0 ? Math.round((paid * l.netMinor) / gross) : paid;
  return { net, tax: paid - net };
};

async function capture(q: Queryable, o: Row, reference?: string, gatewayRef?: string): Promise<boolean> {
  if (!paymentGateway(o.paymentMethod, reference)) return false;
  await q.query(
    `INSERT INTO payments (shard_id, order_id, method, status, amount_minor, currency, gateway_ref, reference, idempotency_key)
     VALUES ($1,$2,$3,'CAPTURED',$4,$5,$6,$7,$8)`,
    [o.shardId, o.id, o.paymentMethod, o.totalMinor, o.currency, gatewayRef ?? `sim_${o.id.slice(0, 8)}`, reference ?? null, `order-${o.id}`],
  );
  const lines = await orderLines(q, o.id);
  const revenue = new Map<string, number>();
  let tax = 0;
  for (const l of lines) {
    const { net, tax: t } = shareOf(l.paidNowMinor, l);
    const key = isGoods(l.offer) ? `${GL.GOODS_REVENUE}|GOODS` : `${GL.SERVICE_REVENUE}|ONE_TIME`; // the stream tells the posting rules which SAP account it goes to
    revenue.set(key, (revenue.get(key) ?? 0) + net);
    tax += t;
  }
  await postJournal(q, {
    date: today(), sourceType: 'ORDER', sourceId: o.id, currency: o.currency,
    lines: [
      { account: GL.CASH, debit: o.totalMinor, description: `Order ${o.number ?? o.id.slice(0, 8)} receipt (${o.paymentMethod})` },
      ...[...revenue].map(([key, credit]) => { const [account, stream] = key.split('|') as [string, RevenueStream]; return { account, stream, credit, description: `Order ${o.number ?? o.id.slice(0, 8)} revenue` }; }),
      { account: GL.TAX_PAYABLE, credit: tax, description: `Order ${o.number ?? o.id.slice(0, 8)} ${(await marketFor(q, o.marketCode)).taxName}` },
    ],
  });
  return true;
}

async function fail(q: Queryable, o: Row, ctx: Ctx, reason: string) {
  await releaseReservations(q, o.id);
  await releaseOrderNumbering(q, o.id, 'system');
  await q.query(`UPDATE order_lines SET status='CANCELLED' WHERE order_id=$1 AND status='ACTIVE'`, [o.id]);
  const paid = (await q.query(`SELECT 1 FROM payments WHERE order_id=$1 AND status='CAPTURED'`, [o.id])).rows.length > 0;
  if (paid) await refund(q, o, await orderLines(q, o.id), { retainMinor: 0, clawbackMinor: 0, label: 'Order failed', all: true });
  await setState(q, o, 'FAILED', ctx.actor, reason);
}

// ───────────────────────── refunds ─────────────────────────
interface RefundSpec { retainMinor: number; clawbackMinor: number; label: string; all?: boolean }
/**
 * Gives money back for some lines: reverses their revenue and tax in the ledger, minus what is kept (a call-out fee, a damage deduction, or a bundle
 * discount the customer no longer qualifies for, which stays as revenue). Returns the cash actually refunded.
 */
async function refund(q: Queryable, o: Row, lines: Row[], spec: RefundSpec): Promise<{ refundMinor: number; retainedMinor: number }> {
  const pay = (await q.query(`SELECT id, amount_minor, refunded_minor FROM payments WHERE order_id=$1 AND status IN ('CAPTURED','REFUNDED') ORDER BY created_at LIMIT 1`, [o.id])).rows[0];
  const paid = lines.reduce((s, l) => s + (l.status === 'ACTIVE' || spec.all ? l.paidNowMinor : 0), 0);
  if (!pay || paid <= 0) return { refundMinor: 0, retainedMinor: 0 };
  const retained = Math.min(paid, spec.retainMinor + spec.clawbackMinor);
  const cash = paid - retained;
  const mk = await marketFor(q, o.marketCode);
  const rev = new Map<string, number>();
  let tax = 0;
  for (const l of lines) {
    if (!(l.status === 'ACTIVE' || spec.all) || l.paidNowMinor <= 0) continue;
    const { net, tax: t } = shareOf(l.paidNowMinor, l);
    const key = isGoods(l.offer ?? { kind: l.kind }) ? `${GL.GOODS_REVENUE}|GOODS` : `${GL.SERVICE_REVENUE}|ONE_TIME`;
    rev.set(key, (rev.get(key) ?? 0) + net); tax += t;
  }
  const keep = taxSplit(retained, mk.taxBps, true);
  await postJournal(q, {
    date: today(), sourceType: 'REFUND', sourceId: o.id, currency: o.currency,
    lines: [
      ...[...rev].map(([key, debit]) => { const [account, stream] = key.split('|') as [string, RevenueStream]; return { account, stream, debit, description: `${spec.label}: revenue reversed` }; }),
      { account: GL.TAX_PAYABLE, debit: tax, description: `${spec.label}: ${mk.taxName} reversed` },
      { account: GL.CASH, credit: paid, description: `${spec.label}: paid ${paid} (refund ${cash})` },
      { account: GL.CASH, debit: retained, description: `${spec.label}: amount kept` },
      { account: GL.SERVICE_REVENUE, stream: 'ONE_TIME', credit: keep.net, description: `${spec.label}: kept as revenue` },
      { account: GL.TAX_PAYABLE, credit: keep.tax, description: `${spec.label}: ${mk.taxName} on amount kept` },
    ],
  });
  // The payment is settled (REFUNDED) once nothing in the order is still standing on it.
  const standing = Number((await q.query(`SELECT COALESCE(sum(paid_now_minor),0) AS v FROM order_lines WHERE order_id=$1 AND status='ACTIVE' AND id <> ALL($2::uuid[])`, [o.id, lines.map((l) => l.id)])).rows[0]!.v);
  await q.query(`UPDATE payments SET refunded_minor = refunded_minor + $2, status = CASE WHEN $3 = 0 THEN 'REFUNDED'::payment_status ELSE status END WHERE id=$1`, [pay.id, cash, standing]);
  await q.query('UPDATE orders SET refunded_minor = refunded_minor + $2 WHERE id=$1', [o.id, cash]);
  return { refundMinor: cash, retainedMinor: retained };
}

/**
 * A bundle discount is only earned while the bundle holds: if a partner part leaves, the discount on what remains is taken back (from the refund).
 * Returns the lines that lose their discount and how much that is. A line is clawed back once: its rules are cleared when it is applied.
 */
async function clawback(q: Queryable, lines: Row[], leaving: Set<string>): Promise<{ total: number; lineIds: string[] }> {
  const remaining = lines.filter((l) => l.status === 'ACTIVE' && !leaving.has(l.id));
  const withDiscount = remaining.filter((l) => l.discountMinor > 0 && (l.discountRules as string[]).length > 0);
  if (!withDiscount.length) return { total: 0, lineIds: [] };
  const rules = new Map((await listBundleRules(q)).map((r) => [r.id, r]));
  const left = remaining.map((l) => ({ offerId: l.offerId as string, kind: l.offer.kind as string }));
  const lost = withDiscount.filter((l) => (l.discountRules as string[]).some((id) => { const r = rules.get(id); return r && !ruleSatisfied(r, left); }));
  return { total: lost.reduce((s, l) => s + l.discountMinor, 0), lineIds: lost.map((l) => l.id) };
}

// ───────────────────────── activation ─────────────────────────
async function activateLines(q: Queryable, o: Row, serviceLines: Array<Row & { offer: OfferNode }>) {
  const lines = serviceLines.filter((l) => l.status === 'ACTIVE');
  if (!lines.length) return;
  const mk = await marketFor(q, o.marketCode);
  let accountId: string | null = o.accountId;
  if (!accountId) {
    const a = (await q.query(`SELECT id FROM accounts WHERE customer_id=$1 AND status='ACTIVE' ORDER BY created_at LIMIT 1`, [o.customerId])).rows[0];
    if (a) accountId = a.id;
    else accountId = (await (await import('./customers.js')).createAccount(q, o.customerId, {})).id;
    await q.query('UPDATE orders SET account_id=$2 WHERE id=$1', [o.id, accountId]);
    o.accountId = accountId;
  }
  const all = await orderLines(q, o.id);
  for (const l of lines) {
    // A service type the operator defined is stored as a subscription tagged with its kind, and may end by itself.
    const kindId = serviceType(l.offer);
    const custom: ServiceKind | null = isBuiltinKind(kindId) ? null : await getServiceKind(q, kindId);
    if (!isBuiltinKind(kindId) && !custom) throw invalid(`the service type ${kindId} no longer exists`);
    const type = custom ? 'SUBSCRIPTION' : kindId;
    const telling = custom ?? (await getServiceKind(q, type)); // the service type says whether the network is told when its services start (built-in types: off until the super user turns it on)
    const validity = custom?.expires ? (l.offer.validityDays ?? custom.validityDays) : null;
    // A device bought on a contract with this plan sets the plan's contract (and is paid for on its bill) once the device has arrived.
    const device = all.find((x) => x.attachPosition === l.position && x.status === 'ACTIVE' && x.deal);
    const term = device ? (device.deal.termMonths as number) : l.offer.contract?.termMonths || null;
    const cols = `(id, shard_id, account_id, customer_id, type, identifier, offer_id, status, contract_start, contract_term_months, activated_at, order_id, service_kind, expires_at`;
    const endsAt = validity ? `now() + make_interval(days => ${Number(validity)})` : 'NULL';
    if (l.quantity > 1) {
      if (type !== 'IOT' && type !== 'MOBILE' && type !== 'SUBSCRIPTION') throw invalid(`cannot bulk-activate ${type}`);
      const prefix = type === 'MOBILE' ? mk.dialCode : type === 'IOT' ? 'IOT' : custom ? custom.identifierPrefix : 'SUB';
      const seq = type === 'MOBILE' ? 'msisdn_seq' : 'circuit_seq';
      await q.query(
        `INSERT INTO services ${cols}) SELECT gen_random_uuid(), $1, $2, $3, $4, $5 || lpad(nextval('${seq}')::text, 10, '0'), $6, 'ACTIVE', now(), $7, now(), $8, $10, ${endsAt} FROM generate_series(1, $9::int)`,
        [o.shardId, accountId, o.customerId, type, prefix, l.offerId, term, o.id, l.quantity, custom?.id ?? null],
      );
      if (telling?.announceStart) for (const s of (await q.query('SELECT id, account_id, identifier, offer_id, expires_at FROM services WHERE order_id=$1 AND offer_id=$2 AND service_kind IS NOT DISTINCT FROM $3', [o.id, l.offerId, custom?.id ?? null])).rows) await announceStart(q, telling, { id: s.id, accountId: s.accountId, identifier: s.identifier, offerId: s.offerId, expiresAt: s.expiresAt });
      for (const s of (await q.query('SELECT id FROM services WHERE order_id=$1 AND offer_id=$2 ORDER BY id', [o.id, l.offerId])).rows) await enqueueOcs(q, 'PROVISION', s.id as string);
      if (l.payMode === 'INSTALLMENT') { // every unit carries its own share of the financed amount
        const financed = l.netMinor + l.taxMinor - l.downPaymentMinor, n = l.installmentMonths as number, unit = Math.floor(financed / l.quantity), each = Math.floor(unit / n);
        const rem = financed - each * n * l.quantity;
        await q.query(`INSERT INTO service_charges (shard_id, service_id, account_id, kind, description, amount_minor, remaining_cycles)
                       SELECT $1, s.id, $2, 'INSTALLMENT', $3, $4, $5 FROM services s WHERE s.order_id=$6 AND s.offer_id=$7 AND NOT EXISTS (SELECT 1 FROM service_charges c WHERE c.service_id = s.id)`,
          [o.shardId, accountId, `${l.offer.name ?? l.description} instalment (${n} mo)`, each, n, o.id, l.offerId]);
        if (rem) await q.query(`INSERT INTO service_charges (shard_id, service_id, account_id, kind, description, amount_minor, remaining_cycles)
                                SELECT $1, s.id, $2, 'ADJUSTMENT', 'Instalment rounding', $3, 1 FROM services s WHERE s.order_id=$4 AND s.offer_id=$5 ORDER BY s.id LIMIT 1`, [o.shardId, accountId, rem, o.id, l.offerId]);
      }
      continue;
    }
    let identifier: string;
    const awaitingPort = !!l.portIn && !l.msisdn; // a port-in without a temporary number: the service waits PENDING and starts when its number arrives
    if (awaitingPort) identifier = (l.portIn as { donorMsisdn: string }).donorMsisdn;
    else if (l.msisdn) { // a chosen number, or the temporary number given while a port-in is processed
      if (!/^\+\d{8,15}$/.test(l.msisdn)) throw invalid(`invalid MSISDN ${l.msisdn}, use E.164 like ${mk.dialCode}91234567`);
      identifier = l.msisdn;
    } else if (type === 'MOBILE') identifier = mk.dialCode + (await q.query(`SELECT nextval('msisdn_seq') AS n`)).rows[0]!.n;
    else if (type === 'FIBER') identifier = 'FBR-' + (await q.query(`SELECT nextval('circuit_seq') AS n`)).rows[0]!.n;
    else if (custom) identifier = custom.identifierPrefix + (await q.query(`SELECT nextval('circuit_seq') AS n`)).rows[0]!.n;
    else identifier = 'SUB-' + (await q.query(`SELECT nextval('circuit_seq') AS n`)).rows[0]!.n;
    const id = randomUUID();
    if (l.msisdn && (await q.query(`SELECT 1 FROM identifier_registry WHERE type=$1 AND identifier=$2`, [type, identifier])).rows.length) throw conflict(`number ${identifier} is already in service`);
    await q.query(
      `INSERT INTO services ${cols}) VALUES ($1,$2,$3,$4,$5,$6,$7,${awaitingPort ? "'PENDING',NULL" : "'ACTIVE',now()"},$8,${awaitingPort ? 'NULL' : 'now()'},$9,$10,${endsAt})`,
      [id, o.shardId, accountId, o.customerId, type, identifier, l.offerId, term, o.id, custom?.id ?? null],
    );
    if (telling?.announceStart && !awaitingPort) await announceStart(q, telling, { id, accountId: accountId!, identifier, offerId: l.offerId, expiresAt: validity ? new Date(Date.now() + validity * 86_400_000) : null });
    await q.query('UPDATE order_lines SET service_id=$3 WHERE id=$1 AND shard_id=$2', [l.id, o.shardId, id]);
    if ((l.iccid || l.msisdn) && !awaitingPort) { // the SIM and number come out of the pools and point at the new service
      const r = await activateResourcesTx(q, { iccid: l.iccid, serviceId: id, actor: 'order' });
      const vip = l.msisdn ? (await q.query('SELECT r.etc_multiplier_bps FROM msisdn_inventory m JOIN msisdn_vip_tier_rules r ON r.tier = m.tier WHERE m.msisdn=$1 AND r.enabled', [l.msisdn])).rows[0] : undefined;
      await q.query('UPDATE services SET iccid=$2, imsi=$3, vip_tier=$4, vip_etc_bps=$5 WHERE id=$1', [id, l.iccid ?? null, r.imsi, l.vipTier ?? null, vip && vip.etcMultiplierBps !== 10000 ? vip.etcMultiplierBps : null]);
      if (l.msisdn) await consumeMsisdnTx(q, l.msisdn, id, 'order');
    }
    if (l.portIn) await createPortInTx(q, { customerId: o.customerId, orderId: o.id, orderLineId: l.id, serviceId: id, input: l.portIn, temporaryMsisdn: awaitingPort ? null : l.msisdn, actor: 'order' });
    if (!awaitingPort) await enqueueOcs(q, 'PROVISION', id); // into the charging system, with the SIM and number it was given above
    if (device) {
      await q.query('UPDATE services SET deal=$2 WHERE id=$1', [id, JSON.stringify({ deviceLineId: device.id, deviceOfferId: device.offerId, device: device.description, termMonths: device.deal.termMonths,
        subsidyMinor: device.deal.subsidyMinor, retailMinor: device.deal.retailMinor ?? 0, waiveInLastMonths: device.deal.waiveInLastMonths ?? 1, currency: device.deal.currency })]);
      if (device.payMode === 'INSTALLMENT') { // the device is paid for on the plan's bill
        const financed = device.netMinor + device.taxMinor - device.downPaymentMinor, n = device.installmentMonths as number, each = Math.floor(financed / n), rem = financed - each * n;
        if (financed > 0) await q.query(`INSERT INTO service_charges (shard_id, service_id, account_id, kind, description, amount_minor, remaining_cycles) VALUES ($1,$2,$3,'INSTALLMENT',$4,$5,$6)`,
          [o.shardId, id, accountId, `${device.description} instalment (${n} mo)`, each, n]);
        if (rem) await q.query(`INSERT INTO service_charges (shard_id, service_id, account_id, kind, description, amount_minor, remaining_cycles) VALUES ($1,$2,$3,'ADJUSTMENT',$4,$5,1)`,
          [o.shardId, id, accountId, `Instalment rounding (${device.description})`, rem]);
      }
    }
    // Instalments: what was not paid at checkout is spread over future bills; the rounding remainder lands on the first one.
    if (l.payMode === 'INSTALLMENT') {
      const financed = l.netMinor + l.taxMinor - l.downPaymentMinor, n = l.installmentMonths as number, each = Math.floor(financed / n), rem = financed - each * n;
      if (financed > 0) await q.query(`INSERT INTO service_charges (shard_id, service_id, account_id, kind, description, amount_minor, remaining_cycles) VALUES ($1,$2,$3,'INSTALLMENT',$4,$5,$6)`,
        [o.shardId, id, accountId, `${l.offer.name ?? l.description} instalment (${n} mo)`, each, n]);
      if (rem) await q.query(`INSERT INTO service_charges (shard_id, service_id, account_id, kind, description, amount_minor, remaining_cycles) VALUES ($1,$2,$3,'ADJUSTMENT',$4,$5,1)`,
        [o.shardId, id, accountId, 'Instalment rounding', rem]);
    }
  }
  try {
    await q.query(`INSERT INTO identifier_registry (type, identifier, service_id) SELECT type::text, identifier, id FROM services WHERE order_id=$1 AND id NOT IN (SELECT service_id FROM identifier_registry)`, [o.id]);
  } catch (e) {
    if (/duplicate key/.test((e as Error).message)) throw conflict('one of the requested numbers is already in service');
    throw e;
  }
  await syncOrderGroups(q, o, 'order'); // a group plan sold here opens its group, and member lines join it
}

/** What each line of the sale is worth to the seller: what is still standing after any cancellations, plus the first month of each plan. */
async function commissionLines(q: Queryable, o: Row): Promise<import('./commission-calculator.js').SaleLine[]> {
  const mk = await marketFor(q, o.marketCode);
  const all = await orderLines(q, o.id);
  const out: import('./commission-calculator.js').SaleLine[] = [];
  for (const l of all) {
    if (l.status !== 'ACTIVE') continue;
    const svc = createsService(l.offer);
    const fee = svc ? monthlyFee(l.offer) : null;
    const basis = l.netMinor + (fee ? taxSplit(fee.amount.amountMinor, mk.taxBps, fee.taxInclusive).net * l.quantity : 0);
    // A device sold on a contract carries the contract's length, and so does the plan it is attached to.
    const device = l.deal ? l : all.find((x) => x.attachPosition === l.position && x.status === 'ACTIVE' && x.deal);
    const term = Number(device?.deal?.termMonths ?? l.offer.contract?.termMonths ?? 0);
    out.push({ lineId: l.id, offerId: l.offerId, offerKind: l.offer.kind, termMonths: term, quantity: l.quantity, basisMinor: basis, createsService: svc });
  }
  return out;
}

async function complete(q: Queryable, o: Row) {
  await setState(q, o, 'COMPLETED', 'system');
  const lines = (await commissionLines(q, o)).filter((l) => l.basisMinor > 0 || l.createsService);
  if (!lines.length) return;
  await recordOrderCommission(q, { channel: o.channel, dealerId: o.dealerId, dealerAgentId: o.dealerAgentId, salespersonId: o.salespersonId, storeId: o.storeId, commissionEligible: o.commissionEligible },
    { orderId: o.id, completedOn: today(), currency: o.currency, lines });
}

// ───────────────────────── external events ─────────────────────────
export type OrderAction =
  | { type: 'confirm_payment'; reference?: string; gatewayRef?: string }
  | { type: 'schedule_installation'; slot: string }
  | { type: 'dispatch_technician' }
  | { type: 'complete_installation' }
  | { type: 'ship'; trackingNumber?: string }
  | { type: 'deliver' }
  | { type: 'ready_for_collection' }
  | { type: 'collect' };

export const advanceOrder = (db: Db, orderId: string, action: OrderAction, actor = 'system'): Promise<Row> => db.tx((q) => advanceOrderTx(q, orderId, action, actor));
/** The same, inside a transaction the caller already has (the field-service callback moves the order along with the visit). */
export async function advanceOrderTx(q: Queryable, orderId: string, action: OrderAction, actor = 'system'): Promise<Row> {
  {
    const o = (await q.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
    if (!o) throw notFound('order', orderId);
    const ctx: Ctx = { actor };
    if (action.type === 'confirm_payment') {
      if (o.state !== 'PAYMENT_PENDING') throw rejected(`cannot confirm_payment while order is ${o.state}`);
      if (paymentMode() === 'manual' && !action.reference?.trim()) throw invalid('a payment reference (terminal approval or receipt number) is required');
      if (!(await capture(q, o, action.reference, action.gatewayRef))) { await fail(q, o, ctx, 'payment declined'); return getOrder(q, orderId); }
      await setState(q, o, 'PAID', actor);
      await drive(q, o, ctx);
      return getOrder(q, orderId);
    }
    if (TERMINAL.includes(o.state) || ['DRAFT', 'SUBMITTED', 'VALIDATED', 'PAYMENT_PENDING'].includes(o.state)) throw rejected(`cannot ${action.type} while order is ${o.state}`);
    const gs = await groupRows(q, orderId);
    const lines = await orderLines(q, orderId);
    const want = (kind: GroupKind, ...states: string[]) => {
      const g = findGroup(gs, kind);
      if (!g || !states.includes(g.status)) throw rejected(kind === 'GOODS' ? (action.type === 'ship' ? 'nothing to ship yet' : action.type === 'collect' || action.type === 'ready_for_collection' ? 'nothing is waiting to be collected' : 'nothing has been shipped') : action.type === 'schedule_installation' && g?.status === 'LOCKED' ? 'technician already dispatched' : `cannot ${action.type}: the ${kind === 'INSTALL' ? 'installation' : 'delivery'} is ${g ? g.status.toLowerCase() : 'not part of this order'}`);
      return g;
    };
    switch (action.type) {
      case 'schedule_installation': {
        want('INSTALL', 'PENDING');
        if (o.fulfilment?.wfm) throw rejected(`this installation is booked with the field-service system: move the visit from case ${o.fulfilment.wfm.caseNumber}`);
        const slot = new Date(action.slot);
        if (Number.isNaN(slot.getTime()) || slot.getTime() < Date.now()) throw invalid('slot must be a valid future date-time');
        await bookSlot(q, o, slot);
        break;
      }
      case 'dispatch_technician': {
        const g = want('INSTALL', 'PENDING');
        if (!o.fulfilment.slot) throw rejected('schedule an installation slot first');
        await consumeReservations(q, orderId, 'INSTALL'); // equipment leaves with the technician
        await patchGroup(q, g.id, `status='LOCKED', locked_at=now()`);
        await q.query(`UPDATE orders SET fulfilment = fulfilment || '{"dispatched":true}'::jsonb WHERE id=$1`, [orderId]);
        await q.query(`UPDATE installation_appointments SET status='DISPATCHED' WHERE order_id=$1 AND status='BOOKED'`, [orderId]);
        await markPointOfNoReturn(q, o);
        await note(q, o, actor, 'Technician dispatched: the installation can no longer be cancelled');
        break;
      }
      case 'complete_installation': {
        const g = want('INSTALL', 'LOCKED');
        if (!o.fulfilment.dispatched) throw rejected('dispatch the technician first');
        await q.query(`UPDATE installation_appointments SET status='DONE' WHERE order_id=$1 AND status='DISPATCHED'`, [orderId]);
        await patchGroup(q, g.id, `status='DONE', done_at=now()`);
        await activateLines(q, o, lines.filter((l) => l.fulfilGroup === 'INSTALL' && createsService(l.offer)));
        await note(q, o, actor, 'Installation completed');
        break;
      }
      case 'ship': {
        const g = want('GOODS', 'PENDING');
        if (o.fulfilment?.delivery?.method === 'COLLECT') throw rejected('this order is collected in store, not shipped');
        await consumeReservations(q, orderId, 'GOODS');
        const tracking = action.trackingNumber ?? `TRK-${String(o.number ?? orderId.slice(0, 8)).replace('-', '')}`;
        await patchGroup(q, g.id, `status='LOCKED', locked_at=now(), details = details || $2::jsonb`, [JSON.stringify({ trackingNumber: tracking })]);
        await q.query(`UPDATE orders SET fulfilment = fulfilment || $2::jsonb WHERE id=$1`, [orderId, JSON.stringify({ trackingNumber: tracking })]);
        await markPointOfNoReturn(q, o);
        await note(q, o, actor, `Goods shipped (${tracking}): the delivery can no longer be cancelled`);
        break;
      }
      case 'ready_for_collection': {
        want('GOODS', 'PENDING');
        if (o.fulfilment?.delivery?.method !== 'COLLECT') throw rejected('this order is shipped, not collected in store');
        if (o.fulfilment.readyForCollection) throw rejected('it is already marked ready for collection');
        await q.query(`UPDATE orders SET fulfilment = fulfilment || '{"readyForCollection":true}'::jsonb WHERE id=$1`, [orderId]);
        await note(q, o, actor, `Ready for collection at ${o.fulfilment.delivery.pickupStoreId}. It can still be cancelled until it is collected`);
        break;
      }
      case 'collect': {
        const g = want('GOODS', 'PENDING');
        if (o.fulfilment?.delivery?.method !== 'COLLECT') throw rejected('this order is shipped, not collected in store');
        if (!o.fulfilment.readyForCollection) throw rejected('mark it ready for collection first');
        await consumeReservations(q, orderId, 'GOODS'); // the goods leave the store with the customer
        await patchGroup(q, g.id, `status='DONE', locked_at=now(), done_at=now(), details = details || $2::jsonb`, [JSON.stringify({ collectedAt: new Date().toISOString() })]);
        await markPointOfNoReturn(q, o);
        await activateLines(q, o, lines.filter((l) => l.fulfilGroup === 'GOODS' && createsService(l.offer)));
        await note(q, o, actor, `Collected in store (${o.fulfilment.delivery.pickupStoreId})`);
        break;
      }
      case 'deliver': {
        const g = want('GOODS', 'LOCKED');
        await patchGroup(q, g.id, `status='DONE', done_at=now()`);
        await activateLines(q, o, lines.filter((l) => l.fulfilGroup === 'GOODS' && createsService(l.offer)));
        await note(q, o, actor, 'Goods delivered');
        break;
      }
    }
    await progress(q, o, ctx);
    return getOrder(q, orderId);
  }
}

// ───────────────────────── cancellation, returns and the installation SLA ─────────────────────────
// What may be cancelled, returned, flagged or auto-cancelled, and what it costs, is decided by the rule base in cancellation.ts (Settings → Cancellation).
// The engine below only enforces what physics demands: shipped goods cannot be cancelled, and an active service cannot be un-activated.
export interface GroupPolicy {
  kind: GroupKind; status: string; canCancel: boolean; needsOverride: boolean; why?: string; ruleId?: string; ruleName?: string;
  feeMinor: number; refundMinor: number; clawbackMinor: number; returnable: boolean; returnUntil?: string; atRisk?: boolean;
}
export interface Who { initiatedBy: 'CUSTOMER' | 'STAFF' | 'SYSTEM'; canOverride: boolean }
const STAFF: Who = { initiatedBy: 'STAFF', canOverride: false };

type Line = Row & { offer: OfferNode };
const paidFor = (lines: Line[], kind: GroupKind) => lines.filter((l) => l.fulfilGroup === kind && l.status === 'ACTIVE').reduce((s, l) => s + l.paidNowMinor, 0);
const physicallyCancellable = (kind: GroupKind, status: string) => (kind === 'INSTALL' ? status === 'PENDING' || status === 'LOCKED' : status === 'PENDING');

async function factsFor(q: Queryable, o: Row, g: Row, lines: Line[], now: Date, who: Who, extra: { returnCondition?: string } = {}): Promise<Facts> {
  const kind = g.kind as GroupKind;
  const mine = lines.filter((l) => l.fulfilGroup === kind && l.status === 'ACTIVE');
  const seg = (await q.query('SELECT segment FROM customers WHERE id=$1', [o.customerId])).rows[0]?.segment as string | undefined;
  const hrs = (from: unknown) => (from ? (now.getTime() - new Date(from as string).getTime()) / 3_600_000 : null);
  const slot = kind === 'INSTALL' && o.fulfilment?.slot ? new Date(o.fulfilment.slot) : null;
  const opened = hrs(g.createdAt) ?? 0;
  return {
    groupStatus: g.status, hoursToVisit: slot ? (slot.getTime() - now.getTime()) / 3_600_000 : null, hoursOpen: opened, daysOpen: opened / 24,
    hoursSinceLocked: hrs(g.lockedAt), daysSinceDelivered: kind === 'GOODS' && g.status === 'DONE' && g.doneAt ? (hrs(g.doneAt) as number) / 24 : null,
    returnCondition: extra.returnCondition ?? null, initiatedBy: who.initiatedBy, channel: o.channel, segment: seg ?? null, market: String(o.marketCode).trim(), paymentMethod: o.paymentMethod,
    paidMinor: mine.reduce((s, l) => s + l.paidNowMinor, 0), hasInstalments: mine.some((l) => l.payMode === 'INSTALLMENT'), hasContract: mine.some((l) => (l.offer.contract?.termMonths ?? 0) > 0),
    offerKinds: [...new Set(mine.map((l) => l.offer.kind as string))],
  };
}
const loadRules = async (q: Queryable) => ({ rules: await listRules(q), settings: await getCancellationSettings(q) });

interface CancelPlan { per: Map<GroupKind, { paid: number; fee: number; claw: number; refund: number; decision: CancellationDecision }>; clawLineIds: string[] }

/**
 * Works out what cancelling these parts together would refund: each part's money paid, what its rule keeps, and the bundle discount taken back from
 * what stays behind. Planned jointly so that cancelling a whole bundle never claws a discount back from a part that is leaving anyway.
 */
async function planCancel(q: Queryable, o: Row, gs: Row[], lines: Line[], kinds: GroupKind[], now: Date, who: Who, action: 'CANCEL' | 'AUTO_CANCEL' = 'CANCEL'): Promise<CancelPlan> {
  const { rules, settings } = await loadRules(q);
  const leaving = new Set(lines.filter((l) => kinds.includes(l.fulfilGroup) && l.status === 'ACTIVE').map((l) => l.id));
  const cl = await clawback(q, lines, leaving);
  let toTake = cl.total;
  const per: CancelPlan['per'] = new Map();
  for (const kind of kinds) {
    const g = findGroup(gs, kind)!;
    const paid = paidFor(lines, kind);
    const decision = decide(rules, settings, { action, group: kind, facts: await factsFor(q, o, g, lines, now, who), paidMinor: paid, canOverride: who.canOverride });
    const fee = decision.allow ? Math.min(paid, decision.retainedMinor) : 0;
    const claw = Math.min(Math.max(0, paid - fee), toTake);
    toTake -= claw;
    per.set(kind, { paid, fee, claw, refund: Math.max(0, paid - fee - claw), decision });
  }
  return { per, clawLineIds: cl.lineIds };
}

/** A plan bought with a device on a contract cannot be cancelled on its own while the device stays: the contract would have nothing to stand on. */
const planNeedsItsDevice = (lines: Line[], gs: Row[], kinds: GroupKind[]): boolean =>
  kinds.includes('ACTIVATION') && !kinds.includes('GOODS') && lines.some((l) => l.status === 'ACTIVE' && l.attachPosition != null && gs.find((g) => g.kind === l.fulfilGroup)?.status !== 'CANCELLED');

async function policyFor(q: Queryable, o: Row, g: Row, gs: Row[], lines: Line[], now: Date, who: Who): Promise<GroupPolicy> {
  const kind = g.kind as GroupKind;
  const base: GroupPolicy = { kind, status: g.status, canCancel: false, needsOverride: false, feeMinor: 0, refundMinor: 0, clawbackMinor: 0, returnable: false };
  if (g.atRisk) base.atRisk = true;
  if (g.status === 'CANCELLED' || g.status === 'RETURNED') return { ...base, why: g.status === 'RETURNED' ? 'Returned.' : 'Already cancelled.' };
  const { rules, settings } = await loadRules(q);
  if (g.status === 'DONE' && kind === 'GOODS') {
    const paid = paidFor(lines, kind);
    const r = decide(rules, settings, { action: 'RETURN', group: kind, facts: await factsFor(q, o, g, lines, now, who, { returnCondition: 'GOOD' }), paidMinor: paid, canOverride: who.canOverride });
    const days = deadlineDays(r.matched, 'daysSinceDelivered');
    base.returnable = r.allow || r.needsOverride;
    if (r.allow) { base.refundMinor = Math.max(0, paid - r.retainedMinor); if (days !== null && g.doneAt) base.returnUntil = new Date(new Date(g.doneAt).getTime() + days * DAY).toISOString(); }
    base.needsOverride = r.needsOverride;
    base.ruleId = r.rule?.id; base.ruleName = r.rule?.name;
  }
  const facts = await factsFor(q, o, g, lines, now, who);
  const dec = decide(rules, settings, { action: 'CANCEL', group: kind, facts, paidMinor: paidFor(lines, kind), canOverride: who.canOverride });
  const goodsGroup = findGroup(gs, 'GOODS');
  const tied = kind === 'ACTIVATION' && planNeedsItsDevice(lines, gs, ['ACTIVATION']) && !(goodsGroup && physicallyCancellable('GOODS', goodsGroup.status)); // cancelled together with the device or not at all
  const physical = physicallyCancellable(kind, g.status) && !tied;
  if (!physical || !dec.allow) {
    return { ...base, needsOverride: base.needsOverride || (physical && dec.needsOverride), ruleId: base.ruleId ?? dec.rule?.id, ruleName: base.ruleName ?? dec.rule?.name,
      why: tied ? 'This plan was bought with a device on a contract that has been shipped: it can no longer be cancelled on its own.' : !physical && dec.allow ? 'This part can no longer be cancelled.' : dec.message };
  }
  const plan = (await planCancel(q, o, gs, lines, [kind], new Date(now), who)).per.get(kind)!;
  return { ...base, canCancel: true, ruleId: dec.rule?.id, ruleName: dec.rule?.name, feeMinor: plan.fee, clawbackMinor: plan.claw, refundMinor: plan.refund, why: plan.fee > 0 || plan.decision.message ? plan.decision.message : undefined };
}

/** What can still be cancelled, what each part would refund, and why the rest cannot. Used by the order screen and by cancellation itself. */
export async function cancellationPreview(q: Queryable, orderId: string, now = new Date(), who: Who = STAFF): Promise<GroupPolicy[]> {
  const o = (await q.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0];
  if (!o) throw notFound('order', orderId);
  const [gs, lines] = await Promise.all([groupRows(q, orderId), orderLines(q, orderId)]);
  return Promise.all(gs.map((g) => policyFor(q, o, g, gs, lines, now, who)));
}

/** What "Cancel order" would do right now: every cancellable part together, with the combined refund. */
export async function cancelAllPreview(q: Queryable, o: Row, now = new Date(), who: Who = STAFF): Promise<{ kinds: GroupKind[]; refundMinor: number; feeMinor: number; clawbackMinor: number }> {
  const [gs, lines] = await Promise.all([groupRows(q, o.id), orderLines(q, o.id)]);
  const kinds = (await Promise.all(gs.map((g) => policyFor(q, o, g, gs, lines, now, who)))).filter((p) => p.canCancel).map((p) => p.kind);
  if (!kinds.length) return { kinds, refundMinor: 0, feeMinor: 0, clawbackMinor: 0 };
  const all = [...(await planCancel(q, o, gs, lines, kinds, now, who)).per.values()];
  return { kinds, refundMinor: all.reduce((s, p) => s + p.refund, 0), feeMinor: all.reduce((s, p) => s + p.fee, 0), clawbackMinor: all.reduce((s, p) => s + p.claw, 0) };
}

async function cancelGroups(q: Queryable, o: Row, kinds: GroupKind[], reason: string, actor: string, who: Who, action: 'CANCEL' | 'AUTO_CANCEL' = 'CANCEL', now = new Date()) {
  const [gs, lines] = [await groupRows(q, o.id), await orderLines(q, o.id)];
  if (planNeedsItsDevice(lines, gs, kinds)) throw rejected('This plan was bought with a device on a contract: cancel the device with it.');
  const plan = await planCancel(q, o, gs, lines, kinds, now, who, action);
  for (const kind of kinds) {
    const g = findGroup(gs, kind)!;
    const p = plan.per.get(kind)!;
    if (!p.decision.allow || !physicallyCancellable(kind, g.status)) throw rejected(p.decision.message || 'that part can no longer be cancelled');
    const mine = lines.filter((l) => l.fulfilGroup === kind && l.status === 'ACTIVE');
    await releaseReservations(q, o.id, kind);
    if (kind === 'ACTIVATION') await releaseOrderNumbering(q, o.id, actor); // the SIM and number of a plan that is not going ahead
    const r = await refund(q, o, mine, { retainMinor: p.fee, clawbackMinor: p.claw, label: `Cancelled ${kind.toLowerCase()}` });
    await q.query(`UPDATE order_lines SET status='CANCELLED' WHERE order_id=$1 AND fulfil_group=$2 AND status='ACTIVE'`, [o.id, kind]);
    if (kind === 'INSTALL') {
      await q.query(`UPDATE installation_appointments SET status='CANCELLED' WHERE order_id=$1 AND status IN ('BOOKED','DISPATCHED')`, [o.id]);
      await cancelOrderVisit(q, o.id, reason, actor);
    }
    await patchGroup(q, g.id, `status='CANCELLED', cancelled_at=now(), refunded_minor=$2, fee_minor=$3, details = details || $4::jsonb`, [r.refundMinor, r.retainedMinor, JSON.stringify({ cancelReason: reason, rule: p.decision.rule?.id ?? null })]);
    await note(q, o, actor, `${({ GOODS: 'Delivery', INSTALL: 'Installation', ACTIVATION: 'Service activation' })[kind]} cancelled${r.refundMinor ? `, ${fmt(r.refundMinor, o.currency)} refunded` : ''}${r.retainedMinor ? `, ${fmt(r.retainedMinor, o.currency)} kept` : ''}: ${reason}`);
  }
  if (plan.clawLineIds.length) await q.query(`UPDATE order_lines SET discount_rules='{}' WHERE id = ANY($1::uuid[])`, [plan.clawLineIds]); // the bundle is broken: that discount has been taken back
}

/**
 * Cancels the parts of an order the rules allow, each refunded on its own (stock goes back, appointments are released). By default every cancellable
 * part is cancelled and the rest stay; pass `groups` to cancel just some. Orders not yet paid are cancelled whole.
 */
export async function cancelOrder(db: Db, orderId: string, reason: string, actor = 'system', opts: { groups?: GroupKind[]; initiatedBy?: Who['initiatedBy']; canOverride?: boolean } = {}): Promise<Row> {
  const who: Who = { initiatedBy: opts.initiatedBy ?? (actor === 'system' ? 'SYSTEM' : 'STAFF'), canOverride: !!opts.canOverride };
  return db.tx(async (q) => {
    const o = (await q.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
    if (!o) throw notFound('order', orderId);
    if (TERMINAL.includes(o.state)) throw rejected(`order is already ${o.state}`);
    const gs = await groupRows(q, orderId);
    if (!gs.length) { // not paid yet: nothing is fulfilling
      await releaseReservations(q, orderId);
      await releaseOrderNumbering(q, orderId, actor);
      await q.query(`UPDATE order_lines SET status='CANCELLED' WHERE order_id=$1`, [orderId]);
      await setState(q, o, 'CANCELLED', actor, reason || 'cancelled');
      return getOrder(q, orderId);
    }
    const lines = await orderLines(q, orderId);
    const now = new Date();
    const policies = await Promise.all(gs.map((g) => policyFor(q, o, g, gs, lines, now, who)));
    const asked = opts.groups?.length ? opts.groups : null;
    if (asked) for (const k of asked) { const p = policies.find((x) => x.kind === k); if (!p) throw rejected(`this order has no ${k.toLowerCase()} part`); if (!p.canCancel) throw rejected(p.why ?? 'that part can no longer be cancelled'); }
    const kinds = (asked ?? policies.filter((p) => p.canCancel).map((p) => p.kind));
    if (!kinds.length) {
      const whys = [...new Set(policies.filter((p) => p.why && !['Already cancelled.', 'Returned.'].includes(p.why)).map((p) => p.why!))];
      throw rejected(`Past the point of no return${whys.length ? `: ${whys.join(' ')}` : ' (goods shipped or technician dispatched); raise a return or termination instead'}`);
    }
    await cancelGroups(q, o, kinds, reason || 'cancelled', actor, who);
    await progress(q, o, { actor }); // what is left may now be able to finish (e.g. a plan no longer waiting for a cancelled device)
    return getOrder(q, orderId);
  });
}

/** Return of delivered goods as the rules allow: refund (less what the rule keeps and any damage deduction), stock back, device contract ended without a termination charge. */
export async function returnGoods(db: Db, orderId: string, o2: { reason: string; deductionMinor?: number; condition?: string; restock?: boolean }, actor = 'system', opts: { canOverride?: boolean } = {}): Promise<Row> {
  const who: Who = { initiatedBy: 'STAFF', canOverride: !!opts.canOverride };
  return db.tx(async (q) => {
    const o = (await q.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
    if (!o) throw notFound('order', orderId);
    const gs = await groupRows(q, orderId);
    const g = findGroup(gs, 'GOODS');
    if (!g) throw rejected('this order has no goods to return');
    if (g.status === 'RETURNED') throw rejected('these goods were already returned');
    if (g.status === 'CANCELLED') throw rejected('these goods were cancelled, not delivered');
    const lines = await orderLines(q, orderId);
    const mine = lines.filter((l) => l.fulfilGroup === 'GOODS' && l.status === 'ACTIVE');
    const paid = mine.reduce((s, l) => s + l.paidNowMinor, 0);
    const { rules, settings } = await loadRules(q);
    const dec = decide(rules, settings, { action: 'RETURN', group: 'GOODS', facts: await factsFor(q, o, g, lines, new Date(), who, { returnCondition: o2.condition ?? 'GOOD' }), paidMinor: paid, canOverride: who.canOverride });
    if (g.status !== 'DONE' || !dec.allow) throw rejected(g.status !== 'DONE' ? 'the goods have not been delivered yet: wait for delivery, then return them' : dec.message);
    const cap = Math.floor((paid * dec.maxDeductionBps) / 10_000);
    if ((o2.deductionMinor ?? 0) > cap) throw rejected(`the damage deduction for this return can be at most ${fmt(cap, o.currency)}`);
    const deduction = Math.max(0, Math.min(paid, o2.deductionMinor ?? 0));
    const keep = Math.min(paid, dec.retainedMinor + deduction);
    const claw = await clawback(q, lines, new Set(mine.map((l) => l.id)));
    const r = await refund(q, o, mine, { retainMinor: keep, clawbackMinor: Math.min(claw.total, Math.max(0, paid - keep)), label: 'Goods returned' });
    if (claw.lineIds.length) await q.query(`UPDATE order_lines SET discount_rules='{}' WHERE id = ANY($1::uuid[])`, [claw.lineIds]);
    if (o2.restock !== false && (o2.condition ?? 'GOOD') === 'GOOD') await restockConsumed(q, orderId, 'GOODS');
    // A device bought on a contract goes back with the contract: the line ends, instalments stop, no early-termination charge.
    const offerIds = mine.filter((l) => createsService(l.offer)).map((l) => l.offerId);
    if (offerIds.length) {
      const svc = (await q.query(`UPDATE services SET status='TERMINATED', terminated_at=now(), version=version+1, updated_at=now() WHERE order_id=$1 AND offer_id = ANY($2) AND status <> 'TERMINATED' RETURNING id`, [orderId, offerIds])).rows;
      for (const s of svc) await q.query('UPDATE service_charges SET remaining_cycles = 0 WHERE service_id=$1', [s.id]);
    }
    // A device bought on a contract with a plan goes back with the contract: the plan stays, but its contract and the device instalments end, with no charge.
    for (const dl of mine.filter((l) => l.deal)) {
      const svc = (await q.query(`UPDATE services SET deal=NULL, contract_term_months=NULL, version=version+1, updated_at=now() WHERE deal->>'deviceLineId' = $1 AND status <> 'TERMINATED' RETURNING id`, [dl.id])).rows;
      for (const s of svc) await q.query(`UPDATE service_charges SET remaining_cycles = 0 WHERE service_id=$1 AND (description LIKE $2 OR description = $3)`, [s.id, `${dl.description} instalment%`, `Instalment rounding (${dl.description})`]);
    }
    await q.query(`UPDATE order_lines SET status='RETURNED' WHERE order_id=$1 AND fulfil_group='GOODS' AND status='ACTIVE'`, [orderId]);
    for (const l of mine) await clawBack(q, { orderId, orderLineId: l.id, trigger: 'ORDER_CANCELLED', on: today() }, actor); // the sale is undone: its commission goes back by the plan's policy
    await patchGroup(q, g.id, `status='RETURNED', refunded_minor=$2, fee_minor=$3, details = details || $4::jsonb`, [r.refundMinor, r.retainedMinor, JSON.stringify({ returnReason: o2.reason, returnCondition: o2.condition ?? 'GOOD', rule: dec.rule?.id ?? null, returnedAt: new Date().toISOString() })]);
    await note(q, o, actor, `Goods returned${r.refundMinor ? `, ${fmt(r.refundMinor, o.currency)} refunded` : ''}${r.retainedMinor ? `, ${fmt(r.retainedMinor, o.currency)} kept` : ''}: ${o2.reason}`);
    await audit(q, actor, 'order', orderId, 'GOODS_RETURNED', { refundMinor: r.refundMinor, deductionMinor: deduction, rule: dec.rule?.id ?? null });
    return getOrder(q, orderId);
  });
}

/**
 * The service-level sweep, driven by the rule base: open parts matching a "flag as at risk" rule are flagged for follow-up, and open parts matching an
 * "automatically cancel" rule are cancelled (refunded as that rule says). Run it daily.
 */
export async function sweepOrders(db: Db, now = new Date(), actor = 'system'): Promise<{ atRisk: number; cancelled: number }> {
  const who: Who = { initiatedBy: 'SYSTEM', canOverride: false };
  const { rules, settings } = await loadRules(db);
  if (!rules.some((r) => r.enabled && (r.action === 'FLAG_AT_RISK' || r.action === 'AUTO_CANCEL'))) return { atRisk: 0, cancelled: 0 };
  let atRisk = 0, cancelled = 0, cursor = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = (await db.query(`SELECT id, order_id FROM order_groups WHERE status IN ('PENDING','LOCKED') AND id > $1 ORDER BY id LIMIT 200`, [cursor])).rows;
    if (!page.length) break;
    cursor = page[page.length - 1]!.id;
    for (const pg of page) await db.tx(async (q) => {
      const o = (await q.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [pg.orderId])).rows[0];
      if (!o || TERMINAL.includes(o.state)) return;
      const gs = await groupRows(q, o.id);
      const g = gs.find((x) => x.id === pg.id);
      if (!g || !OPEN_GROUP.includes(g.status)) return;
      const lines = await orderLines(q, o.id);
      const facts = await factsFor(q, o, g, lines, now, who);
      const paid = paidFor(lines, g.kind);
      const flag = g.atRisk ? null : decide(rules, settings, { action: 'FLAG_AT_RISK', group: g.kind, facts, paidMinor: paid });
      if (flag?.matched && flag.allow) { await patchGroup(q, g.id, 'at_risk = true'); await audit(q, actor, 'order', o.id, `${g.kind}_AT_RISK`, { rule: flag.rule!.id }); atRisk++; }
      if (g.status === 'PENDING') {
        const auto = decide(rules, settings, { action: 'AUTO_CANCEL', group: g.kind, facts, paidMinor: paid });
        if (auto.matched && auto.allow && physicallyCancellable(g.kind, g.status) && !planNeedsItsDevice(lines, gs, [g.kind])) {
          await cancelGroups(q, o, [g.kind], `automatic: ${auto.matched.name}`, actor, who, 'AUTO_CANCEL', now);
          await progress(q, o, { actor });
          cancelled++;
        }
      }
    });
  }
  return { atRisk, cancelled };
}

export async function getOrder(q: Queryable, ref: string, who: Who = STAFF): Promise<Row> {
  // An order is found by its id or by its number (20261014-00042).
  const byNumber = /^\d{8}-\d{5,}$/.test(ref);
  const o = (await q.query(
    `SELECT o.*, c.display_name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE ${byNumber ? 'o.number' : 'o.id'}=$1`, [ref])).rows[0];
  if (!o) throw notFound('order', ref);
  const id = o.id as string;
  const [lines, history, payments, services, appts, groups] = await Promise.all([
    q.query('SELECT * FROM order_lines WHERE order_id=$1 ORDER BY id', [id]),
    q.query('SELECT from_state, to_state, actor, reason, occurred_at FROM order_state_history WHERE order_id=$1 ORDER BY id', [id]),
    q.query('SELECT id, method, status, amount_minor, refunded_minor, reference FROM payments WHERE order_id=$1', [id]),
    q.query('SELECT id, type, identifier, status FROM services WHERE order_id=$1 ORDER BY identifier LIMIT 50', [id]),
    q.query('SELECT slot_start, slot_end, status FROM installation_appointments WHERE order_id=$1 ORDER BY slot_start', [id]),
    cancellationPreview(q, id, new Date(), who),
  ]);
  const svcCount = (await q.query('SELECT count(*) AS n FROM services WHERE order_id=$1', [id])).rows[0]!.n;
  const open = !TERMINAL.includes(o.state);
  const cancellable = open && (groups.length ? groups.some((g) => g.canCancel) : true);
  const meta = new Map((await groupRows(q, id)).map((g) => [g.kind, g]));
  return {
    ...o, lines: lines.rows, history: history.rows, payments: payments.rows, services: services.rows, serviceCount: svcCount, appointments: appts.rows,
    groups: groups.map((g) => { const m = meta.get(g.kind); const closed = g.status === 'CANCELLED' || g.status === 'RETURNED'; return { ...g, lockedAt: m?.lockedAt ?? null, doneAt: m?.doneAt ?? null, dueAt: m?.dueAt ?? null, refundedMinor: m?.refundedMinor ?? 0, feeMinor: closed ? m?.feeMinor ?? 0 : g.feeMinor, details: m?.details ?? {} }; }),
    cancelAll: open ? await cancelAllPreview(q, o, new Date(), who) : null,
    nextActions: nextActions(o, [...meta.values()]), cancellable,
  };
}

function nextActions(o: Row, gs: Row[]): string[] {
  if (o.state === 'PAYMENT_PENDING') return ['confirm_payment'];
  const out: string[] = [];
  const install = findGroup(gs, 'INSTALL'), goods = findGroup(gs, 'GOODS');
  if (install?.status === 'PENDING') out.push(...(o.fulfilment?.wfm ? [] : ['schedule_installation']), ...(o.fulfilment?.slot ? ['dispatch_technician'] : []));  // a visit booked with the field-service system is moved from its case
  if (install?.status === 'LOCKED') out.push('complete_installation');
  if (goods?.status === 'PENDING') out.push(...(o.fulfilment?.delivery?.method === 'COLLECT' ? [o.fulfilment.readyForCollection ? 'collect' : 'ready_for_collection'] : ['ship']));
  if (goods?.status === 'LOCKED') out.push('deliver');
  return TERMINAL.includes(o.state) ? [] : out;
}

export async function listOrders(q: Queryable, f: { customerId?: string; storeId?: string; dealerId?: string; state?: string; channel?: string; q?: string; limit?: number; cursor?: string } = {}): Promise<Page<Row>> {
  const limit = pageSize(f.limit);
  const { params, p } = sqlBuilder();
  const where: string[] = [];
  if (f.customerId) where.push(`o.customer_id = ${p(f.customerId)}`);
  if (f.storeId) where.push(`o.store_id = ${p(f.storeId)}`);
  if (f.dealerId) where.push(`o.dealer_id = ${p(f.dealerId)}`);
  if (f.state) where.push(`o.state = ${p(f.state)}`);
  if (f.channel) where.push(`o.channel = ${p(f.channel)}`);
  // Search: an order id, or whoever the customer is (name words, e-mail, phone / mobile number).
  const asked = (f.q ?? '').trim();
  const byNumber = /^\d{8}(-\d{0,5})?$/.test(asked) || /^\d{8}-$/.test(asked);
  const pq = byNumber ? ({ kind: 'none' } as const) : await parseQuery(q, f.q);
  if (byNumber) where.push(`o.number LIKE ${p(asked + '%')}`);
  else if (pq.kind === 'id') where.push(`(o.id = ${p(pq.id)}::uuid OR o.customer_id = ${p(pq.id)}::uuid)`);
  else { const ids = customerIdsMatching(pq, p); if (ids) where.push(`o.customer_id IN (${ids})`); }
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(o.created_at, o.id) < (${p(cur[0])}::timestamptz, ${p(cur[1])}::uuid)`);
  const rows = (await q.query(
    `SELECT o.id, o.number, o.state, o.channel, o.total_minor, o.currency, o.created_at, o.created_at::text AS cursor_ts, o.store_id, o.salesperson_id, c.display_name AS customer_name, o.customer_id,
       (SELECT string_agg(ol.description || CASE WHEN ol.quantity > 1 THEN ' x' || ol.quantity ELSE '' END, ', ') FROM order_lines ol WHERE ol.order_id = o.id) AS summary
     FROM orders o JOIN customers c ON c.id = o.customer_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY o.created_at DESC, o.id DESC LIMIT ${p(limit + 1)}`, params)).rows;
  return tsPage(rows as Array<Row & { id: string; cursorTs: string }>, limit);
}
