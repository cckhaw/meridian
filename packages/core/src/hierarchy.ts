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
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/.test(v.sku ?? '')) errs.push(`variant ${v.id}: enter the stock SKU (letters, digits, dash, dot, underscore)`);
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
  if (i.sku && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/.test(i.sku)) errs.push('inventory SKU may contain letters, digits, dash, dot and underscore');
  if (i.sku && i.unlimited) errs.push('a line item tied to stock cannot be unlimited');
  if (i.description && i.description.length > 300) errs.push('description is limited to 300 characters');
  return errs;
}
