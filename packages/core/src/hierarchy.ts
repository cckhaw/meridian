import { SKU_RE, SKU_RULE } from './sku.js';
import { behaviourOf, LINE_ITEM_TYPES, type CatalogNode, type CatalogNodeLevel, type LineItemNode, type OfferNode } from '@meridian/types';

/** Network type -> Category -> Group -> Offer -> Line item. A node's parent must be exactly one level above. */
const PARENT_LEVEL: Record<CatalogNodeLevel, CatalogNodeLevel | null> = {
  NETWORK_TYPE: null,
  CATEGORY: 'NETWORK_TYPE',
  GROUP: 'CATEGORY',
  OFFER: 'GROUP',
  LINE_ITEM: 'OFFER',
};

export function validateParent(node: Pick<CatalogNode, 'level'>, parent: Pick<CatalogNode, 'level'> | null): string | null {
  const expected = PARENT_LEVEL[node.level];
  if (expected === null) return parent ? `${node.level} must be a root node` : null;
  if (!parent) return `${node.level} requires a ${expected} parent`;
  return parent.level === expected ? null : `${node.level} parent must be ${expected}, got ${parent.level}`;
}

/** Kind-specific invariants for offers. Returns a list of violations (empty = valid). */
export function validateOffer(o: OfferNode): string[] {
  const errs: string[] = [];
  if (o.prices.length === 0) errs.push('offer needs at least one price component');
  const variants = o.variants ?? [];
  if (variants.length) {
    if (!o.fulfilment?.requiresShipping && !o.fulfilment?.requiresCollection) errs.push('device variants only make sense for offers that ship or hand over a device');
    const ids = new Set<string>();
    for (const v of variants) {
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(v.id ?? '')) errs.push(`variant id “${v.id}” may contain lowercase letters, digits and dashes`);
      if (ids.has(v.id)) errs.push(`variant id “${v.id}” is used twice`);
      ids.add(v.id);
      if (!v.colour?.trim()) errs.push('every variant needs a colour');
      if (!SKU_RE.test(v.sku ?? '')) errs.push(v.sku ? `variant ${v.colour}${v.storage ? ` ${v.storage}` : ''}: “${v.sku}” is not a valid stock SKU (${SKU_RULE}, up to 50 characters)` : `variant ${v.colour}${v.storage ? ` ${v.storage}` : ''}: enter the stock SKU`);
      if (v.priceDeltaMinor !== undefined && !Number.isInteger(v.priceDeltaMinor)) errs.push(`variant ${v.id}: the price difference must be a whole amount in minor units`);
    }
    if (variants.length > 40) errs.push('too many variants (40 at most)');
  }
  const b = behaviourOf(o);
  if (b.goods && b.service && !b.serviceNeedsFee && !o.contract?.subsidy && (o.contract?.termMonths ?? 0) > 0) errs.push('contract device offers need a subsidy definition');
  if (o.contract && o.contract.termMonths > 0 && !o.contract.etc) errs.push('fixed-term contracts need an ETC policy');
  if (b.contract === 'none' && (o.contract?.termMonths ?? 0) > 0) errs.push('this type of offer is sold without a contract');
  if (b.needsPartner && !o.partnerCode) errs.push('partner subscriptions need a partner code');
  if (b.goods && b.outright && !o.fulfilment.requiresShipping && !o.fulfilment.requiresCollection) errs.push('goods must be delivered or collected in store');
  if (b.needsInstallation && !o.fulfilment.requiresInstallation) errs.push('this type of offer must have an installation option');
  if (!b.goods && o.contract?.subsidy) errs.push('only offers with a device can carry a device subsidy');
  const deals = o.deals ?? [];
  if (deals.length) {
    const price = o.prices.filter((p) => p.type === 'ONE_TIME').reduce((t, p) => t + p.amount.amountMinor, 0);
    if (!b.outright) errs.push('only a device sold outright can be offered on a contract with a plan');
    const terms = new Set<number>();
    for (const d of deals) {
      if (![12, 24, 36].includes(d.termMonths)) errs.push('a contract lasts 12, 24 or 36 months');
      if (terms.has(d.termMonths)) errs.push(`there are two ${d.termMonths}-month contracts`);
      terms.add(d.termMonths);
      if (!Number.isInteger(d.subsidyMinor) || d.subsidyMinor <= 0) errs.push(`${d.termMonths} months: enter the subsidy`);
      else if (d.subsidyMinor >= price) errs.push(`${d.termMonths} months: the subsidy must be less than the device price`);
      if (d.waiveInLastMonths !== undefined && (!Number.isInteger(d.waiveInLastMonths) || d.waiveInLastMonths < 0 || d.waiveInLastMonths >= d.termMonths)) errs.push(`${d.termMonths} months: the charge-free months at the end must be fewer than the term`);
    }
  }
  const clash = o.requires.filter((r) => o.excludes.includes(r));
  if (clash.length) errs.push(`offers both required and excluded: ${clash.join(', ')}`);
  return errs;
}

/** Invariants for a line item. Returns violations (empty = valid). */
export function validateLineItem(i: Partial<LineItemNode>): string[] {
  const errs: string[] = [];
  if (!i.itemType || !(LINE_ITEM_TYPES as readonly string[]).includes(i.itemType)) errs.push('choose what kind of line item this is');
  if (i.unlimited) {
    if (i.quantity !== undefined && i.quantity !== null) errs.push('an unlimited line item has no quantity');
  } else if (i.quantity !== undefined && i.quantity !== null && (!Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 1_000_000)) errs.push('quantity must be a whole number of at least 1');
  if (i.unit && (i.unit.length > 20 || /[\r\n]/.test(i.unit))) errs.push('unit must be short (up to 20 characters)');
  if (i.sku && !SKU_RE.test(i.sku)) errs.push(`inventory SKU may contain ${SKU_RULE}`);
  if (i.sku && i.unlimited) errs.push('a line item tied to stock cannot be unlimited');
  if (i.description && i.description.length > 300) errs.push('description is limited to 300 characters');
  return errs;
}
