import type { OfferKind } from '@meridian/types';

export interface SampleOffer { id: string; name: string; kind: OfferKind; path: string; monthly?: number; term?: 0 | 12 | 24 | 36; subsidy?: number; currency: 'SGD' | 'THB' }

export const sampleOffers: SampleOffer[] = [
  { id: 'o1', name: 'Postpaid 5G SIM-only', kind: 'SIM_ONLY', path: 'mobile/postpaid/sim-only', monthly: 3500, term: 0, currency: 'SGD' },
  { id: 'o2', name: 'Postpaid 5G + Phone (24 mo)', kind: 'SIM_DEVICE', path: 'mobile/postpaid/device', monthly: 6800, term: 24, subsidy: 72000, currency: 'SGD' },
  { id: 'o3', name: 'Smart Watch LTE', kind: 'WEARABLE', path: 'mobile/postpaid/wearable', monthly: 1200, term: 12, subsidy: 18000, currency: 'SGD' },
  { id: 'o4', name: 'Fiber 1 Gbps', kind: 'FIBER', path: 'fiber/home/gigabit', monthly: 4900, term: 24, subsidy: 0, currency: 'SGD' },
  { id: 'o5', name: 'Netflix Premium add-on', kind: 'NON_TELCO_SUBSCRIPTION', path: 'none/entertainment/video', monthly: 1999, term: 0, currency: 'SGD' },
  { id: 'o6', name: 'Smart Refrigerator', kind: 'PHYSICAL_GOOD', path: 'none/goods/appliances', currency: 'THB' },
];
