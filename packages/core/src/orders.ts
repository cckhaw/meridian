import { randomUUID } from 'node:crypto';
import type { OfferNode, OrderChannel, OrderState, PaymentMethod } from '@meridian/types';
import { COMMISSION_BPS, GL, market } from './config.js';
import type { Db, Queryable, Row } from './db.js';
import { getOffer, monthlyFee } from './catalog.js';
import { getCustomer } from './customers.js';
import { conflict, DomainError, invalid, notFound, rejected } from './errors.js';
import { MAIN_WAREHOUSE, consumeReservations, releaseReservations, reserve } from './inventory.js';
import { postJournal } from './ledger.js';
import { today } from './dates.js';
import { taxSplit } from './tax.js';

export interface OrderInput {
  customerId?: string;
  accountId?: string;
  channel: OrderChannel;
  marketCode?: string;
  lines: Array<{ offerId: string; quantity?: number; msisdn?: string; serialNumber?: string }>;
  payment: { method: PaymentMethod; installmentMonths?: number; reference?: string };
  attribution?: { storeId?: string; salespersonId?: string; dealerId?: string };
  deliveryAddress?: string;
  actor?: string;
}

const RETAIL: OrderChannel[] = ['RETAIL_ASSISTED', 'QUICK_SALE'];
const GOODS_KINDS = ['PHYSICAL_GOOD', 'WEARABLE', 'SIM_DEVICE'];
const MAX_BULK = 1_000_000;
const TERMINAL: OrderState[] = ['COMPLETED', 'CANCELLED', 'FAILED'];

/** Offers that produce a billable service when the order activates. */
function createsService(o: OfferNode): boolean {
  if (o.kind === 'PHYSICAL_GOOD') return false;
  if (o.kind === 'WEARABLE') return !!monthlyFee(o);
  return true;
}
const serviceType = (o: OfferNode) => (o.kind === 'FIBER' ? 'FIBER' : o.kind === 'IOT_CONNECTIVITY' ? 'IOT' : o.kind === 'VAS' || o.kind === 'NON_TELCO_SUBSCRIPTION' ? 'SUBSCRIPTION' : 'MOBILE');

async function setState(q: Queryable, o: Row, to: OrderState, actor: string, reason?: string) {
  await q.query(
    `UPDATE orders SET state=$3::order_state, failure_reason = CASE WHEN $3::order_state IN ('FAILED','CANCELLED') THEN $4 ELSE failure_reason END,
       completed_at = CASE WHEN $3::order_state = 'COMPLETED' THEN now() ELSE completed_at END, version = version + 1, updated_at = now()
     WHERE id=$1 AND shard_id=$2`,
    [o.id, o.shardId, to, reason ?? null],
  );
  await q.query('INSERT INTO order_state_history (shard_id, order_id, from_state, to_state, actor, reason) VALUES ($1,$2,$3,$4,$5,$6)', [o.shardId, o.id, o.state, to, actor, reason ?? null]);
  o.state = to;
}

export async function walkInCustomer(q: Queryable, marketCode: string): Promise<string> {
  const ref = `WALKIN-${marketCode}`;
  const { createCustomer } = await import('./customers.js');
  const found = (await q.query('SELECT id FROM customers WHERE display_name=$1 AND market_code=$2 LIMIT 1', ['Walk-in customer', marketCode])).rows[0];
  if (found) return found.id;
  return (await createCustomer(q, { segment: 'ENTERPRISE', displayName: 'Walk-in customer', idDocument: ref, marketCode, account: false })).customer.id;
}

export async function placeOrder(db: Db, input: OrderInput): Promise<Row> {
  return db.tx(async (q) => {
    const actor = input.actor ?? input.attribution?.salespersonId ?? 'system';
    if (!input.lines.length) throw invalid('an order needs at least one line');
    const marketCode = input.marketCode ?? 'SG';
    const mk = market(marketCode);

    // ── customer / account ──
    let customerId = input.customerId;
    if (!customerId) {
      if (input.channel !== 'QUICK_SALE') throw invalid('customerId is required (only QUICK_SALE may be anonymous)');
      customerId = await walkInCustomer(q, marketCode);
    }
    const customer = await getCustomer(q, customerId);
    if (customer.status !== 'ACTIVE') throw rejected(`customer is ${customer.status}`);
    let accountId = input.accountId ?? null;
    if (accountId) {
      const a = (await q.query('SELECT customer_id FROM accounts WHERE id=$1', [accountId])).rows[0];
      if (!a || a.customerId !== customerId) throw invalid('accountId does not belong to this customer');
    }

    // ── lines: load offers, validate catalog rules ──
    const offers = new Map<string, OfferNode>();
    for (const l of input.lines) {
      const qty = l.quantity ?? 1;
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_BULK) throw invalid(`quantity must be 1-${MAX_BULK}`);
      if (l.msisdn && qty !== 1) throw invalid('a port-in/chosen number needs quantity 1');
      if (!offers.has(l.offerId)) {
        const o = await getOffer(q, l.offerId);
        if (o.status !== 'ACTIVE') throw rejected(`offer ${o.name} is not active`);
        if (o.markets.length && !o.markets.includes(marketCode)) throw rejected(`offer ${o.name} is not sold in ${marketCode}`);
        offers.set(o.id, o);
      }
    }
    const ids = new Set(offers.keys());
    for (const o of offers.values()) {
      const missing = o.requires.filter((r) => !ids.has(r));
      if (missing.length) throw rejected(`${o.name} requires ${missing.join(', ')} in the same order`);
      const clash = o.excludes.filter((r) => ids.has(r));
      if (clash.length) throw rejected(`${o.name} cannot be combined with ${clash.join(', ')}`);
      if (input.channel === 'QUICK_SALE' && (o.kind !== 'PHYSICAL_GOOD' || o.contract?.termMonths)) throw rejected('quick-sale supports outright goods only');
    }
    const hasService = [...offers.values()].some(createsService);
    if (hasService && customer.displayName === 'Walk-in customer') throw rejected('services need a registered customer');
    if (input.payment.method === 'INSTALLMENT') {
      const m = input.payment.installmentMonths;
      if (![3, 6, 12, 24, 36].includes(m ?? 0)) throw invalid('installmentMonths must be 3, 6, 12, 24 or 36');
      if (!hasService) throw rejected('instalments need a service to bill against');
    }

    // ── pricing (upfront = ONE_TIME components) ──
    const priced = input.lines.map((l) => {
      const o = offers.get(l.offerId)!;
      const qty = l.quantity ?? 1;
      const split = o.prices.filter((p) => p.type === 'ONE_TIME').reduce(
        (a, p) => { const s = taxSplit(p.amount.amountMinor * qty, mk.taxBps, p.taxInclusive); return { net: a.net + s.net, tax: a.tax + s.tax, gross: a.gross + s.gross }; },
        { net: 0, tax: 0, gross: 0 },
      );
      return { l, o, qty, ...split };
    });
    const total = priced.reduce((s, p) => s + p.gross, 0);
    const net = priced.reduce((s, p) => s + p.net, 0);

    // ── persist order ──
    const orderId = randomUUID();
    const att = input.attribution ?? {};
    const eligible = !!(att.salespersonId || att.dealerId) && input.channel in COMMISSION_BPS;
    await q.query(
      `INSERT INTO orders (id, shard_id, customer_id, account_id, channel, state, total_minor, currency, market_code, store_id, salesperson_id, dealer_id,
         commission_eligible, payment_method, installment_months, fulfilment)
       VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [orderId, customer.shardId, customerId, accountId, input.channel, total, mk.currency, marketCode, att.storeId ?? null, att.salespersonId ?? null, att.dealerId ?? null,
       eligible, input.payment.method, input.payment.installmentMonths ?? null, JSON.stringify({ address: input.deliveryAddress ?? null })],
    );
    for (const p of priced) {
      await q.query(
        `INSERT INTO order_lines (shard_id, order_id, offer_id, quantity, unit_price_minor, msisdn, serial_number, description, net_minor, tax_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [customer.shardId, orderId, p.o.id, p.qty, Math.round(p.gross / p.qty), p.l.msisdn ?? null, p.l.serialNumber ?? null, p.o.name, p.net, p.tax],
      );
    }
    const o = (await q.query('SELECT * FROM orders WHERE id=$1', [orderId])).rows[0]!;
    o.state = 'DRAFT';
    await setState(q, o, 'SUBMITTED', actor);
    await drive(q, o, { actor, paymentReference: input.payment.reference, net });
    return getOrder(q, orderId);
  });
}

type Ctx = { actor: string; paymentReference?: string; net?: number };

/** Runs the order forward until it completes, fails, or needs an external event (payment confirmation, shipping, installation). */
async function drive(q: Queryable, o: Row, ctx: Ctx): Promise<void> {
  for (let guard = 0; guard < 20; guard++) {
    switch (o.state as OrderState) {
      case 'SUBMITTED': {
        await setState(q, o, 'VALIDATED', ctx.actor);
        const hasContract = (await q.query(
          `SELECT 1 FROM order_lines ol JOIN catalog_nodes c ON c.id = ol.offer_id WHERE ol.order_id=$1 AND (c.data->'contract'->>'termMonths')::int > 0 LIMIT 1`, [o.id])).rows.length > 0;
        const overdue = (await q.query(`SELECT COALESCE(sum(total_minor - paid_minor - credited_minor),0) AS d FROM invoices WHERE customer_id=$1 AND status='OVERDUE'`, [o.customerId])).rows[0]!.d;
        if (hasContract && overdue > 0) return fail(q, o, ctx, `credit check declined: ${overdue} minor units overdue`);
        break;
      }
      case 'VALIDATED': {
        if (o.totalMinor === 0 || o.paymentMethod === 'INSTALLMENT') { await setState(q, o, 'PAID', ctx.actor, o.totalMinor === 0 ? 'nothing to pay upfront' : 'paid by instalments on future bills'); break; }
        await setState(q, o, 'PAYMENT_PENDING', ctx.actor);
        if (o.paymentMethod === 'QR') return; // waits for confirm_payment
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
        const lines = await orderLines(q, o.id);
        const tasks: string[] = [];
        if (lines.some((l) => l.offer.fulfilment?.requiresInstallation)) tasks.push('INSTALL');
        const goods = lines.some((l) => l.offer.fulfilment?.requiresShipping);
        if (goods && RETAIL.includes(o.channel)) {
          await consumeReservations(q, o.id); // handed over at the counter
          await q.query('UPDATE orders SET point_of_no_return_at = now() WHERE id=$1', [o.id]);
          o.pointOfNoReturnAt = new Date().toISOString();
        } else if (goods) tasks.push('SHIP');
        await q.query('UPDATE orders SET pending_tasks=$2 WHERE id=$1', [o.id, tasks]);
        o.pendingTasks = tasks;
        await setState(q, o, 'FULFILMENT', ctx.actor);
        break;
      }
      case 'FULFILMENT': {
        if (o.pendingTasks.includes('INSTALL')) { await setState(q, o, 'AWAITING_INSTALLATION', ctx.actor); return; }
        if (o.pendingTasks.includes('SHIP')) return; // waits for ship
        await activate(q, o, ctx);
        break;
      }
      case 'AWAITING_INSTALLATION': case 'SHIPPED': return;
      case 'DELIVERED': await activate(q, o, ctx); break;
      case 'ACTIVATED': await complete(q, o, ctx); break;
      default: return;
    }
  }
  throw new Error('order did not settle'); // defensive: indicates a state-machine bug
}

async function orderLines(q: Queryable, orderId: string): Promise<Array<Row & { offer: OfferNode }>> {
  const rows = (await q.query('SELECT ol.*, c.kind, c.data FROM order_lines ol JOIN catalog_nodes c ON c.id = ol.offer_id WHERE ol.order_id=$1 ORDER BY ol.id', [orderId])).rows;
  return rows.map((r) => ({ ...r, offer: { kind: r.kind, ...r.data, prices: r.data.prices ?? [] } as OfferNode }));
}

async function reserveStock(q: Queryable, o: Row) {
  const loc = o.storeId ?? MAIN_WAREHOUSE;
  for (const l of await orderLines(q, o.id)) {
    for (const sku of (l.offer.fulfilment?.inventorySkus ?? []) as string[]) await reserve(q, o.id, loc, sku, l.quantity);
  }
}

function paymentGateway(method: PaymentMethod, reference?: string) {
  // Simulated PSP. A real adapter (Adyen/2C2P/PayNow/DuitNow) plugs in here; references starting DECLINE fail.
  return !(reference ?? '').toUpperCase().startsWith('DECLINE') && method !== 'ETC_CHARGE';
}

async function capture(q: Queryable, o: Row, reference?: string): Promise<boolean> {
  if (!paymentGateway(o.paymentMethod, reference)) return false;
  await q.query(
    `INSERT INTO payments (shard_id, order_id, method, status, amount_minor, currency, gateway_ref, reference, idempotency_key)
     VALUES ($1,$2,$3,'CAPTURED',$4,$5,$6,$7,$8)`,
    [o.shardId, o.id, o.paymentMethod, o.totalMinor, o.currency, `sim_${o.id.slice(0, 8)}`, reference ?? null, `order-${o.id}`],
  );
  const lines = await orderLines(q, o.id);
  const revenue = new Map<string, number>();
  let tax = 0;
  for (const l of lines) {
    const acct = GOODS_KINDS.includes(l.offer.kind) ? GL.GOODS_REVENUE : GL.SERVICE_REVENUE;
    revenue.set(acct, (revenue.get(acct) ?? 0) + l.netMinor);
    tax += l.taxMinor;
  }
  await postJournal(q, {
    date: today(), sourceType: 'ORDER', sourceId: o.id, currency: o.currency,
    lines: [
      { account: GL.CASH, debit: o.totalMinor, description: `Order ${o.id.slice(0, 8)} receipt (${o.paymentMethod})` },
      ...[...revenue].map(([account, credit]) => ({ account, credit, description: `Order ${o.id.slice(0, 8)} revenue` })),
      { account: GL.TAX_PAYABLE, credit: tax, description: `Order ${o.id.slice(0, 8)} ${market(o.marketCode).taxName}` },
    ],
  });
  return true;
}

async function fail(q: Queryable, o: Row, ctx: Ctx, reason: string) {
  await releaseReservations(q, o.id);
  await refundIfCaptured(q, o);
  await setState(q, o, 'FAILED', ctx.actor, reason);
}

async function refundIfCaptured(q: Queryable, o: Row) {
  const p = (await q.query(`SELECT id FROM payments WHERE order_id=$1 AND status='CAPTURED'`, [o.id])).rows[0];
  if (!p) return;
  await q.query(`UPDATE payments SET status='REFUNDED' WHERE id=$1`, [p.id]);
  const orig = (await q.query(`SELECT account_code, debit_minor, credit_minor, description FROM gl_entries WHERE source_type='ORDER' AND source_id=$1`, [o.id])).rows;
  await postJournal(q, {
    date: today(), sourceType: 'REFUND', sourceId: o.id, currency: o.currency,
    lines: orig.map((e) => ({ account: e.accountCode, debit: e.creditMinor, credit: e.debitMinor, description: `Reversal: ${e.description}` })),
  });
}

async function activate(q: Queryable, o: Row, ctx: Ctx) {
  const lines = await orderLines(q, o.id);
  const mk = market(o.marketCode);
  let accountId: string | null = o.accountId;
  const serviceLines = lines.filter((l) => createsService(l.offer));
  if (serviceLines.length && !accountId) {
    const a = (await q.query(`SELECT id FROM accounts WHERE customer_id=$1 AND status='ACTIVE' ORDER BY created_at LIMIT 1`, [o.customerId])).rows[0];
    if (a) accountId = a.id;
    else accountId = (await (await import('./customers.js')).createAccount(q, o.customerId, {})).id;
    await q.query('UPDATE orders SET account_id=$2 WHERE id=$1', [o.id, accountId]);
  }
  let basis = (await q.query('SELECT COALESCE(sum(net_minor),0) AS n FROM order_lines WHERE order_id=$1', [o.id])).rows[0]!.n as number;

  for (const l of serviceLines) {
    const type = serviceType(l.offer);
    const term = l.offer.contract?.termMonths || null;
    const fee = monthlyFee(l.offer);
    if (fee) basis += taxSplit(fee.amount.amountMinor, mk.taxBps, fee.taxInclusive).net * l.quantity;
    const cols = `(id, shard_id, account_id, customer_id, type, identifier, offer_id, status, contract_start, contract_term_months, activated_at, order_id`;
    if (l.quantity > 1) {
      if (type !== 'IOT' && type !== 'MOBILE' && type !== 'SUBSCRIPTION') throw invalid(`cannot bulk-activate ${type}`);
      const prefix = type === 'MOBILE' ? mk.dialCode : type === 'IOT' ? 'IOT' : 'SUB';
      const seq = type === 'MOBILE' ? 'msisdn_seq' : 'circuit_seq';
      await q.query(
        `INSERT INTO services ${cols}) SELECT gen_random_uuid(), $1, $2, $3, $4, $5 || lpad(nextval('${seq}')::text, 10, '0'), $6, 'ACTIVE', now(), $7, now(), $8 FROM generate_series(1, $9::int)`,
        [o.shardId, accountId, o.customerId, type, prefix, l.offerId, term, o.id, l.quantity],
      );
      continue;
    }
    let identifier: string;
    if (l.msisdn) { // number portability (port-in) or chosen number
      if (!/^\+\d{8,15}$/.test(l.msisdn)) throw invalid(`invalid MSISDN ${l.msisdn}, use E.164 like ${mk.dialCode}91234567`);
      identifier = l.msisdn;
    } else if (type === 'MOBILE') identifier = mk.dialCode + (await q.query(`SELECT nextval('msisdn_seq') AS n`)).rows[0]!.n;
    else if (type === 'FIBER') identifier = 'FBR-' + (await q.query(`SELECT nextval('circuit_seq') AS n`)).rows[0]!.n;
    else identifier = 'SUB-' + (await q.query(`SELECT nextval('circuit_seq') AS n`)).rows[0]!.n;
    const id = randomUUID();
    if (l.msisdn && (await q.query(`SELECT 1 FROM identifier_registry WHERE type=$1 AND identifier=$2`, [type, identifier])).rows.length) throw conflict(`number ${identifier} is already in service`);
    await q.query(
      `INSERT INTO services ${cols}) VALUES ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',now(),$8,now(),$9)`,
      [id, o.shardId, accountId, o.customerId, type, identifier, l.offerId, term, o.id],
    );
    // Instalments: the upfront price is spread over future bills, rounding remainder lands on the first one.
    if (o.paymentMethod === 'INSTALLMENT' && l.netMinor + l.taxMinor > 0) {
      const gross = l.netMinor + l.taxMinor, n = o.installmentMonths as number, each = Math.floor(gross / n), rem = gross - each * n;
      await q.query(`INSERT INTO service_charges (shard_id, service_id, account_id, kind, description, amount_minor, remaining_cycles) VALUES ($1,$2,$3,'INSTALLMENT',$4,$5,$6)`,
        [o.shardId, id, accountId, `${l.offer.name ?? l.description} instalment (${n} mo)`, each, n]);
      if (rem) await q.query(`INSERT INTO service_charges (shard_id, service_id, account_id, kind, description, amount_minor, remaining_cycles) VALUES ($1,$2,$3,'ADJUSTMENT',$4,$5,1)`,
        [o.shardId, id, accountId, 'Instalment rounding', rem]);
    }
  }
  try {
    await q.query(`INSERT INTO identifier_registry (type, identifier, service_id) SELECT type::text, identifier, id FROM services WHERE order_id=$1`, [o.id]);
  } catch (e) {
    if (/duplicate key/.test((e as Error).message)) throw conflict('one of the requested numbers is already in service');
    throw e;
  }
  ctx.net = basis;
  await setState(q, o, 'ACTIVATED', ctx.actor);
}

async function complete(q: Queryable, o: Row, ctx: Ctx) {
  await setState(q, o, 'COMPLETED', ctx.actor);
  const bps = COMMISSION_BPS[o.channel];
  if (o.commissionEligible && bps && (ctx.net ?? 0) > 0) {
    await q.query(
      `INSERT INTO commissions (order_id, store_id, salesperson_id, dealer_id, basis_minor, rate_bps, amount_minor, currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [o.id, o.storeId, o.salespersonId, o.dealerId, ctx.net, bps, Math.round(((ctx.net as number) * bps) / 10_000), o.currency],
    );
  }
}

// ───────────────────────── external events ─────────────────────────
export type OrderAction =
  | { type: 'confirm_payment'; reference?: string }
  | { type: 'schedule_installation'; slot: string }
  | { type: 'dispatch_technician' }
  | { type: 'complete_installation' }
  | { type: 'ship'; trackingNumber?: string }
  | { type: 'deliver' };

export async function advanceOrder(db: Db, orderId: string, action: OrderAction, actor = 'system'): Promise<Row> {
  return db.tx(async (q) => {
    const o = (await q.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
    if (!o) throw notFound('order', orderId);
    const ctx: Ctx = { actor };
    const need = (...states: OrderState[]) => { if (!states.includes(o.state)) throw rejected(`cannot ${action.type} while order is ${o.state}`); };
    const done = (t: string) => (o.pendingTasks as string[]).filter((x) => x !== t);
    switch (action.type) {
      case 'confirm_payment': {
        need('PAYMENT_PENDING');
        if (!(await capture(q, o, action.reference))) { await fail(q, o, ctx, 'payment declined'); break; }
        await setState(q, o, 'PAID', actor);
        await drive(q, o, ctx);
        break;
      }
      case 'schedule_installation': {
        need('AWAITING_INSTALLATION');
        const slot = new Date(action.slot);
        if (Number.isNaN(slot.getTime()) || slot.getTime() < Date.now()) throw invalid('slot must be a valid future date-time');
        if (o.pointOfNoReturnAt) throw rejected('technician already dispatched');
        await q.query(`UPDATE orders SET fulfilment = fulfilment || $2::jsonb WHERE id=$1`, [orderId, JSON.stringify({ slot: slot.toISOString() })]);
        await q.query(`UPDATE installation_appointments SET status='CANCELLED' WHERE order_id=$1 AND status='BOOKED'`, [orderId]);
        await q.query(`INSERT INTO installation_appointments (shard_id, order_id, slot_start, slot_end) VALUES ($1,$2,$3,$4)`, [o.shardId, orderId, slot.toISOString(), new Date(slot.getTime() + 4 * 3_600_000).toISOString()]);
        break;
      }
      case 'dispatch_technician': {
        need('AWAITING_INSTALLATION');
        if (!o.fulfilment.slot) throw rejected('schedule an installation slot first');
        await q.query(`UPDATE orders SET point_of_no_return_at = COALESCE(point_of_no_return_at, now()), fulfilment = fulfilment || '{"dispatched":true}'::jsonb WHERE id=$1`, [orderId]);
        await q.query(`UPDATE installation_appointments SET status='DISPATCHED' WHERE order_id=$1 AND status='BOOKED'`, [orderId]);
        break;
      }
      case 'complete_installation': {
        need('AWAITING_INSTALLATION');
        if (!o.fulfilment.dispatched) throw rejected('dispatch the technician first');
        await q.query(`UPDATE installation_appointments SET status='DONE' WHERE order_id=$1 AND status='DISPATCHED'`, [orderId]);
        await q.query('UPDATE orders SET pending_tasks=$2 WHERE id=$1', [orderId, done('INSTALL')]);
        o.pendingTasks = done('INSTALL');
        await setState(q, o, 'FULFILMENT', actor);
        await drive(q, o, ctx);
        break;
      }
      case 'ship': {
        need('FULFILMENT');
        if (o.pendingTasks.includes('INSTALL') || !o.pendingTasks.includes('SHIP')) throw rejected('nothing to ship yet');
        await consumeReservations(q, orderId);
        const tracking = action.trackingNumber ?? `TRK-${orderId.slice(0, 8).toUpperCase()}`;
        await q.query(`UPDATE orders SET point_of_no_return_at = COALESCE(point_of_no_return_at, now()), fulfilment = fulfilment || $2::jsonb WHERE id=$1`, [orderId, JSON.stringify({ trackingNumber: tracking })]);
        await setState(q, o, 'SHIPPED', actor);
        break;
      }
      case 'deliver': {
        need('SHIPPED');
        await q.query('UPDATE orders SET pending_tasks=$2 WHERE id=$1', [orderId, done('SHIP')]);
        o.pendingTasks = done('SHIP');
        await setState(q, o, 'DELIVERED', actor);
        await drive(q, o, ctx);
        break;
      }
    }
    return getOrder(q, orderId);
  });
}

/** Cancellation is only possible before the point of no return (goods shipped / technician dispatched). */
export async function cancelOrder(db: Db, orderId: string, reason: string, actor = 'system'): Promise<Row> {
  return db.tx(async (q) => {
    const o = (await q.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
    if (!o) throw notFound('order', orderId);
    if (TERMINAL.includes(o.state)) throw rejected(`order is already ${o.state}`);
    if (o.pointOfNoReturnAt) throw rejected('past the point of no return (goods shipped or technician dispatched); raise a return or termination instead');
    await releaseReservations(q, orderId);
    await refundIfCaptured(q, o);
    await q.query(`UPDATE installation_appointments SET status='CANCELLED' WHERE order_id=$1 AND status='BOOKED'`, [orderId]);
    await setState(q, o, 'CANCELLED', actor, reason || 'cancelled');
    return getOrder(q, orderId);
  });
}

export async function getOrder(q: Queryable, id: string): Promise<Row> {
  const o = (await q.query(
    `SELECT o.*, c.display_name AS customer_name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id=$1`, [id])).rows[0];
  if (!o) throw notFound('order', id);
  const [lines, history, payments, services, appts] = await Promise.all([
    q.query('SELECT * FROM order_lines WHERE order_id=$1 ORDER BY id', [id]),
    q.query('SELECT from_state, to_state, actor, reason, occurred_at FROM order_state_history WHERE order_id=$1 ORDER BY id', [id]),
    q.query('SELECT id, method, status, amount_minor, reference FROM payments WHERE order_id=$1', [id]),
    q.query('SELECT id, type, identifier, status FROM services WHERE order_id=$1 ORDER BY identifier LIMIT 50', [id]),
    q.query('SELECT slot_start, slot_end, status FROM installation_appointments WHERE order_id=$1 ORDER BY slot_start', [id]),
  ]);
  const svcCount = (await q.query('SELECT count(*) AS n FROM services WHERE order_id=$1', [id])).rows[0]!.n;
  const next = nextActions(o);
  return { ...o, lines: lines.rows, history: history.rows, payments: payments.rows, services: services.rows, serviceCount: svcCount, appointments: appts.rows, nextActions: next, cancellable: !TERMINAL.includes(o.state) && !o.pointOfNoReturnAt };
}

function nextActions(o: Row): string[] {
  switch (o.state) {
    case 'PAYMENT_PENDING': return ['confirm_payment'];
    case 'AWAITING_INSTALLATION': return o.fulfilment.dispatched ? ['complete_installation'] : o.fulfilment.slot ? ['schedule_installation', 'dispatch_technician'] : ['schedule_installation'];
    case 'FULFILMENT': return o.pendingTasks.includes('SHIP') && !o.pendingTasks.includes('INSTALL') ? ['ship'] : [];
    case 'SHIPPED': return ['deliver'];
    default: return [];
  }
}

export async function listOrders(q: Queryable, f: { customerId?: string; state?: string; channel?: string; limit?: number; offset?: number } = {}) {
  const params: unknown[] = []; const where: string[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (f.customerId) where.push(`o.customer_id = ${p(f.customerId)}`);
  if (f.state) where.push(`o.state = ${p(f.state)}`);
  if (f.channel) where.push(`o.channel = ${p(f.channel)}`);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await q.query(`SELECT count(*) AS n FROM orders o ${w}`, params)).rows[0]!.n;
  const lim = p(Math.min(f.limit ?? 25, 100)); const off = p(f.offset ?? 0);
  const items = (await q.query(
    `SELECT o.id, o.state, o.channel, o.total_minor, o.currency, o.created_at, o.store_id, o.salesperson_id, c.display_name AS customer_name, o.customer_id,
       (SELECT string_agg(ol.description || CASE WHEN ol.quantity > 1 THEN ' x' || ol.quantity ELSE '' END, ', ') FROM order_lines ol WHERE ol.order_id = o.id) AS summary
     FROM orders o JOIN customers c ON c.id = o.customer_id ${w} ORDER BY o.created_at DESC, o.id LIMIT ${lim} OFFSET ${off}`, params)).rows;
  return { items, total };
}
