import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { LineItemNode, OfferNode } from '@meridian/types';
import { audit } from './audit.js';
import { ancestorsFor, checkDependencies, getOffer, monthlyFee, pageOffers } from './catalog.js';
import { createAccount, createCustomer, getCustomer } from './customers.js';
import type { Db, Queryable, Row } from './db.js';
import { DomainError, invalid, notFound, rejected } from './errors.js';
import { gatewayById, type GatewayEvent } from './gateways.js';
import { addDocument, attestInPerson, personalProblems, submitRemote, syncCase, markVerified, type Attestation, type Personal } from './kyc.js';
import { advanceOrder, cancelOrder, getOrder, placeOrderTx, type OrderInput } from './orders.js';
import { runCreditCheck } from './device-financing.js';
import { createsService, priceBasket } from './order-pricing.js';
import { behaviourOf } from '@meridian/types';
import { getBranding, getRegional, marketFor, marketMode } from './settings.js';
import { activeGateways, getStoreSettings } from './store-settings.js';
import { taxSplit } from './tax.js';

export type StoreChannel = 'SELF_SERVE' | 'RETAIL_ASSISTED';
export interface Address { line1: string; line2?: string; city: string; state?: string; postcode: string; country: string }
export interface Consent { termsVersion: string; acceptedTerms: boolean; privacyAccepted: boolean; marketingOptIn: boolean; authorisedAssistant?: boolean;
  /** The customer agrees to a credit check on their ID number (device financing). */ creditCheck?: boolean }
/** `attachTo` (with `dealTermMonths`) buys a device on a contract with another product in the basket: the offer id of that plan. */
export interface CartLine { offerId: string; quantity?: number; attachTo?: string; dealTermMonths?: number; /** Pay the device in full now instead of over the contract. */ payInFull?: boolean }
const storedLine = (l: CartLine): CartLine => ({ offerId: l.offerId, quantity: l.quantity ?? 1, ...(l.attachTo ? { attachTo: l.attachTo, dealTermMonths: l.dealTermMonths, ...(l.payInFull ? { payInFull: true } : {}) } : {}) });
/** The basket as order lines: a device on a contract points at its plan by position. */
const orderLines = (lines: CartLine[]) => lines.map((l) => {
  const plan = l.attachTo ? lines.findIndex((x) => x.offerId === l.attachTo) : -1;
  if (l.attachTo && plan < 0) throw invalid('The plan this device goes with is not in the basket.');
  return { offerId: l.offerId, quantity: l.quantity, ...(l.attachTo ? { attachTo: plan, dealTermMonths: l.dealTermMonths } : {}) };
});

const payInFullOf = (lines: CartLine[]) => lines.some((l) => l.attachTo && l.payInFull);
const MAX_LINE_QTY = 5;
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** The market a store sale belongs to: the deployment's own country when we know it. */
async function storeMarket(q: Queryable, customerId?: string | null): Promise<string> {
  const mode = await marketMode(q);
  if (mode.multiple && customerId) return ((await getCustomer(q, customerId)).marketCode as string).trim();
  return mode.default;
}

// ───────────────────────── catalog and pricing (always computed here, never taken from the client) ─────────────────────────
export interface StoreOffer {
  id: string; name: string; kind: string; /** The offer type's name as the operator set it (Settings → Catalog). */ kindName?: string; description?: string; group: string; path: string[];
  monthlyMinor: number; upfrontMinor: number; contractMonths: number; requiresShipping: boolean; requires: string[];
  /** Contracts this device can be bought on with a plan, with the price the customer pays on each. */
  deals: Array<{ termMonths: number; subsidyMinor: number; priceMinor: number }>;
  /** A plan a device can be bought on a contract with (a plan that has no device of its own). */
  hostsDevice: boolean; requiresText: string[]; excludes: string[];
  /** What the offer includes (its active line items), in the operator's order. */
  includes: Array<{ name: string; itemType: string; quantity?: number; unit?: string; unlimited?: boolean; description?: string }>;
}

/**
 * One page of the sellable catalog for a channel, with prices worked out. Searchable by words and paged, so a catalog of thousands of offers
 * never travels to the browser at once. An offer is live only if it and every ancestor is active.
 */
export async function storeCatalog(q: Queryable, channel: StoreChannel, o: { q?: string; kind?: string; notKind?: string; limit?: number; cursor?: string } = {}): Promise<{ currency: string; offers: StoreOffer[]; nextCursor: string | null }> {
  const market = await storeMarket(q);
  const mk = await marketFor(q, market);
  const page = await pageOffers(q, { status: 'ACTIVE', channel, market, q: o.q, kind: o.kind, notKind: o.notKind, limit: o.limit ?? 24, cursor: o.cursor });
  const found = page.items as OfferNode[];
  const ancestors = await ancestorsFor(q, found.map((n) => n.id));
  const chain = (n: OfferNode): string[] | null => {
    const up = ancestors.get(n.id) ?? [];
    return up.length && up.every((a) => a.status === 'ACTIVE') ? up.map((a) => a.name) : null;
  };
  // Offers that can only be collected in a store are sold in store: the online shop has no pickup-store step.
  const offers = found.filter((n) => chain(n) !== null && (channel === 'RETAIL_ASSISTED' || !collectOnly(n)));
  const ids = offers.map((n) => n.id);
  const typeNames = new Map((await q.query('SELECT id, name FROM offer_types WHERE id = ANY($1::text[])', [[...new Set(offers.map((n) => n.kind as string))]])).rows.map((r) => [r.id as string, r.name as string]));
  const items = new Map<string, StoreOffer['includes']>();
  if (ids.length) for (const r of (await q.query(`SELECT * FROM catalog_nodes WHERE level='LINE_ITEM' AND status='ACTIVE' AND parent_id = ANY($1) ORDER BY sort_order, name, id`, [ids])).rows) {
    const d = r.data ?? {};
    items.set(r.parentId, [...(items.get(r.parentId) ?? []), { name: r.name, itemType: d.itemType, quantity: d.quantity, unit: d.unit, unlimited: d.unlimited || undefined, description: d.description }]);
  }
  const reqIds = [...new Set(offers.flatMap((n) => n.requires))];
  const req = new Map<string, { name: string; level: string }>(reqIds.length ? (await q.query('SELECT id, name, level FROM catalog_nodes WHERE id = ANY($1)', [reqIds])).rows.map((r) => [r.id as string, { name: r.name as string, level: r.level as string }]) : []);
  return {
    currency: mk.currency,
    nextCursor: page.nextCursor,
    offers: offers.map((n) => {
      const split = (amount: number, inclusive: boolean) => taxSplit(amount, mk.taxBps, inclusive).gross;
      const up = n.prices.filter((p) => p.type === 'ONE_TIME').reduce((s, p) => s + split(p.amount.amountMinor, p.taxInclusive), 0);
      const fee = monthlyFee(n);
      const path = [...(chain(n) ?? []), n.name];
      return {
        id: n.id, name: n.name, kind: n.kind, kindName: typeNames.get(n.kind as string), description: n.description, group: path[path.length - 2] ?? '', path: path.slice(0, -1),
        monthlyMinor: fee ? split(fee.amount.amountMinor, fee.taxInclusive) : 0, upfrontMinor: up, contractMonths: n.contract?.termMonths ?? 0,
        requiresShipping: !!n.fulfilment?.requiresShipping, requires: n.requires, excludes: n.excludes, includes: items.get(n.id) ?? [],
        deals: (n.deals ?? []).map((d) => {
          let left = d.subsidyMinor; // the subsidy comes off the first upfront price, as in an order
          const price = n.prices.filter((p) => p.type === 'ONE_TIME').reduce((t, p) => { const cut = Math.min(left, p.amount.amountMinor); left -= cut; return t + split(p.amount.amountMinor - cut, p.taxInclusive); }, 0);
          return { termMonths: d.termMonths, subsidyMinor: up - price, priceMinor: price };
        }),
        hostsDevice: createsService(n) && behaviourOf(n).role === 'PLAN' && !behaviourOf(n).goods,
        requiresText: n.requires.map((id) => { const r = req.get(id); return r ? (r.level === 'OFFER' ? r.name : `any ${r.name}`) : id; }),
      };
    }),
  };
}

/** An offer whose goods can only be collected in a store (it cannot be shipped). */
const collectOnly = (o: OfferNode) => !!o.fulfilment?.requiresCollection && !o.fulfilment?.requiresShipping;

export interface Quote {
  currency: string; taxName: string;
  lines: Array<{ offerId: string; name: string; quantity: number; upfrontMinor: number; monthlyMinor: number; deal?: { planName: string; termMonths: number; retailMinor: number; instalmentMinor?: number } }>;
  upfrontMinor: number; monthlyMinor: number; requiresShipping: boolean; violations: string[];
  /** A device paid over its contract. `estimate`: the upfront share is settled by a credit check at checkout, so the figures may change. */
  financing?: { months: number; upfrontMinor: number; instalmentMinor: number; estimate: boolean; creditCheck: boolean };
}

/** Prices a basket for a channel (and, when known, a customer who may already own prerequisites). Does not throw for unmet prerequisites: it reports them. */
export async function quoteBasket(q: Queryable, o: { lines: CartLine[]; channel: StoreChannel; customerId?: string | null; creditCheckId?: string }): Promise<Quote> {
  if (!o.lines.length) throw invalid('The basket is empty.');
  if (o.lines.length > 10) throw invalid('Too many items in the basket.');
  const marketCode = await storeMarket(q, o.customerId);
  const mk = await marketFor(q, marketCode);
  const seen = new Set<string>();
  const lines: Quote['lines'] = [];
  const offers: OfferNode[] = [];
  let shipping = false;
  for (const l of o.lines) {
    const qty = l.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) throw invalid(`Quantity must be 1–${MAX_LINE_QTY}.`);
    if (seen.has(l.offerId)) throw invalid('Each product can appear once; change the quantity instead.');
    seen.add(l.offerId);
    const off = await getOffer(q, l.offerId).catch(() => null);
    if (!off || off.status !== 'ACTIVE') throw rejected('One of the products is no longer available.');
    if ((await marketMode(q)).multiple && off.markets.length && !off.markets.includes(marketCode)) throw rejected(`${off.name} is not available in your country.`);
    if (off.salesChannels?.length && !off.salesChannels.includes(o.channel)) throw rejected(`${off.name} is not sold through this channel.`);
    if (off.prices.some((p) => p.amount.currency !== mk.currency)) throw rejected(`${off.name} is not priced in ${mk.currency}.`);
    if (o.channel !== 'RETAIL_ASSISTED' && collectOnly(off)) throw rejected(`${off.name} can only be collected in a store, so it cannot be ordered online.`);
    const up = off.prices.filter((p) => p.type === 'ONE_TIME').reduce((s, p) => s + taxSplit(p.amount.amountMinor * qty, mk.taxBps, p.taxInclusive).gross, 0);
    const fee = monthlyFee(off);
    lines.push({ offerId: off.id, name: off.name, quantity: qty, upfrontMinor: up, monthlyMinor: fee ? taxSplit(fee.amount.amountMinor * qty, mk.taxBps, fee.taxInclusive).gross : 0 });
    if (off.fulfilment?.requiresShipping) shipping = true;
    offers.push(off);
  }
  // A device bought on a contract with a plan is priced by the same code the order uses, so the shopper is quoted exactly what is charged.
  let financing: Quote['financing'];
  if (o.lines.some((l) => l.attachTo)) {
    const priced = await priceBasket(q, { customerId: o.customerId ?? undefined, channel: o.channel, marketCode, lines: orderLines(o.lines), payment: { method: 'CREDIT_CARD' }, financing: { payInFull: payInFullOf(o.lines), creditCheckId: o.creditCheckId } }, { soft: true });
    priced.lines.forEach((pl, i) => {
      if (!pl.deal) return;
      lines[i]!.upfrontMinor = pl.paidNow;
      lines[i]!.monthlyMinor += pl.instalmentMinor; // the device instalment is billed with the plan
      lines[i]!.deal = { planName: priced.lines[pl.attachPosition!]!.offer.name, termMonths: pl.deal.termMonths, retailMinor: pl.listGross + pl.deal.subsidyMinor, instalmentMinor: pl.instalmentMinor || undefined };
    });
    const f = priced.financing;
    if (f?.applied) financing = { months: f.months, upfrontMinor: f.upfrontMinor, instalmentMinor: f.instalmentMinor, estimate: f.requiresCreditCheck, creditCheck: f.requiresCreditCheck };
  }
  const violations = await checkDependencies(q, o.customerId ?? null, offers.map((x) => x.id));
  return {
    currency: mk.currency, taxName: mk.taxName, lines, upfrontMinor: lines.reduce((s, l) => s + l.upfrontMinor, 0), monthlyMinor: lines.reduce((s, l) => s + l.monthlyMinor, 0),
    requiresShipping: shipping, violations, financing,
  };
}

// ───────────────────────── applications ─────────────────────────
export interface AppAccess { channel: StoreChannel; clientId?: string | null; token?: string; staff?: { username: string; storeId?: string | null; canSeeAll?: boolean } }

async function load(q: Queryable, id: string, access: AppAccess): Promise<Row> {
  const a = (await q.query('SELECT * FROM applications WHERE id=$1', [id])).rows[0];
  // Wrong key, wrong token and unknown id all look the same.
  const nf = notFound('application', id);
  if (!a || a.channel !== access.channel) throw nf;
  if (access.channel === 'SELF_SERVE') {
    if (a.clientId !== access.clientId || !access.token || !a.tokenHash) throw nf;
    const want = Buffer.from(a.tokenHash, 'hex'), got = Buffer.from(hashToken(access.token), 'hex');
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw nf;
  } else if (!access.staff || (!access.staff.canSeeAll && a.storeId !== (access.staff.storeId ?? null) && a.createdBy !== access.staff.username)) throw nf;
  return a;
}

export async function createApplication(q: Queryable, o: { channel: StoreChannel; clientId?: string | null; lines: CartLine[]; customerId?: string | null; staff?: { username: string; storeId?: string | null }; ip?: string | null }): Promise<{ application: Row; token?: string }> {
  const s = await getStoreSettings(q);
  if (o.channel === 'SELF_SERVE' && o.ip) { // a shopper creating hundreds of applications is abuse, not shopping
    const n = (await q.query(`SELECT count(*) AS n FROM applications WHERE created_ip=$1 AND created_at > now() - interval '1 hour'`, [o.ip])).rows[0]!.n as number;
    if (n >= 20) throw new DomainError('RATE_LIMITED', 'Too many sign-ups from this address. Try again later.');
  }
  const quote = await quoteBasket(q, { lines: o.lines, channel: o.channel, customerId: o.customerId });
  if (quote.violations.length) throw rejected(quote.violations.join(' '));
  const token = o.channel === 'SELF_SERVE' ? randomBytes(24).toString('base64url') : undefined;
  const id = randomUUID();
  await q.query(
    `INSERT INTO applications (id, client_id, channel, token_hash, customer_id, lines, store_id, created_by, created_ip, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' hours')::interval)`,
    [id, o.clientId ?? null, o.channel, token ? hashToken(token) : null, o.customerId ?? null, JSON.stringify(o.lines.map(storedLine)),
     o.staff?.storeId ?? null, o.staff?.username ?? null, o.ip ?? null, String(s.applicationTtlHours)],
  );
  if (o.staff) await audit(q, o.staff.username, 'application', id, 'CREATE', { customerId: o.customerId ?? null });
  const application = (await q.query('SELECT * FROM applications WHERE id=$1', [id])).rows[0]!;
  return { application, token };
}

export interface AppPatch { lines?: CartLine[]; personal?: Partial<Personal>; address?: Address; consent?: Partial<Consent> }

export async function updateApplication(q: Queryable, id: string, access: AppAccess, p: AppPatch): Promise<Row> {
  const a = await load(q, id, access);
  // Identity and basket are frozen once KYC is decided; the delivery address and the consent (signed last, at the counter) stay open until checkout.
  const open = a.status === 'DRAFT' || (a.status === 'KYC_APPROVED' && !p.lines && !p.personal);
  if (!open) throw rejected('This application can no longer be edited.');
  if (new Date(a.expiresAt) < new Date()) throw rejected('This application has expired. Please start again.');
  const sets: string[] = []; const vals: unknown[] = [id];
  const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (p.lines) {
    const quote = await quoteBasket(q, { lines: p.lines, channel: access.channel, customerId: a.customerId });
    if (quote.violations.length) throw rejected(quote.violations.join(' '));
    add('lines', JSON.stringify(p.lines.map(storedLine)));
  }
  if (p.personal) {
    const merged = { ...a.personal, ...p.personal };
    // An existing customer keeps the identity on file: it can be re-confirmed in person but not swapped for someone else's.
    add('personal', JSON.stringify(merged));
  }
  if (p.address) {
    const ad = p.address;
    if (!ad.line1?.trim() || !ad.city?.trim() || !ad.postcode?.trim() || !/^[A-Za-z]{2}$/.test(ad.country ?? '')) throw invalid('Enter the street address, city, postcode and country.');
    add('address', JSON.stringify({ ...ad, country: ad.country.toUpperCase() }));
  }
  if (p.consent) {
    const st = await getStoreSettings(q);
    const c = p.consent;
    add('consent', JSON.stringify({ ...(a.consent ?? {}), ...c, termsVersion: st.termsVersion, at: new Date().toISOString(), by: access.staff?.username ?? 'applicant' }));
  }
  if (sets.length) await q.query(`UPDATE applications SET ${sets.join(', ')}, updated_at=now() WHERE id=$1`, vals);
  // Keep the KYC case in step with the details so reviewers always see what the applicant last entered.
  if (p.personal) await syncCase(q, id, access.channel === 'SELF_SERVE' ? 'DOCUMENT_REMOTE' : 'IN_PERSON');
  return (await q.query('SELECT * FROM applications WHERE id=$1', [id])).rows[0]!;
}

export async function uploadDocument(q: Queryable, id: string, access: AppAccess, kind: Parameters<typeof addDocument>[2], bytes: Buffer) {
  const a = await load(q, id, access);
  // Identity documents are frozen once KYC is decided; the customer's signature is captured last, at the counter.
  const ok = a.status === 'DRAFT' || (a.status === 'KYC_APPROVED' && kind === 'SIGNATURE' && access.channel === 'RETAIL_ASSISTED');
  if (!ok) throw rejected('Documents can only be added while the application is open.');
  return addDocument(q, id, kind, bytes);
}

export async function submitKyc(q: Queryable, id: string, access: AppAccess, attestation?: Attestation): Promise<Row> {
  const a = await load(q, id, access);
  const s = await getStoreSettings(q);
  if (access.channel === 'RETAIL_ASSISTED') {
    if (!attestation) throw invalid('The in-person attestation is required.');
    if (a.customerId) { // an existing, already-verified customer needs no new check
      const c = await getCustomer(q, a.customerId);
      if (c.kycStatus === 'VERIFIED') {
        if (!attestation.idSighted || !attestation.faceMatches) throw rejected('Confirm that you have checked the customer in person.');
        await audit(q, access.staff!.username, 'application', id, 'RETURNING_CUSTOMER_CONFIRMED', { customerId: a.customerId });
        await q.query(`UPDATE applications SET status='KYC_APPROVED', updated_at=now() WHERE id=$1`, [id]); return (await q.query('SELECT * FROM applications WHERE id=$1', [id])).rows[0]!;
      }
    }
    await attestInPerson(q, id, access.staff!, attestation, s);
  } else await submitRemote(q, id, s);
  return (await q.query('SELECT * FROM applications WHERE id=$1', [id])).rows[0]!;
}

// ───────────────────────── checkout ─────────────────────────
export interface CheckoutResult { application: Row; order: Row; payment: PaymentStart | null }
export interface PaymentStart { gateway: string; ref: string; clientSecret?: string; redirectUrl?: string; publicConfig: Record<string, string>; amountMinor: number; currency: string }

const addressLine = (a: Address | null) => (a ? [a.line1, a.line2, a.city, a.state, a.postcode, a.country].filter(Boolean).join(', ') : undefined);

/**
 * Turns an approved application into a customer and an order, atomically. The price is recomputed here from the catalog; nothing the
 * client sent about money is used. Self-serve orders then wait for the payment gateway; assisted orders take the cashier's payment.
 */
export async function checkout(db: Db, id: string, access: AppAccess, o: { gateway?: string; returnUrl?: string; assistedPayment?: OrderInput['payment']; deliveryNote?: string } = {}): Promise<CheckoutResult> {
  const { order, appId } = await db.tx(async (q) => {
    await q.query('SELECT 1 FROM applications WHERE id=$1 FOR UPDATE', [id]);
    const a = await load(q, id, access);
    if (a.status === 'ORDERED' && a.orderId) return { order: await getOrder(q, a.orderId), appId: a.id }; // retry: same answer
    if (a.status !== 'KYC_APPROVED') throw rejected(({ DRAFT: 'Identity verification must be completed first.', KYC_REVIEW: 'Identity verification is still being reviewed.', KYC_REJECTED: 'Identity verification was not approved.' } as Record<string, string>)[a.status] ?? `This application is ${a.status.toLowerCase().replace('_', ' ')}.`);
    if (new Date(a.expiresAt) < new Date()) throw rejected('This application has expired. Please start again.');
    const st = await getStoreSettings(q);
    const consent = a.consent as Consent | null;
    if (!consent?.acceptedTerms || !consent.privacyAccepted || consent.termsVersion !== st.termsVersion) throw rejected('The terms and privacy notice must be accepted.');
    if (access.channel === 'RETAIL_ASSISTED' && !consent.authorisedAssistant) throw rejected('The customer must authorise the assistant to complete this order on their behalf.');
    const quote = await quoteBasket(q, { lines: a.lines, channel: access.channel, customerId: a.customerId });
    if (quote.violations.length) throw rejected(quote.violations.join(' '));
    if (quote.financing?.creditCheck && !consent.creditCheck) throw rejected('The customer must agree to a credit check to pay for the device over the contract.');
    if (quote.requiresShipping && access.channel === 'SELF_SERVE' && !a.address) throw rejected('A delivery address is required for this order.');

    // customer: existing (assisted) or created now from the verified identity
    let customerId = a.customerId as string | null;
    const p = a.personal as Personal;
    if (!customerId) {
      try {
        const ad = a.address as Address | null;
        const created = await createCustomer(q, { segment: 'CONSUMER', displayName: p.fullName.trim(), idDocument: p.idNumber.trim(), email: p.email, phone: p.phone, marketCode: await storeMarket(q),
          dateOfBirth: /^\d{4}-\d{2}-\d{2}$/.test(p.dateOfBirth ?? '') ? p.dateOfBirth : undefined, // what the shopper told us for identity verification is kept on the customer
          address: ad ? { line1: ad.line1, line2: ad.line2, postcode: ad.postcode, city: ad.city, state: ad.state, country: ad.country } : undefined });
        customerId = created.customer.id as string;
      } catch (e) {
        // Never echo the existing customer's id back to an applicant.
        if (e instanceof DomainError && e.code === 'CONFLICT') throw rejected('This ID is already registered with us. Please visit a store so we can help you.');
        throw e;
      }
    }
    await markVerified(q, customerId);
    await q.query(`UPDATE kyc_cases SET customer_id=$2 WHERE application_id=$1`, [id, customerId]);
    const acct = (await q.query(`SELECT id FROM accounts WHERE customer_id=$1 AND status='ACTIVE' LIMIT 1`, [customerId])).rows[0];
    if (!acct) await createAccount(q, customerId, {});

    const staff = access.staff;
    const input: OrderInput = {
      customerId, channel: access.channel, lines: orderLines(a.lines as CartLine[]),
      payment: access.channel === 'SELF_SERVE' ? { method: 'CREDIT_CARD', deferred: true } : o.assistedPayment ?? { method: 'CASH', deferred: true },
      attribution: staff ? { storeId: staff.storeId ?? undefined, salespersonId: staff.username } : undefined,
      deliveryAddress: addressLine(a.address as Address | null), actor: staff?.username ?? `store:${a.clientId?.slice(0, 8) ?? 'self'}`,
    };
    // Device financing: with a credit check required, the KYC-verified ID number is checked now and the answer sets the upfront share.
    let checked = false;
    if (quote.financing?.creditCheck) {
      const total = (await priceBasket(q, { customerId, channel: access.channel, lines: input.lines, payment: input.payment, financing: { payInFull: payInFullOf(a.lines) } }, { soft: true })).financing?.financedMinor ?? 0;
      const months = quote.financing.months;
      const check = await runCreditCheck(q, { customerId, idNumber: p.idNumber.trim(), fullName: p.fullName, dateOfBirth: p.dateOfBirth, financedMinor: total, months, currency: quote.currency, consent: { given: true, by: staff?.username ?? 'applicant', how: 'store consent' }, actor: staff?.username ?? 'store', skipCustomerMatch: true });
      input.financing = { creditCheckId: check.id };
      checked = true;
    } else if (payInFullOf(a.lines as CartLine[])) input.financing = { payInFull: true };
    const order = await placeOrderTx(q, input);
    if (!checked && order.totalMinor !== quote.upfrontMinor) throw new Error(`price changed during checkout (${order.totalMinor} vs ${quote.upfrontMinor})`);
    await q.query(`UPDATE applications SET status='ORDERED', customer_id=$2, order_id=$3, updated_at=now() WHERE id=$1`, [id, customerId, order.id]);
    await audit(q, staff?.username ?? 'store', 'application', id, 'CHECKOUT', { orderId: order.id, totalMinor: order.totalMinor });
    return { order, appId: id };
  });
  const application = (await db.query('SELECT * FROM applications WHERE id=$1', [appId])).rows[0]!;
  let payment: PaymentStart | null = null;
  if (order.state === 'PAYMENT_PENDING' && access.channel === 'SELF_SERVE') payment = await startPayment(db, id, access, { gateway: o.gateway, returnUrl: o.returnUrl });
  return { application, order: payment ? order : await getOrder(db, order.id), payment };
}

// ───────────────────────── payments ─────────────────────────
/** (Re)starts a gateway payment for an order that is waiting for money. Safe to call again after a failure. */
export async function startPayment(db: Db, appId: string, access: AppAccess, o: { gateway?: string; returnUrl?: string } = {}): Promise<PaymentStart> {
  const a = await load(db, appId, access);
  if (!a.orderId) throw rejected('There is nothing to pay yet.');
  const order = await getOrder(db, a.orderId);
  if (order.state !== 'PAYMENT_PENDING') throw rejected(`This order is ${String(order.state).toLowerCase().replace('_', ' ')}; no payment is due.`);
  const { list, default: def } = await activeGateways(db);
  const gw = o.gateway ? list.find((g) => g.id === o.gateway) : def;
  if (!gw) throw rejected(o.gateway ? `Payment method ${o.gateway} is not available.` : 'Online payment is not set up yet. Please contact the store.');
  if (o.returnUrl && !/^https:\/\/|^http:\/\/localhost/.test(o.returnUrl)) throw invalid('returnUrl must be an https URL.');
  const attempt = (await db.query('SELECT count(*) AS n FROM payment_intents WHERE order_id=$1', [order.id])).rows[0]!.n as number;
  const intent = await gw.createIntent({
    amountMinor: order.totalMinor, currency: order.currency, reference: order.id, description: `Order ${order.number ?? String(order.id).slice(0, 8)}`,
    idempotencyKey: `meridian-order-${order.id}-${attempt}`, returnUrl: o.returnUrl, metadata: { order_id: order.id, application_id: appId },
  });
  await db.tx(async (q) => {
    await q.query(`UPDATE payment_intents SET status='CANCELLED', updated_at=now() WHERE order_id=$1 AND status='REQUIRES_PAYMENT'`, [order.id]);
    await q.query(`INSERT INTO payment_intents (application_id, order_id, gateway, gateway_ref, amount_minor, currency) VALUES ($1,$2,$3,$4,$5,$6)`,
      [appId, order.id, gw.id, intent.ref, order.totalMinor, order.currency]);
  });
  return { gateway: gw.id, ref: intent.ref, clientSecret: intent.clientSecret, redirectUrl: intent.redirectUrl, publicConfig: gw.publicConfig(), amountMinor: order.totalMinor, currency: order.currency };
}

export interface PaymentLink { gateway: string; url: string; ref: string; expiresAt?: string; amountMinor: number; currency: string }
/**
 * Staff in the CRM collect card payment by sending the customer a payment page of the provider (a link or QR the customer opens on their own phone).
 * Only for an order waiting for money, and only through a gateway switched on for the CRM. Asking again replaces the earlier link. The order is confirmed
 * by the provider's signed webhook exactly as for a store-front payment.
 */
export async function createPaymentLink(db: Db, orderId: string, actor: string, o: { returnUrl: string; gateway?: string }): Promise<PaymentLink> {
  const order = await getOrder(db, orderId);
  if (order.state !== 'PAYMENT_PENDING') throw rejected(`This order is ${String(order.state).toLowerCase().replace(/_/g, ' ')}; no payment is due.`);
  if (!/^https:\/\/|^http:\/\/localhost/.test(o.returnUrl)) throw invalid('returnUrl must be an https URL.');
  const { list } = await activeGateways(db, process.env, 'CRM');
  const usable = list.filter((g) => g.createPaymentLink);
  const gw = o.gateway ? usable.find((g) => g.id === o.gateway) : usable[0];
  if (!gw?.createPaymentLink) throw rejected(usable.length || o.gateway ? `Payment method ${o.gateway} is not switched on for the CRM.` : 'Card payment links are not switched on for the CRM. A super user can switch them on under Integration → Payment gateways.');
  const attempt = (await db.query('SELECT count(*) AS n FROM payment_intents WHERE order_id=$1', [order.id])).rows[0]!.n as number;
  const link = await gw.createPaymentLink({
    amountMinor: order.totalMinor, currency: order.currency, reference: order.id, description: `Order ${order.number ?? String(order.id).slice(0, 8)}`,
    idempotencyKey: `meridian-order-${order.id}-${attempt}`, returnUrl: o.returnUrl, metadata: { order_id: order.id, source: 'crm' },
  });
  await db.tx(async (q) => {
    await q.query(`UPDATE payment_intents SET status='CANCELLED', updated_at=now() WHERE order_id=$1 AND status='REQUIRES_PAYMENT'`, [order.id]);
    await q.query(`INSERT INTO payment_intents (order_id, gateway, gateway_ref, amount_minor, currency) VALUES ($1,$2,$3,$4,$5)`, [order.id, gw.id, link.ref, order.totalMinor, order.currency]);
    await audit(q, actor, 'order', order.id, 'PAYMENT_LINK_CREATED', { gateway: gw.id, amountMinor: order.totalMinor });
  });
  return { gateway: gw.id, url: link.url, ref: link.ref, expiresAt: link.expiresAt, amountMinor: order.totalMinor, currency: order.currency };
}

/** A verified gateway event. Replays are ignored; amount and currency must match what we asked for, or the event is refused and audited. */
export async function applyGatewayEvent(db: Db, gatewayId: string, ev: GatewayEvent): Promise<{ handled: boolean; note?: string }> {
  const fresh = await db.query('INSERT INTO webhook_events (gateway, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [gatewayId, ev.eventId]);
  if (!fresh.rowCount) return { handled: false, note: 'duplicate event' };
  const intent = (await db.query('SELECT * FROM payment_intents WHERE gateway=$1 AND gateway_ref=$2', [gatewayId, ev.ref])).rows[0];
  if (!intent) return { handled: false, note: 'unknown payment' };
  if (ev.type === 'payment.failed') {
    await db.query(`UPDATE payment_intents SET status='FAILED', updated_at=now() WHERE id=$1 AND status='REQUIRES_PAYMENT'`, [intent.id]);
    return { handled: true };
  }
  if (Number(intent.amountMinor) !== ev.amountMinor || String(intent.currency).trim() !== ev.currency) {
    await audit(db, `gateway:${gatewayId}`, 'payment_intent', intent.id, 'AMOUNT_MISMATCH', { expected: [Number(intent.amountMinor), intent.currency], got: [ev.amountMinor, ev.currency] });
    throw new DomainError('REJECTED', 'payment amount does not match the order');
  }
  await db.query(`UPDATE payment_intents SET status='SUCCEEDED', updated_at=now() WHERE id=$1`, [intent.id]);
  const order = await getOrder(db, intent.orderId);
  if (order.state === 'PAYMENT_PENDING') await advanceOrder(db, order.id, { type: 'confirm_payment', reference: ev.ref, gatewayRef: ev.ref }, `gateway:${gatewayId}`);
  return { handled: true };
}

/** Development-only: confirm or decline a payment made with the test gateway, as the provider's webhook would. */
export async function testGatewayOutcome(db: Db, appId: string, access: AppAccess, outcome: 'succeed' | 'decline'): Promise<void> {
  const a = await load(db, appId, access);
  const intent = (await db.query(`SELECT * FROM payment_intents WHERE application_id=$1 AND gateway='test' AND status='REQUIRES_PAYMENT' ORDER BY created_at DESC LIMIT 1`, [a.id])).rows[0];
  if (!intent) throw rejected('There is no test payment to confirm.');
  if (!gatewayById('test').configured()) throw new DomainError('NOT_FOUND', 'not found');
  await applyGatewayEvent(db, 'test', { eventId: `evt_${randomUUID()}`, type: outcome === 'succeed' ? 'payment.succeeded' : 'payment.failed', ref: intent.gatewayRef, amountMinor: Number(intent.amountMinor), currency: String(intent.currency).trim() });
}

// ───────────────────────── status ─────────────────────────
/** What the shopper (or the assistant) sees: the application, the next step, and once ordered the order's progress. */
export async function applicationView(q: Queryable, id: string, access: AppAccess): Promise<Record<string, unknown>> {
  const a = await load(q, id, access);
  const case_ = (await q.query('SELECT id, status, flags, decision_reason, checks, method, id_number_masked FROM kyc_cases WHERE application_id=$1', [id])).rows[0];
  const docs = (await q.query('SELECT kind FROM kyc_documents WHERE application_id=$1', [id])).rows.map((r) => r.kind as string);
  const st = await getStoreSettings(q);
  const quote = await quoteBasket(q, { lines: a.lines, channel: a.channel, customerId: a.customerId }).catch(() => null);
  let order: Row | null = null;
  if (a.orderId) {
    const o = await getOrder(q, a.orderId);
    order = { id: o.id, number: o.number ?? null, state: o.state, totalMinor: o.totalMinor, currency: o.currency, trackingNumber: o.fulfilment?.trackingNumber ?? null, failureReason: o.failureReason ?? null,
      numbers: (o.services as Row[]).filter((s) => s.type === 'MOBILE').map((s) => s.identifier), lines: (o.lines as Row[]).map((l) => ({ name: l.description, quantity: l.quantity })) };
  }
  const p = a.personal as Partial<Personal>;
  const { idNumber: _omit, ...personalSafe } = p as Record<string, unknown>;
  return {
    id: a.id, channel: a.channel, status: a.status, expiresAt: a.expiresAt, lines: a.lines, quote,
    personal: { ...personalSafe, idNumberMasked: case_?.idNumberMasked }, personalProblems: personalProblems(p),
    address: a.address, consent: a.consent, termsVersion: st.termsVersion, termsUrl: st.termsUrl, privacyUrl: st.privacyUrl,
    kyc: case_ ? { status: case_.status, method: case_.method, reason: case_.decisionReason ?? case_.checks?.returnReason ?? null, returned: !!case_.checks?.returnReason && a.status === 'DRAFT', needsReview: a.status === 'KYC_REVIEW' } : null,
    documents: docs, order, customerId: a.customerId, customerKyc: a.customerId ? ((await getCustomer(q, a.customerId)).kycStatus ?? 'NOT_VERIFIED') : null,
  };
}

export async function cancelApplication(db: Db, id: string, access: AppAccess): Promise<void> {
  const a = await load(db, id, access);
  if (a.status === 'CANCELLED' || a.status === 'EXPIRED') return;
  if (a.orderId) await cancelOrder(db, a.orderId, 'cancelled by applicant', access.staff?.username ?? 'store');
  await db.query(`UPDATE applications SET status='CANCELLED', updated_at=now() WHERE id=$1`, [id]);
  await db.query(`UPDATE payment_intents SET status='CANCELLED', updated_at=now() WHERE order_id=$1 AND status='REQUIRES_PAYMENT'`, [a.orderId ?? randomUUID()]);
}

/** Housekeeping, safe to run on a schedule: closes stale applications and releases orders whose payment never arrived. */
export async function expireApplications(db: Db, paymentGraceHours = 24): Promise<{ expired: number; cancelledOrders: number }> {
  const stale = (await db.query(`UPDATE applications SET status='EXPIRED', updated_at=now() WHERE status IN ('DRAFT','KYC_REVIEW','KYC_APPROVED','KYC_REJECTED') AND expires_at < now() RETURNING id`)).rows.length;
  const unpaid = (await db.query(
    `SELECT a.id, a.order_id FROM applications a JOIN orders o ON o.id = a.order_id WHERE a.status='ORDERED' AND o.state='PAYMENT_PENDING' AND o.channel='SELF_SERVE' AND o.created_at < now() - ($1 || ' hours')::interval`, [String(paymentGraceHours)])).rows;
  for (const r of unpaid) {
    await cancelOrder(db, r.orderId, 'payment not received', 'system').catch(() => {});
    await db.query(`UPDATE applications SET status='EXPIRED', updated_at=now() WHERE id=$1`, [r.id]);
    await db.query(`UPDATE payment_intents SET status='CANCELLED', updated_at=now() WHERE order_id=$1 AND status='REQUIRES_PAYMENT'`, [r.orderId]);
  }
  return { expired: stale, cancelledOrders: unpaid.length };
}

export async function storeConfig(q: Queryable) {
  const [brand, regional, st, gw] = await Promise.all([getBranding(q), getRegional(q), getStoreSettings(q), activeGateways(q)]);
  return {
    brand: { name: brand.name, theme: brand.theme, logo: brand.logo ? { sha256: brand.logo.sha256, width: brand.logo.width, height: brand.logo.height } : null, favicon: brand.favicon ? { sha256: brand.favicon.sha256 } : null },
    regional, kyc: { mode: st.kycMode, minAge: st.minAge, requiresBack: ['NATIONAL_ID', 'DRIVING_LICENCE', 'RESIDENCE_PERMIT'], maxDocumentBytes: 2_500_000, idTypes: ['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENCE', 'RESIDENCE_PERMIT'] },
    terms: { version: st.termsVersion, termsUrl: st.termsUrl || null, privacyUrl: st.privacyUrl || null },
    payment: { gateways: gw.list.map((g) => ({ id: g.id, label: g.label, ...g.publicConfig() })), default: gw.default?.id ?? null },
  };
}
