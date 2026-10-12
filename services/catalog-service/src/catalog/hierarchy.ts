import type { CatalogNode, CatalogNodeLevel, OfferNode } from '@nexus/types';

/** Network type -> Category -> Group -> Offer. A node's parent must be exactly one level above. */
const PARENT_LEVEL: Record<CatalogNodeLevel, CatalogNodeLevel | null> = {
  NETWORK_TYPE: null,
  CATEGORY: 'NETWORK_TYPE',
  GROUP: 'CATEGORY',
  OFFER: 'GROUP',
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
