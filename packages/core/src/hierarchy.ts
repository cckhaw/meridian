import { LINE_ITEM_TYPES, type CatalogNode, type CatalogNodeLevel, type LineItemNode, type OfferNode } from '@meridian/types';

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
  const needsContract = o.kind === 'SIM_DEVICE';
  if (needsContract && !o.contract?.subsidy && (o.contract?.termMonths ?? 0) > 0) errs.push('contract device offers need a subsidy definition');
  if (o.contract && o.contract.termMonths > 0 && !o.contract.etc) errs.push('fixed-term contracts need an ETC policy');
  if (o.kind === 'NON_TELCO_SUBSCRIPTION' && !o.partnerCode) errs.push('non-telco subscriptions need a partnerCode');
  if (o.kind === 'PHYSICAL_GOOD' && !o.fulfilment.requiresShipping) errs.push('physical goods must require shipping');
  if (o.kind === 'FIBER' && !o.fulfilment.requiresInstallation) errs.push('fiber offers must require installation');
  if (o.kind === 'SIM_ONLY' && o.contract?.subsidy) errs.push('SIM-only offers cannot carry a device subsidy');
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
