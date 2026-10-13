import { describe, expect, it } from 'vitest';
import { validateOffer, validateParent } from './hierarchy.js';
import type { OfferNode } from '@meridian/types';

const offer = (over: Partial<OfferNode>): OfferNode => ({
  id: 'x', level: 'OFFER', code: 'x', name: 'x', path: 'a/b/c/x', parentId: 'g', status: 'DRAFT', markets: [],
  createdAt: '', updatedAt: '', version: 1, kind: 'SIM_ONLY',
  prices: [{ type: 'RECURRING', amount: { amountMinor: 1000, currency: 'SGD' }, periodMonths: 1, taxInclusive: true }],
  fulfilment: { requiresShipping: false, requiresInstallation: false, requiresSimActivation: true, inventorySkus: [] },
  characteristics: {}, requires: [], excludes: [], ...over,
});

describe('hierarchy', () => {
  it('enforces level ordering', () => {
    expect(validateParent({ level: 'OFFER' }, { level: 'GROUP' })).toBeNull();
    expect(validateParent({ level: 'OFFER' }, { level: 'CATEGORY' })).toMatch(/must be GROUP/);
    expect(validateParent({ level: 'NETWORK_TYPE' }, null)).toBeNull();
    expect(validateParent({ level: 'GROUP' }, null)).toMatch(/requires/);
  });
  it('validates kind-specific rules', () => {
    expect(validateOffer(offer({}))).toEqual([]);
    expect(validateOffer(offer({ kind: 'NON_TELCO_SUBSCRIPTION' }))).toContain('partner subscriptions need a partner code');
    expect(validateOffer(offer({ kind: 'PHYSICAL_GOOD' }))).toContain('goods must be delivered or collected in store');
    expect(validateOffer(offer({ contract: { termMonths: 24 } }))).toContain('fixed-term contracts need an ETC policy');
    expect(validateOffer(offer({ requires: ['a'], excludes: ['a'] }))[0]).toMatch(/required and excluded/);
  });
});
