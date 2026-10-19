import { typeConflictIn } from './offer-conflicts.js';
import { getFinancing, usableCheck } from './device-financing.js';
import { hiddenFixedKinds } from './fiber-client.js';
import { behaviourOf, type DeviceDeal, type DeviceVariant, type OfferNode, type OrderChannel, type PaymentMethod } from '@meridian/types';
import { listBundleRules, matches, ruleSatisfied, type BundleRule } from './bundles.js';
import { assertAncestorsLive, checkDependencies, getOffer, monthlyFee, pageOffers } from './catalog.js';
import { autoCancelDays, termsFor } from './cancellation.js';
import { getCustomer } from './customers.js';
import type { Queryable, Row } from './db.js';
import { invalid, rejected } from './errors.js';
import { effectiveMarket, marketFor, marketMode } from './settings.js';
import { getStoreSettings } from './store-settings.js';
import { taxSplit } from './tax.js';
import { needsSim, resolveNumbering } from './order-numbering.js';
import { prepareLines, type MemberInput } from './group-orders.js';
import type { PortInInput } from './port-in.js';

export type GroupKind = 'ACTIVATION' | 'GOODS' | 'INSTALL';
export const INSTALMENT_MONTHS = [3, 6, 12, 24, 36];
export const RETAIL_CHANNELS: OrderChannel[] = ['RETAIL_ASSISTED', 'QUICK_SALE'];
export const MAX_BULK = 1_000_000;

export interface LinePayment { mode: 'UPFRONT' | 'INSTALLMENT'; months?: number; downPaymentMinor?: number }
export interface LineInput {
  offerId: string; quantity?: number; msisdn?: string; serialNumber?: string; options?: { variantId?: string }; payment?: LinePayment;
  /** The SIM for a plan that needs one: a physical card's ICCID, or `simType` alone for the next free card (PHYSICAL) or a fresh eSIM profile (ESIM). */
  iccid?: string; simType?: 'PHYSICAL' | 'ESIM';
  /** The hold on the chosen number, from when the customer picked it. */
  numberToken?: string;
  /** A device bought on a contract with a plan: the position (in `lines`) of the plan line it goes with, and the contract length. */
  attachTo?: number; dealTermMonths?: number;
  /** A group plan: the member lines that join it (new numbers, ported-in numbers, SIMs or eSIMs), up to the plan's limit. Expanded into lines before pricing. */
  members?: MemberInput[];
  /** Set on a member line once expanded: the position of the group plan line it belongs to. */
  memberOf?: number;
  /** The line joins a group that already exists (more members for a family plan). */
  joinGroupId?: string;
  /** The line brings a number from another operator (port-in). `temporaryNumber` gives the customer a number from our pool meanwhile. */
  portIn?: PortInInput & { donorOperator?: string; donorMnpOperatorId?: string };
}
export interface PricingInput {
  customerId?: string; accountId?: string; channel: OrderChannel; marketCode?: string; lines: LineInput[];
  payment: { method: PaymentMethod; installmentMonths?: number; reference?: string; confirmed?: boolean; deferred?: boolean };
  /** Device financing: the credit check to use, or `payInFull` to pay a device on a contract outright instead of over the contract. */
  financing?: { creditCheckId?: string; payInFull?: boolean };
}

/** Offers that produce a billable service when the order activates. */
export function createsService(o: OfferNode): boolean {
  const b = behaviourOf(o);
  if (!b.service) return false;
  return b.serviceNeedsFee ? !!monthlyFee(o) : true;
}
/** Which part of the order fulfils an offer: a visit, a parcel (shipped or collected in store), or just switching the service on. */
export const groupOf = (o: OfferNode): GroupKind => (o.fulfilment?.requiresInstallation ? 'INSTALL' : o.fulfilment?.requiresShipping || o.fulfilment?.requiresCollection ? 'GOODS' : 'ACTIVATION');

export type DeliveryMethod = 'SHIP' | 'COLLECT';
/** How the goods of an order can reach the customer: what every goods offer in it allows (an offer may ship, be collected in store, or both). */
export function deliveryMethods(offers: OfferNode[]): DeliveryMethod[] {
  const goods = offers.filter((o) => groupOf(o) === 'GOODS');
  if (!goods.length) return [];
  return (['SHIP', 'COLLECT'] as const).filter((m) => goods.every((o) => (m === 'SHIP' ? !!o.fulfilment?.requiresShipping : !!o.fulfilment?.requiresCollection)));
}

/** Stock to reserve for an offer: its own SKUs, with the chosen variant's SKU standing in for the device SKUs the variants cover. */
export function skusFor(o: OfferNode, v?: DeviceVariant): string[] {
  const own = o.fulfilment?.inventorySkus ?? [];
  if (!v) return own;
  const covered = new Set((o.variants ?? []).map((x) => x.sku));
  return [...own.filter((s) => !covered.has(s)), v.sku];
}

export interface Entitlement { name: string; itemType: string; quantity?: number; unit?: string; unlimited?: boolean; description?: string }
export interface PricedLine {
  input: LineInput; offer: OfferNode; qty: number; group: GroupKind; variant?: DeviceVariant; position: number;
  /** Set on a device bought on a contract with a plan: the plan line it is attached to and the contract. */
  attachPosition?: number; deal?: DeviceDeal & { retailMinor: number };
  listGross: number;            // upfront price before any discount
  discountMinor: number; discountRules: string[];
  net: number; tax: number; gross: number;     // upfront price after discount
  payMode: 'UPFRONT' | 'INSTALLMENT'; months: number | null; downMinor: number; paidNow: number; financed: number; instalmentMinor: number;
  monthlyFeeMinor: number;      // recurring plan fee, tax included, for the quantity
  entitlements: Entitlement[];
  /** A VIP number: its tier, the connection fee included in the upfront price, and the multiplier on the early-termination charge. */
  vipTier?: string | null; vipFeeMinor: number; vipEtcBps?: number; numberInPool?: boolean;
}
export interface Priced {
  customer: Row | null; marketCode: string; currency: string; taxName: string; taxBps: number;
  lines: PricedLine[]; dueNow: number; net: number; monthlyPlanMinor: number; monthlyInstalmentMinor: number; discountMinor: number;
  bundles: Array<{ ruleId: string; name: string; discountMinor: number; lineOffer: string }>;
  problems: string[]; hasService: boolean;
  /** Set when a device on a contract is financed: how it is split and whether the customer still needs a credit check. */
  financing?: FinancingInfo;
}
export interface FinancingInfo {
  applied: boolean; months: number; financedMinor: number; upfrontMinor: number; ratioBps: number; instalmentMinor: number;
  requiresCreditCheck: boolean; checkId?: string; score?: number | null; band?: string | null; source?: string; fallback?: boolean; payInFull?: boolean;
}

function resolveVariant(o: OfferNode, id?: string): DeviceVariant | undefined {
  const vs = o.variants ?? [];
  if (!vs.length) { if (id) throw invalid(`${o.name} has no colour or storage options`); return undefined; }
  const v = id ? vs.find((x) => x.id === id) : vs[0]; // an unspecified choice falls back to the first option
  if (!v) throw invalid(`${o.name}: choose one of ${vs.map((x) => `${x.colour}${x.storage ? ` ${x.storage}` : ''} (${x.id})`).join(', ')}`);
  return v;
}

async function entitlementsFor(q: Queryable, offerIds: string[]): Promise<Map<string, Entitlement[]>> {
  const out = new Map<string, Entitlement[]>();
  if (!offerIds.length) return out;
  for (const r of (await q.query(`SELECT parent_id, name, data FROM catalog_nodes WHERE level='LINE_ITEM' AND status='ACTIVE' AND parent_id = ANY($1) ORDER BY sort_order, name, id`, [offerIds])).rows) {
    const d = r.data ?? {};
    out.set(r.parentId, [...(out.get(r.parentId) ?? []), { name: r.name, itemType: d.itemType, quantity: d.quantity, unit: d.unit, unlimited: d.unlimited || undefined, description: d.description }]);
  }
  return out;
}

/**
 * Prices a basket exactly as placing the order will, without saving anything. `soft` collects prerequisite/conflict problems instead of throwing,
 * so the order wizard can show the price and say what is missing. Everything else invalid still throws.
 */
export async function priceBasket(q: Queryable, raw: PricingInput, o: { soft?: boolean } = {}): Promise<Priced> {
  if (!raw.lines.length) throw invalid('an order needs at least one line');
  const input: PricingInput = { ...raw, lines: await prepareLines(q, raw) }; // group plans become their member lines; port-in details are checked
  const problems: string[] = [];
  const fail = (m: string) => { if (!o.soft) throw rejected(m); problems.push(m); };

  let customer: Row | null = null;
  const mode = await marketMode(q);
  let marketCode = await effectiveMarket(q, input.marketCode);
  if (input.customerId) {
    customer = await getCustomer(q, input.customerId);
    if (mode.multiple) marketCode = (customer.marketCode as string).trim(); // the customer's own market decides currency, tax and what is sellable
    if (customer.status !== 'ACTIVE') throw rejected(`customer is ${customer.status}`);
    if (input.accountId) {
      const a = (await q.query('SELECT customer_id FROM accounts WHERE id=$1', [input.accountId])).rows[0];
      if (!a || a.customerId !== input.customerId) throw invalid('accountId does not belong to this customer');
    }
  }
  const mk = await marketFor(q, marketCode);

  const offers = new Map<string, OfferNode>();
  const hiddenKinds = await hiddenFixedKinds(q);
  for (const l of input.lines) {
    const qty = l.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_BULK) throw invalid(`quantity must be 1-${MAX_BULK}`);
    if (l.msisdn && qty !== 1) throw invalid('a port-in/chosen number needs quantity 1');
    if (!offers.has(l.offerId)) {
      const of = await getOffer(q, l.offerId);
      if (of.status !== 'ACTIVE') throw rejected(`offer ${of.name} is not active`);
      if (hiddenKinds.includes(of.kind as string)) throw rejected(`${of.name} is not on sale right now.`);
      if (mode.multiple && of.markets.length && !of.markets.includes(marketCode)) throw rejected(`offer ${of.name} is not sold in ${marketCode}`);
      if (of.prices.some((p) => p.amount.currency !== mk.currency)) throw rejected(`offer ${of.name} is not priced in ${mk.currency}`);
      offers.set(of.id, of);
    }
  }
  await assertAncestorsLive(q, [...offers.values()]); // retired, draft or scheduled parents hide the offers beneath them from every sale
  const clash = await typeConflictIn(q, [...offers.values()]);
  if (clash) fail(clash);
  const violations = await checkDependencies(q, input.customerId ?? null, [...offers.keys()]);
  if (violations.length) fail(violations.join(' '));
  // Goods in one order travel together: they must share a way to reach the customer (counter sales hand them over at once).
  if (!RETAIL_CHANNELS.includes(input.channel) && [...offers.values()].some((o) => groupOf(o) === 'GOODS') && deliveryMethods([...offers.values()]).length === 0) {
    fail('These items cannot be delivered the same way (one can only be collected in store, another can only be shipped). Place them as separate orders.');
  }
  for (const of of offers.values()) {
    if (input.channel === 'QUICK_SALE' && (!behaviourOf(of).outright || of.contract?.termMonths)) throw rejected('quick-sale supports outright goods only');
    if (of.salesChannels?.length && !of.salesChannels.includes(input.channel)) throw rejected(`${of.name} is not sold through this channel`);
  }
  const hasService = [...offers.values()].some(createsService);
  if (hasService && customer?.displayName === 'Walk-in customer') throw rejected('services need a registered customer');
  // Identity. A customer whose check was rejected is not sold a service. With the gate at BEFORE_ORDER (CRM channels; the store-front gets there through its own
  // application) nothing is sold until the check is approved; otherwise the order is taken and the service is activated when the check is approved.
  if (hasService && customer && customer.kycStatus !== 'VERIFIED') {
    if (customer.kycStatus === 'REJECTED') fail('This customer’s identity verification was not approved, so a service cannot be sold to them.');
    else if (input.channel !== 'SELF_SERVE' && (await getStoreSettings(q)).kycGate === 'BEFORE_ORDER') fail('Identity verification (KYC) must be completed before a service can be sold to this customer.');
  }

  // A device on a contract is bought together with a plan: exactly one plan line, one device, and a contract the device is offered on.
  const attached = new Map<number, number>(); // plan position -> device position
  input.lines.forEach((l, pos) => {
    if (l.attachTo === undefined) { if (l.dealTermMonths !== undefined) throw invalid('choose the plan this device goes with'); return; }
    const dev = offers.get(l.offerId)!;
    const plan = input.lines[l.attachTo];
    if (!plan || l.attachTo === pos) throw invalid(`${dev.name}: choose a plan from this order to attach it to`);
    const planOffer = offers.get(plan.offerId)!;
    if (plan.attachTo !== undefined || !createsService(planOffer) || behaviourOf(planOffer).role !== 'PLAN' || behaviourOf(planOffer).goods) throw rejected(`${dev.name} can only be bought on a contract with a plan that has no device of its own`);
    if ((l.quantity ?? 1) !== 1 || (plan.quantity ?? 1) !== 1) throw invalid('a device on a contract goes with one plan: order one device and one plan');
    if (attached.has(l.attachTo)) throw rejected(`${planOffer.name} already has a device on a contract`);
    if (!(dev.deals ?? []).some((d) => d.termMonths === l.dealTermMonths)) throw rejected(`${dev.name} is not offered on a ${l.dealTermMonths ?? '?'}-month contract`);
    attached.set(l.attachTo, pos);
  });
  const legacy = input.payment.method === 'INSTALLMENT';
  if (legacy && !INSTALMENT_MONTHS.includes(input.payment.installmentMonths ?? 0)) throw invalid(`installmentMonths must be ${INSTALMENT_MONTHS.join(', ')}`);
  if (legacy && !hasService) throw rejected('instalments need a service to bill against');
  const ents = await entitlementsFor(q, [...offers.keys()]);
  const contractOf = (pos: number) => {
    const dev = [...attached.entries()].find(([plan]) => plan === pos);
    return dev ? (offers.get(input.lines[dev[1]]!.offerId)!.deals ?? []).find((d) => d.termMonths === input.lines[dev[1]]!.dealTermMonths)?.termMonths ?? 0 : offers.get(input.lines[pos]!.offerId)!.contract?.termMonths ?? 0;
  };
  const fmtMoney = (minor: number) => `${mk.currency} ${(minor / 100).toFixed(2)}`;
  const numbering = await resolveNumbering(q, input.lines, offers, { channel: input.channel, contractMonthsOf: contractOf, fail, fmt: fmtMoney });

  const lines: PricedLine[] = input.lines.map((l, position) => {
    const offer = offers.get(l.offerId)!;
    const qty = l.quantity ?? 1;
    const variant = resolveVariant(offer, l.options?.variantId);
    const flag = offer.prices.find((p) => p.type === 'ONE_TIME')?.taxInclusive ?? true;
    const dealDef = l.attachTo !== undefined ? (offer.deals ?? []).find((d) => d.termMonths === l.dealTermMonths) : undefined;
    // On a contract the customer pays the retail price less the subsidy (the first upfront price carries it).
    let subsidyLeft = dealDef?.subsidyMinor ?? 0;
    const parts = offer.prices.filter((p) => p.type === 'ONE_TIME').map((p) => { const cut = Math.min(subsidyLeft, p.amount.amountMinor); subsidyLeft -= cut; return taxSplit((p.amount.amountMinor - cut) * qty, mk.taxBps, p.taxInclusive); });
    if (variant?.priceDeltaMinor) parts.push(taxSplit(variant.priceDeltaMinor * qty, mk.taxBps, flag));
    const nr = numbering.get(position);
    if (nr?.oneTimeFeeMinor) parts.push(taxSplit(nr.oneTimeFeeMinor, mk.taxBps, flag)); // the VIP connection fee is part of what is paid now
    const split = parts.reduce((a, s) => ({ net: a.net + s.net, tax: a.tax + s.tax, gross: a.gross + s.gross }), { net: 0, tax: 0, gross: 0 });
    // Payment structure for this line: explicit, or the whole-order instalment default.
    const wanted: LinePayment = l.payment ?? (legacy && createsService(offer) && split.gross > 0 ? { mode: 'INSTALLMENT', months: input.payment.installmentMonths } : { mode: 'UPFRONT' });
    const fee = monthlyFee(offer);
    return {
      input: l, offer, qty, group: groupOf(offer), variant, position, attachPosition: dealDef ? l.attachTo : undefined,
      deal: dealDef ? { ...dealDef, retailMinor: offer.prices.filter((p) => p.type === 'ONE_TIME').reduce((t, p) => t + p.amount.amountMinor, 0) + (variant?.priceDeltaMinor ?? 0) } : undefined, listGross: split.gross, discountMinor: 0, discountRules: [], net: split.net, tax: split.tax, gross: split.gross,
      payMode: wanted.mode, months: wanted.mode === 'INSTALLMENT' ? wanted.months ?? null : null, downMinor: wanted.mode === 'INSTALLMENT' ? wanted.downPaymentMinor ?? 0 : 0,
      paidNow: 0, financed: 0, instalmentMinor: 0,
      monthlyFeeMinor: fee ? taxSplit(fee.amount.amountMinor * qty, mk.taxBps, fee.taxInclusive).gross : 0,
      entitlements: ents.get(offer.id) ?? [],
      vipTier: nr?.tier && nr.tier !== 'STANDARD' ? nr.tier : null, vipFeeMinor: nr?.oneTimeFeeMinor ?? 0, vipEtcBps: nr?.inPool ? nr.etcMultiplierBps : undefined, numberInPool: nr?.inPool,
    };
  });

  // Bundle discounts come off the target line's upfront price.
  const bundles: Priced['bundles'] = [];
  const ruleLines = lines.map((l) => ({ offerId: l.offer.id, kind: l.offer.kind as string }));
  for (const rule of (await listBundleRules(q, 'ACTIVE')) as BundleRule[]) {
    if (!ruleSatisfied(rule, ruleLines)) continue;
    for (const l of lines) {
      if (!matches(rule.target, { offerId: l.offer.id, kind: l.offer.kind })) continue;
      const room = l.gross;
      const want = rule.percentBps !== undefined ? Math.round((l.listGross * rule.percentBps) / 10_000) : (rule.amountMinor ?? 0) * l.qty;
      const d = Math.min(want, room);
      if (d <= 0) continue;
      const ratio = (l.gross - d) / l.gross;
      const net = Math.round(l.net * ratio);
      l.net = net; l.gross -= d; l.tax = l.gross - net; l.discountMinor += d; l.discountRules.push(rule.id);
      bundles.push({ ruleId: rule.id, name: rule.name, discountMinor: d, lineOffer: l.offer.name });
    }
  }

  // Device financing: a device on a contract is paid for over the whole contract unless the customer pays in full. The credit check decides the upfront share.
  let financing: FinancingInfo | undefined;
  const fset = await getFinancing(q);
  const dealLines = lines.filter((l) => l.deal && !l.input.payment && l.gross > 0);
  if (dealLines.length && fset.financeOverContract && !legacy) {
    if (input.financing?.payInFull) financing = { applied: false, months: 0, financedMinor: 0, upfrontMinor: 0, ratioBps: 10000, instalmentMinor: 0, requiresCreditCheck: false, payInFull: true };
    else {
      const total = dealLines.reduce((t, l) => t + l.gross, 0);
      let ratio = 0, check: Awaited<ReturnType<typeof usableCheck>> | undefined, needs = false;
      if (input.financing?.creditCheckId) check = await usableCheck(q, input.financing.creditCheckId, input.customerId);
      if (check) ratio = check.ratioBps;
      else if (fset.creditCheckRequired) {
        needs = true; ratio = fset.fallbackUpfrontBps; // shown as an estimate until the check is done
        fail('A credit check is needed before this device can be financed.');
      }
      let upfront = 0, instalment = 0;
      for (const l of dealLines) {
        const down = ratio >= 10000 ? l.gross : Math.min(l.gross - 1, Math.max(0, Math.round((l.gross * ratio) / 10000)));
        if (ratio >= 10000) { l.payMode = 'UPFRONT'; l.months = null; l.downMinor = 0; upfront += l.gross; }
        else { l.payMode = 'INSTALLMENT'; l.months = l.deal!.termMonths; l.downMinor = down; upfront += down; instalment += Math.floor((l.gross - down) / l.deal!.termMonths); }
      }
      financing = { applied: ratio < 10000, months: dealLines[0]!.deal!.termMonths, financedMinor: total, upfrontMinor: upfront, ratioBps: ratio, instalmentMinor: instalment, requiresCreditCheck: needs, checkId: check?.id, score: check?.score, band: check?.band, source: check?.source, fallback: check?.fallback };
    }
  }
  let dueNow = 0, net = 0, plan = 0, inst = 0, disc = 0;
  for (const l of lines) {
    if (l.payMode === 'INSTALLMENT') {
      if (!createsService(l.offer) && !l.deal) throw rejected(`${l.offer.name} cannot be paid by instalments: there is no service to bill them to`);
      if (l.deal && (l.months as number) > l.deal.termMonths) throw rejected(`${l.offer.name}: instalments (${l.months} months) cannot run longer than the ${l.deal.termMonths}-month contract`);
      if (!INSTALMENT_MONTHS.includes(l.months ?? 0)) throw invalid(`instalment months must be ${INSTALMENT_MONTHS.join(', ')}`);
      if (!legacy && l.offer.contract?.termMonths && (l.months as number) > l.offer.contract.termMonths) throw rejected(`${l.offer.name}: instalments (${l.months} months) cannot run longer than the ${l.offer.contract.termMonths}-month contract`);
      if (l.gross <= 0) throw rejected(`${l.offer.name} has nothing upfront to spread over instalments`);
      if (!Number.isInteger(l.downMinor) || l.downMinor < 0 || l.downMinor >= l.gross) throw invalid(`${l.offer.name}: the down payment must be at least 0 and less than the price`);
      l.paidNow = l.downMinor; l.financed = l.gross - l.downMinor; l.instalmentMinor = Math.floor(l.financed / (l.months as number));
    } else { l.paidNow = l.gross; l.downMinor = 0; }
    dueNow += l.paidNow; net += l.net; plan += l.monthlyFeeMinor; inst += l.instalmentMinor; disc += l.discountMinor;
  }
  if (dueNow > 0 && legacy) throw rejected('part of this order is due now: choose how it is paid (card, cash or QR) instead of instalments only');
  return { customer, marketCode, currency: mk.currency, taxName: mk.taxName, taxBps: mk.taxBps, lines, dueNow, net, monthlyPlanMinor: plan, monthlyInstalmentMinor: inst, discountMinor: disc, bundles, problems, hasService, financing };
}

/** What the customer is told about changing their mind, per part of the order, written from the cancellation rules in force. */
export const cancellationTerms = (q: Queryable, kinds: GroupKind[], currency: string) => termsFor(q, kinds, currency);

/** Add-ons this customer can actually buy with this basket: prerequisites met (by the basket or what they own), no conflicts, sold on this channel. */
export async function eligibleAddons(q: Queryable, o: { customerId?: string | null; offerIds: string[]; channel: OrderChannel; marketCode: string; q?: string; limit?: number; cursor?: string }) {
  const page = await pageOffers(q, { forSale: true, status: 'ACTIVE', market: o.marketCode, channel: o.channel, step: 'ADDON', q: o.q, limit: o.limit ?? 24, cursor: o.cursor });
  const items: Array<{ offer: OfferNode; reason?: string }> = [];
  for (const offer of page.items as OfferNode[]) {
    if (o.offerIds.includes(offer.id)) continue;
    const problems = await checkDependencies(q, o.customerId ?? null, [...o.offerIds, offer.id]);
    const blocking = problems.filter((m) => m.startsWith(offer.name) || m.includes(`combined with ${offer.name}`));
    if (blocking.length) continue; // not eligible: hidden rather than offered and then refused
    items.push({ offer });
  }
  return { items, nextCursor: page.nextCursor };
}

export interface OrderQuoteLine {
  offerId: string; name: string; kind: string; quantity: number; group: GroupKind;
  variant?: { id: string; colour: string; storage?: string };
  entitlements: Entitlement[]; contractMonths: number; etc?: unknown; subsidyMinor?: number;
  /** A device on a contract: which plan line it goes with, the retail price and the subsidy taken off. */
  deal?: { attachTo: number; planName: string; termMonths: number; subsidyMinor: number; retailMinor: number };
  requiresShipping: boolean; requiresInstallation: boolean;
  listMinor: number; discountMinor: number; priceMinor: number;
  payMode: 'UPFRONT' | 'INSTALLMENT'; months: number | null; downMinor: number; paidNowMinor: number; financedMinor: number; instalmentMinor: number; monthlyFeeMinor: number;
  /** The plan needs a SIM (one line, one plan). */
  needsSim: boolean;
  /** A VIP number on this line: its tier and the connection fee included in the price. */
  vip?: { tier: string; feeMinor: number; etcMultiplierBps: number };
  /** A group plan (the family head's line): how many member lines it holds and the pool they share. */
  groupPlan?: { maxMembers: number; sharedPoolQuotaGb: number | null };
  /** A member line: the position of the group plan line it belongs to, or the existing group it joins. */
  memberOf?: number; joinGroupId?: string;
  /** A number brought from another operator, and whether a temporary number is given meanwhile. */
  portIn?: { donorMsisdn: string; donorOperator: string; mnpOperatorId: string; temporaryNumber: boolean };
}
export interface OrderQuote {
  currency: string; taxName: string; taxBps: number;
  lines: OrderQuoteLine[]; bundles: Priced['bundles'];
  dueNowMinor: number; monthlyPlanMinor: number; monthlyInstalmentMinor: number; monthlyTotalMinor: number; discountMinor: number;
  problems: string[];
  groups: Array<{ group: GroupKind; title: string; text: string; points: Array<{ when: string; what: string }>; items: string[] }>;
  needs: { delivery: boolean; installation: boolean; customer: boolean; sim: boolean };
  /** How the goods can reach the customer (ship, collect in store, or both) when the order has goods and is not sold over a counter. */
  deliveryMethods: DeliveryMethod[];
  installationSlaDays: number | null;
  /** A device on a contract paid over the contract: the split, and whether a credit check is still needed. */
  financing?: FinancingInfo;
}

/** Everything the order wizard's review step shows, from the same pricing the order will be charged with. Saves nothing. */
export async function quoteOrder(q: Queryable, input: PricingInput): Promise<OrderQuote> {
  const p = await priceBasket(q, input, { soft: true });
  const kinds = [...new Set(p.lines.map((l) => l.group))];
  const terms = await cancellationTerms(q, kinds, p.currency);
  return {
    currency: p.currency, taxName: p.taxName, taxBps: p.taxBps, bundles: p.bundles, problems: p.problems, financing: p.financing,
    lines: p.lines.map((l) => ({
      offerId: l.offer.id, name: l.offer.name, kind: l.offer.kind, quantity: l.qty, group: l.group,
      variant: l.variant ? { id: l.variant.id, colour: l.variant.colour, storage: l.variant.storage } : undefined,
      entitlements: l.entitlements, contractMonths: l.deal?.termMonths ?? l.offer.contract?.termMonths ?? 0, etc: l.offer.contract?.etc, subsidyMinor: l.deal?.subsidyMinor ?? l.offer.contract?.subsidy?.subsidyAmount.amountMinor,
      deal: l.deal ? { attachTo: l.attachPosition!, planName: p.lines[l.attachPosition!]!.offer.name, termMonths: l.deal.termMonths, subsidyMinor: l.deal.subsidyMinor, retailMinor: l.deal.retailMinor } : undefined,
      requiresShipping: !!l.offer.fulfilment?.requiresShipping, requiresInstallation: !!l.offer.fulfilment?.requiresInstallation,
      listMinor: l.listGross, discountMinor: l.discountMinor, priceMinor: l.gross,
      payMode: l.payMode, months: l.months, downMinor: l.downMinor, paidNowMinor: l.paidNow, financedMinor: l.financed, instalmentMinor: l.instalmentMinor, monthlyFeeMinor: l.monthlyFeeMinor,
      needsSim: createsService(l.offer) && needsSim(l.offer) && l.qty === 1,
      vip: l.vipTier ? { tier: l.vipTier, feeMinor: l.vipFeeMinor, etcMultiplierBps: l.vipEtcBps ?? 10000 } : undefined,
      groupPlan: l.offer.group?.isGroupOffer ? { maxMembers: l.offer.group.maxGroupMembers, sharedPoolQuotaGb: l.offer.group.sharedPoolQuotaGb ?? null } : undefined,
      memberOf: l.input.memberOf, joinGroupId: l.input.joinGroupId,
      portIn: l.input.portIn ? { donorMsisdn: l.input.portIn.donorMsisdn, donorOperator: l.input.portIn.donorOperator ?? '', mnpOperatorId: l.input.portIn.donorMnpOperatorId ?? '', temporaryNumber: !!l.input.portIn.temporaryNumber } : undefined,
    })),
    dueNowMinor: p.dueNow, monthlyPlanMinor: p.monthlyPlanMinor, monthlyInstalmentMinor: p.monthlyInstalmentMinor, monthlyTotalMinor: p.monthlyPlanMinor + p.monthlyInstalmentMinor, discountMinor: p.discountMinor,
    groups: terms.map((t) => ({ ...t, items: p.lines.filter((l) => l.group === t.group).map((l) => l.offer.name) })),
    needs: { delivery: kinds.includes('GOODS') && !RETAIL_CHANNELS.includes(input.channel), installation: kinds.includes('INSTALL'), customer: p.hasService, sim: p.lines.some((l) => createsService(l.offer) && needsSim(l.offer) && l.qty === 1) },
    deliveryMethods: RETAIL_CHANNELS.includes(input.channel) ? [] : deliveryMethods(p.lines.map((l) => l.offer)),
    installationSlaDays: kinds.includes('INSTALL') ? await autoCancelDays(q, 'INSTALL') : null,
  };
}

/** Stock behind each colour/storage choice at a location, so the wizard can grey out what is not available. */
export async function variantAvailability(q: Queryable, offerId: string, locationId: string): Promise<Array<{ variantId: string; available: number }>> {
  const o = await getOffer(q, offerId);
  const vs = o.variants ?? [];
  if (!vs.length) return [];
  const rows = (await q.query('SELECT sku, on_hand - reserved AS avail FROM inventory_stock WHERE location_id=$1 AND sku = ANY($2)', [locationId, vs.map((v) => v.sku)])).rows;
  const by = new Map(rows.map((r) => [r.sku as string, Number(r.avail)]));
  return vs.map((v) => ({ variantId: v.id, available: Math.max(0, by.get(v.sku) ?? 0) }));
}
